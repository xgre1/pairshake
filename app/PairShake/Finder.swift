import ARKit
import CoreBluetooth
import CoreLocation
import CoreMotion
import CryptoKit
import NearbyInteraction
import Combine
import simd

/// Where is your person? Built to keep working when things go wrong:
/// - Ultra Wideband (Nearby Interaction) gives real distance. Direction comes the way Find My's Precision
///   Finding gets it: camera assistance. ARKit tracks how the phone moves, NI fuses that with the radio and
///   places the other person in the room, and the arrow is drawn from where the phone is now to that spot,
///   so it stays right while you turn and while you walk. iPhone 15 Pro / 16 Pro (the U2 chip) give no
///   direction at all without the camera; older ones give a 3D direction that the camera only improves.
/// - The UWB token travels two ways at once: through the server and directly over Bluetooth,
///   so a bad venue Wi-Fi can't stop the two phones from finding each other.
/// - Without world tracking (no camera assistance, camera still starting up) a direction is pinned to the
///   room with the gyroscope instead, so it survives turning but not walking.
/// - Sessions that stall, get suspended or die are restarted on their own.
/// - When UWB isn't live (too far, or a phone without it) Bluetooth signal strength gives a rough distance.
/// - A demo attendee with no phone falls back to a compass bearing and your step count.
@MainActor
final class Finder: NSObject, ObservableObject {
    enum Mode { case searching, uwb, bluetooth, estimate }

    @Published var distance: Double?        // metres
    @Published var angle: Double?           // radians; 0 = straight ahead, positive = to the right
    @Published var precise = false          // true while UWB is giving live readings
    @Published var mode: Mode = .searching
    /// What to do so the direction can be worked out (camera-assisted UWB needs the phone moved), nil when fine.
    @Published var coach: String?

    var sendToken: ((Data) -> Void)?
    var onLog: ((String) -> Void)?             // for the app's diagnostics file

    // how the radios are doing, logged every 5 s: UWB readings, how many placed the person or had a direction,
    // and how horizontalAngle compares with NI's placement (its sign isn't documented)
    private struct Stat {
        var uwb = 0, world = 0, dir = 0, horiz = 0, since = Date()
        var hSame = 0.0, hFlip = 0.0, hN = 0
    }
    private var stat = Stat()

    private var started = false
    private var watchdog: Timer?

    // UWB
    private var session: NISession?
    private var myToken: Data?
    private var peerToken: Data?
    private var runningWith: Data?
    private var lastUWB: Date?
    private var lastRun: Date?
    private var lastRebuild = Date.distantPast

    // Camera assistance, on for the whole search where the phone supports it. Switching it off and on
    // restarts NI and throws away what it has worked out (on U2 phones that takes ~10 s of moving the phone),
    // so it never toggles. Our own ARSession is handed to NI, so we can read where the phone is in the same
    // world NI places the other person in.
    // NI refuses our ARSession (NIERROR_INVALID_AR_SESSION_DESCRIPTION) until it delivers frames, so the
    // first run waits for a frame. If NI still refuses it twice, NI runs its own camera session: direction
    // then comes as horizontalAngle pinned with the gyroscope, and there is no camera picture to show.
    private var assist = false                  // camera assistance on (ours or NI's own ARSession)
    private(set) var ar: ARSession?             // our own, also drawn blurred behind the finding screen
    var cameraLive: Bool { ar != nil && firstFrame }
    private var arRefused = 0
    private var pendingPeer: Data?              // a run waiting for the camera's first frame
    private var firstFrame = false
    private var peerAt: simd_double3?       // the other person in ARKit's world (y up), smoothed
    private var peerSeen: Date?             // last reading that moved peerAt
    private var farSince: Date?             // readings far from peerAt since (a bounce, or they really moved)
    private var offSince: Date?             // the live distance disagreeing with peerAt since
    private var rawAngle: Double?           // only for a phone with no motion data at all
    private var lastDirAt: Date?
    private var lastTokenSent = Date.distantPast
    private var recentDistances: [Double] = []

