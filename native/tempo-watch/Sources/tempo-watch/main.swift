// tempo-watch: reads Chess.app's windows through the macOS Accessibility API and prints
// the text it finds as NDJSON. The Tempo daemon parses the move list out of it.
//
//   tempo-watch --once                 one snapshot, then exit
//   tempo-watch --watch [--interval-ms N]   a snapshot line every time the text changes
//   tempo-watch --dump                 print Chess.app's accessibility tree (for debugging)
//
// Read-only. Never clicks, types, or changes anything in Chess.app.

import AppKit
import ApplicationServices
import Foundation

let chessBundleID = "com.apple.Chess"
let maxDepth = 40
let maxNodesPerWindow = 8000
let maxTextLength = 20_000

struct WindowSnapshot: Encodable {
    let title: String
    let texts: [String]
}

struct OkSnapshot: Encodable {
    let ok: Bool
    let windows: [WindowSnapshot]
}

struct ErrSnapshot: Encodable {
    let ok: Bool
    let error: String
}

// MARK: - AX helpers

func copyAttr(_ el: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(el, name as CFString, &value) == .success else { return nil }
    return value
}

func stringAttr(_ el: AXUIElement, _ name: String) -> String? {
    guard let v = copyAttr(el, name) else { return nil }
    if let s = v as? String { return s }
    if let a = v as? NSAttributedString { return a.string }
    return nil
}

func childrenOf(_ el: AXUIElement) -> [AXUIElement] {
    guard let v = copyAttr(el, kAXChildrenAttribute as String) else { return [] }
    return (v as? [AXUIElement]) ?? []
}

func chessApp() -> NSRunningApplication? {
    NSRunningApplication.runningApplications(withBundleIdentifier: chessBundleID).first
}

func isTrusted(prompt: Bool) -> Bool {
    let key = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
    return AXIsProcessTrustedWithOptions([key: prompt] as CFDictionary)
}

// MARK: - Collect text

func collectTexts(_ el: AXUIElement, depth: Int, budget: inout Int, into texts: inout [String]) {
    if budget <= 0 || depth > maxDepth { return }
    budget -= 1
    var seen = Set<String>()
    for key in [kAXValueAttribute as String, kAXTitleAttribute as String] {
        if let s = stringAttr(el, key)?.trimmingCharacters(in: .whitespacesAndNewlines),
           !s.isEmpty, !seen.contains(s) {
            seen.insert(s)
            texts.append(String(s.prefix(maxTextLength)))
        }
    }
    for child in childrenOf(el) {
        collectTexts(child, depth: depth + 1, budget: &budget, into: &texts)
    }
}

func snapshot(app: NSRunningApplication) -> OkSnapshot {
    let appEl = AXUIElementCreateApplication(app.processIdentifier)
    AXUIElementSetMessagingTimeout(appEl, 1.0)
    var windows: [WindowSnapshot] = []
    let wins = (copyAttr(appEl, kAXWindowsAttribute as String) as? [AXUIElement]) ?? []
    for w in wins.prefix(50) {
        var texts: [String] = []
        var budget = maxNodesPerWindow
        for child in childrenOf(w) {
            collectTexts(child, depth: 1, budget: &budget, into: &texts)
        }
        windows.append(WindowSnapshot(title: stringAttr(w, kAXTitleAttribute as String) ?? "", texts: Array(texts.prefix(5000))))
    }
    return OkSnapshot(ok: true, windows: windows)
}

// MARK: - Output

let encoder: JSONEncoder = {
    let e = JSONEncoder()
    e.outputFormatting = [.withoutEscapingSlashes]
    return e
}()

func encodeLine<T: Encodable>(_ value: T) -> String? {
    guard let data = try? encoder.encode(value) else { return nil }
    return String(data: data, encoding: .utf8)
}

func emit(_ line: String) {
    FileHandle.standardOutput.write((line + "\n").data(using: .utf8)!)
}

func currentLine() -> String? {
    guard isTrusted(prompt: false) else { return encodeLine(ErrSnapshot(ok: false, error: "not_trusted")) }
    guard let app = chessApp() else { return encodeLine(ErrSnapshot(ok: false, error: "not_running")) }
    return encodeLine(snapshot(app: app))
}

// MARK: - Dump

func dump(_ el: AXUIElement, depth: Int, budget: inout Int) {
    if budget <= 0 || depth > maxDepth { return }
    budget -= 1
    let role = stringAttr(el, kAXRoleAttribute as String) ?? "?"
    let subrole = stringAttr(el, kAXSubroleAttribute as String).map { "/\($0)" } ?? ""
    var parts = ["\(role)\(subrole)"]
    for (label, key) in [("title", kAXTitleAttribute as String), ("value", kAXValueAttribute as String), ("desc", kAXDescriptionAttribute as String)] {
        if let s = stringAttr(el, key), !s.isEmpty {
            let flat = s.replacingOccurrences(of: "\n", with: "\\n")
            parts.append("\(label)=\"\(flat.prefix(160))\"")
        }
    }
    print(String(repeating: "  ", count: depth) + parts.joined(separator: " "))
    for child in childrenOf(el) {
        dump(child, depth: depth + 1, budget: &budget)
    }
}

// MARK: - Main

let args = CommandLine.arguments.dropFirst()
var intervalMs = 400
if let i = args.firstIndex(of: "--interval-ms"), args.index(after: i) < args.endIndex,
   let n = Int(args[args.index(after: i)]) {
    intervalMs = min(max(n, 100), 10_000)
}

if args.contains("--dump") {
    guard isTrusted(prompt: true) else {
        FileHandle.standardError.write("Grant Accessibility access to this terminal in System Settings > Privacy & Security > Accessibility, then re-run.\n".data(using: .utf8)!)
        exit(2)
    }
    guard let app = chessApp() else {
        FileHandle.standardError.write("Chess.app isn't running.\n".data(using: .utf8)!)
        exit(1)
    }
    let appEl = AXUIElementCreateApplication(app.processIdentifier)
    AXUIElementSetMessagingTimeout(appEl, 1.0)
    var budget = 20_000
    dump(appEl, depth: 0, budget: &budget)
    exit(0)
}

if args.contains("--watch") {
    _ = isTrusted(prompt: true) // show the permission prompt once
    var last = ""
    var lastEmit = Date.distantPast
    while true {
        autoreleasepool {
            if let line = currentLine() {
                // Emit on change, plus a heartbeat every 10s so the daemon knows we're alive.
                if line != last || Date().timeIntervalSince(lastEmit) > 10 {
                    emit(line)
                    last = line
                    lastEmit = Date()
                }
            }
        }
        usleep(useconds_t(intervalMs * 1000))
    }
}

if let line = currentLine() { emit(line) }
