import SwiftUI

/// After an introduction: see what you share, talk (Emma suggests follow-up questions), then each
/// decides whether to meet. Built on what actually gets strangers talking:
/// rare shared things bond people more than common ones (Alves 2018); people who ask follow-up
/// questions are liked more (Huang et al. 2017); questions that go from light to deep build closeness
/// (Aron et al. 1997); and people underestimate how much the other person liked them (Boothby et al. 2018).
struct RoomView: View {
    let mission: Mission
    @EnvironmentObject var flow: Flow
    @Environment(\.dismiss) var dismiss
    @StateObject private var room = RoomClient()
    @StateObject private var finder = Finder()
    @State private var chatting = false
    @State private var draft = ""
    @State private var asking = false
    @State private var finding = false

    private var them: Person { mission.person }
    private var me: Person? { flow.result?.me }

    var body: some View {
        ZStack {
            Color(.systemBackground).ignoresSafeArea()
            VStack(spacing: 0) {
                topBar
                if chatting {
                    ChatPane(room: room, mission: mission, userId: flow.userId, draft: $draft)
                        .transition(.move(edge: .trailing).combined(with: .opacity))
                } else {
                    OverlapView(overlap: mission.overlap, me: me, them: them) { opener in
                        draft = opener
                        chatting = true
                    }
                    .transition(.opacity)
                }
            }
            if let yes = room.meet {
                Outcome(yes: yes, person: them, me: me, finder: finder,
                        find: { finding = true },
                        done: { finder.stop(); room.close(); dismiss() })
                    .transition(.opacity.combined(with: .scale(scale: 1.04)))
            }
        }
        .animation(.smooth(duration: 0.45), value: chatting)
        .animation(.smooth(duration: 0.5), value: room.meet)
        .sheet(isPresented: $asking) {
            MeetSheet(person: them, me: me) { yes in
                asking = false
                room.decide(yes)
            }
        }
        .onAppear {
            room.onMeet = { yes in
                UINotificationFeedbackGenerator().notificationOccurred(yes ? .success : .warning)
                if yes { Task { await flow.emmaSays("You both said yes. Follow the arrow to \(them.firstName).") } }
            }
            room.connect(mission: mission.id, user: flow.userId)
        }
        .onDisappear { room.close(); finder.stop() }
        .onChange(of: room.peerToken) { _, t in if let t { finder.received(t) } }
        .onChange(of: room.meet) { _, yes in if yes == true { startFinding() } }
        .fullScreenCover(isPresented: $finding) {
            FindView(person: them, finder: finder) { finding = false }
        }
    }

    private func startFinding() {
        finder.sendToken = { [weak room] in room?.sendNI($0) }
        finder.start(peer: them.seed != true, room: mission.id)
        if let t = room.peerToken { finder.received(t) }
    }

