import SwiftUI

/// Where the Roomie web app lives. The app shows the same page the audience opens in their browser,
/// so it has to be an https address (the microphone only works on secure pages): the tunnel link,
/// or the Mac on this Wi-Fi if it serves https.
enum Server {
    static let fallback = "https://roomie.binjto.workers.dev"     // Cloudflare: fixed address, see edge/
    private static let key = "server.manual"      // only an address typed in by hand; older saved ones are ignored

    static var address: String {
        get { UserDefaults.standard.string(forKey: key) ?? fallback }
        set {
            let v = normalize(newValue)
            if v == fallback { UserDefaults.standard.removeObject(forKey: key) } else { UserDefaults.standard.set(v, forKey: key) }
        }
    }

    static var url: URL { URL(string: active) ?? URL(string: fallback)! }

    /// The server this launch talks to: an address set by hand (shake the phone) if it answers,
    /// otherwise Roomie's fixed Cloudflare address.
    private(set) static var active = fallback

    private static var candidates: [String] {
        var c: [String] = []
        if let saved = UserDefaults.standard.string(forKey: key) { c.append(saved) }
        c.append(fallback)
        return c.reduce(into: []) { if !$0.contains($1) { $0.append($1) } }
    }

    /// Asks every candidate at once (up to ~3 s) and takes the first one in the list that answered.
    static func pick(_ done: @escaping (String) -> Void) {
        let list = candidates
        var ok = Set<String>()
        let group = DispatchGroup()
        let lock = NSLock()
        for c in list {
            guard let u = URL(string: c + "/room") else { continue }
            group.enter()
            URLSession.shared.dataTask(with: URLRequest(url: u, timeoutInterval: 3)) { data, resp, _ in
                if (resp as? HTTPURLResponse)?.statusCode == 200, let data,
                   (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["stats"] != nil {
                    lock.lock(); ok.insert(c); lock.unlock()
                }
                group.leave()
            }.resume()
        }
        group.notify(queue: .main) {
            active = list.first(where: ok.contains) ?? list.first ?? fallback
            done(active)
        }
    }

    /// "letters-x.trycloudflare.com" or "192.168.1.5:8780" become full addresses.
    static func normalize(_ s: String) -> String {
        var t = s.trimmingCharacters(in: .whitespacesAndNewlines)
        while t.hasSuffix("/") { t.removeLast() }
        if t.isEmpty { return fallback }
        if !t.contains("://") {
            let local = t.first?.isNumber == true || t.contains(".local")
            t = (local ? "http://" : "https://") + t
        }
        return t
    }
}

/// Opens when the page can't load, or when you shake the phone.
struct ServerSheet: View {
    @State var address: String
    let problem: String?
    let connect: (String) -> Void
    let cancel: () -> Void

    var body: some View {
        NavigationStack {
            Form {
                if let problem {
                    Section { Text(problem).foregroundStyle(.secondary) }
                }
                Section {
                    TextField("https://…", text: $address)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .submitLabel(.go)
                        .onSubmit { connect(address) }
                    Button("Paste link") {
                        if let s = UIPasteboard.general.string { address = s }
                    }
                } header: {
                    Text("Server")
                } footer: {
                    Text("Use the same link the audience opens. Shake the phone any time to come back here.")
                }
            }
            .navigationTitle("Roomie server")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel", action: cancel) }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Connect") { connect(address) }.bold()
                }
            }
        }
    }
}
