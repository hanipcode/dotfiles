import AppKit
import CoreGraphics
import Foundation
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

struct CLIError: LocalizedError {
    let message: String

    var errorDescription: String? { message }
}

struct Options {
    var command = "help"
    var windowID: CGWindowID?
    var app: String?
    var title: String?
    var workspace: String?
    var output: String?
    var scale: CGFloat = 2
    var focused = false
    var pretty = false
    var requestPermission = false
}

struct WindowRecord: Codable {
    let id: CGWindowID
    let appName: String
    let bundleID: String?
    let processID: pid_t
    let title: String
    let workspace: String?
    let isOnScreen: Bool
    let frame: FrameRecord

    struct FrameRecord: Codable {
        let x: CGFloat
        let y: CGFloat
        let width: CGFloat
        let height: CGFloat
    }
}

struct CaptureRecord: Codable {
    let path: String
    let window: WindowRecord
    let pixelWidth: Int
    let pixelHeight: Int
}

@main
enum HShot {
    static func main() async {
        do {
            let application = NSApplication.shared
            application.setActivationPolicy(.prohibited)
            let options = try parse(Array(CommandLine.arguments.dropFirst()))
            switch options.command {
            case "list":
                try await list(options)
            case "capture":
                try await capture(options)
            case "permissions":
                try permissions(options)
            case "help":
                printHelp()
            default:
                throw CLIError(message: "unknown command: \(options.command)")
            }
        } catch {
            let message = (error as? LocalizedError)?.errorDescription ?? String(describing: error)
            FileHandle.standardError.write(Data("hshot: \(message)\n".utf8))
            exit(1)
        }
    }

    static func parse(_ arguments: [String]) throws -> Options {
        var options = Options()
        var index = 0

        if let command = arguments.first, !command.hasPrefix("-") {
            options.command = command
            index = 1
        }

        func value(after flag: String) throws -> String {
            guard index + 1 < arguments.count else {
                throw CLIError(message: "missing value for \(flag)")
            }
            index += 1
            return arguments[index]
        }

        while index < arguments.count {
            let argument = arguments[index]
            switch argument {
            case "--id":
                let raw = try value(after: argument)
                guard let id = CGWindowID(raw) else {
                    throw CLIError(message: "invalid window ID: \(raw)")
                }
                options.windowID = id
            case "--app":
                options.app = try value(after: argument)
            case "--title":
                options.title = try value(after: argument)
            case "--workspace":
                options.workspace = try value(after: argument)
            case "--output", "-o":
                options.output = try value(after: argument)
            case "--scale":
                let raw = try value(after: argument)
                guard let scale = Double(raw), scale > 0, scale <= 4 else {
                    throw CLIError(message: "scale must be greater than 0 and at most 4")
                }
                options.scale = CGFloat(scale)
            case "--focused":
                options.focused = true
            case "--pretty":
                options.pretty = true
            case "--request":
                options.requestPermission = true
            case "--help", "-h":
                options.command = "help"
            default:
                throw CLIError(message: "unknown option: \(argument)")
            }
            index += 1
        }

        return options
    }

    static func list(_ options: Options) async throws {
        let windows = try await matchingWindows(options)
        try writeJSON(windows.map(\.record), pretty: options.pretty)
    }

    static func capture(_ options: Options) async throws {
        let windows = try await matchingWindows(options)
        guard windows.count == 1, let selected = windows.first else {
            if windows.isEmpty {
                throw CLIError(message: "no window matched; run `hshot list --pretty` to inspect available windows")
            }
            let matches = windows.map { "\($0.record.id) \($0.record.appName): \($0.record.title)" }.joined(separator: "\n  ")
            throw CLIError(message: "selector matched \(windows.count) windows; add --id or a narrower --title:\n  \(matches)")
        }

        let configuration = SCStreamConfiguration()
        configuration.width = max(1, Int(selected.window.frame.width * options.scale))
        configuration.height = max(1, Int(selected.window.frame.height * options.scale))
        configuration.showsCursor = false
        configuration.ignoreShadowsSingleWindow = true

        let filter = SCContentFilter(desktopIndependentWindow: selected.window)
        let image = try await SCScreenshotManager.captureImage(
            contentFilter: filter,
            configuration: configuration
        )
        let outputURL = try outputURL(options.output, windowID: selected.record.id)
        try save(image, to: outputURL)

        try writeJSON(
            CaptureRecord(
                path: outputURL.path,
                window: selected.record,
                pixelWidth: image.width,
                pixelHeight: image.height
            ),
            pretty: options.pretty
        )
    }

