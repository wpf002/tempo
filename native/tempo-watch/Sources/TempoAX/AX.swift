// Accessibility helpers shared by tempo-watch (reader) and tempo-overlay (on-screen overlay).
// Read-only. Nothing here clicks, types, or changes anything in another app.

import AppKit
import ApplicationServices

public let chessBundleID = "com.apple.Chess"

public func copyAttr(_ el: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(el, name as CFString, &value) == .success else { return nil }
    return value
}

public func stringAttr(_ el: AXUIElement, _ name: String) -> String? {
    guard let v = copyAttr(el, name) else { return nil }
    if let s = v as? String { return s }
    if let a = v as? NSAttributedString { return a.string }
    return nil
}

public func childrenOf(_ el: AXUIElement) -> [AXUIElement] {
    guard let v = copyAttr(el, kAXChildrenAttribute as String) else { return [] }
    return (v as? [AXUIElement]) ?? []
}

public func windowsOf(_ appEl: AXUIElement) -> [AXUIElement] {
    (copyAttr(appEl, kAXWindowsAttribute as String) as? [AXUIElement]) ?? []
}

public func chessApp() -> NSRunningApplication? {
    NSRunningApplication.runningApplications(withBundleIdentifier: chessBundleID).first
}

public func isTrusted(prompt: Bool) -> Bool {
    let key = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
    return AXIsProcessTrustedWithOptions([key: prompt] as CFDictionary)
}

/// Screen frame of an element in Accessibility coordinates: origin at the top-left of the primary display, y down.
public func frameOf(_ el: AXUIElement) -> CGRect? {
    guard let p = copyAttr(el, kAXPositionAttribute as String), let s = copyAttr(el, kAXSizeAttribute as String),
          CFGetTypeID(p) == AXValueGetTypeID(), CFGetTypeID(s) == AXValueGetTypeID() else { return nil }
    var point = CGPoint.zero
    var size = CGSize.zero
    guard AXValueGetValue(p as! AXValue, .cgPoint, &point), AXValueGetValue(s as! AXValue, .cgSize, &size) else { return nil }
    return CGRect(origin: point, size: size)
}

// MARK: - Chess.app board

public struct BoardSquare {
    public let name: String
    /// FEN piece letter (uppercase White, lowercase Black), or nil for an empty square.
    public let piece: Character?
    public let element: AXUIElement
}

private let pieceLetters: [String: Character] = ["king": "k", "queen": "q", "rook": "r", "bishop": "b", "knight": "n", "pawn": "p"]

private func isSquareName(_ s: String) -> Bool {
    let c = Array(s)
    return c.count == 2 && ("a"..."h").contains(c[0]) && ("1"..."8").contains(c[1])
}

/// Chess.app titles each square button "e4" when empty and "white pawn, e2" when occupied.
public func parseSquare(_ title: String) -> (name: String, piece: Character?)? {
    let parts = title.lowercased().components(separatedBy: ", ")
    if parts.count == 1, isSquareName(parts[0]) { return (parts[0], nil) }
    guard parts.count == 2, isSquareName(parts[1]) else { return nil }
    let words = parts[0].split(separator: " ")
    guard words.count == 2, let letter = pieceLetters[String(words[1])] else { return nil }
    switch words[0] {
    case "white": return (parts[1], Character(letter.uppercased()))
    case "black": return (parts[1], letter)
    default: return nil
    }
}

/// The 64 squares of a Chess.app game window, or nil if this window has no readable board.
public func readBoard(_ window: AXUIElement) -> [BoardSquare]? {
    var found: [String: BoardSquare] = [:]
    var budget = 600
    func walk(_ el: AXUIElement, _ depth: Int) {
        if budget <= 0 || depth > 4 { return }
        budget -= 1
        if stringAttr(el, kAXRoleAttribute as String) == (kAXButtonRole as String),
           let title = stringAttr(el, kAXTitleAttribute as String), let sq = parseSquare(title) {
            found[sq.name] = BoardSquare(name: sq.name, piece: sq.piece, element: el)
            return
        }
        for child in childrenOf(el) { walk(child, depth + 1) }
    }
    walk(window, 0)
    return found.count == 64 ? Array(found.values) : nil
}

/// FEN piece placement ("rnbqkbnr/pppppppp/8/...") for a full set of squares.
public func placement(_ squares: [BoardSquare]) -> String {
    var bySquare: [String: Character] = [:]
    for s in squares { if let p = s.piece { bySquare[s.name] = p } }
    var ranks: [String] = []
    for rank in stride(from: 8, through: 1, by: -1) {
        var row = ""
        var empty = 0
        for file in "abcdefgh" {
            if let p = bySquare["\(file)\(rank)"] {
                if empty > 0 { row += String(empty); empty = 0 }
                row.append(p)
            } else {
                empty += 1
            }
        }
        if empty > 0 { row += String(empty) }
        ranks.append(row)
    }
    return ranks.joined(separator: "/")
}
