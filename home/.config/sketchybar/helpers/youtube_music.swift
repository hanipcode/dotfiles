import Cocoa
import CryptoKit
import Foundation
import WebKit

struct MusicItem: Codable {
    let id: String
    let title: String
    let subtitle: String
    let thumbnail: String
    let kind: String
    let browseId: String
    let section: String
}

final class MusicAPI {
    private var apiKey = ""
    private var clientVersion = "1.20250818.03.00"
    private let cookieHeader: String
    private let sapisid: String

    init(cookiePath: String) {
        var cookies: [String] = []
        var signingCookie = ""
        if let value = try? String(contentsOfFile: cookiePath, encoding: .utf8) {
            for rawLine in value.split(separator: "\n") {
                var line = String(rawLine)
                if line.hasPrefix("#HttpOnly_") { line.removeFirst("#HttpOnly_".count) }
                if line.hasPrefix("#") { continue }
                let fields = line.split(separator: "\t", omittingEmptySubsequences: false)
                guard fields.count >= 7 else { continue }
                let name = String(fields[5])
                let cookieValue = String(fields[6])
                cookies.append("\(name)=\(cookieValue)")
                if name == "SAPISID" || (signingCookie.isEmpty && name == "__Secure-3PAPISID") {
                    signingCookie = cookieValue
                }
            }
        }
        cookieHeader = cookies.joined(separator: "; ")
        sapisid = signingCookie
    }

    func bootstrap(completion: @escaping (Bool) -> Void) {
        guard let url = URL(string: "https://music.youtube.com/") else {
            completion(false)
            return
        }
        var request = URLRequest(url: url)
        applyAuth(to: &request)
        request.setValue("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36", forHTTPHeaderField: "User-Agent")
        request.setValue("en-US,en;q=0.9", forHTTPHeaderField: "Accept-Language")
        URLSession.shared.dataTask(with: request) { data, _, _ in
            guard let data, let html = String(data: data, encoding: .utf8) else {
                completion(false)
                return
            }
            self.apiKey = self.capture("INNERTUBE_API_KEY[\\\"']*:[\\\"']([^\\\"']+)", in: html) ?? ""
            self.clientVersion = self.capture("INNERTUBE_CLIENT_VERSION[\\\"']*:[\\\"']([^\\\"']+)", in: html) ?? self.clientVersion
            completion(!self.apiKey.isEmpty)
        }.resume()
    }

    func home(completion: @escaping ([MusicItem]) -> Void) {
        request(endpoint: "browse", payload: ["browseId": "FEmusic_home"], completion: completion)
    }

    func browse(_ browseId: String, completion: @escaping ([MusicItem]) -> Void) {
        request(endpoint: "browse", payload: ["browseId": browseId], completion: completion)
    }

    func search(_ query: String, completion: @escaping ([MusicItem]) -> Void) {
        request(endpoint: "search", payload: ["query": query], completion: completion)
    }

    private func request(endpoint: String, payload: [String: Any], completion: @escaping ([MusicItem]) -> Void) {
        guard !apiKey.isEmpty,
              let url = URL(string: "https://music.youtube.com/youtubei/v1/\(endpoint)?key=\(apiKey)&prettyPrint=false") else {
            completion([])
            return
        }
        var body = payload
        body["context"] = ["client": [
            "clientName": "WEB_REMIX",
            "clientVersion": clientVersion,
            "hl": "en",
            "gl": "US"
        ]]
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("67", forHTTPHeaderField: "X-YouTube-Client-Name")
        request.setValue(clientVersion, forHTTPHeaderField: "X-YouTube-Client-Version")
        request.setValue("https://music.youtube.com", forHTTPHeaderField: "Origin")
        request.setValue("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36", forHTTPHeaderField: "User-Agent")
        applyAuth(to: &request)

        URLSession.shared.dataTask(with: request) { data, _, _ in
            guard let data,
                  let json = try? JSONSerialization.jsonObject(with: data) else {
                completion([])
                return
            }
            completion(self.extractItems(from: json))
        }.resume()
    }

