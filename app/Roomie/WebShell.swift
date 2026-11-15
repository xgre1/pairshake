import AuthenticationServices
import AVFoundation
import CoreLocation
import SwiftUI
import UIKit
import WebKit

/// The whole app is the PairShake web page (the same one the audience opens), shown full screen.
/// The phone adds what a browser can't do:
/// - Finding your person with the phones' own radios (Ultra Wideband + Bluetooth, see Finder),
///   wired into the page's own finding screen.
/// - GPS from Core Location (one permission prompt, no "this website wants your location").
/// - Real haptics, microphone and motion granted without the web prompts, screen kept awake.
final class WebShell: UIViewController, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler, UITabBarDelegate {
    private var web: WKWebView!
    private let tabs = UITabBar()                      // iOS's own tab bar, shown when the page asks ("tabs")
    private var finder: Finder?
    private var signIn: ASWebAuthenticationSession?     // LinkedIn's sign-in sheet while it is open
    private var findRoom: String?
    private var pushTimer: Timer?
    private var lastFix = ""
    private var lastFixAt = Date.distantPast
    private let gps = Locator()
    private let local = LocalServer()
    private var useLocal = false
    private var sheetOpen = false
    private var retry: Timer?
    private let waiting = UIView()
    private var keyboard: CGFloat = 0           // how much of the screen the keyboard covers

    // Diagnostics: what the page reports (errors, load times, whether the hands came up), one file per
    // launch in the app's Documents. Read on the Mac with
    // xcrun devicectl device copy from --device <id> --domain-type appDataContainer
    //   --domain-identifier com.jtobin.roomie --source Documents/web.log --destination web.log
    private let logURL = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("web.log")
    private let started = Date()
    private func note(_ line: String) {
        let t = String(format: "%7.2f ", Date().timeIntervalSince(started))
        guard let data = (t + line + "\n").data(using: .utf8) else { return }
        if let h = try? FileHandle(forWritingTo: logURL) { h.seekToEndOfFile(); h.write(data); try? h.close() }
        else { try? data.write(to: logURL) }
    }

    override func loadView() {
        let content = WKUserContentController()
        content.add(WeakHandler(self), name: "roomie")
        content.addUserScript(WKUserScript(source: Self.bridge, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        content.addUserScript(WKUserScript(source: Self.feel, injectionTime: .atDocumentEnd, forMainFrameOnly: true))

        let config = WKWebViewConfiguration()
        config.userContentController = content
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        config.applicationNameForUserAgent = "RoomieApp"

        web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = self
        web.uiDelegate = self
        web.isInspectable = true                       // Safari > Develop > iPhone, for debugging on stage
        web.allowsLinkPreview = false
        web.allowsBackForwardNavigationGestures = false
        web.isOpaque = false
        web.backgroundColor = .systemBackground
        web.scrollView.backgroundColor = .systemBackground
        web.scrollView.contentInsetAdjustmentBehavior = .never   // the page pads for the notch itself
        web.scrollView.bounces = true                  // rubber band at the ends of pages that scroll, like any iOS list
        web.scrollView.alwaysBounceVertical = false    // (a page that fits the screen stays still)
        web.scrollView.alwaysBounceHorizontal = false
        hideFormBar(web)
        let root = UIView()
        root.backgroundColor = .systemBackground
        web.frame = root.bounds
        root.addSubview(web)
        // The tab bar is the system's; which screen each tab opens is the page's business (RoomieApp.onTab).
        tabs.items = [("Home", "house.fill"), ("People", "person.2.fill"), ("You", "person.crop.circle.fill"),
                      ("Settings", "gearshape.fill")].enumerated().map { i, t in
            UITabBarItem(title: t.0, image: UIImage(systemName: t.1), tag: i)
        }
        tabs.delegate = self
        tabs.tintColor = .label
        tabs.isHidden = true
        tabs.translatesAutoresizingMaskIntoConstraints = false
        root.addSubview(tabs)
        NSLayoutConstraint.activate([tabs.leadingAnchor.constraint(equalTo: root.leadingAnchor),
                                     tabs.trailingAnchor.constraint(equalTo: root.trailingAnchor),
                                     tabs.bottomAnchor.constraint(equalTo: root.bottomAnchor)])
        buildWaiting(in: root)
        view = root

        gps.onFix = { [weak self] js in self?.js(js) }
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        let prev = logURL.deletingLastPathComponent().appendingPathComponent("web.prev.log")
        try? FileManager.default.removeItem(at: prev)
        try? FileManager.default.moveItem(at: logURL, to: prev)
        note("launch \(UIDevice.current.model) iOS \(UIDevice.current.systemVersion) server \(Server.address)")
        UIApplication.shared.isIdleTimerDisabled = true
        try? AVAudioSession.sharedInstance().setCategory(.playAndRecord, mode: .default,
                                                         options: [.defaultToSpeaker, .allowBluetoothA2DP])
        try? AVAudioSession.sharedInstance().setActive(true)
        local.onReady = { [weak self] ok in
            self?.note(ok ? "local server ready" : "local server failed, loading the server directly")
            self?.useLocal = ok
            self?.reconnect()
        }
        local.start()
        // The keyboard: the page is made shorter so it ends where the keyboard starts, the way a native chat
        // screen does. Letting the keyboard cover the page instead makes WebKit pan it, and on iOS 26 it doesn't
        // always pan back (WebKit bug 297779), which leaves the top bar and its back arrow halfway down.
        NotificationCenter.default.addObserver(forName: UIResponder.keyboardWillChangeFrameNotification, object: nil, queue: .main) { [weak self] n in
            MainActor.assumeIsolated { self?.keyboardMoved(n) }
        }
        NotificationCenter.default.addObserver(forName: UIResponder.keyboardDidHideNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.settle() }
        }
        NotificationCenter.default.addObserver(forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.note("back in front"); self?.local.restart() }
        }
    }

