import CoreBluetooth
import CoreLocation
import CoreMotion
import CryptoKit
import NearbyInteraction
import simd
import SwiftUI

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

    var sendToken: ((Data) -> Void)?

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
        guard let s = session,
              let token = try? NSKeyedUnarchiver.unarchivedObject(ofClass: NIDiscoveryToken.self, from: data) else { return }
        let config = NINearbyPeerConfiguration(peerToken: token)
        if NISession.deviceCapabilities.supportsCameraAssistance { config.isCameraAssistanceEnabled = true }
        s.run(config)
        runningWith = data
        lastRun = Date()
    }

    /// Once a second: restart whatever has stalled, and decide what the screen shows.
    private func check() {
        let now = Date()
        let live = lastUWB.map { now.timeIntervalSince($0) < 2 } ?? false

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
        updateAngle()
    }

    fileprivate func uwbUpdate(distance d: Double?, direction: simd_float3?, horizontalAngle: Double?) {
        lastUWB = Date()
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

// MARK: - The finding screen

/// Full screen, like finding AirPods: a big arrow, the distance, and the screen fills with
/// their colour when you face them.
struct FindView: View {
    let person: Person
    @ObservedObject var finder: Finder
    let close: () -> Void

    private var angle: Double { finder.angle ?? 0 }
    private var aligned: Bool { finder.angle != nil && abs(angle) < 0.28 }
    private var arrived: Bool { finder.precise && (finder.distance ?? 99) < 1.2 }

    var body: some View {
        ZStack {
            (aligned || arrived ? Color(hex: person.color) : Color(white: 0.07))
                .ignoresSafeArea()
                .animation(.easeInOut(duration: 0.35), value: aligned || arrived)

            VStack(spacing: 0) {
                HStack(spacing: 12) {
                    Avatar(person: person, size: 40)
                    VStack(alignment: .leading, spacing: 1) {
                        Text("Finding").font(.footnote).opacity(0.6)
                        Text(person.firstName).font(.headline)
                    }
                    Spacer()
                    Button(action: close) {
                        Image(systemName: "xmark").font(.footnote.weight(.bold))
                            .frame(width: 32, height: 32)
                            .background(.white.opacity(0.15), in: Circle())
                    }
                    .buttonStyle(.plain)
                }
                .padding(.horizontal, 24).padding(.top, 12)

                Spacer()
                ZStack {
                    if arrived {
                        PulseRing()
                    } else {
                        Image(systemName: "arrow.up")
                            .font(.system(size: 190, weight: .bold))
                            .rotationEffect(.radians(angle))
                            .animation(.interpolatingSpring(stiffness: 120, damping: 16), value: angle)
                            .opacity(finder.angle == nil ? 0.25 : 1)
                    }
                }
                .frame(height: 300)
                Spacer()

                VStack(alignment: .leading, spacing: 6) {
                    Text(distanceText)
                        .font(.system(size: 72, weight: .semibold, design: .rounded).monospacedDigit())
                        .contentTransition(.numericText())
                        .animation(.smooth, value: distanceText)
                    Text(directionText).font(.title2.weight(.medium)).opacity(0.75)
                    Text(person.spot).font(.subheadline).opacity(0.5).padding(.top, 10)
                    if let hint {
                        Text(hint).font(.caption).opacity(0.4)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 28)
                .padding(.bottom, 24)
            }
            .foregroundStyle(aligned || arrived ? Color.black : Color.white)
        }
        .preferredColorScheme(.dark)
        .sensoryFeedback(.impact(weight: .medium), trigger: aligned) { _, new in new }
        .sensoryFeedback(.increase, trigger: Int((finder.distance ?? 0).rounded()))
        .sensoryFeedback(.success, trigger: arrived) { _, new in new }
    }

    private var hint: String? {
        switch finder.mode {
        case .uwb: return nil
        case .estimate: return "Approximate: \(person.firstName) is a demo attendee"
        case .bluetooth: return "Rough distance. Keep walking, it gets exact when you're close."
        case .searching: return "Hold your phone up and turn slowly"
        }
    }

    private var distanceText: String {
        guard let d = finder.distance else { return "–" }
        if d < 1.2 && finder.mode != .bluetooth { return "Here" }
        if finder.mode == .bluetooth { return "~\(max(1, Int(d.rounded()))) m" }
        return d < 10 ? String(format: "%.1f m", d) : "\(Int(d.rounded())) m"
    }

    private var directionText: String {
        if arrived { return "\(person.firstName) is right next to you" }
        guard finder.angle != nil else { return finder.mode == .bluetooth ? "Getting closer…" : "Finding direction…" }
        let deg = angle * 180 / .pi
        if abs(deg) < 16 { return "ahead" }
        if abs(deg) > 135 { return "behind you" }
        return deg > 0 ? "to your right" : "to your left"
    }
}

struct PulseRing: View {
    @State private var on = false
    var body: some View {
        ZStack {
            ForEach(0..<3) { i in
                Circle().stroke(lineWidth: 3)
                    .frame(width: 120, height: 120)
                    .scaleEffect(on ? 2.2 : 0.6)
                    .opacity(on ? 0 : 0.8)
                    .animation(.easeOut(duration: 1.8).repeatForever(autoreverses: false).delay(Double(i) * 0.6), value: on)
            }
            Circle().frame(width: 34, height: 34)
        }
        .onAppear { on = true }
    }
}

/// A small live version for the "you both said yes" card.
struct MiniFinder: View {
    @ObservedObject var finder: Finder
    var body: some View {
        HStack(spacing: 14) {
            Image(systemName: "arrow.up")
                .font(.system(size: 26, weight: .bold))
                .rotationEffect(.radians(finder.angle ?? 0))
                .animation(.interpolatingSpring(stiffness: 120, damping: 16), value: finder.angle ?? 0)
                .frame(width: 44, height: 44)
                .background(.thinMaterial, in: Circle())
            if let d = finder.distance {
                Text(finder.mode == .bluetooth ? "~\(max(1, Int(d.rounded()))) m"
                     : d < 1.2 ? "Here" : (d < 10 ? String(format: "%.1f m", d) : "\(Int(d.rounded())) m"))
                    .font(.title2.weight(.semibold).monospacedDigit())
                    .contentTransition(.numericText())
            }
        }
    }
}