    static func permissions(_ options: Options) throws {
        var granted = CGPreflightScreenCaptureAccess()
        if !granted, options.requestPermission {
            granted = CGRequestScreenCaptureAccess()
        }
        try writeJSON(["screenRecording": granted], pretty: options.pretty)
        if !granted {
            throw CLIError(message: "Screen Recording permission is required; run `hshot permissions --request`, then enable your terminal or agent host in System Settings > Privacy & Security > Screen & System Audio Recording")
        }
    }

    struct MatchedWindow {
        let window: SCWindow
        let record: WindowRecord
    }

    static func matchingWindows(_ options: Options) async throws -> [MatchedWindow] {
        let workspaceByID = try aerospaceWorkspaces(required: options.workspace != nil)
        var requestedID = options.windowID
        if options.focused {
            guard requestedID == nil else {
                throw CLIError(message: "use either --id or --focused, not both")
            }
            requestedID = try aerospaceFocusedWindowID()
        }

        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        return content.windows.compactMap { window in
            guard let application = window.owningApplication,
                  window.frame.width > 1,
                  window.frame.height > 1
            else { return nil }

            let record = WindowRecord(
                id: window.windowID,
                appName: application.applicationName,
                bundleID: application.bundleIdentifier,
                processID: application.processID,
                title: window.title ?? "",
                workspace: workspaceByID[window.windowID],
                isOnScreen: window.isOnScreen,
                frame: .init(
                    x: window.frame.origin.x,
                    y: window.frame.origin.y,
                    width: window.frame.width,
                    height: window.frame.height
                )
            )

            guard requestedID.map({ record.id == $0 }) ?? true,
                  options.app.map({ matches($0, record.appName) || matches($0, record.bundleID ?? "") }) ?? true,
                  options.title.map({ matches($0, record.title) }) ?? true,
                  options.workspace.map({ record.workspace == $0 }) ?? true
            else { return nil }

            return MatchedWindow(window: window, record: record)
        }.sorted {
            ($0.record.appName.localizedCaseInsensitiveCompare($1.record.appName) == .orderedAscending) ||
                ($0.record.appName == $1.record.appName && $0.record.id < $1.record.id)
        }
    }

    static func matches(_ needle: String, _ haystack: String) -> Bool {
        haystack.range(of: needle, options: [.caseInsensitive, .diacriticInsensitive]) != nil
    }

    static func aerospaceWorkspaces(required: Bool) throws -> [CGWindowID: String] {
        guard executableExists("aerospace") else {
            if required {
                throw CLIError(message: "AeroSpace is required for --workspace and --focused")
            }
            return [:]
        }

        let output: String
        do {
            output = try run("/usr/bin/env", ["aerospace", "list-windows", "--all", "--format", "%{window-id}\t%{workspace}"])
        } catch {
            if required { throw error }
            return [:]
        }
        return output.split(separator: "\n").reduce(into: [:]) { result, line in
            let fields = line.split(separator: "\t", maxSplits: 1, omittingEmptySubsequences: false)
            if fields.count == 2, let id = CGWindowID(fields[0]) {
                result[id] = String(fields[1])
            }
        }
    }