    private func extractItems(from root: Any) -> [MusicItem] {
        var items: [MusicItem] = []
        var seen = Set<String>()

        func text(_ value: Any?) -> String {
            guard let dict = value as? [String: Any] else { return "" }
            if let simple = dict["simpleText"] as? String { return simple }
            return (dict["runs"] as? [[String: Any]])?
                .compactMap { $0["text"] as? String }.joined() ?? ""
        }

        func thumbnail(_ node: Any?) -> String {
            guard let dict = node as? [String: Any] else { return "" }
            if let thumbs = dict["thumbnails"] as? [[String: Any]] {
                return thumbs.last?["url"] as? String ?? ""
            }
            for value in dict.values {
                let result = thumbnail(value)
                if !result.isEmpty { return result }
            }
            return ""
        }

        func endpoint(_ node: Any?) -> (String, String) {
            guard let dict = node as? [String: Any] else { return ("", "") }
            if let watch = dict["watchEndpoint"] as? [String: Any] {
                return (watch["videoId"] as? String ?? "", "")
            }
            var browseId = ""
            if let browse = dict["browseEndpoint"] as? [String: Any] {
                browseId = browse["browseId"] as? String ?? ""
            }
            for value in dict.values {
                let result = endpoint(value)
                if !result.0.isEmpty { return result }
                if browseId.isEmpty, !result.1.isEmpty { browseId = result.1 }
            }
            return ("", browseId)
        }

        func musicVideoType(_ node: Any?) -> String {
            guard let dict = node as? [String: Any] else { return "" }
            if let value = dict["musicVideoType"] as? String { return value }
            for value in dict.values {
                let result = musicVideoType(value)
                if !result.isEmpty { return result }
            }
            return ""
        }

        func musicPageType(_ node: Any?) -> String {
            guard let dict = node as? [String: Any] else { return "" }
            if let value = dict["pageType"] as? String { return value }
            for value in dict.values {
                let result = musicPageType(value)
                if !result.isEmpty { return result }
            }
            return ""
        }

        func parseRenderer(_ renderer: [String: Any], section: String, twoRow: Bool) {
            var title = ""
            var subtitle = ""
            if twoRow {
                title = text(renderer["title"])
                subtitle = cleanSubtitle(text(renderer["subtitle"]))
            } else if let columns = renderer["flexColumns"] as? [[String: Any]] {
                let values = columns.compactMap { column -> String? in
                    guard let display = column["musicResponsiveListItemFlexColumnRenderer"] as? [String: Any] else { return nil }
                    let value = text(display["text"])
                    return value.isEmpty ? nil : value
                }
                title = values.first ?? ""
                subtitle = cleanSubtitle(values.dropFirst().first ?? "")
            }
            let target = endpoint(renderer["navigationEndpoint"] ?? renderer)
            let videoType = musicVideoType(renderer)
            let pageType = musicPageType(renderer)
            let isVideo = subtitle.range(
                of: "^Video(?:\\s*[•·]|$)",
                options: [.regularExpression, .caseInsensitive]
            ) != nil || videoType.contains("OMV") || videoType.contains("UGC")
            let isPodcast = subtitle.range(
                of: "^(?:Episode|Podcast)(?:\\s*[•·]|$)",
                options: [.regularExpression, .caseInsensitive]
            ) != nil || videoType.contains("PODCAST") || pageType.contains("PODCAST")
            if (!target.0.isEmpty && isVideo) || isPodcast { return }
            let key = !target.0.isEmpty ? "v:\(target.0)" : "b:\(target.1)"
            guard !title.isEmpty, key.count > 2, !seen.contains(key) else { return }
            seen.insert(key)
            let kind = !target.0.isEmpty ? "song" : "collection"
            items.append(MusicItem(
                id: target.0,
                title: title,
                subtitle: subtitle,
                thumbnail: thumbnail(renderer["thumbnailRenderer"] ?? renderer["thumbnail"]),
                kind: kind,
                browseId: target.1,
                section: section.isEmpty ? "Discover" : section
            ))
        }

        func walk(_ node: Any, section: String = "") {
            if let array = node as? [Any] {
                array.forEach { walk($0, section: section) }
                return
            }
            guard let dict = node as? [String: Any] else { return }
            if let shelf = dict["musicCarouselShelfRenderer"] as? [String: Any] {
                var shelfTitle = section
                if let header = shelf["header"] as? [String: Any],
                   let basic = header["musicCarouselShelfBasicHeaderRenderer"] as? [String: Any] {
                    shelfTitle = text(basic["title"])
                }
                walk(shelf["contents"] as Any, section: shelfTitle)
                return
            }
            if let renderer = dict["musicTwoRowItemRenderer"] as? [String: Any] {
                parseRenderer(renderer, section: section, twoRow: true)
                return
            }
            if let renderer = dict["musicResponsiveListItemRenderer"] as? [String: Any] {
                parseRenderer(renderer, section: section, twoRow: false)
                return
            }
            if let renderer = dict["musicCardShelfRenderer"] as? [String: Any] {
                parseRenderer(renderer, section: section.isEmpty ? "Top result" : section, twoRow: true)
            }
            dict.values.forEach { walk($0, section: section) }
        }

        walk(root)
        return Array(items.prefix(80))
    }

