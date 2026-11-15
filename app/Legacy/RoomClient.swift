import SwiftUI

/// Live connection to one introduction: the chat, presence, both people's decision, and the
/// Nearby Interaction token relay used to find each other.
@MainActor
final class RoomClient: ObservableObject {
    struct Message: Identifiable, Equatable {
        let id = UUID()
        let from: String
        let text: String
    }

    @Published var you = "a"
    @Published var chat: [Message] = []
    @Published var typing = false
    @Published var decided = false
    @Published var meet: Bool?                 // nil until both have decided (or one said no)
    @Published var otherOnline = false
    @Published var connected = false
    @Published var peerToken: Data?            // the other iPhone's Nearby Interaction token

    var them: String { you == "a" ? "b" : "a" }
    var onMeet: ((Bool) -> Void)?

    private var socket: URLSessionWebSocketTask?
    private var target: (mission: String, user: String)?

    func connect(mission: String, user: String) {
        target = (mission, user)
        var c = URLComponents(url: API.base.appendingPathComponent("ws"), resolvingAgainstBaseURL: false)!
        c.scheme = c.scheme == "https" ? "wss" : "ws"
        c.queryItems = [URLQueryItem(name: "mission", value: mission), URLQueryItem(name: "id", value: user)]
        socket = URLSession.shared.webSocketTask(with: c.url!)
        socket?.resume()
        receive()
    }

    func close() {
        target = nil
        socket?.cancel(with: .goingAway, reason: nil)
        socket = nil
    }

    private func receive() {
        socket?.receive { [weak self] result in
            Task { @MainActor in
                guard let self else { return }
                switch result {
                case .success(.string(let s)):
                    self.handle(s)
                    self.receive()
                case .success:
                    self.receive()
                case .failure:
                    self.connected = false
                    self.reconnect()
                }
            }
        }
    }

    /// Venue Wi-Fi drops: come back on our own so the chat and the token relay keep working.
    private func reconnect() {
        guard let t = target else { return }
        socket = nil
        Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(1.5))
            guard let self, self.socket == nil, self.target != nil else { return }
            self.connect(mission: t.mission, user: t.user)
        }
    }

    private func handle(_ s: String) {
        guard let d = (try? JSONSerialization.jsonObject(with: Data(s.utf8))) as? [String: Any],
              let t = d["t"] as? String else { return }
        switch t {
        case "state":
            connected = true
            you = d["you"] as? String ?? "a"
            chat = (d["chat"] as? [[String: Any]] ?? []).map { Message(from: $0["from"] as? String ?? "", text: $0["text"] as? String ?? "") }
            decided = d["decided"] as? Bool ?? false
            meet = d["meet"] as? Bool
            otherOnline = d["online"] as? Bool ?? false
        case "chat":
            typing = false
            withAnimation(.smooth) { chat.append(Message(from: d["from"] as? String ?? them, text: d["text"] as? String ?? "")) }
        case "typing":
            withAnimation { typing = true }
        case "presence":
            otherOnline = d["online"] as? Bool ?? false
        case "ni":
            if let t = d["token"] as? String, let data = Data(base64Encoded: t) { peerToken = data }
        case "meet":
            let yes = d["yes"] as? Bool ?? false
            withAnimation(.smooth) { meet = yes }
            onMeet?(yes)
        default:
            break
        }
    }

    private func send(_ d: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: d), let s = String(data: data, encoding: .utf8) else { return }
        socket?.send(.string(s)) { _ in }
    }

    func say(_ text: String) {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return }
        withAnimation(.smooth) { chat.append(Message(from: you, text: t)) }
        send(["t": "chat", "text": t])
    }

    func sendNI(_ token: Data) { send(["t": "ni", "token": token.base64EncodedString()]) }

    func decide(_ yes: Bool) {
        decided = true
        send(["t": "decide", "yes": yes])
    }
}
