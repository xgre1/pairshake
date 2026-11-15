import SwiftUI

@main
struct PairShakeApp: App {
    @StateObject private var flow = Flow()
    var body: some Scene {
        WindowGroup {
            let args = ProcessInfo.processInfo.arguments
            if args.contains("-demoFind") || args.contains("-demoFindAligned") {
                FindPreviewHost(aligned: args.contains("-demoFindAligned"))
            } else {
                RootView()
                    .environmentObject(flow)
                    .environmentObject(flow.voice)
            }
        }
    }
}

/// Emma's own words are set in New York; everything else is SF.
extension Font {
    static func emma(_ size: CGFloat) -> Font { .system(size: size, weight: .regular, design: .serif) }
}

struct RootView: View {
    @EnvironmentObject var flow: Flow

    var body: some View {
        ZStack(alignment: .top) {
            Color(.systemBackground).ignoresSafeArea()
            Group {
                switch flow.stage {
                case .welcome: WelcomeView()
                case .interview: InterviewView()
                case .socials: SocialsView()
                case .matching: MatchingView()
                case .match: IntroductionView()
                case .failed(let msg): FailedView(message: msg)
                }
            }
            .transition(.opacity)
            if let m = flow.incoming {
                IncomingBanner(mission: m)
                    .padding(.horizontal, 12)
                    .transition(.move(edge: .top).combined(with: .opacity))
            }
        }
        .animation(.smooth(duration: 0.5), value: flow.stage)
        .animation(.spring(response: 0.45, dampingFraction: 0.8), value: flow.incoming)
        .fullScreenCover(item: $flow.openMission) { RoomView(mission: $0) }
        .task {
            let args = ProcessInfo.processInfo.arguments
            if args.contains("-demoRoom") { flow.rehearse() }
            if args.contains("-demoIntro") || args.contains("-demoGame") {
                flow.loadSample(openGame: args.contains("-demoGame"))
            }
        }
    }
}

// MARK: - Welcome

struct WelcomeView: View {
    @EnvironmentObject var flow: Flow
    @State private var settings = false

    var body: some View {
        VStack(spacing: 0) {
            Spacer()
            Orb(size: 210)
                .onLongPressGesture { settings = true }
            Text("Hi, I'm Emma.")
                .font(.emma(36))
                .padding(.top, 52)
            Text("Tell me what you're building, and I'll introduce you to someone here.")
                .font(.body)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 44)
                .padding(.top, 10)
            Spacer()
            PrimaryButton(title: "Start talking") { flow.begin() }
                .padding(.horizontal, 24)
                .padding(.bottom, 12)
        }
        .sheet(isPresented: $settings) { ServerSettings() }
    }
}

struct PrimaryButton: View {
    let title: String
    var subtitle: String? = nil
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            VStack(spacing: 2) {
                Text(title).font(.headline)
                if let subtitle { Text(subtitle).font(.footnote).opacity(0.6) }
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, subtitle == nil ? 17 : 12)
            .background(Color.primary, in: Capsule())
            .foregroundStyle(Color(.systemBackground))
        }
        .buttonStyle(.plain)
        .sensoryFeedback(.impact(weight: .light), trigger: title)
    }
}

struct ServerSettings: View {
    @Environment(\.dismiss) var dismiss
    @State private var server = API.baseString
    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("http://192.168.1.10:8780", text: $server)
                        .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                } header: {
                    Text("Server")
                } footer: {
                    Text("The Mac running server.py, on the same Wi-Fi.")
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { Button("Save") { API.baseString = server; dismiss() }.bold() }
        }
        .presentationDetents([.medium])
    }
}

// MARK: - Conversation

struct InterviewView: View {
    @EnvironmentObject var flow: Flow
    @EnvironmentObject var voice: VoiceIO