    /// A quiet "Connecting…" over the page while the server can't be reached (it may be restarting).
    private func buildWaiting(in root: UIView) {
        waiting.backgroundColor = .systemBackground
        waiting.isHidden = true
        waiting.frame = root.bounds
        waiting.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        let spin = UIActivityIndicatorView(style: .medium)
        spin.startAnimating()
        let title = UILabel()
        title.text = "Connecting to PairShake…"
        title.font = .preferredFont(forTextStyle: .headline)
        let hint = UILabel()
        hint.text = "Shake the phone to change the server."
        hint.font = .preferredFont(forTextStyle: .footnote)
        hint.textColor = .secondaryLabel
        let stack = UIStackView(arrangedSubviews: [spin, title, hint])
        stack.axis = .vertical
        stack.alignment = .center
        stack.spacing = 10
        stack.translatesAutoresizingMaskIntoConstraints = false
        waiting.addSubview(stack)
        NSLayoutConstraint.activate([stack.centerXAnchor.constraint(equalTo: waiting.centerXAnchor),
                                     stack.centerYAnchor.constraint(equalTo: waiting.centerYAnchor)])
        root.addSubview(waiting)
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        web.frame = CGRect(x: 0, y: 0, width: view.bounds.width, height: view.bounds.height - keyboard)
    }

    private func keyboardMoved(_ n: Notification) {
        // the keyboard of the LinkedIn/Google sign-in sheet isn't ours: closing the sheet with it up never says it
        // went away, and the page would stay squeezed to nothing (a white screen)
        guard signIn == nil else { return }
        guard let end = n.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect else { return }
        let local = view.convert(end, from: nil)
        let cover = max(0, view.bounds.maxY - local.minY)
        guard cover != keyboard else { return }
        keyboard = cover
        let time = n.userInfo?[UIResponder.keyboardAnimationDurationUserInfoKey] as? Double ?? 0.25
        let curve = n.userInfo?[UIResponder.keyboardAnimationCurveUserInfoKey] as? Int ?? 7
        UIView.animate(withDuration: time, delay: 0, options: UIView.AnimationOptions(rawValue: UInt(curve) << 16)) {
            self.view.setNeedsLayout()
            self.view.layoutIfNeeded()
        } completion: { _ in
            // WebKit scrolls the focused field above the keyboard as it comes up, before the page has been made
            // shorter; once it has, that scroll only pushes the whole page up (top bar under the status bar,
            // a gap under the message box). The page fits now, so it goes back in place.
            self.settle()
        }
    }