    static func aerospaceFocusedWindowID() throws -> CGWindowID {
        guard executableExists("aerospace") else {
            throw CLIError(message: "AeroSpace is required for --focused")
        }
        let output = try run("/usr/bin/env", ["aerospace", "list-windows", "--focused", "--format", "%{window-id}"])
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard let id = CGWindowID(output) else {
            throw CLIError(message: "AeroSpace has no focused window")
        }
        return id
    }

    static func executableExists(_ name: String) -> Bool {
        (try? run("/usr/bin/env", ["sh", "-c", "command -v \"$1\" >/dev/null", "sh", name])) != nil
    }

    static func run(_ executable: String, _ arguments: [String]) throws -> String {
        let process = Process()
        let stdout = Pipe()
        let stderr = Pipe()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        process.standardOutput = stdout
        process.standardError = stderr
        try process.run()
        process.waitUntilExit()

        let output = stdout.fileHandleForReading.readDataToEndOfFile()
        let error = stderr.fileHandleForReading.readDataToEndOfFile()
        guard process.terminationStatus == 0 else {
            let detail = String(decoding: error, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
            throw CLIError(message: detail.isEmpty ? "command failed: \(arguments.joined(separator: " "))" : detail)
        }
        return String(decoding: output, as: UTF8.self)
    }

    static func outputURL(_ path: String?, windowID: CGWindowID) throws -> URL {
        let resolved: String
        if let path {
            resolved = NSString(string: path).expandingTildeInPath
        } else {
            let formatter = DateFormatter()
            formatter.dateFormat = "yyyyMMdd-HHmmss-SSS"
            resolved = "/tmp/hshot-\(windowID)-\(formatter.string(from: Date())).png"
        }

        let url = URL(fileURLWithPath: resolved)
        let supported = ["png", "jpg", "jpeg", "heic"]
        guard supported.contains(url.pathExtension.lowercased()) else {
            throw CLIError(message: "output extension must be png, jpg, jpeg, or heic")
        }
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        return url
    }

    static func save(_ image: CGImage, to url: URL) throws {
        let type: UTType = switch url.pathExtension.lowercased() {
        case "jpg", "jpeg": .jpeg
        case "heic": .heic
        default: .png
        }
        guard let destination = CGImageDestinationCreateWithURL(url as CFURL, type.identifier as CFString, 1, nil) else {
            throw CLIError(message: "could not create image at \(url.path)")
        }
        CGImageDestinationAddImage(destination, image, nil)
        guard CGImageDestinationFinalize(destination) else {
            throw CLIError(message: "could not encode image at \(url.path)")
        }
    }

    static func writeJSON<T: Encodable>(_ value: T, pretty: Bool) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = pretty ? [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes] : [.sortedKeys, .withoutEscapingSlashes]
        let data = try encoder.encode(value)
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data("\n".utf8))
    }

    static func printHelp() {
        print("""
        hshot - capture a macOS window without focusing it

        USAGE
          hshot list [--app TEXT] [--title TEXT] [--workspace NAME] [--pretty]
          hshot capture (--id ID | --focused | selectors) [-o PATH] [--scale N] [--pretty]
          hshot permissions [--request] [--pretty]

        SELECTORS
          --id ID           Exact macOS/AeroSpace window ID
          --focused         Window currently focused according to AeroSpace
          --app TEXT        Case-insensitive app name or bundle ID substring
          --title TEXT      Case-insensitive window title substring
          --workspace NAME  Exact AeroSpace workspace

        CAPTURE
          -o, --output PATH PNG, JPEG, or HEIC path (default: /tmp/hshot-ID-TIME.png)
          --scale N         Output pixels per window point, (0, 4] (default: 2)

        Output is JSON so scripts and agents can select IDs with jq. Capturing uses
        ScreenCaptureKit and does not focus, raise, move, or resize the target window.

        EXAMPLES
          hshot list --app Safari --pretty
          hshot capture --id 432 -o /tmp/chrome.png
          hshot capture --workspace D --app Chrome
          hshot capture --focused | jq -r .path
        """)
    }
}
