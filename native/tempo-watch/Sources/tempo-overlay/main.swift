// tempo-overlay: floats Tempo over the chess game you're playing.
//
//   tempo-overlay --url http://localhost:3100/overlay
//
// Two always-on-top windows that follow the game window while it is frontmost:
//   - a HUD (web view on a blurred panel) with the eval, hints, and coach. Drag it by its top edge.
//   - a click-through layer over Chess.app's board that draws the hint square and arrow on the real squares.
//
// Chess.app publishes each square's screen frame through Accessibility, so marks land on the board at any
// view angle. A browser doesn't publish Lichess's board, so Lichess games get the HUD only.
// Read-only: it never clicks or types in the game.

import AppKit
import ApplicationServices
import TempoAX
import WebKit

let browserBundleIDs: Set<String> = [
    "com.apple.Safari", "com.google.Chrome", "company.thebrowser.Browser", "com.brave.Browser",
    "com.microsoft.edgemac", "org.mozilla.firefox", "com.vivaldi.Vivaldi", "com.operasoftware.Opera",
]

let hudWidth: CGFloat = 320
let accent = NSColor(srgbRed: 0x6e / 255, green: 0xa4 / 255, blue: 0xf4 / 255, alpha: 0.9)

/// Accessibility rects have a top-left origin; AppKit windows use bottom-left of the primary display.
func cocoaRect(_ ax: CGRect) -> NSRect {
    let h = NSScreen.screens.first?.frame.height ?? 0
    return NSRect(x: ax.minX, y: h - ax.maxY, width: ax.width, height: ax.height)
}

final class Panel: NSPanel {
    override var canBecomeKey: Bool { true }
}

func makePanel() -> Panel {
    let p = Panel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    p.isOpaque = false
    p.backgroundColor = .clear
    p.hasShadow = false
    p.level = .floating
    p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
    p.hidesOnDeactivate = false
    p.isReleasedWhenClosed = false
    p.becomesKeyOnlyIfNeeded = true
    return p
}

/// Lets a click on the HUD act immediately instead of only focusing the panel.
final class HudWebView: WKWebView {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

/// Top strip of the HUD. Dragging it moves the panel.
final class DragStrip: NSView {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func mouseDown(with event: NSEvent) { window?.performDrag(with: event) }
    override func resetCursorRects() { addCursorRect(bounds, cursor: .openHand) }
    override func draw(_ dirtyRect: NSRect) {
        NSColor.white.withAlphaComponent(0.3).setFill()
        NSBezierPath(roundedRect: NSRect(x: bounds.midX - 16, y: bounds.midY - 2, width: 32, height: 4), xRadius: 2, yRadius: 2).fill()
    }
}

/// Draws the hint marks. Coordinates are relative to the game window's top-left corner.
final class MarksView: NSView {
    var highlight: CGRect?
    var arrow: (from: CGRect, to: CGRect)?
    override var isFlipped: Bool { true }

    override func draw(_ dirtyRect: NSRect) {
        if let r = highlight {
            let inset = r.insetBy(dx: 3, dy: 3)
            let path = NSBezierPath(roundedRect: inset, xRadius: 6, yRadius: 6)
            path.lineWidth = 4
            accent.setStroke()
            path.stroke()
        }
        guard let a = arrow else { return }
        let start = CGPoint(x: a.from.midX, y: a.from.midY)
        let end = CGPoint(x: a.to.midX, y: a.to.midY)
        let dx = end.x - start.x
        let dy = end.y - start.y
        let len = hypot(dx, dy)
        guard len > 1 else { return }
        let ux = dx / len
        let uy = dy / len
        let size = min(a.to.width, a.to.height)
        let shaft = max(6, size * 0.16)
        let head = max(16, size * 0.42)
        let neck = CGPoint(x: end.x - ux * head, y: end.y - uy * head)
        let line = NSBezierPath()
        line.move(to: CGPoint(x: start.x + ux * size * 0.25, y: start.y + uy * size * 0.25))
        line.line(to: neck)
        line.lineWidth = shaft
        line.lineCapStyle = .round
        accent.setStroke()
        line.stroke()
        let tip = NSBezierPath()
        tip.move(to: end)
        tip.line(to: CGPoint(x: neck.x - uy * head * 0.5, y: neck.y + ux * head * 0.5))
        tip.line(to: CGPoint(x: neck.x + uy * head * 0.5, y: neck.y - ux * head * 0.5))
        tip.close()
        accent.setFill()
        tip.fill()
    }
}

final class Overlay: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
    private let url: URL
    private let hud = makePanel()
    private let marks = makePanel()
    private let marksView = MarksView()
    private let web: HudWebView
    private var hudHeight: CGFloat = 96
    // What the page asked to be marked, and which source its game came from.
    private var wantSquare: String?
    private var wantArrow: String?
    private var gameSource: String?
    fileprivate var squares: [String: AXUIElement] = [:]
    private var boardView: AXUIElement?
    private var squaresAge = 0
    private var target: CGRect?
    private var placing = false
    // HUD position relative to the game window's top-right corner. Changed by dragging.
    private var offset = CGPoint(x: UserDefaults.standard.double(forKey: "hudDX"), y: UserDefaults.standard.double(forKey: "hudDY"))

