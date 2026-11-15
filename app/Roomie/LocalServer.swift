import CryptoKit
import Foundation
import Network

/// The page runs from http://localhost:<port> inside the app (localhost counts as a secure page, so the
/// microphone still works), served by this small server on the phone itself:
/// - The hands' heavy files (~7 MB of models, the hand solver, the matching ring) and three.js ship inside
///   the app, so the first launch doesn't download them. Each bundled model is still checked against the
///   PairShake server's copy with one tiny request (a 304 when it's the same); if the server has a newer one,
///   that one is used. If the server can't be reached in time, the bundled copy is used.
/// - Everything else (the page, Emma's voice, the API, the chat socket) is passed through to the PairShake server.
final class LocalServer: NSObject, URLSessionDelegate {
    static let port: UInt16 = 47_213
    var onReady: ((Bool) -> Void)?

    private var listener: NWListener?
    private var everReady = false
    private let queue = DispatchQueue(label: "roomie.localserver")
    private lazy var session: URLSession = {
        let c = URLSessionConfiguration.ephemeral
        c.timeoutIntervalForRequest = 120
        c.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: c, delegate: self, delegateQueue: nil)
    }()
    private let web = Bundle.main.resourceURL!.appendingPathComponent("web")
    private lazy var manifest: [String: String] = {
        guard let d = try? Data(contentsOf: web.appendingPathComponent("manifest.json")),
              let m = try? JSONSerialization.jsonObject(with: d) as? [String: String] else { return [:] }
        return m
    }()

    private var remote: String { Server.active }

    func start() {
        guard let port = NWEndpoint.Port(rawValue: Self.port) else { onReady?(false); return }
        let params = NWParameters.tcp
        params.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: port)   // only this phone can connect
        params.allowLocalEndpointReuse = true
        guard let l = try? NWListener(using: params) else { onReady?(false); return }
        listener = l
        l.stateUpdateHandler = { [weak self, weak l] state in
            guard let self else { return }
            switch state {
            case .ready:
                if !self.everReady { self.everReady = true; DispatchQueue.main.async { self.onReady?(true) } }
            case .failed:
                l?.cancel()
                if !self.everReady { self.everReady = true; DispatchQueue.main.async { self.onReady?(false) } }
                else { self.queue.asyncAfter(deadline: .now() + 0.5) { self.start() } }   // keep trying
            default: break
            }
        }
        l.newConnectionHandler = { [weak self] c in self?.accept(c) }
        l.start(queue: queue)
    }

    /// iOS takes listening sockets away from suspended apps: open a fresh one when the app comes back.
    /// The page and its open connections carry on; only new requests wait the moment it takes.
    func restart() {
        queue.async { [weak self] in
            self?.listener?.cancel()
            self?.listener = nil
            self?.queue.asyncAfter(deadline: .now() + 0.2) { self?.start() }
        }
    }

    // MARK: HTTP

    private struct Request {
        let method: String
        let target: String              // path and query
        let headers: [String: String]   // lowercased names
        let body: Data
        var path: String { String(target.split(separator: "?", maxSplits: 1).first ?? "/") }
    }

    private func accept(_ c: NWConnection) {
        c.start(queue: queue)
        readHead(c, [])
    }

    /// Bytes are copied into plain arrays: what NWConnection hands over can be several separate chunks
    /// underneath, and searching those (Data.range(of:)) missed the end of longer requests.
    private func readHead(_ c: NWConnection, _ buffer: [UInt8]) {
        c.receive(minimumIncompleteLength: 1, maximumLength: 1 << 16) { [weak self] data, _, done, error in
            guard let self else { return }
            let buf = buffer + (data.map { [UInt8]($0) } ?? [])
            guard let end = Self.headEnd(buf) else {
                if done || error != nil || buf.count > 1 << 20 { c.cancel() } else { self.readHead(c, buf) }
                return
            }
            var lines = String(decoding: buf[..<end], as: UTF8.self).components(separatedBy: "\r\n")
            let first = lines.removeFirst().split(separator: " ")
            guard first.count >= 2 else { c.cancel(); return }
            var headers: [String: String] = [:]
            for l in lines {
                guard let i = l.firstIndex(of: ":") else { continue }
                headers[l[..<i].lowercased()] = l[l.index(after: i)...].trimmingCharacters(in: .whitespaces)
            }
            let need = Int(headers["content-length"] ?? "") ?? 0
            self.readBody(c, Data(buf[(end + 4)...]), need) { body in
                self.handle(c, Request(method: String(first[0]), target: String(first[1]), headers: headers, body: body))
            }
        }
    }

    private func readBody(_ c: NWConnection, _ have: Data, _ need: Int, _ done: @escaping (Data) -> Void) {
        if have.count >= need { done(have.prefix(need)); return }
        c.receive(minimumIncompleteLength: 1, maximumLength: 1 << 20) { [weak self] data, _, end, error in
            guard let data, error == nil else { c.cancel(); return }
            if end && data.isEmpty { c.cancel(); return }
            self?.readBody(c, have + Data([UInt8](data)), need, done)
        }
    }

    private static func headEnd(_ b: [UInt8]) -> Int? {
        guard b.count >= 4 else { return nil }
        for i in 0...(b.count - 4) where b[i] == 13 && b[i + 1] == 10 && b[i + 2] == 13 && b[i + 3] == 10 { return i }
        return nil
    }

    private func handle(_ c: NWConnection, _ r: Request) {
        if r.headers["upgrade"]?.lowercased() == "websocket" { return websocket(c, r) }
        if r.path.hasPrefix("/vendor/") { return vendor(c, r) }
        if let etag = manifest[r.path], r.method == "GET" { return bundled(c, r, etag) }
        proxy(c, r)
    }

    /// three.js, pinned by version: from the app, or from the CDN if the page asks for a file we don't ship.
    private func vendor(_ c: NWConnection, _ r: Request) {
        let rel = String(r.path.dropFirst("/vendor/".count))
        let file = web.appendingPathComponent("vendor").appendingPathComponent(rel)
        if !rel.contains(".."), let d = try? Data(contentsOf: file) { return respond(c, 200, type(of: rel), d) }
        fetch(c, URL(string: "https://cdn.jsdelivr.net/npm/" + rel), r)
    }

    /// A model that ships with the app: use it unless the server has a different one.
    private func bundled(_ c: NWConnection, _ r: Request, _ etag: String) {
        let file = web.appendingPathComponent(String(r.path.dropFirst()))
        guard let url = URL(string: remote + r.target) else { return proxy(c, r) }
        var q = URLRequest(url: url, timeoutInterval: 5)
        q.setValue(etag, forHTTPHeaderField: "If-None-Match")
        session.dataTask(with: q) { [weak self] data, resp, _ in
            guard let self else { return }
            if let h = resp as? HTTPURLResponse, h.statusCode == 200, let data {   // changed on the server
                return self.respond(c, 200, h.value(forHTTPHeaderField: "Content-Type") ?? self.type(of: r.path), data)
            }
            if let d = try? Data(contentsOf: file) { self.respond(c, 200, self.type(of: r.path), d) }
            else { self.proxy(c, r) }
        }.resume()
    }

    private func proxy(_ c: NWConnection, _ r: Request) {
        fetch(c, URL(string: remote + r.target), r)
    }

    private func fetch(_ c: NWConnection, _ url: URL?, _ r: Request) {
        guard let url else { return respond(c, 400, "text/plain", Data("bad address".utf8)) }
        var q = URLRequest(url: url)
        q.httpMethod = r.method
        for (k, v) in r.headers where !["host", "connection", "content-length", "accept-encoding", "origin", "referer",
                                        "if-none-match", "if-modified-since"].contains(k) {
            q.setValue(v, forHTTPHeaderField: k)
        }
        if !r.body.isEmpty || r.method == "POST" { q.httpBody = r.body }
        session.dataTask(with: q) { [weak self] data, resp, error in
            guard let self else { return }
            guard let h = resp as? HTTPURLResponse else {
                return self.respond(c, 502, "text/plain", Data("Can't reach \(self.remote): \(error?.localizedDescription ?? "")".utf8))
            }
            var body = data ?? Data()
            let type = h.value(forHTTPHeaderField: "Content-Type") ?? "application/octet-stream"
            if type.hasPrefix("text/html") {             // the page's three.js comes from the app
                body = Data(String(decoding: body, as: UTF8.self)
                    .replacingOccurrences(of: "https://cdn.jsdelivr.net/npm/three@", with: "/vendor/three@").utf8)
            }
            self.respond(c, h.statusCode, type, body)
        }.resume()
    }

    private func respond(_ c: NWConnection, _ status: Int, _ type: String, _ body: Data) {
        let head = "HTTP/1.1 \(status) \(status < 400 ? "OK" : "Error")\r\nContent-Type: \(type)\r\nContent-Length: \(body.count)\r\n" +
                   "Cache-Control: no-store\r\nConnection: close\r\n\r\n"
        c.send(content: Data(head.utf8) + body, completion: .contentProcessed { _ in c.cancel() })
    }

    private func type(of path: String) -> String {
        switch (path as NSString).pathExtension.lowercased() {
        case "js", "mjs": return "text/javascript"
        case "json": return "application/json"
        case "wasm": return "application/wasm"
        case "glb": return "model/gltf-binary"
        case "html": return "text/html; charset=utf-8"
        default: return "application/octet-stream"
        }
    }

    // MARK: WebSocket (the room's chat, decisions and finding tokens), relayed to the server's /ws

    private func websocket(_ c: NWConnection, _ r: Request) {
        guard let key = r.headers["sec-websocket-key"],
              let url = URL(string: remote.replacingOccurrences(of: "https://", with: "wss://")
                                          .replacingOccurrences(of: "http://", with: "ws://") + r.target) else { c.cancel(); return }
        let accept = Data(Insecure.SHA1.hash(data: Data((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").utf8))).base64EncodedString()
        let ws = session.webSocketTask(with: url)
        ws.maximumMessageSize = 4 << 20
        ws.resume()
        c.stateUpdateHandler = { state in
            switch state { case .failed, .cancelled: ws.cancel(with: .goingAway, reason: nil); default: break }
        }
        let head = "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: \(accept)\r\n\r\n"
        c.send(content: Data(head.utf8), completion: .contentProcessed { _ in })
        fromServer(ws, c)
        fromPage(c, ws, r.body)
    }

    private func fromServer(_ ws: URLSessionWebSocketTask, _ c: NWConnection) {
        ws.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(.string(let s)): self.frame(c, 1, Data(s.utf8)); self.fromServer(ws, c)
            case .success(.data(let d)): self.frame(c, 2, d); self.fromServer(ws, c)
            case .success: self.fromServer(ws, c)
            case .failure:
                self.frame(c, 8, Data())
                c.send(content: nil, isComplete: true, completion: .contentProcessed { _ in c.cancel() })
            }
        }
    }

    private func fromPage(_ c: NWConnection, _ ws: URLSessionWebSocketTask, _ buffer: Data) {
        var buf = buffer
        while let (op, payload, used) = Self.parse(buf) {
            buf = Data(buf.dropFirst(used))
            switch op {
            case 1: ws.send(.string(String(decoding: payload, as: UTF8.self))) { _ in }
            case 2: ws.send(.data(payload)) { _ in }
            case 8: ws.cancel(with: .normalClosure, reason: nil); frame(c, 8, payload.prefix(2)) { c.cancel() }; return
            case 9: frame(c, 10, payload)
            default: break
            }
        }
        let rest = buf
        c.receive(minimumIncompleteLength: 1, maximumLength: 1 << 16) { [weak self] data, _, done, error in
            guard error == nil, !(done && (data?.isEmpty ?? true)) else { ws.cancel(with: .goingAway, reason: nil); c.cancel(); return }
            self?.fromPage(c, ws, rest + Data([UInt8](data ?? Data())))
        }
    }

    /// One client frame: opcode, unmasked payload and how many bytes it took. Nil until it's all here.
    static func parse(_ d: Data) -> (UInt8, Data, Int)? {
        let b = [UInt8](d.prefix(14))
        guard b.count >= 2 else { return nil }
        var len = Int(b[1] & 0x7f), i = 2
        if len == 126 { guard b.count >= 4 else { return nil }; len = Int(b[2]) << 8 | Int(b[3]); i = 4 }
        else if len == 127 { guard b.count >= 10 else { return nil }; len = b[2..<10].reduce(0) { $0 << 8 | Int($1) }; i = 10 }
        var mask: [UInt8] = []
        if b[1] & 0x80 != 0 { guard b.count >= i + 4 else { return nil }; mask = Array(b[i..<i + 4]); i += 4 }
        guard d.count >= i + len else { return nil }
        var p = [UInt8](d[d.startIndex + i..<d.startIndex + i + len])
        if !mask.isEmpty { for k in p.indices { p[k] ^= mask[k & 3] } }
        return (b[0] & 0x0f, Data(p), i + len)
    }

    private func frame(_ c: NWConnection, _ op: UInt8, _ payload: Data, then: (() -> Void)? = nil) {
        var h: [UInt8] = [0x80 | op]
        let n = payload.count
        if n < 126 { h.append(UInt8(n)) }
        else if n < 65_536 { h += [126, UInt8(n >> 8), UInt8(n & 0xff)] }
        else { h.append(127); for s in stride(from: 56, through: 0, by: -8) { h.append(UInt8((n >> s) & 0xff)) } }
        c.send(content: Data(h) + payload, completion: .contentProcessed { _ in then?() })
    }

    // MARK: our own server may use a self-signed certificate on the local Wi-Fi

    func urlSession(_ s: URLSession, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        if challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
           challenge.protectionSpace.host == Server.url.host, let trust = challenge.protectionSpace.serverTrust {
            completionHandler(.useCredential, URLCredential(trust: trust))
        } else {
            completionHandler(.performDefaultHandling, nil)
        }
    }
}