    private func cleanSubtitle(_ value: String) -> String {
        guard let regex = try? NSRegularExpression(
            pattern: "(?i)(?:\\s*[•·]\\s*)?[\\d,.]+\\s*[KMB]?\\s+views\\b"
        ) else { return value }
        let range = NSRange(value.startIndex..., in: value)
        return regex.stringByReplacingMatches(in: value, range: range, withTemplate: "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func capture(_ pattern: String, in value: String) -> String? {
        guard let regex = try? NSRegularExpression(pattern: pattern),
              let match = regex.firstMatch(in: value, range: NSRange(value.startIndex..., in: value)),
              let range = Range(match.range(at: 1), in: value) else { return nil }
        return String(value[range])
    }

    private func applyAuth(to request: inout URLRequest) {
        guard !cookieHeader.isEmpty else { return }
        request.setValue(cookieHeader, forHTTPHeaderField: "Cookie")
        request.setValue("0", forHTTPHeaderField: "X-Goog-AuthUser")
        request.setValue("https://music.youtube.com", forHTTPHeaderField: "X-Origin")
        guard !sapisid.isEmpty else { return }
        let timestamp = Int(Date().timeIntervalSince1970)
        let input = "\(timestamp) \(sapisid) https://music.youtube.com"
        let digest = Insecure.SHA1.hash(data: Data(input.utf8)).map { String(format: "%02x", $0) }.joined()
        request.setValue("SAPISIDHASH \(timestamp)_\(digest)", forHTTPHeaderField: "Authorization")
    }
}

@MainActor
final class MusicApp: NSObject, NSApplicationDelegate, NSWindowDelegate, WKScriptMessageHandler {
    private let api: MusicAPI
    private var window: NSPanel!
    private var webView: WKWebView!
    private var toggleSignal: DispatchSourceSignal!
    private var playbackSignal: DispatchSourceSignal!
    private var nextSignal: DispatchSourceSignal!
    private var previousSignal: DispatchSourceSignal!
    private let htmlPath: String
    private let statePath: String
    private let cookiePath: String
    private let socketPath: String
    private var playerProcess: Process?
    private var observerProcess: Process?
    private var observerInput: Pipe?
    private var observerOutput: Pipe?
    private var observerBuffer = Data()
    private var playGeneration = 0
    private var isPlaying = false

