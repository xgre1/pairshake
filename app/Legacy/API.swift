import Foundation

struct Person: Codable, Identifiable, Hashable {
    let id: String
    let name: String
    let role: String
    let color: String
    let building: String
    let needs: String
    let offers: String
    let spot: String
    let line: String
    let socials: [String: String]
    var seed: Bool? = nil          // a demo attendee played by Emma (no phone to find)

    var initials: String {
        name.split(separator: " ").prefix(2).compactMap { $0.first }.map(String.init).joined()
    }
    var firstName: String { name.split(separator: " ").first.map(String.init) ?? name }
}

struct RareOverlap: Codable, Hashable {
    let text: String
    let opener: String
}

/// What two people share (rare things first: they bond people most), what each could give the other,
/// and three questions that go from light to deep.
struct Overlap: Codable, Hashable {
    let rare: [RareOverlap]
    let you_only: [String]
    let them_only: [String]
    let give: String
    let get: String
    let ladder: [String]
}

struct SuggestResp: Codable { let ideas: [String] }

/// An introduction Emma made: who, why (her note), and what the two of you share.
struct Mission: Codable, Identifiable, Hashable {
    let id: String
    let intro: String
    let overlap: Overlap
    let person: Person
    let outcome: String?
}

/// One conversation between your agent and someone else's agent while Emma searches.
struct Talk: Codable, Identifiable, Hashable {
    let person: Person
    let ask: String
    let reply: String
    let fit: Int
    var id: String { person.id }
}
struct ScanResp: Codable { let talks: [Talk]; let total: Int }

struct StartResp: Codable { let id: String; let say: String }
struct TurnResp: Codable { let say: String; let done: Bool }
struct MatchResp: Codable { let say: String; let me: Person; let mission: Mission }
struct SayResp: Codable { let say: String }
struct InboxResp: Codable { let missions: [Mission] }

enum API {
    static let defaultServer = "http://172.20.1.88:8780"

    static var baseString: String {
        get { UserDefaults.standard.string(forKey: "server") ?? defaultServer }
        set { UserDefaults.standard.set(newValue, forKey: "server") }
    }
    static var base: URL { URL(string: baseString) ?? URL(string: defaultServer)! }

    static func post<T: Decodable>(_ path: String, _ body: [String: Any], timeout: TimeInterval = 90) async throws -> T {
        let data = try await raw(path, body, timeout: timeout)
        return try JSONDecoder().decode(T.self, from: data)
    }

    static func get<T: Decodable>(_ path: String, _ query: [String: String]) async throws -> T {
        var c = URLComponents(url: base.appendingPathComponent(path), resolvingAgainstBaseURL: false)!
        c.queryItems = query.map { URLQueryItem(name: $0.key, value: $0.value) }
        var r = URLRequest(url: c.url!)
        r.timeoutInterval = 10
        let (d, resp) = try await URLSession.shared.data(for: r)
        try check(resp)
        return try JSONDecoder().decode(T.self, from: d)
    }

    /// Emma's voice for a line of text, as WAV.
    static func speech(_ text: String) async throws -> Data {
        try await raw("speak", ["text": text], timeout: 30)
    }

    private static func raw(_ path: String, _ body: [String: Any], timeout: TimeInterval) async throws -> Data {
        var r = URLRequest(url: base.appendingPathComponent(path))
        r.httpMethod = "POST"
        r.setValue("application/json", forHTTPHeaderField: "Content-Type")
        r.httpBody = try JSONSerialization.data(withJSONObject: body)
        r.timeoutInterval = timeout
        let (d, resp) = try await URLSession.shared.data(for: r)
        try check(resp)
        return d
    }

    private static func check(_ resp: URLResponse) throws {
        if let h = resp as? HTTPURLResponse, h.statusCode >= 400 { throw URLError(.badServerResponse) }
    }
}

enum Social: String, CaseIterable {
    case x, instagram, linkedin, github

    var label: String {
        switch self {
        case .x: return "X"
        case .instagram: return "Instagram"
        case .linkedin: return "LinkedIn"
        case .github: return "GitHub"
        }
    }
    var badge: String {
        switch self {
        case .x: return "X"
        case .instagram: return "IG"
        case .linkedin: return "in"
        case .github: return "GH"
        }
    }
    func url(_ handle: String) -> URL? {
        let h = handle.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: "@", with: "")
        switch self {
        case .x: return URL(string: "https://x.com/\(h)")
        case .instagram: return URL(string: "https://instagram.com/\(h)")
        case .linkedin: return URL(string: "https://www.linkedin.com/in/\(h)")
        case .github: return URL(string: "https://github.com/\(h)")
        }
    }
}