    private var topBar: some View {
        HStack(spacing: 10) {
            if chatting {
                Button { chatting = false } label: {
                    Image(systemName: "chevron.left").font(.body.weight(.semibold))
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
            }
            Avatar(person: them, size: 32)
            VStack(alignment: .leading, spacing: 0) {
                Text(them.firstName).font(.subheadline.weight(.semibold))
                HStack(spacing: 4) {
                    Circle().fill(room.otherOnline ? Color.green : Color.secondary.opacity(0.4)).frame(width: 6, height: 6)
                    Text(room.typing ? "typing…" : (room.otherOnline ? "Here now" : "Not here yet"))
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            Spacer()
            if chatting && room.meet == nil {
                Button { asking = true } label: {
                    Text(room.decided ? "Waiting…" : "Meet?")
                        .font(.subheadline.weight(.semibold))
                        .padding(.horizontal, 14).padding(.vertical, 7)
                        .background(Color.primary, in: Capsule())
                        .foregroundStyle(Color(.systemBackground))
                }
                .buttonStyle(.plain)
                .disabled(room.decided)
                .opacity(room.decided ? 0.4 : 1)
            }
            Button { flow.voice.stopSpeaking(); room.close(); dismiss() } label: {
                Image(systemName: "xmark").font(.footnote.weight(.bold))
                    .frame(width: 30, height: 30)
                    .background(.thinMaterial, in: Circle())
            }
            .buttonStyle(.plain)
            .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 10)
    }
}

// MARK: - What you share

struct OverlapView: View {
    let overlap: Overlap
    let me: Person?
    let them: Person
    let open: (String) -> Void
    @State private var together = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 26) {
                Text("What you share").font(.emma(34))

                venn
                    .frame(height: 220)
                    .frame(maxWidth: .infinity)

                VStack(alignment: .leading, spacing: 10) {
                    Text("Rare things in common").font(.footnote.weight(.semibold)).foregroundStyle(.secondary)
                    ForEach(Array(overlap.rare.enumerated()), id: \.offset) { i, r in
                        Button { open(r.opener) } label: {
                            VStack(alignment: .leading, spacing: 8) {
                                Text(r.text).font(.emma(20)).foregroundStyle(.primary)
                                HStack(alignment: .top, spacing: 6) {
                                    Image(systemName: "arrow.turn.down.right").font(.caption)
                                    Text("“\(r.opener)”").font(.subheadline)
                                }
                                .foregroundStyle(.secondary)
                            }
                            .multilineTextAlignment(.leading)
                            .padding(16)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                        }
                        .buttonStyle(.plain)
                        .opacity(together ? 1 : 0)
                        .offset(y: together ? 0 : 16)
                        .animation(.smooth(duration: 0.6).delay(0.5 + Double(i) * 0.12), value: together)
                    }
                }

                InsetGroup {
                    Exchange(icon: "arrow.right", label: "You could give \(them.firstName)", text: overlap.give)
                    Exchange(icon: "arrow.left", label: "\(them.firstName) could give you", text: overlap.get)
                }
                .opacity(together ? 1 : 0)
                .animation(.smooth(duration: 0.6).delay(0.8), value: together)

                Spacer().frame(height: 90)
            }
            .padding(.horizontal, 24)
            .padding(.top, 8)
        }
        .safeAreaInset(edge: .bottom) {
            PrimaryButton(title: "Message \(them.firstName)", subtitle: "Or tap one of the openers above") { open("") }
                .padding(.horizontal, 24)
                .padding(.top, 28)
                .padding(.bottom, 8)
                .background(Fade())
        }
        .onAppear { withAnimation(.spring(response: 0.9, dampingFraction: 0.75).delay(0.15)) { together = true } }
    }

    /// Two circles that slide together; the lens is what you share.
    private var venn: some View {
        let d: CGFloat = 196
        let gap: CGFloat = together ? 62 : 132
        return ZStack {
            Circle()
                .fill(Color(hex: me?.color ?? "#8FD3FF").opacity(0.32))
                .frame(width: d, height: d)
                .offset(x: -gap)
            Circle()
                .fill(Color(hex: them.color).opacity(0.32))
                .frame(width: d, height: d)
                .offset(x: gap)

            lobe(title: "You", tags: overlap.you_only).offset(x: -gap - 42)
            lobe(title: them.firstName, tags: overlap.them_only).offset(x: gap + 42)

            VStack(spacing: 0) {
                Text("\(overlap.rare.count)").font(.emma(44))
                Text("in\ncommon").font(.caption2.weight(.semibold)).multilineTextAlignment(.center).foregroundStyle(.secondary)
            }
            .opacity(together ? 1 : 0)
            .scaleEffect(together ? 1 : 0.6)
        }
    }

    private func lobe(title: String, tags: [String]) -> some View {
        VStack(spacing: 6) {
            Text(title).font(.caption.weight(.bold))
            ForEach(tags.prefix(2), id: \.self) { t in
                Text(t).font(.caption2).multilineTextAlignment(.center).foregroundStyle(.secondary)
            }
        }
        .frame(width: 92)
    }
}

struct Exchange: View {
    let icon: String
    let label: String
    let text: String
    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: icon).font(.footnote.weight(.bold)).foregroundStyle(.secondary).frame(width: 18).padding(.top, 2)
            VStack(alignment: .leading, spacing: 2) {
                Text(label).font(.footnote).foregroundStyle(.secondary)
                Text(text).font(.body)
            }
        }
    }
}

