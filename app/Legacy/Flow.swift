import SwiftUI
import UIKit

@MainActor
final class Flow: ObservableObject {
    enum Stage: Equatable { case welcome, interview, socials, matching, match, failed(String) }
    enum Mode { case idle, speaking, listening, thinking }

    @Published var stage: Stage = .welcome
    @Published var mode: Mode = .idle
    @Published var emmaLine = ""
    @Published var answers = 0
    @Published var result: MatchResp?
    @Published var incoming: Mission?          // someone else matched with you
    @Published var openMission: Mission?
    @Published var talks: [Talk] = []          // your agent's conversations, as they come in
    @Published var scanTotal = 0
    @Published var chosenId: String?

    let voice = VoiceIO()
    private(set) var userId = ""
    private var seenMissions = Set<String>()
    private var inboxTask: Task<Void, Never>?

    // MARK: interview

    func begin() {
        Task { await interview() }
    }

    private func interview() async {
        guard await voice.prepare() else {
            stage = .failed("Roomie needs the microphone and speech recognition. Turn them on in Settings.")
            return
        }
        stage = .interview
        mode = .thinking
        do {
            let s: StartResp = try await API.post("start", [:], timeout: 15)
            userId = s.id
            var line = s.say
            while stage == .interview {
                emmaLine = line
                mode = .speaking
                let cutOff = await voice.say(line, bargeIn: true)      // talk over her and she stops
                mode = .listening
                let said = await voice.listen().trimmingCharacters(in: .whitespacesAndNewlines)
                if said.isEmpty {
                    line = "Sorry, I didn't catch that. Say it again?"
                    continue
                }
                answers += 1
                mode = .thinking
                // If the reply takes a moment, Emma says "mm-hm" instead of leaving dead air.
                let filler = Task { [voice] in
                    try? await Task.sleep(for: .seconds(0.9))
                    if !Task.isCancelled { voice.playFiller() }
                }
                let t: TurnResp = try await API.post("turn", ["id": userId, "text": said, "interrupted": cutOff])
                filler.cancel()
                if t.done {
                    emmaLine = t.say
                    stage = .socials
                    mode = .speaking
                    await voice.say(t.say)
                    mode = .idle
                    return
                }
                line = t.say
            }
        } catch {
            fail()
        }
    }

    /// The person taps the orb to say they're finished talking.
    func doneTalking() {
        if mode == .listening { voice.endListening() }
        else if mode == .speaking { voice.stopSpeaking() }
    }

    // MARK: match

    func findMatch(socials: [String: String]) {
        voice.stopSpeaking()
        talks = []
        scanTotal = 0
        chosenId = nil
        stage = .matching
        mode = .thinking
        Task {                                   // stream the agent-to-agent talks for the animation
            while stage == .matching {
                if let r: ScanResp = try? await API.get("scan", ["id": userId]) {
                    scanTotal = r.total
                    if r.talks.count != talks.count { talks = r.talks }
                    if r.total > 0 && r.talks.count >= r.total { break }
                }
                try? await Task.sleep(for: .seconds(0.7))
            }
        }
        Task {
            do {
                let m: MatchResp = try await API.post("match", ["id": userId, "socials": socials])
                result = m
                seenMissions.insert(m.mission.id)
                chosenId = m.mission.person.id
            } catch {
                fail()
            }
        }
    }

    /// Called by the matching animation once it has converged on the chosen person.
    func revealMatch() {
        guard let m = result, stage == .matching else { return }
        stage = .match
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        startInbox()
        if autoReady { openMission = m.mission }
        Task {
            mode = .speaking
            await voice.say(m.say)
            mode = .idle
        }
    }

    /// Rehearsal: skip the voice chat with canned answers and go straight to the room (launch with -demoRoom).
    func rehearse() {
        Task {
            do {
                let s: StartResp = try await API.post("start", [:], timeout: 15)
                userId = s.id
                for line in ["I'm Kai, building an agent that reads restaurant menus in any language and tells you what to order.",
                             "I need a designer, and travellers to test it.", "I can help with iOS and Swift.",
                             "Back left, green beanie."] {
                    let _: TurnResp = try await API.post("turn", ["id": userId, "text": line])
                }
                autoReady = true
                findMatch(socials: [:])
            } catch { fail() }
        }
    }

    var autoReady = false

    /// Emma reads a line aloud (announcements, wrap-ups).
    func emmaSays(_ line: String) async {
        voice.stopSpeaking()
        mode = .speaking
        await voice.say(line)
        mode = .idle
    }

    /// Real attendees can be picked as someone else's match; their phone hears about it here.
    private func startInbox() {
        inboxTask?.cancel()
        inboxTask = Task {
            while !Task.isCancelled {
                if let r: InboxResp = try? await API.get("inbox", ["id": userId]) {
                    for m in r.missions where !seenMissions.contains(m.id) {
                        seenMissions.insert(m.id)
                        incoming = m
                        UINotificationFeedbackGenerator().notificationOccurred(.warning)
                        await voice.say("Psst. I just introduced you to \(m.person.firstName). They want to play.")
                    }
                }
                try? await Task.sleep(for: .seconds(4))
            }
        }
    }

    func restart() {
        inboxTask?.cancel()
        voice.stopSpeaking()
        voice.endListening()
        result = nil
        incoming = nil
        openMission = nil
        answers = 0
        emmaLine = ""
        seenMissions = []
        stage = .welcome
        mode = .idle
    }

    private func fail() {
        mode = .idle
        stage = .failed("Can't reach the Roomie server at \(API.baseString). Is it running on the Mac, on the same Wi-Fi?")
    }
}