    init(htmlPath: String, cookiePath: String) {
        self.htmlPath = htmlPath
        self.cookiePath = cookiePath
        statePath = URL(fileURLWithPath: cookiePath).deletingLastPathComponent().appendingPathComponent("youtube-player-state").path
        socketPath = URL(fileURLWithPath: cookiePath).deletingLastPathComponent().appendingPathComponent("youtube-mpv.sock").path
        api = MusicAPI(cookiePath: cookiePath)
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        try? FileManager.default.removeItem(atPath: statePath)
        let nowPlayingPath = URL(fileURLWithPath: statePath).deletingLastPathComponent().appendingPathComponent("youtube-now-playing.json").path
        try? FileManager.default.removeItem(atPath: nowPlayingPath)
        try? FileManager.default.removeItem(atPath: socketPath)
        refreshBar()

        let controller = WKUserContentController()
        controller.add(self, name: "bridge")
        let configuration = WKWebViewConfiguration()
        configuration.userContentController = controller
        configuration.websiteDataStore = .default()
        configuration.mediaTypesRequiringUserActionForPlayback = []

        webView = WKWebView(frame: .zero, configuration: configuration)
        window = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 900, height: 760),
            styleMask: [.titled, .closable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.title = "Hanif Music"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.isFloatingPanel = true
        window.hidesOnDeactivate = false
        window.isReleasedWhenClosed = false
        window.level = .floating
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        window.minSize = NSSize(width: 620, height: 600)
        window.backgroundColor = NSColor(red: 0.09, green: 0.10, blue: 0.15, alpha: 1)
        window.contentView = webView
        window.delegate = self
        positionWindow()

        let htmlURL = URL(fileURLWithPath: htmlPath)
        webView.loadFileURL(htmlURL, allowingReadAccessTo: htmlURL.deletingLastPathComponent())
        setupSignals()
        show()
    }

    private func setupSignals() {
        signal(SIGUSR1, SIG_IGN)
        signal(SIGUSR2, SIG_IGN)
        signal(SIGINFO, SIG_IGN)
        signal(SIGWINCH, SIG_IGN)
        toggleSignal = DispatchSource.makeSignalSource(signal: SIGUSR1, queue: .main)
        playbackSignal = DispatchSource.makeSignalSource(signal: SIGUSR2, queue: .main)
        nextSignal = DispatchSource.makeSignalSource(signal: SIGINFO, queue: .main)
        previousSignal = DispatchSource.makeSignalSource(signal: SIGWINCH, queue: .main)
        toggleSignal.setEventHandler { [weak self] in self?.toggle() }
        playbackSignal.setEventHandler { [weak self] in self?.togglePlayback() }
        nextSignal.setEventHandler { [weak self] in self?.webView.evaluateJavaScript("playNext()") }
        previousSignal.setEventHandler { [weak self] in self?.webView.evaluateJavaScript("playPrevious()") }
        toggleSignal.resume()
        playbackSignal.resume()
        nextSignal.resume()
        previousSignal.resume()
    }

    private func positionWindow() {
        guard let screen = NSScreen.main else { return }
        window.setFrameOrigin(NSPoint(x: screen.visibleFrame.minX + 36, y: screen.visibleFrame.maxY - window.frame.height - 10))
    }

    private func show() {
        positionWindow()
        NSApplication.shared.unhide(nil)
        NSApplication.shared.activate(ignoringOtherApps: true)
        window.makeKey()
        window.orderFrontRegardless()
    }