// MARK: - Chat

struct ChatPane: View {
    @ObservedObject var room: RoomClient
    let mission: Mission
    let userId: String
    @Binding var draft: String
    @FocusState private var focused: Bool
    @State private var ideas: [String] = []
    @State private var loadingIdeas = false
    @State private var rung = 0

    private var first: String { mission.person.firstName }

    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 6) {
                        if room.chat.isEmpty { emptyState }
                        ForEach(room.chat) { m in Bubble(text: m.text, mine: m.from == room.you) }
                        if room.typing { Bubble(text: "···", mine: false).opacity(0.6) }
                        if room.decided && room.meet == nil {
                            Text("You said yes. If \(first) does too, Emma shows you where to find each other.")
                                .font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center)
                                .padding(.top, 12).padding(.horizontal, 20)
                        }
                        Color.clear.frame(height: 1).id("end")
                    }
                    .padding(.horizontal, 16)
                    .padding(.top, 8)
                }
                .scrollDismissesKeyboard(.interactively)
                .onChange(of: room.chat.count) { withAnimation { proxy.scrollTo("end") } }
                .onChange(of: room.typing) { withAnimation { proxy.scrollTo("end") } }
            }
            suggestions
            composer
        }
        .onAppear { if !draft.isEmpty { focused = true } }
        .onChange(of: room.chat.count) { _, _ in
            if room.chat.last?.from == room.them { fetchIdeas() } else { ideas = [] }
        }
    }

    private var emptyState: some View {
        VStack(spacing: 10) {
            Text("Start with something you share").font(.footnote.weight(.semibold)).foregroundStyle(.secondary)
                .padding(.top, 24)
            ForEach(mission.overlap.rare, id: \.self) { r in
                Button { draft = r.opener; focused = true } label: {
                    Text(r.opener).font(.subheadline).multilineTextAlignment(.leading)
                        .padding(.horizontal, 14).padding(.vertical, 10)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.bottom, 12)
    }

    /// Follow-up ideas after their message, and a deeper question once you've warmed up.
    @ViewBuilder private var suggestions: some View {
        let deeper = room.chat.count >= 4 && rung < mission.overlap.ladder.count
        if !ideas.isEmpty || loadingIdeas || deeper {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 6) {
                    Orb(size: 14)
                    Text(loadingIdeas ? "Thinking of a follow-up…" : "Ask a follow-up")
                        .font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                }
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(ideas, id: \.self) { idea in
                            chip(idea) { draft = idea; focused = true }
                        }
                        if deeper {
                            chip("Go deeper: \(mission.overlap.ladder[rung])", icon: "arrow.down.right") {
                                draft = mission.overlap.ladder[rung]
                                rung += 1
                                focused = true
                            }
                        }
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
            .transition(.move(edge: .bottom).combined(with: .opacity))
        }
    }

    private func chip(_ text: String, icon: String? = nil, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 6) {
                if let icon { Image(systemName: icon).font(.caption.weight(.bold)) }
                Text(text).font(.subheadline).lineLimit(2).multilineTextAlignment(.leading)
            }
            .padding(.horizontal, 12).padding(.vertical, 8)
            .frame(maxWidth: 260, alignment: .leading)
            .background(Color(.tertiarySystemFill), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
        .buttonStyle(.plain)
    }

    private var composer: some View {
        HStack(spacing: 10) {
            // Single-line on purpose: a vertical-axis TextField here got SwiftUI stuck in a layout loop (100% CPU).
            TextField("Message", text: $draft)
                .focused($focused)
                .submitLabel(.send)
                .onSubmit(send)
                .padding(.horizontal, 16).padding(.vertical, 10)
                .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 20, style: .continuous))
            Button(action: send) {
                Image(systemName: "arrow.up.circle.fill").font(.system(size: 34))
            }
            .disabled(draft.trimmingCharacters(in: .whitespaces).isEmpty)
            .tint(.primary)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .background(.bar)
    }

    private func send() {
        room.say(draft)
        draft = ""
        ideas = []
    }

    private func fetchIdeas() {
        loadingIdeas = true
        ideas = []
        Task {
            let r: SuggestResp? = try? await API.post("suggest", ["id": userId, "mission": mission.id], timeout: 30)
            withAnimation(.smooth) {
                ideas = r?.ideas ?? []
                loadingIdeas = false
            }
        }
    }
}

