import AVFoundation
import Speech
import SwiftUI

/// Holds the live recognition request so the audio thread can feed it.
private final class RequestBox: @unchecked Sendable {
    private let lock = NSLock()
    private var req: SFSpeechAudioBufferRecognitionRequest?
    func set(_ r: SFSpeechAudioBufferRecognitionRequest?) { lock.lock(); req = r; lock.unlock() }
    func append(_ b: AVAudioPCMBuffer) { lock.lock(); let r = req; lock.unlock(); r?.append(b) }
}

/// Emma's voice and ears, full duplex.
///
/// One audio engine runs the whole conversation: the mic stays open with Apple's voice processing
/// (echo cancellation), and Emma's audio plays through the same engine, so she never hears herself.
/// That makes barge-in possible: start talking while she speaks and she stops and listens.
/// The end of your turn is decided by the words, not a fixed timer: a pause after "and…" or "um…"
/// waits longer, and recognition segments that the system closes on its own are stitched together.
@MainActor
final class VoiceIO: ObservableObject {
    @Published var level: CGFloat = 0          // 0...1, drives the orb
    @Published var heard = ""                  // live transcript of the current turn

    /// Quiet after the last new word that ends your turn.
    var endSilence: TimeInterval = 1.8
    /// Same, when the last word leaves the sentence open ("and", "but", "um"…).
    var endSilenceOpen: TimeInterval = 3.4

    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    private let playFormat = AVAudioFormat(standardFormatWithSampleRate: 24000, channels: 1)!
    private var running = false
    private var observing = false

    private let box = RequestBox()
    private let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
    private var task: SFSpeechRecognitionTask?
    private var segment = 0
    private var committed = ""

    private enum Phase { case idle, speaking, listening }
    private var phase: Phase = .idle
    private var bargeIn = false
    private var echoWords = Set<String>()
    private var speakDone: CheckedContinuation<Bool, Never>?
    private var listenDone: CheckedContinuation<String, Never>?
    private var pendingResult: String?

    private var micLevel: Float = 0
    private var lastText = Date()
    private var lastVoice = Date.distantPast
    private var listenStart = Date()
    private var envelope: [Float] = []
    private var playStart = Date()
    private var playDuration: Double = 0
    private var ticker: Timer?

    private var fillers: [AVAudioPCMBuffer] = []
    private var fillerUntil = Date.distantPast

    // MARK: setup

    func prepare() async -> Bool {
        let mic = await AVAudioApplication.requestRecordPermission()
        let speech = await withCheckedContinuation { (c: CheckedContinuation<Bool, Never>) in
            SFSpeechRecognizer.requestAuthorization { c.resume(returning: $0 == .authorized) }
        }
        startEngine()
        Task { await loadFillers() }
        return mic && speech
    }