    private func toggle() {
        window.isVisible ? window.orderOut(nil) : show()
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        sender.orderOut(nil)
        return false
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let action = body["action"] as? String else { return }
        switch action {
        case "ready", "home":
            loadHome()
        case "search":
            let query = body["query"] as? String ?? ""
            if query.isEmpty { loadHome() } else { loadSearch(query) }
        case "browse":
            let browseId = body["browseId"] as? String ?? ""
            guard !browseId.isEmpty else { return }
            sendLoading("Loading collection…")
            api.browse(browseId) { [weak self] items in self?.render(items, mode: "collection") }
        case "library":
            sendLoading("Opening your library…")
            api.browse("FEmusic_library_landing") { [weak self] items in self?.render(items, mode: "library") }
        case "playerState":
            let state = body["state"] as? String ?? "UNKNOWN"
            try? state.write(toFile: statePath, atomically: true, encoding: .utf8)
        case "play":
            guard let id = body["id"] as? String, !id.isEmpty else { return }
            play(
                id: id,
                title: body["title"] as? String ?? "YouTube Music",
                subtitle: body["subtitle"] as? String ?? "",
                thumbnail: body["thumbnail"] as? String ?? ""
            )
        case "toggle":
            togglePlayback()
        default:
            break
        }
    }

    private func play(id: String, title: String, subtitle: String, thumbnail: String) {
        playGeneration += 1
        let generation = playGeneration
        stopPlaybackObserver()
        playerProcess?.terminationHandler = nil
        playerProcess?.terminate()
        try? FileManager.default.removeItem(atPath: socketPath)

        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/opt/homebrew/bin/mpv")
        process.arguments = [
            "--no-video",
            "--audio-display=no",
            "--really-quiet",
            "--input-ipc-server=\(socketPath)",
            "--ytdl-raw-options=cookies=\(cookiePath)",
            "--force-media-title=\(title)",
            "https://www.youtube.com/watch?v=\(id)"
        ]
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        process.terminationHandler = { [weak self] terminatedProcess in
            DispatchQueue.main.async {
                guard let self, self.playGeneration == generation else { return }
                self.stopPlaybackObserver()
                self.isPlaying = false
                if terminatedProcess.terminationReason == .exit && terminatedProcess.terminationStatus == 0 {
                    self.setPlayerState("ENDED")
                    self.webView.evaluateJavaScript("nativePlaybackEnded()")
                } else {
                    self.setPlayerState("ERROR_PLAYBACK")
                }
            }
        }
        do {
            try process.run()
            playerProcess = process
            isPlaying = true
            writeNowPlaying(title: title, subtitle: subtitle, thumbnail: thumbnail)
            setPlayerState("PLAYING")
            startPlaybackObserver(generation: generation)
        } catch {
            setPlayerState("ERROR_MPV")
        }
    }

    private func togglePlayback() {
        guard playerProcess?.isRunning == true else { return }
        sendMPV(["command": ["cycle", "pause"]])
        isPlaying.toggle()
        setPlayerState(isPlaying ? "PLAYING" : "PAUSED")
    }

    private func sendMPV(_ command: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: command) else { return }
        let process = Process()
        let input = Pipe()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/nc")
        process.arguments = ["-U", socketPath]
        process.standardInput = input
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        try? process.run()
        input.fileHandleForWriting.write(data + Data([0x0a]))
        try? input.fileHandleForWriting.close()
    }

    private func startPlaybackObserver(generation: Int, attempt: Int = 0) {
        guard generation == playGeneration, playerProcess?.isRunning == true else { return }
        guard FileManager.default.fileExists(atPath: socketPath) else {
            guard attempt < 30 else { return }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { [weak self] in
                self?.startPlaybackObserver(generation: generation, attempt: attempt + 1)
            }
            return
        }

        let process = Process()
        let input = Pipe()
        let output = Pipe()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/nc")
        process.arguments = ["-U", socketPath]
        process.standardInput = input
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        output.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty else { return }
            DispatchQueue.main.async {
                self?.receiveMPVEvent(data, generation: generation)
            }
        }
        process.terminationHandler = { [weak self] _ in
            DispatchQueue.main.async {
                guard let self, generation == self.playGeneration, self.playerProcess?.isRunning == true else { return }
                self.stopPlaybackObserver()
                self.startPlaybackObserver(generation: generation, attempt: 0)
            }
        }