    // direction pinned to the room
    private let motion = CMMotionManager()
    private var useInverse: Bool?
    private var pointing: Double?           // where the phone points, world azimuth (radians, counter-clockwise)
    private var currentAttitude: simd_quatd?
    private var target: Double?             // the other person, world azimuth
    private var lastDirection: Date?

    // Bluetooth
    private var link: PeerLink?
    private var rssi: [Double] = []
    private var smoothedRSSI: Double?
    private var lastRSSI: Date?

    // demo attendee
    private let compass = CLLocationManager()
    private let pedometer = CMPedometer()
    private var demoBearing = Double.random(in: 0..<360)
    private var demoStart = Double.random(in: 11...19)

    /// `peer`: false for a demo attendee (no phone on the other side). `room`: shared by both phones.
    func start(peer: Bool, room: String) {
        guard !started else { return }
        started = true

        guard peer else { startEstimate(); return }

        startMotion()
        let caps = NISession.deviceCapabilities
        assist = caps.supportsCameraAssistance
        ar = assist ? makeAR() : nil
        onLog?("finder: uwb \(caps.supportsPreciseDistanceMeasurement), plain direction \(caps.supportsDirectionMeasurement), camera assistance \(caps.supportsCameraAssistance), world tracking \(ar != nil)")
        let l = PeerLink(room: room)
        l.onToken = { [weak self] data in Task { @MainActor in self?.received(data) } }
        l.onRSSI = { [weak self] v in Task { @MainActor in self?.gotRSSI(v) } }
        link = l
        buildSession()
        if let p = peerToken { run(with: p) }

        watchdog = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.check() }
        }
    }

    /// The other iPhone's token arrived (from the server or over Bluetooth).
    func received(_ data: Data) {
        peerToken = data
        guard session != nil, data != runningWith else { return }
        run(with: data)
    }

    func stop() {
        watchdog?.invalidate(); watchdog = nil
        session?.invalidate(); session = nil
        link?.stop(); link = nil
        motion.stopDeviceMotionUpdates()
        compass.stopUpdatingHeading()
        pedometer.stopUpdates()
        dropAR()
        peerAt = nil; target = nil; lastDirection = nil
        runningWith = nil; pendingPeer = nil
        started = false
    }

    private func dropAR() {
        ar?.delegate = nil                       // first, or ARKit keeps handing us frames after pause
        ar?.pause(); ar = nil
        firstFrame = false
        peerAt = nil
    }

    /// World tracking for camera assistance. The configuration is the one NI accepts: gravity-aligned,
    /// no collaboration, no face tracking, no saved world map.
    private func makeAR() -> ARSession? {
        guard NISession.deviceCapabilities.supportsCameraAssistance, ARWorldTrackingConfiguration.isSupported else { return nil }
        let c = ARWorldTrackingConfiguration()
        c.worldAlignment = .gravity
        c.isCollaborationEnabled = false
        c.userFaceTrackingEnabled = false
        c.initialWorldMap = nil
        c.planeDetection = []
        c.environmentTexturing = .none
        let s = ARSession()
        s.delegate = self
        s.run(c)
        return s
    }

    // MARK: UWB session

    private func buildSession() {
        guard NISession.deviceCapabilities.supportsPreciseDistanceMeasurement else { return }
        lastRebuild = Date()
        session?.invalidate()
        let s = NISession()
        s.delegate = self
        if let ar { s.setARSession(ar) }
        session = s
        runningWith = nil
        if let token = s.discoveryToken,
           let data = try? NSKeyedArchiver.archivedData(withRootObject: token, requiringSecureCoding: true) {
            myToken = data
            link?.setToken(data)
            shareToken()
        }
    }

    private func shareToken() {
        guard let t = myToken else { return }
        lastTokenSent = Date()
        sendToken?(t)
    }

    private func run(with data: Data) {
        if ar != nil, !firstFrame {                       // NI won't take an ARSession with no frames yet
            if pendingPeer == nil { onLog?("uwb run waits for the camera") }
            pendingPeer = data
            return
        }
        onLog?("uwb run, camera assistance \(assist ? ar != nil ? "on (ours)" : "on (NI's own)" : "off")")
        guard let s = session,
              let token = try? NSKeyedUnarchiver.unarchivedObject(ofClass: NIDiscoveryToken.self, from: data) else { return }
        let config = NINearbyPeerConfiguration(peerToken: token)
        config.isCameraAssistanceEnabled = assist
        s.run(config)
        runningWith = data
        lastRun = Date()
    }

    /// Once a second: restart whatever has stalled, and decide what the screen shows.
    private func check() {
        let now = Date()
        if now.timeIntervalSince(stat.since) >= 5 { logStat(now) }
        let live = lastUWB.map { now.timeIntervalSince($0) < 2 } ?? false
        // a gap of a few seconds keeps the last UWB distance: Bluetooth's guess is metres off and made the number jump
        let recent = lastUWB.map { now.timeIntervalSince($0) < 6 } ?? false

        if session != nil, !live {
            // keep offering my token until we're ranging; it's tiny
            if now.timeIntervalSince(lastTokenSent) > 3 { shareToken() }
            let quiet = now.timeIntervalSince(lastUWB ?? lastRun ?? now)
            if let p = peerToken, now.timeIntervalSince(lastRun ?? .distantPast) > 5 { run(with: p) }
            if quiet > 20, now.timeIntervalSince(lastRebuild) > 20 { buildSession() }
        }
        // without camera assistance, direction only comes for someone roughly in front of you
        if !assist { coach = live && now.timeIntervalSince(lastDirAt ?? .distantPast) > 2 ? "turn" : nil }

        // The spot we placed them on stops being true once they walk off: the live distance says so.
        if let p = peerAt, let pose = camera(), let r = distance, live {
            let est = simd_distance(flat(p), flat(pose.position))
            if abs(est - r) > max(1.0, 0.35 * r) {
                offSince = offSince ?? now
                if now.timeIntervalSince(offSince!) > 1.5 { dropPeer(String(format: "placed %.1f m away, radio says %.1f m", est, r)) }
            } else { offSince = nil }
        }
        if let s = peerSeen, peerAt != nil, now.timeIntervalSince(s) > 30 { dropPeer("no reading for 30 s") }
        // a gyroscope-pinned direction survives turning, not walking: keep it only briefly
        if let d = lastDirection, now.timeIntervalSince(d) > 15 { target = nil; lastDirection = nil }
        if let d = lastDirAt, now.timeIntervalSince(d) > 2 { rawAngle = nil }

        let bt = lastRSSI.map { now.timeIntervalSince($0) < 4 } ?? false
        if recent {
            mode = .uwb
        } else if bt, let r = smoothedRSSI {
            mode = .bluetooth
            distance = PeerLink.metres(fromRSSI: r)
        } else {
            mode = .searching
        }
        precise = live
        updateAngle()
    }

    private func logStat(_ now: Date) {
        let t = now.timeIntervalSince(stat.since)
        var line = String(format: "uwb %.1f/s, placed by NI %.1f/s, 3D direction %.1f/s, angle only %.1f/s, mode %@, distance %@, arrow %@, coach %@, camera %@",
                          Double(stat.uwb) / t, Double(stat.world) / t, Double(stat.dir) / t, Double(stat.horiz) / t, "\(mode)",
                          distance.map { String(format: "%.1f m", $0) } ?? "-",
                          angle.map { String(format: "%.0f°", $0 * 180 / .pi) } ?? "-", coach ?? "-", arState())
        if stat.hN > 0 {
            line += String(format: ", horizontalAngle vs NI: as is %.0f°, flipped %.0f° (n %d)",
                           stat.hSame / Double(stat.hN) * 180 / .pi, stat.hFlip / Double(stat.hN) * 180 / .pi, stat.hN)
        }
        onLog?(line)
        stat = Stat(since: now)
    }

    fileprivate func uwbUpdate(distance d: Double?, direction: simd_float3?, horizontalAngle: Double?, world: simd_float4x4?) {
        let now = Date()
        if let last = lastUWB, now.timeIntervalSince(last) > 2 { recentDistances.removeAll() }   // old values from before a gap
        lastUWB = now
        stat.uwb += 1
        if world != nil { stat.world += 1 }
        if direction != nil { stat.dir += 1 } else if horizontalAngle != nil { stat.horiz += 1 }
        if world != nil || direction != nil || horizontalAngle != nil { lastDirAt = now }
        if let d { distance = steady(d) }

        if let pose = camera() {
            // Where they are in the room. NI's own placement is best; failing that, the radio's direction
            // and distance from where the phone is right now.
            var spot: simd_double3?
            if let w = world {
                spot = simd_double3(Double(w.columns.3.x), Double(w.columns.3.y), Double(w.columns.3.z))
                if let h = horizontalAngle {
                    let a = pose.angle(to: spot!)
                    stat.hSame += abs(wrap(h - a)); stat.hFlip += abs(wrap(-h - a)); stat.hN += 1
                }
            } else if let r = distance, let dir = direction {
                spot = pose.position + (pose.right * Double(dir.x) + pose.top * Double(dir.y) + pose.screen * Double(dir.z)) * r
            } else if let r = distance, let h = horizontalAngle {
                spot = pose.position + (pose.ahead * cos(h) + pose.side * sin(h)) * r      // positive = to the right
            }
            if let spot { place(spot, now) }
        } else if let p = pointing, let q = currentAttitude {
            if let dir = direction {
                let w = toWorld(simd_double3(dir), q)
                if hypot(w.x, w.y) > 0.25 { pin(atan2(w.y, w.x)) }
            } else if let h = horizontalAngle {
                pin(p - h)
            }
        } else if let dir = direction {
            rawAngle = Double(atan2(dir.x, -dir.z))          // no motion data: show it raw
        } else if let h = horizontalAngle {
            rawAngle = h
        }
        if mode != .uwb { mode = .uwb; precise = true }
        updateAngle()
    }

    /// Median of the last five readings (0.1 s), so a bounce off a wall can't make the number jump.
    private func steady(_ d: Double) -> Double {
        recentDistances.append(d)
        if recentDistances.count > 5 { recentDistances.removeFirst() }
        return recentDistances.sorted()[recentDistances.count / 2]
    }

    /// Move the estimate toward a new reading. A reading far from it is a bounce unless the next ones
    /// agree for 0.7 s, so one reflection can't swing the arrow but a real move still gets through.
    private func place(_ s: simd_double3, _ now: Date) {
        guard let p = peerAt else { peerAt = s; peerSeen = now; return }
        let r = distance ?? simd_distance(flat(p), flat(s))
        if simd_distance(flat(p), flat(s)) > max(1.0, 0.4 * r) {
            farSince = farSince ?? now
            guard now.timeIntervalSince(farSince!) > 0.7 else { return }
            peerAt = s
        } else {
            let dt = min(1, now.timeIntervalSince(peerSeen ?? now))
            peerAt = p + (s - p) * (1 - exp(-dt / 0.25))         // ~0.25 s smoothing, whatever the reading rate
        }
        farSince = nil
        peerSeen = now
    }

    private func dropPeer(_ why: String) {
        onLog?("direction dropped: \(why)")
        peerAt = nil; farSince = nil; offSince = nil
    }

    private func pin(_ azimuth: Double) {
        lastDirection = Date()
        guard let t = target else { target = azimuth; return }
        // average on the circle so 359° and 1° don't average to 180°
        let x = 0.65 * cos(t) + 0.35 * cos(azimuth), y = 0.65 * sin(t) + 0.35 * sin(azimuth)
        target = atan2(y, x)
    }

    private func updateAngle() {
        guard mode != .estimate else { return }                 // the compass drives a demo attendee's arrow
        if let p = peerAt, let pose = camera() { angle = pose.angle(to: p); return }
        if let t = target, let p = pointing { angle = wrap(p - t); return }
        angle = pointing == nil ? rawAngle : nil
    }

    // MARK: world tracking

    /// The phone in ARKit's world (y up). ARKit's camera axes are the landscape sensor's: x runs from the
    /// front camera toward the bottom of the phone, y to its right side, z out of the screen.
    private struct Pose {
        let position, top, right, screen: simd_double3
        let ahead, side: simd_double3                  // horizontal: where the phone points, and its right

        /// Horizontal angle to a spot, radians: 0 = ahead, positive = to the right.
        func angle(to p: simd_double3) -> Double {
            let v = p - position
            return atan2(simd_dot(v, side), simd_dot(v, ahead))
        }
    }

    private func camera() -> Pose? {
        guard let frame = ar?.currentFrame else { return nil }
        let cam = frame.camera
        guard ProcessInfo.processInfo.systemUptime - frame.timestamp < 1 else { return nil }   // AR stalled
        switch cam.trackingState {
        case .normal, .limited(.excessiveMotion), .limited(.insufficientFeatures): break
        default: return nil                                      // starting up, relocalising, or lost
        }
        let m = cam.transform
        func v(_ c: simd_float4) -> simd_double3 { simd_double3(Double(c.x), Double(c.y), Double(c.z)) }
        let top = -v(m.columns.0), right = v(m.columns.1), screen = v(m.columns.2)
        // where the phone points: its top when held flat, its back when held upright; both agree in between
        var ahead = top - screen
        ahead.y = 0
        guard simd_length(ahead) > 0.2 else { return nil }
        ahead = simd_normalize(ahead)
        return Pose(position: v(m.columns.3), top: top, right: right, screen: screen,
                    ahead: ahead, side: simd_double3(-ahead.z, 0, ahead.x))
    }

    private func flat(_ p: simd_double3) -> simd_double2 { simd_double2(p.x, p.z) }

    private func arState() -> String {
        guard let ar else { return "off" }
        guard let cam = ar.currentFrame?.camera else { return "no frames" }
        switch cam.trackingState {
        case .normal: return "tracking"
        case .notAvailable: return "not tracking"
        case .limited(let why):
            switch why {
            case .initializing: return "starting"
            case .excessiveMotion: return "moving too fast"
            case .insufficientFeatures: return "too dark or plain"
            case .relocalizing: return "relocalising"
            @unknown default: return "limited"
            }
        }
    }

    // MARK: motion

    private func startMotion() {
        guard motion.isDeviceMotionAvailable else { return }
        motion.deviceMotionUpdateInterval = 1.0 / 30
        // gyroscope only, no magnetometer: stays steady indoors near laptops and steel
        motion.startDeviceMotionUpdates(using: .xArbitraryZVertical, to: .main) { [weak self] m, _ in
            guard let self, let m else { return }
            MainActor.assumeIsolated { self.gotMotion(m) }
        }
    }

    private func gotMotion(_ m: CMDeviceMotion) {
        let a = m.attitude.quaternion
        let q = simd_quatd(ix: a.x, iy: a.y, iz: a.z, r: a.w)
        if useInverse == nil {
            // work out once which way round the attitude is: gravity must point down in the world
            let g = simd_double3(m.gravity.x, m.gravity.y, m.gravity.z)
            let z = q.act(g).z, zi = q.inverse.act(g).z
            if abs(z - zi) > 0.5 { useInverse = zi < z }
        }
        guard useInverse != nil else { return }
        currentAttitude = q
        // where the phone points: its top when held flat, its back when held upright; both agree in between
        let top = toWorld(simd_double3(0, 1, 0), q), back = toWorld(simd_double3(0, 0, -1), q)
        let hx = top.x + back.x, hy = top.y + back.y
        if hypot(hx, hy) > 0.2 { pointing = atan2(hy, hx) }
        updateAngle()
    }

    private func toWorld(_ v: simd_double3, _ q: simd_quatd) -> simd_double3 {
        (useInverse == true ? q.inverse : q).act(v)
    }

    private func wrap(_ a: Double) -> Double {
        var x = a
        while x > .pi { x -= 2 * .pi }
        while x < -.pi { x += 2 * .pi }
        return x
    }

    // MARK: Bluetooth

    private func gotRSSI(_ v: Int) {
        guard v < 0, v > -110 else { return }       // 127 means "unknown"
        rssi.append(Double(v))
        if rssi.count > 15 { rssi.removeFirst() }
        let med = rssi.sorted()[rssi.count / 2]
        smoothedRSSI = smoothedRSSI.map { 0.8 * $0 + 0.2 * med } ?? med
        lastRSSI = Date()
    }

    // MARK: demo attendee

    private func startEstimate() {
        mode = .estimate
        compass.delegate = self
        compass.headingFilter = 1
        if CLLocationManager.headingAvailable() { compass.startUpdatingHeading() }
        distance = demoStart
        if CMPedometer.isDistanceAvailable() {
            pedometer.startUpdates(from: Date()) { [weak self] data, _ in
                guard let walked = data?.distance?.doubleValue else { return }
                Task { @MainActor in
                    guard let self else { return }
                    self.distance = max(0.6, self.demoStart - walked)
                }
            }
        }
    }
}

extension Finder: NISessionDelegate {
    nonisolated func session(_ session: NISession, didUpdateAlgorithmConvergence convergence: NIAlgorithmConvergence, for object: NINearbyObject?) {
        let why: String?
        switch convergence.status {
        case .converged: why = nil
        case .notConverged(let reasons):
            if reasons.contains(.insufficientLighting) { why = "light" }
            else if reasons.contains(.insufficientHorizontalSweep) { why = "sweep" }
            else if reasons.contains(.insufficientVerticalSweep) { why = "tilt" }
            else if reasons.contains(.insufficientMovement) { why = "move" }
            else { why = "sweep" }
        default: why = nil
        }
        Task { @MainActor in
            guard self.assist else { return }
            if self.coach != why { self.onLog?("convergence: \(why ?? "converged")") }
            self.coach = why
        }
    }

    nonisolated func session(_ session: NISession, didUpdate nearbyObjects: [NINearbyObject]) {
        guard let o = nearbyObjects.first else { return }
        let d = o.distance.map(Double.init)
        let dir = o.direction
        let h = o.horizontalAngle.map(Double.init)
        let world = session.worldTransform(for: o)              // nil until camera assistance has converged
        Task { @MainActor in self.uwbUpdate(distance: d, direction: dir, horizontalAngle: h, world: world) }
    }

    nonisolated func session(_ session: NISession, didRemove nearbyObjects: [NINearbyObject], reason: NINearbyObject.RemovalReason) {
        Task { @MainActor in
            guard self.session === session else { return }
            // timeout: they walked out of range or behind a wall, try again. peerEnded: they'll send a new token.
            if reason == .timeout, let p = self.peerToken { self.run(with: p) }
            if reason == .peerEnded { self.runningWith = nil }
        }
    }

    nonisolated func sessionWasSuspended(_ session: NISession) {}

    nonisolated func sessionSuspensionEnded(_ session: NISession) {
        Task { @MainActor in
            guard self.session === session, let p = self.peerToken else { return }
            self.run(with: p)
        }
    }

    nonisolated func session(_ session: NISession, didInvalidateWith error: Error) {
        Task { @MainActor in
            self.onLog?("uwb session ended: \(error.localizedDescription), camera \(self.arState())")
            guard self.started, self.session === session else { return }
            self.precise = false
            self.session = nil
            if (error as? NIError)?.code == .invalidARConfiguration, self.ar != nil {
                self.arRefused += 1
                if self.arRefused >= 2 {                       // NI won't take ours: let it run its own camera
                    self.onLog?("NI refused our ARSession twice, camera state \(self.arState()); using NI's own")
                    self.dropAR()
                }
            }
            // a dead session can't be revived: start a new one (new token) after a short pause
            try? await Task.sleep(for: .seconds(1))
            if self.started, self.session == nil { self.buildSession(); if let p = self.peerToken { self.run(with: p) } }
        }
    }
}

extension Finder: ARSessionDelegate {
    // Called for every camera frame; only the first one matters here, and no frame is kept
    // (holding ARFrames starves the camera).
    nonisolated func session(_ session: ARSession, didUpdate frame: ARFrame) {
        MainActor.assumeIsolated {
            guard self.ar === session, !self.firstFrame else { return }
            self.firstFrame = true
            self.onLog?("camera: first frame")
            if let p = self.pendingPeer { self.pendingPeer = nil; self.run(with: p) }
        }
    }

    nonisolated func session(_ session: ARSession, didFailWithError error: Error) {
        let msg = error.localizedDescription
        let denied = (error as? ARError)?.code == .cameraUnauthorized
        Task { @MainActor in
            guard self.ar === session else { return }
            self.onLog?("camera failed: \(msg)")
            self.dropAR()
            if denied { self.assist = false }              // no camera at all: plain UWB
            // the NISession was bound to that ARSession: a fresh one (new token) goes without it
            if self.started, self.session != nil { self.buildSession(); if let p = self.peerToken { self.run(with: p) } }
        }
    }

    nonisolated func sessionWasInterrupted(_ session: ARSession) {
        Task { @MainActor in self.onLog?("camera interrupted") }
    }

    nonisolated func sessionInterruptionEnded(_ session: ARSession) {
        Task { @MainActor in self.onLog?("camera back") }
    }
}

extension Finder: CLLocationManagerDelegate {
    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateHeading h: CLHeading) {
        let heading = h.magneticHeading
        Task { @MainActor in
            guard self.mode == .estimate else { return }
            var diff = self.demoBearing - heading
            while diff > 180 { diff -= 360 }
            while diff < -180 { diff += 360 }
            self.angle = diff * .pi / 180
        }
    }

    nonisolated func locationManagerShouldDisplayHeadingCalibration(_ manager: CLLocationManager) -> Bool { false }
}

