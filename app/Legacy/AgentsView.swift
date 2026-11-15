import SwiftUI

/// While Emma searches: your agent in the middle, everyone else's agent around it. Lines carry the
/// messages; each agent's real reply lands in the feed below; weak fits fade, strong ones glow; at the
/// end every line but one goes quiet and your person comes forward.
struct MatchingView: View {
    @EnvironmentObject var flow: Flow
    @State private var revealed: [Talk] = []
    @State private var converging = false
    @State private var started = Date()

    private var slots: Int { max(flow.scanTotal, revealed.count, 8) }
    private var shortlisted: Int { revealed.filter { $0.fit >= 35 }.count }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 6) {
                Text(converging ? "Found your person." : "Your agent is talking to everyone's agents.")
                    .font(.emma(26))
                    .contentTransition(.opacity)
                Text(converging ? "Out of \(revealed.count) conversations, one stood out."
                                : "\(revealed.count) of \(slots) agents answered · \(shortlisted) shortlisted")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .contentTransition(.numericText())
            }
            .padding(.horizontal, 24)
            .padding(.top, 20)
            .animation(.smooth, value: converging)

            graph.frame(height: 330)

            VStack(spacing: 8) {
                ForEach(revealed.suffix(3).reversed()) { t in
                    TalkRow(talk: t, picked: converging && t.id == flow.chosenId)
                        .transition(.asymmetric(insertion: .move(edge: .top).combined(with: .opacity),
                                                removal: .opacity))
                }
            }
            .padding(.horizontal, 20)
            .animation(.spring(response: 0.5, dampingFraction: 0.85), value: revealed.count)
            .animation(.smooth, value: converging)
            Spacer(minLength: 0)
        }
        .task { await drive() }
    }

    // MARK: pacing

    /// Reveals replies one at a time as they arrive, then converges once the match is known.
    private func drive() async {
        started = Date()
        while !Task.isCancelled {
            if !converging, let next = flow.talks.first(where: { t in !revealed.contains { $0.id == t.id } }) {
                withAnimation(.spring(response: 0.5, dampingFraction: 0.8)) { revealed.append(next) }
                try? await Task.sleep(for: .seconds(0.55))
                continue
            }
            let elapsed = Date().timeIntervalSince(started)
            let allIn = flow.scanTotal > 0 && revealed.count >= flow.scanTotal
            if let chosen = flow.chosenId, !converging,
               allIn || elapsed > 16 || (flow.talks.isEmpty && elapsed > 5) {
                if !revealed.contains(where: { $0.id == chosen }), let p = flow.result?.mission.person {
                    withAnimation { revealed.append(Talk(person: p, ask: "", reply: "", fit: 90)) }
                    try? await Task.sleep(for: .seconds(0.5))
                }
                withAnimation(.smooth(duration: 1.1)) { converging = true }
                try? await Task.sleep(for: .seconds(2.2))
                flow.revealMatch()
                return
            }
            try? await Task.sleep(for: .seconds(0.15))
        }
    }

    // MARK: the network

    private func position(_ i: Int, _ n: Int, _ c: CGPoint, _ r: CGFloat) -> CGPoint {
        let a = Double(i) / Double(n) * 2 * .pi - .pi / 2
        let wobble = (i % 2 == 0 ? 1.0 : 0.86)          // two rings, so it reads as a crowd, not a clock
        return CGPoint(x: c.x + CGFloat(cos(a)) * r * wobble, y: c.y + CGFloat(sin(a)) * r * wobble)
    }

    private func isChosen(_ t: Talk) -> Bool { converging && t.id == flow.chosenId }

    private var graph: some View {
        GeometryReader { g in
            let c = CGPoint(x: g.size.width / 2, y: g.size.height / 2)
            let r = min(g.size.width, g.size.height) * 0.42
            let n = slots
            ZStack {
                TimelineView(.animation) { tl in
                    let t = tl.date.timeIntervalSinceReferenceDate
                    Canvas { ctx, _ in
                        for i in 0..<n {
                            let p = position(i, n, c, r)
                            var line = Path()
                            line.move(to: c)
                            line.addLine(to: p)
                            let talk = i < revealed.count ? revealed[i] : nil
                            if let talk {
                                let chosen = isChosen(talk)
                                let op = converging ? (chosen ? 0.95 : 0.04) : (talk.fit >= 60 ? 0.85 : talk.fit >= 35 ? 0.4 : 0.15)
                                ctx.stroke(line, with: .color(Color(hex: talk.person.color).opacity(op)),
                                           lineWidth: chosen ? 3.5 : (talk.fit >= 60 ? 2 : 1.2))
                                if chosen {
                                    for k in 0..<3 {          // a steady two-way stream to your person
                                        let ph = (t * 0.9 + Double(k) / 3).truncatingRemainder(dividingBy: 1)
                                        dot(&ctx, c, p, ph, Color(hex: talk.person.color), 4)
                                        dot(&ctx, p, c, ph, .iris, 3)
                                    }
                                } else if !converging && i == revealed.count - 1 {
                                    let ph = (t * 1.6).truncatingRemainder(dividingBy: 1)
                                    dot(&ctx, p, c, ph, Color(hex: talk.person.color), 3.5)   // the reply coming back
                                }
                            } else if !converging {
                                ctx.stroke(line, with: .color(.secondary.opacity(0.18)),
                                           style: StrokeStyle(lineWidth: 1, dash: [2, 5]))
                                let ph = (t * 0.55 + Double(i) * 0.37).truncatingRemainder(dividingBy: 1)
                                dot(&ctx, c, p, ph, .iris, 2.5)                              // your agent asking
                            }
                        }
                    }
                }

                ForEach(revealed.count..<max(revealed.count, n), id: \.self) { i in
                    GhostAgent(delay: Double(i) * 0.13)
                        .position(position(i, n, c, r))
                        .opacity(converging ? 0 : 1)
                }

                ForEach(Array(revealed.enumerated()), id: \.element.id) { i, talk in
                    let chosen = isChosen(talk)
                    Avatar(person: talk.person, size: 38)
                        .overlay(Circle().stroke(chosen ? Color.white : .clear, lineWidth: 3))
                        .background(Circle().fill(Color(hex: talk.person.color).opacity(chosen ? 0.35 : 0)).scaleEffect(1.7).blur(radius: 10))
                        .scaleEffect(chosen ? 1.55 : 1)
                        .opacity(converging ? (chosen ? 1 : 0.15) : (talk.fit >= 35 ? 1 : 0.45))
                        .saturation(!converging && talk.fit < 35 ? 0.2 : 1)
                        .position(position(i, n, c, r))
                        .transition(.scale(scale: 0.3).combined(with: .opacity))
                }

                Orb(mode: .thinking, size: 66).position(c)
                Text("Your agent").font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
                    .position(x: c.x, y: c.y + 48)
            }
        }
        .padding(.horizontal, 12)
    }

    private func dot(_ ctx: inout GraphicsContext, _ a: CGPoint, _ b: CGPoint, _ ph: Double, _ color: Color, _ size: CGFloat) {
        let x = a.x + (b.x - a.x) * ph, y = a.y + (b.y - a.y) * ph
        let fade = sin(ph * .pi)
        ctx.fill(Path(ellipseIn: CGRect(x: x - size / 2, y: y - size / 2, width: size, height: size)),
                 with: .color(color.opacity(0.9 * fade)))
    }
}