    private var hint: String {
        switch flow.mode {
        case .listening: return "Tap Emma when you're done"
        case .speaking: return "Tap to skip"
        case .thinking: return " "
        case .idle: return " "
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(flow.emmaLine)
                .font(.emma(30))
                .lineSpacing(2)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 28)
                .padding(.top, 36)
                .contentTransition(.opacity)
                .animation(.easeOut(duration: 0.35), value: flow.emmaLine)

            Spacer()
            Orb(mode: flow.mode, level: voice.level, size: 180)
                .frame(maxWidth: .infinity)
                .contentShape(Circle())
                .onTapGesture { flow.doneTalking() }
            Spacer()

            Text(flow.mode == .listening ? voice.heard : "")
                .font(.title3)
                .foregroundStyle(.secondary)
                .lineLimit(3, reservesSpace: true)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 28)
            Text(hint)
                .font(.footnote)
                .foregroundStyle(.tertiary)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 20)
        }
    }
}

// MARK: - Handles

struct SocialsView: View {
    @EnvironmentObject var flow: Flow
    @EnvironmentObject var voice: VoiceIO
    @AppStorage("h.x") var x = ""
    @AppStorage("h.instagram") var ig = ""
    @AppStorage("h.linkedin") var li = ""
    @AppStorage("h.github") var gh = ""

    var body: some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: 18) {
                    Orb(mode: flow.mode, level: voice.level, size: 56)
                    Text("Where can they follow you?").font(.emma(30))
                }
                .padding(.top, 24)
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets(top: 0, leading: 4, bottom: 8, trailing: 4))
            }
            Section {
                field(.x, $x)
                field(.instagram, $ig)
                field(.linkedin, $li)
                field(.github, $gh)
            } footer: {
                Text("Optional. These show on your introduction.")
            }
        }
        .scrollDismissesKeyboard(.interactively)
        .safeAreaInset(edge: .bottom) {
            PrimaryButton(title: "Introduce me") {
                flow.findMatch(socials: ["x": x, "instagram": ig, "linkedin": li, "github": gh])
            }
            .padding(.horizontal, 24)
            .padding(.bottom, 8)
        }
    }

    func field(_ s: Social, _ text: Binding<String>) -> some View {
        HStack(spacing: 14) {
            SocialGlyph(social: s)
            TextField(s.label, text: text)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .textContentType(.username)
        }
    }
}

struct SocialGlyph: View {
    let social: Social
    var body: some View {
        Text(social.badge)
            .font(.system(size: 12, weight: .bold, design: .rounded))
            .frame(width: 30, height: 30)
            .background(Color(.tertiarySystemFill), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
    }
}

// MARK: - Introduction

struct IntroductionView: View {
    @EnvironmentObject var flow: Flow
    @State private var revealed = false

    var body: some View {
        if let r = flow.result {
            let p = r.mission.person
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    hero(me: r.me, them: p)

                    VStack(alignment: .leading, spacing: 28) {
                        VStack(alignment: .leading, spacing: 6) {
                            Text("Meet \(p.firstName).").font(.emma(40))
                            Text(p.role).foregroundStyle(.secondary)
                        }

                        Text(r.mission.intro)
                            .font(.emma(20))
                            .lineSpacing(4)
                            .foregroundStyle(.primary.opacity(0.9))

                        Group {
                            InsetGroup {
                                Fact(label: "Building", text: p.building)
                                Fact(label: "Looking for", text: p.needs)
                                Fact(label: "Good at", text: p.offers)
                            }
                            if !p.socials.isEmpty {
                                InsetGroup { SocialRows(person: p) }
                            }
                        }

                        Button("Start over") { flow.restart() }
                            .font(.footnote)
                            .foregroundStyle(.tertiary)
                            .frame(maxWidth: .infinity)
                            .padding(.top, 8)
                    }
                    .padding(.horizontal, 24)
                    .padding(.top, 28)
                    .padding(.bottom, 120)
                    .opacity(revealed ? 1 : 0)
                    .offset(y: revealed ? 0 : 24)
                }
            }
            .ignoresSafeArea(edges: .top)
            .safeAreaInset(edge: .bottom) {
                PrimaryButton(title: "Talk with \(p.firstName)", subtitle: "See what you share, then talk") {
                    flow.openMission = r.mission
                }
                .padding(.horizontal, 24)
                .padding(.top, 28)
                .padding(.bottom, 8)
                .background(Fade())
                .opacity(revealed ? 1 : 0)
            }
            .onAppear { withAnimation(.smooth(duration: 0.8).delay(0.25)) { revealed = true } }
        }
    }

    /// Two colours meeting, two faces leaning in: the signature of every introduction.
    func hero(me: Person, them: Person) -> some View {
        ZStack {
            PairMesh(a: Color(hex: me.color), b: Color(hex: them.color))
            HStack(spacing: -18) {
                Avatar(person: me, size: 92)
                    .overlay(Circle().stroke(.white, lineWidth: 3))
                    .offset(x: revealed ? 0 : -60)
                Avatar(person: them, size: 92)
                    .overlay(Circle().stroke(.white, lineWidth: 3))
                    .offset(x: revealed ? 0 : 60)
            }
            .shadow(color: .black.opacity(0.12), radius: 16, y: 8)
            .padding(.top, 50)
        }
        .frame(height: 330)
        .mask(LinearGradient(stops: [.init(color: .black, location: 0.7), .init(color: .clear, location: 1)],
                             startPoint: .top, endPoint: .bottom))
    }
}