    private func startEngine() {
        guard !running else { return }
        let s = AVAudioSession.sharedInstance()
        try? s.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetoothA2DP])
        try? s.setActive(true)

        _ = engine.mainMixerNode                    // touch the output side before voice processing
        _ = engine.outputNode
        let input = engine.inputNode
        if !input.isVoiceProcessingEnabled { try? input.setVoiceProcessingEnabled(true) }
        if !engine.attachedNodes.contains(player) { engine.attach(player) }
        engine.connect(player, to: engine.mainMixerNode, format: playFormat)

        let format = input.outputFormat(forBus: 0)
        input.removeTap(onBus: 0)
        if format.sampleRate > 0 {
            input.installTap(onBus: 0, bufferSize: 1024, format: format) { [box, weak self] buffer, _ in
                box.append(buffer)
                let l = VoiceIO.rms(buffer)
                Task { @MainActor in self?.micLevel = l }
            }
        }
        engine.prepare()
        do {
            try engine.start()
            running = true
        } catch {
            running = false
        }
        if !observing {
            observing = true
            NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main) { [weak self] _ in
                Task { @MainActor in
                    // The system stopped the engine (route change, call…). Restart it a moment later, never inline.
                    try? await Task.sleep(for: .milliseconds(300))
                    guard let self else { return }
                    if !self.engine.isRunning { try? self.engine.start() }
                }
            }
        }
        startTicker()
    }

    private func startTicker() {
        guard ticker == nil else { return }
        ticker = Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.tick() }
        }
    }

    // MARK: recognition (restarted whenever the system closes a segment)

    private func startRecognition() {
        stopRecognition()
        guard let recognizer, recognizer.isAvailable else { return }
        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        req.taskHint = .dictation
        req.addsPunctuation = true
        if recognizer.supportsOnDeviceRecognition { req.requiresOnDeviceRecognition = true }
        segment += 1
        let seg = segment
        box.set(req)
        task = recognizer.recognitionTask(with: req) { [weak self] result, error in
            Task { @MainActor in
                guard let self, seg == self.segment else { return }
                if let result {
                    let t = result.bestTranscription.formattedString
                    let full = [self.committed, t].filter { !$0.isEmpty }.joined(separator: " ")
                    if full != self.heard {
                        self.heard = full
                        self.lastText = Date()
                    }
                    if result.isFinal {
                        self.committed = full
                        if self.phase != .idle { self.startRecognition() }
                    }
                } else if error != nil, self.phase != .idle {
                    self.committed = self.heard
                    try? await Task.sleep(for: .milliseconds(200))
                    if seg == self.segment, self.phase != .idle { self.startRecognition() }
                }
            }
        }
    }

    private func stopRecognition() {
        segment += 1
        box.set(nil)
        task?.cancel()
        task = nil
    }

    // MARK: speaking

    /// Speaks a line. With `bargeIn`, talking over Emma stops her and starts your turn.
    /// Returns true if she was cut off (by voice or a tap).
    @discardableResult
    func say(_ text: String, bargeIn allow: Bool = false) async -> Bool {
        guard let data = try? await API.speech(text), let buf = pcm(data) else { return false }
        return await play(buf, line: text, bargeIn: allow)
    }

    private func play(_ buf: AVAudioPCMBuffer, line: String, bargeIn allow: Bool) async -> Bool {
        startEngine()
        let wait = fillerUntil.timeIntervalSinceNow
        if wait > 0 { try? await Task.sleep(for: .seconds(wait)) }      // let an "mm-hm" finish
        if phase == .speaking { endSpeaking(byVoice: false, tapped: true) }
        if phase == .listening { finishListening() }

        phase = .speaking
        bargeIn = allow
        echoWords = Set(Self.words(line))
        committed = ""
        heard = ""
        if allow { startRecognition() }
        envelope = Self.envelope(buf)
        playDuration = Double(buf.frameLength) / buf.format.sampleRate
        player.stop()
        player.scheduleBuffer(buf, at: nil, options: [], completionHandler: nil)
        player.play()
        playStart = Date()
        return await withCheckedContinuation { (c: CheckedContinuation<Bool, Never>) in
            speakDone = c
        }
    }

    /// Tap to skip: Emma stops, nothing is taken as your words.
    func stopSpeaking() {
        if phase == .speaking { endSpeaking(byVoice: false, tapped: true) }
        player.stop()
        fillerUntil = .distantPast
    }

    private func endSpeaking(byVoice: Bool, tapped: Bool = false) {
        guard phase == .speaking else { return }
        if byVoice || tapped { player.stop() }
        if byVoice {
            phase = .listening                  // keep the recognition running: your turn has started
            listenStart = Date()
            lastText = Date()
        } else {
            phase = .idle
            if bargeIn { stopRecognition() }
            heard = ""
        }
        level = 0
        let c = speakDone
        speakDone = nil
        c?.resume(returning: byVoice || tapped)
    }

    /// Someone is talking over Emma: at least two recognised words that aren't her own.
    private func talkingOver() -> Bool {
        Self.words(heard).filter { !echoWords.contains($0) }.count >= 2
    }

    // MARK: listening

    func listen() async -> String {
        startEngine()
        if let p = pendingResult { pendingResult = nil; return p }
        if phase != .listening {
            phase = .listening
            committed = ""
            heard = ""
            startRecognition()
            listenStart = Date()
            lastText = Date()
        }
        return await withCheckedContinuation { (c: CheckedContinuation<String, Never>) in
            listenDone = c
        }
    }

    /// Tap to finish your turn now.
    func endListening() { finishListening() }

    private func finishListening() {
        guard phase == .listening else { return }
        phase = .idle
        stopRecognition()
        level = 0
        let text = heard.trimmingCharacters(in: .whitespacesAndNewlines)
        if let c = listenDone {
            listenDone = nil
            c.resume(returning: text)
        } else {
            pendingResult = text
        }
    }

    // MARK: the clock

    private func tick() {
        let now = Date()
        switch phase {
        case .speaking:
            let t = now.timeIntervalSince(playStart)
            if !envelope.isEmpty { level = CGFloat(envelope[min(envelope.count - 1, max(0, Int(t * 30)))]) }
            if bargeIn && talkingOver() {
                endSpeaking(byVoice: true)
            } else if t >= playDuration + 0.12 {
                endSpeaking(byVoice: false)
            }
        case .listening:
            level = CGFloat(min(1, micLevel))
            if micLevel > 0.1 { lastVoice = now }
            let text = heard.trimmingCharacters(in: .whitespacesAndNewlines)
            let sinceText = now.timeIntervalSince(lastText)
            let sinceVoice = now.timeIntervalSince(lastVoice)
            let need = Self.endsOpen(text) ? endSilenceOpen : endSilence
            if !text.isEmpty, sinceText > need, sinceVoice > 0.6 || sinceText > need + 2.5 {
                finishListening()
            } else if text.isEmpty, now.timeIntervalSince(listenStart) > 14 {
                finishListening()
            } else if now.timeIntervalSince(listenStart) > 90 {
                finishListening()
            }
        case .idle:
            if level != 0 && fillerUntil < now { level = 0 }
        }
    }

    // MARK: fillers ("mm-hm" while Emma thinks)

    private func loadFillers() async {
        guard fillers.isEmpty else { return }
        for f in ["Mm-hm.", "Okay.", "Right."] {
            if let d = try? await API.speech(f), let b = pcm(d) { fillers.append(b) }
        }
    }

    func playFiller() {
        guard phase == .idle, let b = fillers.randomElement() else { return }
        startEngine()
        player.stop()
        player.scheduleBuffer(b, at: nil, options: [], completionHandler: nil)
        player.play()
        let d = Double(b.frameLength) / b.format.sampleRate
        fillerUntil = Date().addingTimeInterval(d)
        level = 0.25
    }

    // MARK: helpers

    private func pcm(_ data: Data) -> AVAudioPCMBuffer? {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".wav")
        guard (try? data.write(to: url)) != nil, let file = try? AVAudioFile(forReading: url) else { return nil }
        defer { try? FileManager.default.removeItem(at: url) }
        guard let buf = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(file.length)),
              (try? file.read(into: buf)) != nil else { return nil }
        if buf.format == playFormat { return buf }
        guard let conv = AVAudioConverter(from: buf.format, to: playFormat),
              let out = AVAudioPCMBuffer(pcmFormat: playFormat,
                                         frameCapacity: AVAudioFrameCount(Double(buf.frameLength) * playFormat.sampleRate / buf.format.sampleRate) + 1024)
        else { return nil }
        var fed = false
        var err: NSError?
        conv.convert(to: out, error: &err) { _, status in
            if fed { status.pointee = .endOfStream; return nil }
            fed = true
            status.pointee = .haveData
            return buf
        }
        return err == nil ? out : nil
    }

    private static func envelope(_ b: AVAudioPCMBuffer) -> [Float] {
        guard let ch = b.floatChannelData?[0] else { return [] }
        let n = Int(b.frameLength)
        let step = max(1, Int(b.format.sampleRate / 30))
        var out: [Float] = []
        var i = 0
        while i < n {
            let end = min(n, i + step)
            var s: Float = 0
            for k in i..<end { s += ch[k] * ch[k] }
            out.append(min(1, sqrt(s / Float(end - i)) * 5))
            i = end
        }
        return out
    }

    nonisolated static func rms(_ b: AVAudioPCMBuffer) -> Float {
        guard let ch = b.floatChannelData?[0] else { return 0 }
        let n = Int(b.frameLength)
        guard n > 0 else { return 0 }
        var s: Float = 0
        for i in 0..<n { s += ch[i] * ch[i] }
        return min(1, sqrt(s / Float(n)) * 14)
    }

    static func words(_ s: String) -> [String] {
        s.lowercased().components(separatedBy: CharacterSet.letters.inverted).filter { !$0.isEmpty }
    }

    private static let openEndings: Set<String> = ["and", "but", "so", "because", "or", "um", "uh", "like", "then",
                                                     "with", "the", "a", "an", "to", "of", "for", "my", "i", "m", "is", "that"]

    /// The sentence sounds unfinished: wait longer before taking the turn.
    static func endsOpen(_ text: String) -> Bool {
        if text.hasSuffix(",") || text.hasSuffix("…") { return true }
        guard let last = words(text).last else { return false }
        return openEndings.contains(last)
    }
}
