import Cocoa
import Foundation
import WebKit

@MainActor
final class MermaidViewerApp: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKScriptMessageHandler {
    private let htmlPath: String
    private var window: NSPanel!
    private var webView: WKWebView!
    private var toggleSignal: DispatchSourceSignal!
    private var pageLoaded = false
    private var pendingSource: String?

    init(htmlPath: String) {
        self.htmlPath = htmlPath
    }

    func applicationWillFinishLaunching(_ notification: Notification) {
        NSAppleEventManager.shared().setEventHandler(
            self,
            andSelector: #selector(handleDeepLink(_:withReplyEvent:)),
            forEventClass: AEEventClass(kInternetEventClass),
            andEventID: AEEventID(kAEGetURL)
        )
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        setupMainMenu()

        let controller = WKUserContentController()
        controller.add(self, name: "bridge")

        let configuration = WKWebViewConfiguration()
        configuration.userContentController = controller
        configuration.websiteDataStore = .default()

        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.allowsMagnification = false

        window = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 1240, height: 780),
            styleMask: [.titled, .closable, .resizable, .miniaturizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.title = "Mermaid Studio"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.isFloatingPanel = true
        window.hidesOnDeactivate = false
        window.isReleasedWhenClosed = false
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenPrimary]
        window.minSize = NSSize(width: 760, height: 520)
        window.backgroundColor = NSColor(red: 0.09, green: 0.10, blue: 0.15, alpha: 1)
        window.contentView = webView
        window.delegate = self
        positionWindow()

        let htmlURL = URL(fileURLWithPath: htmlPath)
        webView.loadFileURL(htmlURL, allowingReadAccessTo: htmlURL.deletingLastPathComponent())
        setupSignal()
        show()
    }

    private func setupMainMenu() {
        let mainMenu = NSMenu()

        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "Quit Mermaid Studio", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        mainMenu.addItem(appItem)

        let editItem = NSMenuItem()
        let editMenu = NSMenu(title: "Edit")
        editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(NSMenuItem.separator())
        editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = editMenu
        mainMenu.addItem(editItem)

        NSApplication.shared.mainMenu = mainMenu
    }

    private func setupSignal() {
        signal(SIGUSR1, SIG_IGN)
        toggleSignal = DispatchSource.makeSignalSource(signal: SIGUSR1, queue: .main)
        toggleSignal.setEventHandler { [weak self] in self?.toggle() }
        toggleSignal.resume()
    }

    private func positionWindow() {
        guard let screen = NSScreen.main else { return }
        let frame = screen.visibleFrame
        let width = min(window.frame.width, frame.width - 48)
        let height = min(window.frame.height, frame.height - 48)
        window.setContentSize(NSSize(width: width, height: height))
        window.setFrameOrigin(NSPoint(x: frame.midX - width / 2, y: frame.midY - height / 2))
    }

    private func show() {
        positionWindow()
        NSApplication.shared.unhide(nil)
        NSApplication.shared.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
    }

    private func toggle() {
        window.isVisible ? window.orderOut(nil) : show()
    }

    @objc private func handleDeepLink(_ event: NSAppleEventDescriptor, withReplyEvent reply: NSAppleEventDescriptor) {
        guard let value = event.paramDescriptor(forKeyword: keyDirectObject)?.stringValue,
              let components = URLComponents(string: value),
              components.scheme == "mermaid-studio" else { return }
        if components.host == "clipboard" {
            pendingSource = NSPasteboard.general.string(forType: .string)
        } else {
            pendingSource = components.queryItems?.first(where: { $0.name == "source" })?.value
        }
        if window != nil {
            show()
            applyPendingSource()
        }
    }

    private func applyPendingSource() {
        guard pageLoaded, let source = pendingSource,
              let data = try? JSONEncoder().encode(source),
              let json = String(data: data, encoding: .utf8) else { return }
        pendingSource = nil
        webView.evaluateJavaScript("nativeOpenSource(\(json))")
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        sender.orderOut(nil)
        return false
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any],
              body["action"] as? String == "openLive",
              let source = body["source"] as? String else { return }

        let state: [String: Any] = [
            "code": source,
            "mermaid": "{\"theme\":\"dark\"}",
            "autoSync": true,
            "updateDiagram": true,
            "editorMode": "code"
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: state),
              let url = liveURL(for: data) else { return }
        NSWorkspace.shared.open(url)
    }

    private func liveURL(for data: Data) -> URL? {
        let encoded = data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        return URL(string: "https://mermaid.live/edit#base64:\(encoded)")
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.cancel)
            return
        }
        decisionHandler(url.isFileURL || url.scheme == "about" ? .allow : .cancel)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        pageLoaded = true
        applyPendingSource()
    }
}

@main
@MainActor
struct MermaidViewer {
    private static var delegate: MermaidViewerApp!

    static func main() {
        guard let htmlPath = CommandLine.arguments.dropFirst().first(where: { $0.hasSuffix(".html") })
            ?? Bundle.main.path(forResource: "mermaid_viewer", ofType: "html") else { return }
        let app = NSApplication.shared
        delegate = MermaidViewerApp(htmlPath: htmlPath)
        app.setActivationPolicy(.accessory)
        app.delegate = delegate
        app.run()
    }
}