    init(url: URL) {
        self.url = url
        let cfg = WKWebViewConfiguration()
        web = HudWebView(frame: .zero, configuration: cfg)
        super.init()
        cfg.userContentController.add(self, name: "tempo")
        web.navigationDelegate = self
        web.setValue(false, forKey: "drawsBackground")

        let blur = NSVisualEffectView()
        blur.material = .hudWindow
        blur.blendingMode = .behindWindow
        blur.state = .active
        blur.wantsLayer = true
        blur.layer?.cornerRadius = 12
        blur.layer?.masksToBounds = true
        hud.contentView = blur
        web.frame = blur.bounds
        web.autoresizingMask = [.width, .height]
        blur.addSubview(web)
        let strip = DragStrip(frame: NSRect(x: 0, y: blur.bounds.height - 20, width: blur.bounds.width, height: 20))
        strip.autoresizingMask = [.width, .minYMargin]
        blur.addSubview(strip)

        marks.ignoresMouseEvents = true
        marks.contentView = marksView

        NotificationCenter.default.addObserver(self, selector: #selector(hudMoved), name: NSWindow.didMoveNotification, object: hud)
        web.load(URLRequest(url: url))
        Timer.scheduledTimer(withTimeInterval: 0.12, repeats: true) { [weak self] _ in self?.tick() }
    }

    // MARK: Page bridge

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any] else { return }
        if let h = body["height"] as? Double { hudHeight = CGFloat(min(max(h, 48), 720)) }
        if body.keys.contains("source") {
            gameSource = body["source"] as? String
            wantSquare = body["square"] as? String
            wantArrow = body["arrow"] as? String
        }
    }

    // The panel can start before the web server is up. Keep trying.
    private func retry() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
            guard let self else { return }
            self.web.load(URLRequest(url: self.url))
        }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { retry() }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { retry() }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        // The HUD only ever shows the local panel.
        decisionHandler(action.request.url?.host == url.host && action.request.url?.port == url.port ? .allow : .cancel)
    }

    // MARK: Following the game window

    @objc private func hudMoved() {
        guard !placing, let t = target else { return }
        let home = homeOrigin(for: t)
        offset = CGPoint(x: hud.frame.minX - home.x, y: hud.frame.maxY - home.y)
        UserDefaults.standard.set(Double(offset.x), forKey: "hudDX")
        UserDefaults.standard.set(Double(offset.y), forKey: "hudDY")
    }

    /// Default HUD top-left: beside the game window where the screen has room, so it doesn't cover the board.
    /// Falls back to the window's top-right corner, below the title bar.
    private func homeOrigin(for target: CGRect) -> CGPoint {
        let r = cocoaRect(target)
        let screen = NSScreen.screens.first(where: { $0.frame.intersects(r) })?.visibleFrame ?? r
        if screen.maxX - r.maxX >= hudWidth + 16 { return CGPoint(x: r.maxX + 8, y: r.maxY) }
        if r.minX - screen.minX >= hudWidth + 16 { return CGPoint(x: r.minX - hudWidth - 8, y: r.maxY) }
        return CGPoint(x: r.maxX - hudWidth - 16, y: r.maxY - 44)
    }

    private func focusedWindow(_ app: NSRunningApplication) -> AXUIElement? {
        let appEl = AXUIElementCreateApplication(app.processIdentifier)
        AXUIElementSetMessagingTimeout(appEl, 0.5)
        for key in [kAXFocusedWindowAttribute as String, kAXMainWindowAttribute as String] {
            if let w = copyAttr(appEl, key), CFGetTypeID(w) == AXUIElementGetTypeID() { return (w as! AXUIElement) }
        }
        return windowsOf(appEl).first
    }

    private func hide() {
        target = nil
        hud.orderOut(nil)
        marks.orderOut(nil)
    }

    private func tick() {
        guard isTrusted(prompt: false), let app = NSWorkspace.shared.frontmostApplication, let bundle = app.bundleIdentifier else { return hide() }
        let isChess = bundle == chessBundleID
        guard isChess || browserBundleIDs.contains(bundle), let win = focusedWindow(app), let frame = frameOf(win) else { return hide() }
        if !isChess {
            let title = (stringAttr(win, kAXTitleAttribute as String) ?? "").lowercased()
            guard title.contains("lichess") else { return hide() }
        }
        target = frame

        placing = true
        let home = homeOrigin(for: frame)
        var origin = CGPoint(x: home.x + offset.x, y: home.y + offset.y - hudHeight)
        if let screen = NSScreen.screens.first(where: { $0.frame.intersects(cocoaRect(frame)) })?.visibleFrame {
            origin.x = min(max(origin.x, screen.minX), screen.maxX - hudWidth)
            origin.y = min(max(origin.y, screen.minY), screen.maxY - hudHeight)
        }
        hud.setFrame(NSRect(x: origin.x, y: origin.y, width: hudWidth, height: hudHeight), display: true)
        hud.orderFrontRegardless()
        placing = false

        drawMarks(isChess: isChess, window: win, frame: frame)
    }

    private func drawMarks(isChess: Bool, window: AXUIElement, frame: CGRect) {
        let wanted = isChess && gameSource == "chessapp" && (wantSquare != nil || wantArrow != nil)
        guard wanted else {
            marks.orderOut(nil)
            return
        }
        // Square elements are re-read every couple of seconds; their frames are read every tick so marks track the board as it tilts.
        squaresAge += 1
        if squares.count != 64 || squaresAge > 16 {
            squaresAge = 0
            squares = [:]
            for s in readBoard(window) ?? [] { squares[s.name] = s.element }
            boardView = squares["a1"].flatMap { copyAttr($0, kAXParentAttribute as String) }.flatMap {
                CFGetTypeID($0) == AXUIElementGetTypeID() ? ($0 as! AXUIElement) : nil
            }
        }
        let mirror = boardView.flatMap(frameOf).flatMap { framesAreMirrored() ? $0 : nil }
        func local(_ name: String) -> CGRect? {
            guard let el = squares[name], var f = frameOf(el) else { return nil }
            if let b = mirror { f.origin.y = b.minY + b.maxY - f.maxY }
            return f.offsetBy(dx: -frame.minX, dy: -frame.minY)
        }
        marksView.highlight = wantSquare.flatMap(local)
        if let uci = wantArrow, uci.count >= 4, let from = local(String(uci.prefix(2))), let to = local(String(uci.dropFirst(2).prefix(2))) {
            marksView.arrow = (from, to)
        } else {
            marksView.arrow = nil
        }
        if marksView.highlight == nil && marksView.arrow == nil { squares = [:] }
        marks.setFrame(cocoaRect(frame), display: false)
        marksView.needsDisplay = true
        marks.orderFrontRegardless()
    }
}