/// Lets content scroll softly under a pinned bottom button.
struct Fade: View {
    var body: some View {
        LinearGradient(stops: [.init(color: Color(.systemBackground).opacity(0), location: 0),
                               .init(color: Color(.systemBackground), location: 0.45)],
                       startPoint: .top, endPoint: .bottom)
            .ignoresSafeArea()
    }
}

struct InsetGroup<Content: View>: View {
    @ViewBuilder var content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Group(subviews: content) { subviews in
                ForEach(Array(subviews.enumerated()), id: \.offset) { i, v in
                    if i > 0 { Divider().padding(.leading, 16) }
                    v.padding(.horizontal, 16).padding(.vertical, 13)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 22, style: .continuous))
    }
}

struct Fact: View {
    let label: String
    let text: String
    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label).font(.footnote).foregroundStyle(.secondary)
            Text(text).font(.body)
        }
    }
}

struct SocialRows: View {
    let person: Person
    @Environment(\.openURL) var openURL
    @AppStorage("following") private var followingRaw = ""

    var body: some View {
        ForEach(Social.allCases.filter { !(person.socials[$0.rawValue] ?? "").isEmpty }, id: \.self) { s in
            let h = person.socials[s.rawValue] ?? ""
            let key = "\(s.rawValue):\(h)"
            let on = followingRaw.split(separator: ",").contains(Substring(key))
            HStack(spacing: 14) {
                SocialGlyph(social: s)
                VStack(alignment: .leading, spacing: 1) {
                    Text("@\(h)").font(.body)
                    Text(s.label).font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                Button {
                    if !on { followingRaw += (followingRaw.isEmpty ? "" : ",") + key }
                    if let u = s.url(h) { openURL(u) }
                } label: {
                    Label(on ? "Following" : "Follow", systemImage: on ? "checkmark" : "plus")
                        .font(.subheadline.weight(.semibold))
                        .labelStyle(.titleAndIcon)
                }
                .buttonStyle(.bordered)
                .buttonBorderShape(.capsule)
                .tint(on ? .secondary : .primary)
                .sensoryFeedback(.success, trigger: on)
            }
        }
    }
}

struct IncomingBanner: View {
    let mission: Mission
    @EnvironmentObject var flow: Flow
    var body: some View {
        Button {
            flow.openMission = mission
            flow.incoming = nil
        } label: {
            HStack(spacing: 12) {
                Avatar(person: mission.person, size: 40)
                VStack(alignment: .leading, spacing: 1) {
                    Text("Emma introduced you to \(mission.person.firstName)").font(.subheadline.weight(.semibold))
                    Text("Tap to see what you share").font(.footnote).foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
            }
            .padding(12)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
            .shadow(color: .black.opacity(0.12), radius: 20, y: 8)
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Failure

struct FailedView: View {
    let message: String
    @EnvironmentObject var flow: Flow
    @State private var settings = false
    var body: some View {
        VStack(spacing: 16) {
            Spacer()
            Text(message).font(.title3).multilineTextAlignment(.center).padding(.horizontal, 32)
            Button("Change server") { settings = true }.buttonStyle(.bordered).buttonBorderShape(.capsule)
            Button("Try again") { flow.restart() }.foregroundStyle(.secondary)
            Spacer()
        }
        .sheet(isPresented: $settings) { ServerSettings() }
    }
}