struct Bubble: View {
    let text: String
    let mine: Bool
    var body: some View {
        HStack {
            if mine { Spacer(minLength: 60) }
            Text(text)
                .padding(.horizontal, 14).padding(.vertical, 9)
                .background(mine ? Color.primary : Color(.secondarySystemBackground),
                            in: RoundedRectangle(cornerRadius: 19, style: .continuous))
                .foregroundStyle(mine ? Color(.systemBackground) : Color.primary)
            if !mine { Spacer(minLength: 60) }
        }
        .transition(.move(edge: .bottom).combined(with: .opacity))
    }
}

// MARK: - Deciding

struct MeetSheet: View {
    let person: Person
    let me: Person?
    let decide: (Bool) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: -12) {
                if let me { Avatar(person: me, size: 44).overlay(Circle().stroke(Color(.systemBackground), lineWidth: 2)) }
                Avatar(person: person, size: 44).overlay(Circle().stroke(Color(.systemBackground), lineWidth: 2))
            }
            Text("Meet \(person.firstName) in person?").font(.emma(30))
            Text("If you both say yes, Emma shows you where to find each other. If not, nobody is told.")
                .foregroundStyle(.secondary)
            Text("People usually underestimate how much the other person enjoyed talking to them.")
                .font(.footnote).foregroundStyle(.tertiary)
            Spacer(minLength: 0)
            PrimaryButton(title: "Yes, let's meet") { decide(true) }
            Button("Not now") { decide(false) }
                .frame(maxWidth: .infinity)
                .foregroundStyle(.secondary)
        }
        .padding(24)
        .presentationDetents([.height(420)])
        .presentationCornerRadius(32)
    }
}

struct Outcome: View {
    let yes: Bool
    let person: Person
    let me: Person?
    @ObservedObject var finder: Finder
    let find: () -> Void
    let done: () -> Void

    var body: some View {
        ZStack {
            Color(.systemBackground).ignoresSafeArea()
            if yes {
                PairMesh(a: Color(hex: me?.color ?? "#B9A7FF"), b: Color(hex: person.color))
                    .opacity(0.5).ignoresSafeArea()
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    Spacer().frame(height: 40)
                    if yes {
                        HStack(spacing: -18) {
                            if let me { Avatar(person: me, size: 84).overlay(Circle().stroke(.white, lineWidth: 3)) }
                            Avatar(person: person, size: 84).overlay(Circle().stroke(.white, lineWidth: 3))
                        }
                        Text("You both said yes.").font(.emma(40))
                        Button(action: find) {
                            VStack(alignment: .leading, spacing: 14) {
                                HStack {
                                    MiniFinder(finder: finder)
                                    Spacer()
                                    Image(systemName: "chevron.right").foregroundStyle(.tertiary)
                                }
                                Text(person.spot).font(.body).foregroundStyle(.secondary)
                            }
                            .padding(18)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
                        }
                        .buttonStyle(.plain)
                        if !person.socials.isEmpty {
                            InsetGroup { SocialRows(person: person) }
                        }
                    } else {
                        Text("Not this time.").font(.emma(40))
                        Text("That's fine. Emma will keep looking for your person.").font(.title3).foregroundStyle(.secondary)
                    }
                }
                .padding(.horizontal, 24)
            }
            .safeAreaInset(edge: .bottom) {
                VStack(spacing: 4) {
                    if yes {
                        PrimaryButton(title: "Find \(person.firstName)", action: find)
                        Button("Done", action: done).foregroundStyle(.secondary).padding(.vertical, 10)
                    } else {
                        PrimaryButton(title: "Done", action: done)
                    }
                }
                .padding(.horizontal, 24).padding(.bottom, 8)
            }
        }
    }
}