    /// After the keyboard: put the page back exactly in place if WebKit left it scrolled past its end.
    private func settle() {
        let sv = web.scrollView
        let maxY = max(0, sv.contentSize.height - sv.bounds.height)
        if sv.contentOffset.y > maxY || sv.contentOffset.y < 0 { sv.setContentOffset(CGPoint(x: 0, y: min(max(0, sv.contentOffset.y), maxY)), animated: false) }
        js("window.scrollTo(window.scrollX, window.scrollY)")
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        becomeFirstResponder()
    }

    /// Find the server (an address typed in by hand first, then PairShake's Cloudflare address), then load the page.
    private func reconnect() {
        Server.pick { [weak self] s in
            self?.note("server \(s)")
            self?.load()
        }
    }

    private func load() {
        note("load")
        let url = useLocal ? URL(string: "http://localhost:\(LocalServer.port)/")! : Server.url
        web.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 30))
    }

    private func js(_ s: String) { web.evaluateJavaScript(s, completionHandler: nil) }

    // MARK: shake for the server address

    override var canBecomeFirstResponder: Bool { true }

    override func motionEnded(_ motion: UIEvent.EventSubtype, with event: UIEvent?) {
        if motion == .motionShake { askForServer(problem: nil) }
        else { super.motionEnded(motion, with: event) }
    }

    private func askForServer(problem: String?) {
        guard !sheetOpen else { return }
        sheetOpen = true
        var host: UIHostingController<ServerSheet>?
        let close = { [weak self] in host?.dismiss(animated: true); self?.sheetOpen = false }
        host = UIHostingController(rootView: ServerSheet(address: Server.address, problem: problem, connect: { [weak self] a in
            Server.address = a
            close()
            self?.reconnect()
        }, cancel: { [weak self] in
            close()
            if problem != nil { self?.reconnect() }       // try again
        }))
        host?.isModalInPresentation = true
        if let host { present(host, animated: true) }
    }

    func tabBar(_ tabBar: UITabBar, didSelect item: UITabBarItem) {
        UISelectionFeedbackGenerator().selectionChanged()
        js("window.RoomieApp && RoomieApp.onTab && RoomieApp.onTab(\(item.tag))")
    }

    // MARK: messages from the page

    func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let d = message.body as? [String: Any], let t = d["t"] as? String else { return }
        switch t {
        case "find":                                        // both said yes: start the radios
            if let room = d["room"] as? String { startFinding(room: room) }
        case "ni":                                          // the other iPhone's UWB token, relayed by the server
            if let s = d["token"] as? String, let data = Data(base64Encoded: s) { finderFor(nil).received(data) }
        case "geo":
            (d["on"] as? Bool ?? false) ? gps.start() : gps.stop()
        case "tabs":                                        // the page is on one of its tab screens (or not)
            tabs.isHidden = !(d["on"] as? Bool ?? false)
            if let i = d["sel"] as? Int, tabs.items?.indices.contains(i) == true { tabs.selectedItem = tabs.items?[i] }
        case "server":                                      // Settings > Server
            askForServer(problem: nil)
        case "log":
            note(d["m"] as? String ?? "")
        case "signin", "linkedin":                          // Continue with LinkedIn or Google: Apple's sign-in sheet, not the page
            if let s = d["url"] as? String, let url = URL(string: s) { signInWithLinkedIn(url) }
        case "haptic":
            haptic(d["k"] as? String ?? "light")
        default:
            break
        }
    }

    /// LinkedIn or Google in Apple's sign-in sheet (it shares Safari's session, so usually one tap). The server
    /// ends the sign-in by sending the sheet to pairshake://signin?id=... (or ?error=...), handed to the page.
    private func signInWithLinkedIn(_ url: URL) {
        let s = ASWebAuthenticationSession(url: url, callbackURLScheme: "pairshake") { [weak self] back, error in
            DispatchQueue.main.async {
                self?.signIn = nil
                if let me = self, me.keyboard != 0 { me.keyboard = 0; me.view.setNeedsLayout(); me.view.layoutIfNeeded() }
                self?.note("signin done err=\(String(describing: error)) kb=\(self?.keyboard ?? -1) web=\(self?.web.frame ?? .zero) hidden=\(self?.web.isHidden ?? false) alpha=\(self?.web.alpha ?? -1)")
                self?.js("APP?.post({t:'log', m:'page screen=' + document.body.dataset.screen + ' on=' + [...document.querySelectorAll('.screen.on')].map(e=>e.id) + ' vh=' + innerHeight + ' sy=' + scrollY + ' vis=' + document.visibilityState})")
                let q = back.flatMap { URLComponents(url: $0, resolvingAgainstBaseURL: false)?.queryItems } ?? []
                let id = q.first { $0.name == "id" }?.value ?? ""
                let err = q.first { $0.name == "error" }?.value ?? (error == nil ? "" : "cancelled")
                let safe = { (v: String) in v.filter { $0.isLetter || $0.isNumber || $0 == "_" || $0 == "-" } }
                self?.js("window.RoomieApp && RoomieApp.onLogin && RoomieApp.onLogin('\(safe(id))', '\(safe(err))')")
            }
        }
        s.presentationContextProvider = self
        s.prefersEphemeralWebBrowserSession = false
        signIn = s
        s.start()
    }

    /// A token can arrive before the finding starts (the other person said yes first).
    private func finderFor(_ room: String?) -> Finder {
        if let f = finder, room == nil || findRoom == nil || room == findRoom {
            if let room { findRoom = room }
            return f
        }
        finder?.stop()                                      // a different introduction: start fresh
        let f = Finder()
        f.onLog = { [weak self] line in self?.note(line) }
        f.sendToken = { [weak self] data in
            self?.js("window.RoomieApp && RoomieApp.onToken && RoomieApp.onToken('\(data.base64EncodedString())')")
        }
        finder = f
        findRoom = room
        return f
    }

    private func startFinding(room: String) {
        let f = finderFor(room)
        f.start(peer: true, room: room)
        pushTimer?.invalidate()
        pushTimer = Timer.scheduledTimer(withTimeInterval: 1.0 / 15, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.pushFix() }
        }
    }

    /// What the radios say, 15 times a second (or once a second if nothing changed, so the page knows it's live).
    private func pushFix() {
        guard let f = finder else { return }
        let num: (Double?, Int) -> String = { v, p in
            guard let v, v.isFinite else { return "null" }
            return String(format: "%.\(p)f", v)
        }
        let fix = "{d:\(num(f.distance, 2)),a:\(num(f.angle, 3)),mode:'\(f.mode)',coach:\(f.coach.map { "'\($0)'" } ?? "null")}"
        guard fix != lastFix || Date().timeIntervalSince(lastFixAt) > 1 else { return }
        lastFix = fix
        lastFixAt = Date()
        js("window.RoomieApp && RoomieApp.onFix && RoomieApp.onFix(\(fix))")
    }

    private func haptic(_ k: String) {
        switch k {
        case "success": UINotificationFeedbackGenerator().notificationOccurred(.success)
        case "warning": UINotificationFeedbackGenerator().notificationOccurred(.warning)
        default: UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        }
    }

    // MARK: loading

    func webView(_ w: WKWebView, didCommit n: WKNavigation!) {
        note("page committed")
        retry?.invalidate()
        waiting.isHidden = true
        let info = Bundle.main.infoDictionary
        let version = "\(info?["CFBundleShortVersionString"] as? String ?? "?") (\(info?["CFBundleVersion"] as? String ?? "?"))"
        js("window.RoomieApp && (RoomieApp.server = '\(Server.active)', RoomieApp.version = '\(version)')")
    }
    func webView(_ w: WKWebView, didFinish n: WKNavigation!) { note("page finished") }

    func webView(_ w: WKWebView, didFailProvisionalNavigation n: WKNavigation!, withError error: Error) {
        note("failed: \(error.localizedDescription)")
        cantReach(error.localizedDescription)
    }

    func webView(_ w: WKWebView, didFail n: WKNavigation!, withError error: Error) {
        if (error as NSError).code != NSURLErrorCancelled { cantReach(error.localizedDescription) }
    }

    func webView(_ w: WKWebView, decidePolicyFor r: WKNavigationResponse) async -> WKNavigationResponsePolicy {
        if r.isForMainFrame, let h = r.response as? HTTPURLResponse, h.statusCode >= 400 {
            cantReach("The server answered \(h.statusCode). If the tunnel was restarted, paste its new link.")
            return .cancel
        }
        return .allow
    }

    /// Links to someone's X or LinkedIn open in their app or Safari, never inside PairShake.
    func webView(_ w: WKWebView, decidePolicyFor a: WKNavigationAction) async -> WKNavigationActionPolicy {
        guard let url = a.request.url, a.targetFrame?.isMainFrame ?? true else { return .allow }
        let scheme = url.scheme ?? ""
        if ["http", "https"].contains(scheme) ? (url.host == Server.url.host || url.host == "localhost") : ["about", "blob", "data"].contains(scheme) {
            return .allow
        }
        await UIApplication.shared.open(url)
        return .cancel
    }

    func webView(_ w: WKWebView, createWebViewWith c: WKWebViewConfiguration, for a: WKNavigationAction,
                 windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = a.request.url { UIApplication.shared.open(url) }
        return nil
    }

    func webViewWebContentProcessDidTerminate(_ w: WKWebView) { note("web content process died (memory?), reloading"); load() }

    override func didReceiveMemoryWarning() { super.didReceiveMemoryWarning(); note("memory warning") }

    /// Usually the server is restarting or the Wi-Fi blinked: say so and try again every 2 s.
    private func cantReach(_ why: String) {
        note("can't reach \(Server.active): \(why)")
        waiting.isHidden = false
        retry?.invalidate()
        retry = Timer.scheduledTimer(withTimeInterval: 2, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated { self?.reconnect() }
        }
    }

    /// The Mac on this Wi-Fi may use a self-signed certificate: trust it for our own server only.
    func webView(_ w: WKWebView, respondTo challenge: URLAuthenticationChallenge)
        async -> (URLSession.AuthChallengeDisposition, URLCredential?) {
        if challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
           challenge.protectionSpace.host == Server.url.host, let trust = challenge.protectionSpace.serverTrust {
            return (.useCredential, URLCredential(trust: trust))
        }
        return (.performDefaultHandling, nil)
    }

    // MARK: permissions: the app already asked (once, natively), so no second prompt from the page

    func webView(_ w: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame f: WKFrameInfo,
                 type: WKMediaCaptureType) async -> WKPermissionDecision { .grant }

    func webView(_ w: WKWebView, requestDeviceOrientationAndMotionPermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame f: WKFrameInfo) async -> WKPermissionDecision { .grant }

    // MARK: injected scripts

    /// Runs before the page: tells it it's in the app, and serves GPS from Core Location.
    private static let bridge = """
    (() => {
      const post = m => { try { webkit.messageHandlers.roomie.postMessage(m); } catch (e) {} };
      const watchers = new Map(); let next = 1, last = null;
      window.RoomieApp = {
        native: true, tabs: true, linkedin: true, post, onTab: null, onFix: null, onToken: null, onLogin: null,
        geo(c) { last = c; const p = {coords: c, timestamp: Date.now()}; for (const w of [...watchers.values()]) { try { w(p); } catch (e) {} } },
      };
      const geo = {
        watchPosition(ok) { const id = next++; watchers.set(id, ok); post({t: "geo", on: true}); if (last) setTimeout(() => RoomieApp.geo(last)); return id; },
        clearWatch(id) { watchers.delete(id); if (!watchers.size) post({t: "geo", on: false}); },
        getCurrentPosition(ok) { const id = geo.watchPosition(p => { geo.clearWatch(id); ok(p); }); },
      };
      try { Object.defineProperty(navigator, "geolocation", {value: geo, configurable: true}); } catch (e) {}
      // diagnostics for the app's log file
      const str = x => { try { return typeof x === "string" ? x : x instanceof Error ? x.name + ": " + x.message + " " + (x.stack || "").split("\\n")[0] : JSON.stringify(x); } catch (e) { return String(x); } };
      const log = (...a) => post({t: "log", m: a.map(str).join(" ").slice(0, 4000)});
      for (const k of ["warn", "error"]) { const o = console[k].bind(console); console[k] = (...a) => { log(k, ...a); o(...a); }; }
      addEventListener("error", e => log("error", e.message || (e.target && (e.target.src || e.target.href)) || "?", e.filename || "", e.lineno || ""), true);
      addEventListener("unhandledrejection", e => log("rejection", e.reason && (e.reason.stack || e.reason.message) || String(e.reason)));
      addEventListener("DOMContentLoaded", () => log("dom ready"));
      addEventListener("load", () => log("all loaded"));
      let gl2 = null;
      for (const s of [5, 12, 25, 45]) setTimeout(() => {
        if (gl2 == null) { try { gl2 = !!document.createElement("canvas").getContext("webgl2"); } catch (e) { gl2 = "err " + e; } }
        const res = performance.getEntriesByType("resource").map(r => r.name.split("/").pop().split("?")[0] + " " + Math.round(r.startTime) + "+" + Math.round(r.duration) + "ms " + Math.round(r.transferSize / 1024) + "KB");
        log("t=" + s + "s screen=" + document.body?.dataset.screen + " hands=" + (window.Hands ? window.Hands.ok : "none") + " ring=" + (window.Ring ? window.Ring.ok : "none") + " webgl2=" + gl2 + " secure=" + window.isSecureContext + " mic=" + !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia), "\\n  " + res.join("\\n  "));
      }, s * 1000);
    })();
    """

    /// Feels like an app: no pinch zoom, no long-press callouts or text selection outside text fields.
    private static let feel = """
    (() => {
      const v = document.querySelector('meta[name=viewport]');
      if (v && !/user-scalable/.test(v.content)) v.content += ', maximum-scale=1, user-scalable=no';
      const s = document.createElement('style');
      s.textContent = 'html{-webkit-touch-callout:none;-webkit-text-size-adjust:100%}body{-webkit-user-select:none;user-select:none}input,textarea,[contenteditable]{-webkit-user-select:text;user-select:text}';
      document.head.appendChild(s);
    })();
    """
}