/// An agent that hasn't answered yet: a faint pulsing seat.
struct GhostAgent: View {
    let delay: Double
    @State private var on = false
    var body: some View {
        Circle()
            .fill(Color.secondary.opacity(0.14))
            .frame(width: 26, height: 26)
            .scaleEffect(on ? 1.12 : 0.88)
            .animation(.easeInOut(duration: 0.9).repeatForever().delay(delay), value: on)
            .onAppear { on = true }
    }
}

struct TalkRow: View {
    let talk: Talk
    let picked: Bool

    private var verdict: (String, Color) {
        if picked { return ("Your person", .iris) }
        if talk.fit >= 60 { return ("Strong fit", .green) }
        if talk.fit >= 35 { return ("Maybe", .orange) }
        return ("Pass", .secondary)
    }

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Avatar(person: talk.person, size: 30)
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text("\(talk.person.firstName)'s agent").font(.footnote.weight(.semibold))
                    Spacer()
                    Text(verdict.0)
                        .font(.caption2.weight(.semibold))
                        .padding(.horizontal, 8).padding(.vertical, 3)
                        .background(verdict.1.opacity(0.14), in: Capsule())
                        .foregroundStyle(verdict.1)
                }
                if !talk.ask.isEmpty {
                    Text("Your agent: \(talk.ask)").font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
                    Text("\(talk.person.firstName): \(talk.reply)").font(.subheadline).lineLimit(2)
                }
            }
        }
        .padding(12)
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(picked ? Color.iris.opacity(0.5) : .clear, lineWidth: 1.5))
    }
}