extension Overlay {
    /// Chess.app (macOS 15 and later, at least) reports square frames upside down within the board view:
    /// the rank nearest the camera, which is drawn widest and lowest, comes back highest. Detect that from
    /// the perspective so the correction turns itself off if Apple fixes it. A flat top-down view has no
    /// perspective to check, so it assumes the mirrored behavior that was measured.
    fileprivate func framesAreMirrored() -> Bool {
        guard let a1 = squares["a1"].flatMap(frameOf), let a8 = squares["a8"].flatMap(frameOf) else { return true }
        if abs(a1.width - a8.width) < 2 { return true }
        let (near, far) = a1.width > a8.width ? (a1, a8) : (a8, a1)
        return near.midY < far.midY
    }
}

// MARK: - Main

let args = Array(CommandLine.arguments.dropFirst())
var target = "http://localhost:3100/overlay"
if let i = args.firstIndex(of: "--url"), i + 1 < args.count { target = args[i + 1] }
guard let url = URL(string: target), let host = url.host, ["localhost", "127.0.0.1"].contains(host) else {
    FileHandle.standardError.write("tempo-overlay only loads the local panel (localhost).\n".data(using: .utf8)!)
    exit(2)
}

// When the daemon starts us it holds our stdin open. If it goes away, so do we.
if isatty(STDIN_FILENO) == 0 {
    Thread.detachNewThread {
        while !FileHandle.standardInput.availableData.isEmpty {}
        exit(0)
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
_ = isTrusted(prompt: true)
let overlay = Overlay(url: url)
app.run()