/// WKUserContentController keeps its handlers alive; this stops it keeping the shell alive.
private final class WeakHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?
    init(_ t: WKScriptMessageHandler) { target = t }
    func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
        target?.userContentController(c, didReceive: m)
    }
}

/// GPS for the page's finding screen (it falls back to this when the two phones can't range by radio,
/// e.g. when your person is on the web page).
extension WebShell: ASWebAuthenticationPresentationContextProviding {
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        view.window ?? ASPresentationAnchor()
    }
}

final class Locator: NSObject, CLLocationManagerDelegate {
    var onFix: ((String) -> Void)?
    private let manager = CLLocationManager()

    override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyBest
        manager.activityType = .otherNavigation
    }

    func start() {
        manager.requestWhenInUseAuthorization()
        manager.startUpdatingLocation()
    }

    func stop() { manager.stopUpdatingLocation() }

    func locationManager(_ m: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let l = locations.last, l.horizontalAccuracy >= 0 else { return }
        let speed = l.speed >= 0 ? String(l.speed) : "null"
        let course = l.course >= 0 ? String(l.course) : "null"
        onFix?("window.RoomieApp && RoomieApp.geo({latitude:\(l.coordinate.latitude),longitude:\(l.coordinate.longitude),accuracy:\(l.horizontalAccuracy),speed:\(speed),heading:\(course)})")
    }
}

/// No ^ v ✓ bar above the keyboard: WebKit adds it to every text field, and a native chat screen has none.
/// The view that holds the page's text input is switched to a subclass whose inputAccessoryView is empty.
@MainActor private func hideFormBar(_ web: WKWebView) {
    guard let content = web.scrollView.subviews.first(where: { String(describing: type(of: $0)).hasPrefix("WKContent") })
    else { return }
    let base: AnyClass = type(of: content)
    let name = "\(NSStringFromClass(base))_NoFormBar"
    var cls: AnyClass? = NSClassFromString(name)
    if cls == nil, let made = objc_allocateClassPair(base, name, 0) {
        let none: @convention(block) (AnyObject) -> UIView? = { _ in nil }
        class_addMethod(made, #selector(getter: UIResponder.inputAccessoryView), imp_implementationWithBlock(none), "@@:")
        objc_registerClassPair(made)
        cls = made
    }
    if let cls { object_setClass(content, cls) }
}

struct WebShellView: UIViewControllerRepresentable {
    func makeUIViewController(context: Context) -> WebShell { WebShell() }
    func updateUIViewController(_ vc: WebShell, context: Context) {}
}