        do {
            try process.run()
            observerProcess = process
            observerInput = input
            observerOutput = output
            observerBuffer.removeAll(keepingCapacity: true)
            let command: [String: Any] = ["command": ["observe_property", 1, "pause"]]
            guard let data = try? JSONSerialization.data(withJSONObject: command) else { return }
            input.fileHandleForWriting.write(data + Data([0x0a]))
        } catch {
            stopPlaybackObserver()
        }
    }

    private func receiveMPVEvent(_ data: Data, generation: Int) {
        guard generation == playGeneration else { return }
        observerBuffer.append(data)
        while let newline = observerBuffer.firstIndex(of: 0x0a) {
            let line = observerBuffer[..<newline]
            observerBuffer.removeSubrange(...newline)
            guard let object = try? JSONSerialization.jsonObject(with: Data(line)) as? [String: Any],
                  object["event"] as? String == "property-change",
                  object["name"] as? String == "pause",
                  let paused = object["data"] as? Bool else { continue }
            let playing = !paused
            guard isPlaying != playing else { continue }
            isPlaying = playing
            setPlayerState(playing ? "PLAYING" : "PAUSED")
        }
    }

    private func stopPlaybackObserver() {
        observerOutput?.fileHandleForReading.readabilityHandler = nil
        observerProcess?.terminationHandler = nil
        observerProcess?.terminate()
        try? observerInput?.fileHandleForWriting.close()
        observerProcess = nil
        observerInput = nil
        observerOutput = nil
        observerBuffer.removeAll(keepingCapacity: true)
    }

    private func setPlayerState(_ state: String) {
        try? state.write(toFile: statePath, atomically: true, encoding: .utf8)
        webView.evaluateJavaScript("nativePlaybackState('\(state)')")
        refreshBar()
    }

    private func writeNowPlaying(title: String, subtitle: String, thumbnail: String) {
        let value: [String: String] = ["title": title, "artist": subtitle, "thumbnail": thumbnail]
        guard let data = try? JSONSerialization.data(withJSONObject: value) else { return }
        let path = URL(fileURLWithPath: statePath).deletingLastPathComponent().appendingPathComponent("youtube-now-playing.json")
        try? data.write(to: path, options: .atomic)
    }

    private func refreshBar() {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/opt/homebrew/bin/sketchybar")
        process.arguments = ["--trigger", "music_change"]
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        try? process.run()
    }

    private func loadHome() {
        sendLoading("Tuning your home feed…")
        api.bootstrap { [weak self] ok in
            guard let self else { return }
            if ok { self.api.home { [weak self] items in self?.render(items, mode: "home") } }
            else { self.render([], mode: "home") }
        }
    }

    private func loadSearch(_ query: String) {
        sendLoading("Searching YouTube Music…")
        api.search(query) { [weak self] items in self?.render(items, mode: "search") }
    }

    private func sendLoading(_ text: String) {
        let encoded = try? JSONEncoder().encode(text)
        let value = encoded.flatMap { String(data: $0, encoding: .utf8) } ?? "\"Loading…\""
        DispatchQueue.main.async { self.webView.evaluateJavaScript("showLoading(\(value))") }
    }

    private func render(_ items: [MusicItem], mode: String) {
        guard let data = try? JSONEncoder().encode(items), let json = String(data: data, encoding: .utf8) else { return }
        DispatchQueue.main.async { self.webView.evaluateJavaScript("renderItems(\(json), '\(mode)')") }
    }
}

@main
@MainActor
struct HanifMusic {
    private static var delegate: MusicApp!

    static func main() {
        guard CommandLine.arguments.count > 2 else { return }
        let app = NSApplication.shared
        delegate = MusicApp(htmlPath: CommandLine.arguments[1], cookiePath: CommandLine.arguments[2])
        app.setActivationPolicy(.accessory)
        app.delegate = delegate
        app.run()
    }
}
