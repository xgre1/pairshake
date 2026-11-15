import CoreBluetooth
import CoreLocation
import CoreMotion
import CryptoKit
import NearbyInteraction
import Combine
import simd

/// Where is your person? Built to keep working when things go wrong:
/// - Ultra Wideband (Nearby Interaction) gives real distance and direction, like finding AirPods.
/// - The UWB token travels two ways at once: through the server and directly over Bluetooth,
///   so a bad venue Wi-Fi can't stop the two phones from finding each other.
/// - The direction is pinned to the room using the gyroscope, so the arrow stays right when you turn
///   or when the other person drops out of the narrow cone UWB can see.
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

    // how the radios are doing, logged every 5 s: UWB readings, how many had a direction
    private var stat = (uwb: 0, dir: 0, horiz: 0, since: Date())

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

    // Camera assistance: ARKit + UWB together see direction beyond UWB's narrow front cone and further away,
    // but only once the phone has been moved around in enough light. Plain UWB works in the dark and is
    // instant, but only for someone roughly in front of you. So: plain first; camera-assisted while no
    // direction comes; back to plain if the camera can't work it out either.
    private var assist = false
    private var assistSince = Date.distantPast
    private var plainSince = Date()
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
        runningWith = nil
        started = false
    }

    // MARK: UWB session

    private func buildSession() {
        guard NISession.deviceCapabilities.supportsPreciseDistanceMeasurement else { return }
        lastRebuild = Date()
        session?.invalidate()
        let s = NISession()
        s.delegate = self
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
        onLog?("uwb run, camera assist \(assist ? "on" : "off")")
        guard let s = session,
              let token = try? NSKeyedUnarchiver.unarchivedObject(ofClass: NIDiscoveryToken.self, from: data) else { return }
        let config = NINearbyPeerConfiguration(peerToken: token)
        config.isCameraAssistanceEnabled = assist && NISession.deviceCapabilities.supportsCameraAssistance
        s.run(config)
        runningWith = data
        lastRun = Date()
    }

    private func chooseAssist(_ now: Date, _ peer: Data) {
        let noDir = now.timeIntervalSince(max(lastDirAt ?? .distantPast, assist ? assistSince : plainSince))
        if !assist {
            // in front of you UWB answers within a second; quiet for 5 s means they're off to the side or behind
            coach = noDir > 2 ? "turn" : nil
            if noDir > 5, NISession.deviceCapabilities.supportsCameraAssistance {
                assist = true; assistSince = now; coach = "sweep"; run(with: peer)
            }
        } else if noDir > 15 || (coach == "light" && now.timeIntervalSince(assistSince) > 8) {
            assist = false; plainSince = now; coach = nil; run(with: peer)       // the camera can't help here
        }
    }

    /// Once a second: restart whatever has stalled, and decide what the screen shows.
    private func check() {
        let now = Date()
        if now.timeIntervalSince(stat.since) >= 5 {
            let t = now.timeIntervalSince(stat.since)
            onLog?(String(format: "uwb %.1f/s, with direction %.1f/s, angle only %.1f/s, mode %@, distance %@, coach %@",
                          Double(stat.uwb) / t, Double(stat.dir) / t, Double(stat.horiz) / t, "\(mode)",
                          distance.map { String(format: "%.1f m", $0) } ?? "-", coach ?? "-"))
            stat = (0, 0, 0, now)
        }
        let live = lastUWB.map { now.timeIntervalSince($0) < 2 } ?? false
        if live, let p = peerToken { chooseAssist(now, p) }

        if session != nil, !live {
            // keep offering my token until we're ranging; it's tiny
            if now.timeIntervalSince(lastTokenSent) > 3 { shareToken() }
            let quiet = now.timeIntervalSince(lastUWB ?? lastRun ?? now)
            if let p = peerToken, now.timeIntervalSince(lastRun ?? .distantPast) > 5 { run(with: p) }
            if quiet > 20, now.timeIntervalSince(lastRebuild) > 20 { buildSession() }
        }

        // an old direction is still useful for a while because it's pinned to the room
        if let d = lastDirection, now.timeIntervalSince(d) > 45 { target = nil; lastDirection = nil }

        let bt = lastRSSI.map { now.timeIntervalSince($0) < 4 } ?? false
        if live {
            mode = .uwb
        } else if bt, let r = smoothedRSSI {
            mode = .bluetooth
            distance = PeerLink.metres(fromRSSI: r)
        } else {
            mode = .searching
        }
        precise = live
        if lastDirection == nil, pointing != nil, mode != .estimate { angle = nil }   // no direction pinned yet
        updateAngle()
    }

    fileprivate func uwbUpdate(distance d: Double?, direction: simd_float3?, horizontalAngle: Double?) {
        lastUWB = Date()
        stat.uwb += 1
        if direction != nil { stat.dir += 1 } else if horizontalAngle != nil { stat.horiz += 1 }
        if direction != nil || horizontalAngle != nil { lastDirAt = Date() }
        if let d { distance = steady(d) }
        if let p = pointing, let q = currentAttitude {
            if let dir = direction {
                let w = toWorld(simd_double3(dir), q)
                if hypot(w.x, w.y) > 0.25 { pin(atan2(w.y, w.x)) }
            } else if let h = horizontalAngle {
                pin(p - h)
            }
        } else if let dir = direction {
            angle = Double(atan2(dir.x, -dir.z))          // no motion data: show it raw
        } else if let h = horizontalAngle {
            angle = h
        }
        if mode != .uwb { mode = .uwb; precise = true }
        updateAngle()
    }

    /// Median of the last three readings, so one bad bounce can't make the number jump.
    private func steady(_ d: Double) -> Double {
        recentDistances.append(d)
        if recentDistances.count > 3 { recentDistances.removeFirst() }
        return recentDistances.sorted()[recentDistances.count / 2]
    }

    private func pin(_ azimuth: Double) {
        lastDirection = Date()
        guard let t = target else { target = azimuth; return }
        // average on the circle so 359° and 1° don't average to 180°
        let x = 0.65 * cos(t) + 0.35 * cos(azimuth), y = 0.65 * sin(t) + 0.35 * sin(azimuth)
        target = atan2(y, x)
    }

    private func updateAngle() {
        guard let t = target, let p = pointing else { return }
        angle = wrap(p - t)
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
        Task { @MainActor in self.uwbUpdate(distance: d, direction: dir, horizontalAngle: h) }
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
            self.onLog?("uwb session ended: \(error.localizedDescription)")
            guard self.started, self.session === session else { return }
            self.precise = false
            self.session = nil
            // a dead session can't be revived: start a new one (new token) after a short pause
            try? await Task.sleep(for: .seconds(1))
            if self.started, self.session == nil { self.buildSession(); if let p = self.peerToken { self.run(with: p) } }
        }
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
        let h = Array(SHA256.hash(data: Data("roomie-find-\(room)".utf8)).prefix(16))
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