// MARK: - Bluetooth link between the two phones

/// Each phone advertises a service only its match knows (derived from the room), serves its UWB token
/// on it, and connects to the other phone's: that hands over the token with no server, and the
/// connection's signal strength gives a rough distance.
final class PeerLink: NSObject, CBCentralManagerDelegate, CBPeripheralManagerDelegate, CBPeripheralDelegate {
    var onToken: ((Data) -> Void)?
    var onRSSI: ((Int) -> Void)?

    private let service: CBUUID
    private let tokenID = CBUUID(string: "6E1D4C2A-93B7-4F0E-8A51-2C7D9E3B4F10")
    private var central: CBCentralManager!
    private var peripheralManager: CBPeripheralManager!
    private var token = Data()
    private var peer: CBPeripheral?
    private var tokenChar: CBCharacteristic?
    private var timer: Timer?
    private var ticks = 0
    private var lastToken: Data?

    init(room: String) {
        let h = Array(SHA256.hash(data: Data("pairshake-find-\(room)".utf8)).prefix(16))
        let hex = h.map { String(format: "%02X", $0) }.joined()
        let s = Array(hex)
        let uuid = [s[0..<8], s[8..<12], s[12..<16], s[16..<20], s[20..<32]].map { String($0) }.joined(separator: "-")
        service = CBUUID(string: uuid)
        super.init()
        central = CBCentralManager(delegate: self, queue: nil)
        peripheralManager = CBPeripheralManager(delegate: self, queue: nil)
        timer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in self?.tick() }
    }

    func setToken(_ t: Data) { token = t }

    func stop() {
        timer?.invalidate(); timer = nil
        if central.state == .poweredOn { central.stopScan() }
        if let p = peer { central.cancelPeripheralConnection(p) }
        peer = nil
        if peripheralManager.state == .poweredOn {
            peripheralManager.stopAdvertising()
            peripheralManager.removeAllServices()
        }
    }

    /// Log-distance path loss: -59 dBm at 1 m is typical for an iPhone, indoors the falloff is ~2.2.
    static func metres(fromRSSI r: Double) -> Double {
        min(40, max(0.5, pow(10, (-59 - r) / 22)))
    }

    private func tick() {
        guard let p = peer, p.state == .connected else { return }
        p.readRSSI()
        ticks += 1
        // re-read the token now and then: it changes when the other phone restarts its UWB session
        if ticks % 6 == 0, let c = tokenChar { p.readValue(for: c) }
    }

    // advertising side

    func peripheralManagerDidUpdateState(_ m: CBPeripheralManager) {
        guard m.state == .poweredOn else { return }
        let c = CBMutableCharacteristic(type: tokenID, properties: [.read], value: nil, permissions: [.readable])
        let s = CBMutableService(type: service, primary: true)
        s.characteristics = [c]
        m.removeAllServices()
        m.add(s)
    }

    func peripheralManager(_ m: CBPeripheralManager, didAdd service: CBService, error: Error?) {
        guard error == nil else { return }
        m.startAdvertising([CBAdvertisementDataServiceUUIDsKey: [self.service]])
    }

    func peripheralManager(_ m: CBPeripheralManager, didReceiveRead request: CBATTRequest) {
        guard request.characteristic.uuid == tokenID else { m.respond(to: request, withResult: .attributeNotFound); return }
        guard request.offset <= token.count else { m.respond(to: request, withResult: .invalidOffset); return }
        request.value = token.subdata(in: request.offset..<token.count)
        m.respond(to: request, withResult: .success)
    }

    // connecting side

    func centralManagerDidUpdateState(_ c: CBCentralManager) {
        guard c.state == .poweredOn else { return }
        c.scanForPeripherals(withServices: [service], options: [CBCentralManagerScanOptionAllowDuplicatesKey: true])
    }

    func centralManager(_ c: CBCentralManager, didDiscover p: CBPeripheral, advertisementData: [String: Any], rssi: NSNumber) {
        if peer?.state != .connected { onRSSI?(rssi.intValue) }
        guard peer == nil else { return }
        peer = p
        p.delegate = self
        c.connect(p)
    }

    func centralManager(_ c: CBCentralManager, didConnect p: CBPeripheral) {
        p.discoverServices([service])
    }

    func centralManager(_ c: CBCentralManager, didFailToConnect p: CBPeripheral, error: Error?) {
        c.connect(p)                                     // never times out: connects when back in range
    }

    func centralManager(_ c: CBCentralManager, didDisconnectPeripheral p: CBPeripheral, error: Error?) {
        tokenChar = nil
        if peer === p { c.connect(p) }
    }

    func peripheral(_ p: CBPeripheral, didDiscoverServices error: Error?) {
        guard let s = p.services?.first(where: { $0.uuid == service }) else { return }
        p.discoverCharacteristics([tokenID], for: s)
    }

    func peripheral(_ p: CBPeripheral, didDiscoverCharacteristicsFor s: CBService, error: Error?) {
        guard let c = s.characteristics?.first(where: { $0.uuid == tokenID }) else { return }
        tokenChar = c
        p.readValue(for: c)
    }

    func peripheral(_ p: CBPeripheral, didUpdateValueFor c: CBCharacteristic, error: Error?) {
        guard error == nil, let v = c.value, !v.isEmpty, v != lastToken else { return }
        lastToken = v
        onToken?(v)
    }

    func peripheral(_ p: CBPeripheral, didReadRSSI RSSI: NSNumber, error: Error?) {
        if error == nil { onRSSI?(RSSI.intValue) }
    }
}
