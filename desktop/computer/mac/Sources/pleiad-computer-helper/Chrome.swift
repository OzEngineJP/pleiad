// Chrome の OS の層のヘルパー操作（macOS）。
// WindowServer（CGWindowListCopyWindowInfo）と Accessibility API（AXUIElement）で Chrome の窓・確認のダイアログ・
// chrome://inspect/#remote-debugging のトグルを扱う。
#if canImport(AppKit) && canImport(ScreenCaptureKit)
import AppKit
import ApplicationServices
import Carbon.HIToolbox
import CoreGraphics
import Foundation
import ComputerProtocol

enum Chrome {
    static let browserBundleIds: Set<String> = ["com.google.Chrome", "com.microsoft.edgemac"]
    static let browserNames: Set<String> = ["Google Chrome", "Microsoft Edge"]
    static let maxDialogWidth: Double = 1000
    static let maxDialogHeight: Double = 700
    static let minDialogWidth: Double = 100
    static let minDialogHeight: Double = 60

    private static var nextId: Int = 1
    private static var knownWindows: [(id: String, pid: pid_t, element: AXUIElement)] = []

    // ---- 属性の読み書き ------------------------------------------------------------------------

    private static func axString(_ element: AXUIElement, _ attr: String) -> String? {
        var ref: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attr as CFString, &ref) == .success, let val = ref else { return nil }
        return val as? String
    }

    private static func axBool(_ element: AXUIElement, _ attr: String) -> Bool? {
        var ref: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attr as CFString, &ref) == .success, let val = ref else { return nil }
        if let num = val as? NSNumber { return num.boolValue }
        return val as? Bool
    }

    private static func axInt(_ element: AXUIElement, _ attr: String) -> Int? {
        var ref: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attr as CFString, &ref) == .success, let val = ref else { return nil }
        if let num = val as? NSNumber { return num.intValue }
        if let str = val as? String { return Int(str) }
        return nil
    }

    private static func axPoint(_ element: AXUIElement, _ attr: String) -> CGPoint? {
        var ref: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attr as CFString, &ref) == .success,
              let val = ref, CFGetTypeID(val) == AXValueGetTypeID() else { return nil }
        var pt = CGPoint.zero
        guard AXValueGetValue(val as! AXValue, .cgPoint, &pt) else { return nil }
        return pt
    }

    private static func axSize(_ element: AXUIElement, _ attr: String) -> CGSize? {
        var ref: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attr as CFString, &ref) == .success,
              let val = ref, CFGetTypeID(val) == AXValueGetTypeID() else { return nil }
        var sz = CGSize.zero
        guard AXValueGetValue(val as! AXValue, .cgSize, &sz) else { return nil }
        return sz
    }

    private static func axChildren(_ element: AXUIElement, _ attr: String = kAXChildrenAttribute as String) -> [AXUIElement] {
        var ref: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attr as CFString, &ref) == .success,
              let list = ref as? [AXUIElement] else { return [] }
        return list
    }

    private static func axParent(_ element: AXUIElement) -> AXUIElement? {
        var ref: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXParentAttribute as CFString, &ref) == .success,
              let val = ref, CFGetTypeID(val) == AXUIElementGetTypeID() else { return nil }
        return (val as! AXUIElement)
    }

    private static func enableAppAccessibility(_ pid: pid_t) {
        let app = AXUIElementCreateApplication(pid)
        _ = AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)
        _ = AXUIElementSetAttributeValue(app, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
    }

    private static func registerWindow(pid: pid_t, element: AXUIElement) -> String {
        if let hit = knownWindows.first(where: { $0.pid == pid && CFEqual($0.element, element) }) {
            return hit.id
        }
        if knownWindows.count > 256 {
            knownWindows.removeAll { entry in
                axString(entry.element, kAXRoleAttribute as String) == nil
            }
            if knownWindows.count > 256 {
                knownWindows.removeFirst(knownWindows.count - 192)
            }
        }
        let id = "ax-\(pid)-\(nextId)"
        nextId += 1
        knownWindows.append((id: id, pid: pid, element: element))
        return id
    }

    private static func lookupWindow(id: String) -> (pid: pid_t, element: AXUIElement)? {
        if let hit = knownWindows.first(where: { $0.id == id }) {
            if axString(hit.element, kAXRoleAttribute as String) != nil {
                return (hit.pid, hit.element)
            }
        }
        return nil
    }

    // ---- プロセスとポートの特定 ----------------------------------------------------------------

    static func isBrowserApp(_ app: NSRunningApplication) -> Bool {
        if let bid = app.bundleIdentifier, browserBundleIds.contains(bid) { return true }
        if let name = app.localizedName, browserNames.contains(name) { return true }
        if let exe = app.executableURL?.lastPathComponent, browserNames.contains(exe) { return true }
        return false
    }

    static func browserPids() -> [pid_t] {
        var pids: [pid_t] = []
        for app in NSWorkspace.shared.runningApplications where isBrowserApp(app) {
            let pid = app.processIdentifier
            if pid > 0 && !pids.contains(pid) { pids.append(pid) }
        }
        if let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] {
            for win in list {
                let owner = win[kCGWindowOwnerName as String] as? String ?? ""
                let pid = (win[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value ?? 0
                if pid > 0 && browserNames.contains(owner) && !pids.contains(pid) {
                    pids.append(pid)
                }
            }
        }
        return pids
    }

    /** TCP ポートを LISTEN しているプロセスの PID（lsof -nP -iTCP:<port> -sTCP:LISTEN -Fp） */
    static func listenerPid(port: Int) -> pid_t? {
        guard port > 0 && port <= 65535 else { return nil }
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/usr/sbin/lsof")
        proc.arguments = ["-nP", "-iTCP:\(port)", "-sTCP:LISTEN", "-Fp"]
        let pipe = Pipe()
        proc.standardOutput = pipe
        proc.standardError = FileHandle.nullDevice
        do {
            try proc.run()
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            proc.waitUntilExit()
            if let text = String(data: data, encoding: .utf8) {
                for line in text.split(whereSeparator: \.isNewline) {
                    if line.hasPrefix("p"), let pid = Int32(line.dropFirst()), pid > 0 {
                        return pid
                    }
                }
            }
        } catch {}
        return nil
    }

    // ---- 窓の列挙 ------------------------------------------------------------------------------

    private static func windowDict(id: String, pid: pid_t, element: AXUIElement) -> [String: Any]? {
        guard let role = axString(element, kAXRoleAttribute as String) else { return nil }
        let subrole = axString(element, kAXSubroleAttribute as String) ?? ""
        let title = axString(element, kAXTitleAttribute as String) ?? ""
        let pt = axPoint(element, kAXPositionAttribute as String) ?? .zero
        let sz = axSize(element, kAXSizeAttribute as String) ?? .zero
        let minimized = axBool(element, kAXMinimizedAttribute as String) ?? false
        let app = NSRunningApplication(processIdentifier: pid)
        let exe = app?.executableURL?.lastPathComponent ?? app?.localizedName ?? "Google Chrome"
        return [
            "id": id,
            "pid": Int(pid),
            "exe": exe,
            "title": title,
            "x": Double(pt.x),
            "y": Double(pt.y),
            "width": Double(sz.width),
            "height": Double(sz.height),
            "minimized": minimized,
            "visible": !minimized && sz.width > 0 && sz.height > 0,
            "role": role,
            "subrole": subrole
        ]
    }

    private static func collectAxWindows(for pid: pid_t) -> [[String: Any]] {
        let appElem = AXUIElementCreateApplication(pid)
        var windows = axChildren(appElem, kAXWindowsAttribute as String)
        var focusedRef: CFTypeRef?
        if AXUIElementCopyAttributeValue(appElem, kAXFocusedWindowAttribute as CFString, &focusedRef) == .success,
           let fw = focusedRef, CFGetTypeID(fw) == AXUIElementGetTypeID() {
            let fElem = fw as! AXUIElement
            if !windows.contains(where: { CFEqual($0, fElem) }) { windows.insert(fElem, at: 0) }
        }
        var out: [[String: Any]] = []
        for win in windows {
            let id = registerWindow(pid: pid, element: win)
            if let dict = windowDict(id: id, pid: pid, element: win) {
                out.append(dict)
            }
            // シートや子ダイアログがあれば一緒に拾う
            for sheet in axChildren(win, "AXSheets") {
                let sid = registerWindow(pid: pid, element: sheet)
                if let sdict = windowDict(id: sid, pid: pid, element: sheet) {
                    out.append(sdict)
                }
            }
        }
        return out
    }

    /** { port?: Int } → { windows: [...], ownerPid: Int|null, trusted: Bool } */
    static func windows(_ args: [String: Any]) -> [String: Any] {
        let port = intValue(args["port"]) ?? 0
        let ownerPid = port > 0 ? listenerPid(port: port) : nil
        let trusted = AXIsProcessTrusted()
        var list: [[String: Any]] = []
        if trusted {
            for pid in browserPids() {
                list.append(contentsOf: collectAxWindows(for: pid))
            }
        }
        // AX が使えない、または CGWindowList にだけ出ている窓を補う
        if let cgList = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] {
            let pids = Set(browserPids())
            for w in cgList {
                let pid = (w[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value ?? 0
                let layer = (w[kCGWindowLayer as String] as? NSNumber)?.intValue ?? 0
                let alpha = (w[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1
                guard pids.contains(pid), layer == 0, alpha > 0,
                      let boundsDict = w[kCGWindowBounds as String] as? NSDictionary,
                      let b = CGRect(dictionaryRepresentation: boundsDict as CFDictionary),
                      b.width > 0, b.height > 0 else { continue }
                let matched = list.contains { existing in
                    guard (existing["pid"] as? Int) == Int(pid),
                          let ex = existing["x"] as? Double, let ey = existing["y"] as? Double,
                          let ew = existing["width"] as? Double, let eh = existing["height"] as? Double else { return false }
                    return abs(ex - Double(b.origin.x)) <= 4 && abs(ey - Double(b.origin.y)) <= 4 &&
                           abs(ew - Double(b.width)) <= 4 && abs(eh - Double(b.height)) <= 4
                }
                if !matched {
                    // 点の下から AXWindow が引けるなら登録する
                    if trusted {
                        var hitElem: AXUIElement?
                        let midX = Float(b.midX), midY = Float(b.midY)
                        if AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(), midX, midY, &hitElem) == .success,
                           let elem = hitElem {
                            var hitPid: pid_t = 0
                            if AXUIElementGetPid(elem, &hitPid) == .success, hitPid == pid {
                                var cur: AXUIElement = elem
                                while let parent = axParent(cur) {
                                    let role = axString(cur, kAXRoleAttribute as String) ?? ""
                                    if role == "AXWindow" || role == "AXDialog" || role == "AXSheet" { break }
                                    cur = parent
                                }
                                let id = registerWindow(pid: pid, element: cur)
                                if !list.contains(where: { ($0["id"] as? String) == id }),
                                   let dict = windowDict(id: id, pid: pid, element: cur) {
                                    list.append(dict)
                                    continue
                                }
                            }
                        }
                    }
                    let winNum = (w[kCGWindowNumber as String] as? NSNumber)?.intValue ?? 0
                    let title = w[kCGWindowName as String] as? String ?? ""
                    let ownerName = w[kCGWindowOwnerName as String] as? String ?? "Google Chrome"
                    list.append([
                        "id": "cg-\(pid)-\(winNum)",
                        "pid": Int(pid),
                        "exe": ownerName,
                        "title": title,
                        "x": Double(b.origin.x),
                        "y": Double(b.origin.y),
                        "width": Double(b.width),
                        "height": Double(b.height),
                        "minimized": false,
                        "visible": true,
                        "role": "CGWindow",
                        "subrole": ""
                    ])
                }
            }
        }
        return [
            "windows": list,
            "ownerPid": ownerPid.map { Int($0) } as Any? ?? NSNull(),
            "trusted": trusted
        ]
    }

    // ---- 確認のダイアログの検出と「許可する / Allow」の押下 ------------------------------------

    private static func isAllowButtonLabel(_ raw: String) -> Bool {
        let s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        let lower = s.lowercased()
        return lower == "allow" || s == "許可する" || s == "許可"
    }

    private static func looksLikeDialogText(_ raw: String) -> Bool {
        let lower = raw.lowercased()
        return lower.contains("remote debugging") || raw.contains("リモート デバッグ") || raw.contains("リモートデバッグ")
    }

    private static func collectShortText(_ node: AXUIElement, depth: Int = 0, maxDepth: Int = 3) -> String {
        if depth > maxDepth { return "" }
        var parts: [String] = []
        if let t = axString(node, kAXTitleAttribute as String), !t.isEmpty { parts.append(t) }
        if let d = axString(node, kAXDescriptionAttribute as String), !d.isEmpty { parts.append(d) }
        if let v = axString(node, kAXValueAttribute as String), !v.isEmpty { parts.append(v) }
        if let h = axString(node, kAXHelpAttribute as String), !h.isEmpty { parts.append(h) }
        for c in axChildren(node) {
            let ct = collectShortText(c, depth: depth + 1, maxDepth: maxDepth)
            if !ct.isEmpty { parts.append(ct) }
        }
        return parts.joined(separator: " ")
    }

    /** Web の中身（AXWebArea）を除いた Chrome 自身の UI 木から、許可ボタンとダイアログ文言を探す */
    private static func scanDialogInTree(_ root: AXUIElement, maxDepth: Int = 25) -> (allowButton: AXUIElement?, allowTitle: String?, hasDialogText: Bool) {
        var allowButton: AXUIElement?
        var allowTitle: String?
        var hasText = false
        var visited = 0

        func walk(_ node: AXUIElement, depth: Int) {
            if depth > maxDepth || visited > 3000 { return }
            visited += 1
            let role = axString(node, kAXRoleAttribute as String) ?? ""
            if role == "AXWebArea" { return } // ページの DOM の中の偽ボタンは絶対に触らない
            let title = axString(node, kAXTitleAttribute as String) ?? ""
            let desc = axString(node, kAXDescriptionAttribute as String) ?? ""
            let val = axString(node, kAXValueAttribute as String) ?? ""
            if looksLikeDialogText(title) || looksLikeDialogText(desc) || looksLikeDialogText(val) {
                hasText = true
            }
            if role == "AXButton" && allowButton == nil {
                if isAllowButtonLabel(title) {
                    allowButton = node
                    allowTitle = title
                } else if isAllowButtonLabel(desc) {
                    allowButton = node
                    allowTitle = desc
                } else if isAllowButtonLabel(val) {
                    allowButton = node
                    allowTitle = val
                } else {
                    let childText = collectShortText(node, depth: 0, maxDepth: 2)
                    if isAllowButtonLabel(childText) {
                        allowButton = node
                        allowTitle = childText
                    }
                }
            }
            for child in axChildren(node) {
                walk(child, depth: depth + 1)
            }
        }

        walk(root, depth: 0)
        return (allowButton, allowTitle, hasText)
    }

    /** { since?: [String], port?: Int } → { dialog: [String: Any] | NSNull } */
    static func findDialog(_ args: [String: Any]) -> [String: Any] {
        let since = Set((args["since"] as? [String]) ?? [])
        let port = intValue(args["port"]) ?? 0
        let ownerPid = port > 0 ? listenerPid(port: port) : nil
        let targetPids: [pid_t]
        if let ownerPid {
            targetPids = [ownerPid]
        } else if port > 0 {
            let all = browserPids()
            targetPids = all.count == 1 ? all : []
        } else {
            targetPids = browserPids()
        }

        let snap = windows(["port": port])
        let allWins = (snap["windows"] as? [[String: Any]]) ?? []

        guard AXIsProcessTrusted() else {
            for w in allWins {
                guard let id = w["id"] as? String, !since.contains(id),
                      let pid = w["pid"] as? Int, targetPids.contains(pid_t(pid)),
                      let visible = w["visible"] as? Bool, visible,
                      let width = w["width"] as? Double, let height = w["height"] as? Double,
                      width >= minDialogWidth, width <= maxDialogWidth,
                      height >= minDialogHeight, height <= maxDialogHeight else { continue }
                return ["dialog": w]
            }
            return ["dialog": NSNull()]
        }

        for pid in targetPids {
            enableAppAccessibility(pid)
        }

        for w in allWins {
            guard let id = w["id"] as? String,
                  let pid = w["pid"] as? Int, targetPids.contains(pid_t(pid)),
                  let visible = w["visible"] as? Bool, visible,
                  let width = w["width"] as? Double, let height = w["height"] as? Double else { continue }
            let isSmall = width >= minDialogWidth && width <= maxDialogWidth && height >= minDialogHeight && height <= maxDialogHeight
            if !since.contains(id) && isSmall {
                return ["dialog": w]
            }
            if let entry = lookupWindow(id: id) {
                let scan = scanDialogInTree(entry.element)
                if scan.allowButton != nil && (scan.hasDialogText || !since.contains(id) || isSmall) {
                    var d = w
                    d["hasAllowButton"] = true
                    return ["dialog": d]
                }
            }
        }

        // アプリ直下の要素（kAXWindowsAttribute に出ないモーダルやシート）も走査する
        for pid in targetPids {
            let appElem = AXUIElementCreateApplication(pid)
            let scan = scanDialogInTree(appElem, maxDepth: 25)
            if scan.allowButton != nil && scan.hasDialogText {
                let id = registerWindow(pid: pid, element: appElem)
                return [
                    "dialog": [
                        "id": id,
                        "pid": Int(pid),
                        "exe": "Google Chrome",
                        "title": "Allow remote debugging?",
                        "x": 100.0,
                        "y": 100.0,
                        "width": 420.0,
                        "height": 180.0,
                        "minimized": false,
                        "visible": true,
                        "hasAllowButton": true
                    ]
                ]
            }
        }
        return ["dialog": NSNull()]
    }

    /** { id: String } → { ok: Bool, title?: String } */
    static func allowDialog(_ args: [String: Any]) -> [String: Any] {
        guard AXIsProcessTrusted(), let id = args["id"] as? String else {
            return ["ok": false, "reason": "not-trusted-or-no-id"]
        }
        guard let entry = lookupWindow(id: id) else {
            return ["ok": false, "reason": "unknown-window"]
        }
        enableAppAccessibility(entry.pid)

        // 1. 対象の要素の中から Allow / 許可する ボタンを探す
        let scan = scanDialogInTree(entry.element, maxDepth: 25)
        if let btn = scan.allowButton {
            _ = AXUIElementSetAttributeValue(btn, kAXFocusedAttribute as CFString, kCFBooleanTrue)
            let err = AXUIElementPerformAction(btn, kAXPressAction as CFString)
            if err == .success {
                return ["ok": true, "button": scan.allowTitle ?? "Allow", "method": "ax-press"]
            }
            if AXUIElementPerformAction(btn, kAXConfirmAction as CFString) == .success {
                return ["ok": true, "button": scan.allowTitle ?? "Allow", "method": "ax-confirm"]
            }
        }

        // 2. 同じ PID のアプリ全体・他の AXWindow からも探す
        let appElem = AXUIElementCreateApplication(entry.pid)
        let appScan = scanDialogInTree(appElem, maxDepth: 25)
        if let btn = appScan.allowButton, appScan.hasDialogText {
            _ = AXUIElementSetAttributeValue(btn, kAXFocusedAttribute as CFString, kCFBooleanTrue)
            let err = AXUIElementPerformAction(btn, kAXPressAction as CFString)
            if err == .success {
                return ["ok": true, "button": appScan.allowTitle ?? "Allow", "method": "ax-press-app"]
            }
        }
        for win in axChildren(appElem, kAXWindowsAttribute as String) {
            let s = scanDialogInTree(win, maxDepth: 25)
            if let btn = s.allowButton, s.hasDialogText {
                let err = AXUIElementPerformAction(btn, kAXPressAction as CFString)
                if err == .success {
                    return ["ok": true, "button": s.allowTitle ?? "Allow", "method": "ax-press-sibling"]
                }
            }
        }
        return ["ok": false, "reason": "allow-button-not-found"]
    }

    // ---- chrome://inspect/#remote-debugging の自動有効化 ---------------------------------------

    private static func findAddressBar(in root: AXUIElement) -> AXUIElement? {
        var candidates: [(elem: AXUIElement, score: Int)] = []
        var visited = 0

        func walk(_ node: AXUIElement, depth: Int) {
            if depth > 20 || visited > 2000 { return }
            visited += 1
            let role = axString(node, kAXRoleAttribute as String) ?? ""
            if role == "AXWebArea" { return }
            if role == "AXTextField" || role == "AXComboBox" {
                let title = (axString(node, kAXTitleAttribute as String) ?? "").lowercased()
                let desc = (axString(node, kAXDescriptionAttribute as String) ?? "").lowercased()
                let domId = (axString(node, "AXDOMIdentifier") ?? axString(node, kAXIdentifierAttribute as String) ?? "").lowercased()
                var score = 10
                if title.contains("address") || desc.contains("address") || title.contains("アドレス") || desc.contains("アドレス") ||
                   domId.contains("omnibox") || desc.contains("search bar") || desc.contains("検索バー") {
                    score += 50
                }
                if let sz = axSize(node, kAXSizeAttribute as String), sz.width > 120 {
                    score += 20
                }
                candidates.append((node, score))
            }
            for child in axChildren(node) {
                walk(child, depth: depth + 1)
            }
        }

        walk(root, depth: 0)
        return candidates.max(by: { $0.score < $1.score })?.elem
    }

    private struct CheckboxMatch {
        let checkbox: AXUIElement
        let parent: AXUIElement?
        let checked: Bool
        let enabled: Bool
        let label: String
        let score: Int
    }

    private static func scanRemoteDebuggingCheckboxes(in root: AXUIElement) -> (best: CheckboxMatch?, all: [[String: Any]]) {
        var matches: [CheckboxMatch] = []
        var all: [[String: Any]] = []
        var visited = 0

        func walk(_ node: AXUIElement, parent: AXUIElement?, grandparent: AXUIElement?, depth: Int) {
            if depth > 35 || visited > 5000 { return }
            visited += 1
            let role = axString(node, kAXRoleAttribute as String) ?? ""
            if role == "AXCheckBox" || role == "AXSwitch" || role == "AXRadioButton" {
                let domId = axString(node, "AXDOMIdentifier") ?? axString(node, kAXIdentifierAttribute as String) ?? ""
                var titleElemText = ""
                var titleElemRef: CFTypeRef?
                if AXUIElementCopyAttributeValue(node, kAXTitleUIElementAttribute as CFString, &titleElemRef) == .success,
                   let te = titleElemRef, CFGetTypeID(te) == AXUIElementGetTypeID() {
                    titleElemText = collectShortText(te as! AXUIElement, depth: 0, maxDepth: 2)
                }
                let ownText = collectShortText(node, depth: 0, maxDepth: 2)
                let parentText = parent.map { collectShortText($0, depth: 0, maxDepth: 2) } ?? ""
                let grandText = grandparent.map { collectShortText($0, depth: 0, maxDepth: 2) } ?? ""
                let combined = "\(domId) \(titleElemText) \(ownText) \(parentText) \(grandText)"
                let lower = combined.lowercased()
                let domLower = domId.lowercased()
                let enabled = axBool(node, kAXEnabledAttribute as String) ?? true
                let val = axInt(node, kAXValueAttribute as String) ?? ((axBool(node, kAXValueAttribute as String) == true) ? 1 : 0)

                var score = 0
                if domLower == "remote-debugging-enabled" {
                    score += 500
                }
                if lower.contains("allow remote debugging") || lower.contains("browser instance") ||
                   combined.contains("このブラウザ インスタンスでリモート デバッグを許可") || combined.contains("リモート デバッグを許可") {
                    score += 200
                } else if lower.contains("remote debugging") || combined.contains("リモート デバッグ") || combined.contains("リモートデバッグ") {
                    score += 100
                }
                if domLower.contains("discover-") || domLower.contains("port-forwarding") || domLower.contains("bubble-locking") ||
                   lower.contains("discover usb") || lower.contains("discover network") || lower.contains("port forwarding") || lower.contains("bubble locking") {
                    score -= 400
                }

                let label = !domId.isEmpty ? domId : (!ownText.isEmpty ? ownText : parentText)
                all.append([
                    "domId": domId,
                    "checked": val != 0,
                    "enabled": enabled,
                    "score": score,
                    "label": String(label.prefix(80))
                ])
                if score >= 100 {
                    matches.append(CheckboxMatch(
                        checkbox: node,
                        parent: parent,
                        checked: val != 0,
                        enabled: enabled,
                        label: String(label.prefix(80)),
                        score: score
                    ))
                }
            }
            for child in axChildren(node) {
                walk(child, parent: node, grandparent: parent, depth: depth + 1)
            }
        }

        walk(root, parent: nil, grandparent: nil, depth: 0)
        let best = matches.max(by: { $0.score < $1.score })
        return (best, all)
    }

    private static func postKeyToPid(_ pid: pid_t, code: Int) {
        let src = CGEventSource(stateID: .hidSystemState)
        if let down = CGEvent(keyboardEventSource: src, virtualKey: CGKeyCode(code), keyDown: true),
           let up = CGEvent(keyboardEventSource: src, virtualKey: CGKeyCode(code), keyDown: false) {
            down.flags = []
            up.flags = []
            down.postToPid(pid)
            usleep(20_000)
            up.postToPid(pid)
        }
    }

    private static func postHidKey(_ code: Int, flags: CGEventFlags = []) {
        let src = CGEventSource(stateID: .hidSystemState)
        if let down = CGEvent(keyboardEventSource: src, virtualKey: CGKeyCode(code), keyDown: true),
           let up = CGEvent(keyboardEventSource: src, virtualKey: CGKeyCode(code), keyDown: false) {
            down.flags = flags
            up.flags = flags
            down.post(tap: .cghidEventTap)
            usleep(20_000)
            up.post(tap: .cghidEventTap)
        }
    }

    /**
     * chrome://inspect/#remote-debugging への遷移とトグルの 1 ステップ。
     * { id: String, url?: String, marker?: String, navigate?: Bool, activateFallback?: Bool }
     */
    static func enableStep(_ args: [String: Any]) -> [String: Any] {
        guard AXIsProcessTrusted(), let id = args["id"] as? String else {
            return ["state": "error", "reason": "not-trusted-or-no-id"]
        }
        guard let entry = lookupWindow(id: id) else {
            return ["state": "error", "reason": "window-gone"]
        }
        let targetUrl = (args["url"] as? String) ?? "chrome://inspect/#remote-debugging"
        let marker = (args["marker"] as? String) ?? ""
        enableAppAccessibility(entry.pid)
        let title = axString(entry.element, kAXTitleAttribute as String) ?? ""
        let stillOnMarker = !marker.isEmpty ? title.contains(marker) : title.contains("PLY-ENABLE-")

        // 1. すでに遷移していてリモートデバッグのチェックボックスが見えていれば、有効化を待ってトグルする
        let scan = scanRemoteDebuggingCheckboxes(in: entry.element)
        if !stillOnMarker, let found = scan.best {
            if !found.enabled {
                return ["state": "checkbox-disabled", "label": found.label, "title": title, "checkboxes": scan.all]
            }
            if found.checked {
                return ["state": "already-on", "checked": true, "label": found.label, "title": title, "checkboxes": scan.all]
            }
            // 方法 1: チェックボックス自身に kAXPressAction
            let err1 = AXUIElementPerformAction(found.checkbox, kAXPressAction as CFString)
            usleep(250_000)
            if scanRemoteDebuggingCheckboxes(in: entry.element).best?.checked == true {
                return ["state": "toggled", "checked": true, "method": "ax-press-checkbox", "axError": Int(err1.rawValue), "label": found.label, "title": title]
            }
            // 方法 2: 親の label 要素に kAXPressAction
            if let parent = found.parent {
                _ = AXUIElementPerformAction(parent, kAXPressAction as CFString)
                usleep(250_000)
                if scanRemoteDebuggingCheckboxes(in: entry.element).best?.checked == true {
                    return ["state": "toggled", "checked": true, "method": "ax-press-label", "label": found.label, "title": title]
                }
            }
            // 方法 3: フォーカスして Space キーを送る
            _ = AXUIElementSetAttributeValue(found.checkbox, kAXFocusedAttribute as CFString, kCFBooleanTrue)
            usleep(50_000)
            postKeyToPid(entry.pid, code: kVK_Space)
            usleep(250_000)
            let after3 = scanRemoteDebuggingCheckboxes(in: entry.element).best?.checked == true
            return [
                "state": after3 ? "toggled" : "toggle-pending",
                "checked": after3,
                "method": "focus-space",
                "axError": Int(err1.rawValue),
                "label": found.label,
                "title": title,
                "checkboxes": scan.all
            ]
        }

        // 2. まだ遷移していない（または遷移指示がある）ならアドレス欄から遷移する
        let doNavigate = (args["navigate"] as? Bool) ?? false
        let activateFallback = (args["activateFallback"] as? Bool) ?? false

        if activateFallback {
            let prevFrontPid = NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0
            _ = AXUIElementPerformAction(entry.element, kAXRaiseAction as CFString)
            _ = AXUIElementSetAttributeValue(entry.element, kAXMainAttribute as CFString, kCFBooleanTrue)
            _ = NSRunningApplication(processIdentifier: entry.pid)?.activate()
            usleep(120_000)
            postHidKey(kVK_ANSI_L, flags: .maskCommand)
            usleep(80_000)
            try? InputDriver.shared.text(["text": targetUrl])
            usleep(80_000)
            postHidKey(kVK_Return)
            return ["state": "navigated-active", "prevFrontPid": Int(prevFrontPid), "title": title]
        }

        if doNavigate {
            let prevFrontPid = NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0
            // Chrome はアドレス欄の Return を前面の窓でしか受けないため、遷移の間だけ対象窓を前に出す
            _ = AXUIElementPerformAction(entry.element, kAXRaiseAction as CFString)
            _ = AXUIElementSetAttributeValue(entry.element, kAXMainAttribute as CFString, kCFBooleanTrue)
            _ = NSRunningApplication(processIdentifier: entry.pid)?.activate()
            usleep(100_000)
            if let bar = findAddressBar(in: entry.element) {
                _ = AXUIElementSetAttributeValue(bar, kAXFocusedAttribute as CFString, kCFBooleanTrue)
                usleep(60_000)
                _ = AXUIElementSetAttributeValue(bar, kAXValueAttribute as CFString, targetUrl as CFTypeRef)
                usleep(60_000)
                _ = AXUIElementPerformAction(bar, kAXConfirmAction as CFString)
                postKeyToPid(entry.pid, code: kVK_Return)
                postHidKey(kVK_Return)
                return ["state": "navigated-bg", "prevFrontPid": Int(prevFrontPid), "title": title]
            }
            return ["state": "no-address-bar", "prevFrontPid": Int(prevFrontPid), "title": title]
        }

        return ["state": "waiting", "title": title, "stillOnMarker": stillOnMarker, "checkboxes": scan.all]
    }

    // ---- 窓の操作（前に出す・閉じる・位置と大きさ・ディスプレイ） ------------------------------

    /** { id: String } → { ok: Bool, method: String } */
    static func raise(_ args: [String: Any]) -> [String: Any] {
        guard AXIsProcessTrusted(), let id = args["id"] as? String, let entry = lookupWindow(id: id) else {
            return ["ok": false, "method": "failed"]
        }
        if axBool(entry.element, kAXMinimizedAttribute as String) == true {
            _ = AXUIElementSetAttributeValue(entry.element, kAXMinimizedAttribute as CFString, kCFBooleanFalse)
        }
        let r1 = AXUIElementPerformAction(entry.element, kAXRaiseAction as CFString)
        _ = AXUIElementSetAttributeValue(entry.element, kAXMainAttribute as CFString, kCFBooleanTrue)
        let activated = NSRunningApplication(processIdentifier: entry.pid)?.activate() ?? false
        return ["ok": r1 == .success || activated, "method": "direct"]
    }

    /** { id: String } → { ok: Bool, gone?: Bool } */
    static func close(_ args: [String: Any]) -> [String: Any] {
        guard let id = args["id"] as? String else { return ["ok": false] }
        guard let entry = lookupWindow(id: id) else {
            return ["ok": true, "gone": true]
        }
        var btnRef: CFTypeRef?
        if AXUIElementCopyAttributeValue(entry.element, kAXCloseButtonAttribute as CFString, &btnRef) == .success,
           let btn = btnRef, CFGetTypeID(btn) == AXUIElementGetTypeID() {
            let err = AXUIElementPerformAction(btn as! AXUIElement, kAXPressAction as CFString)
            if err == .success { return ["ok": true] }
        }
        for child in axChildren(entry.element) {
            if axString(child, kAXSubroleAttribute as String) == "AXCloseButton" {
                if AXUIElementPerformAction(child, kAXPressAction as CFString) == .success {
                    return ["ok": true]
                }
            }
        }
        return ["ok": false]
    }

    /** { id: String, x?: Double, y?: Double, width?: Double, height?: Double, minimized?: Bool } */
    static func moveWindow(_ args: [String: Any]) -> [String: Any] {
        guard AXIsProcessTrusted(), let id = args["id"] as? String, let entry = lookupWindow(id: id) else {
            return ["ok": false]
        }
        if let minVal = args["minimized"] as? Bool {
            _ = AXUIElementSetAttributeValue(entry.element, kAXMinimizedAttribute as CFString, minVal ? kCFBooleanTrue : kCFBooleanFalse)
        }
        if let x = doubleValue(args["x"]), let y = doubleValue(args["y"]) {
            var pt = CGPoint(x: x, y: y)
            if let val = AXValueCreate(.cgPoint, &pt) {
                _ = AXUIElementSetAttributeValue(entry.element, kAXPositionAttribute as CFString, val)
            }
        }
        if let w = doubleValue(args["width"]), let h = doubleValue(args["height"]) {
            var sz = CGSize(width: w, height: h)
            if let val = AXValueCreate(.cgSize, &sz) {
                _ = AXUIElementSetAttributeValue(entry.element, kAXSizeAttribute as CFString, val)
            }
        }
        let pt = axPoint(entry.element, kAXPositionAttribute as String) ?? .zero
        let sz = axSize(entry.element, kAXSizeAttribute as String) ?? .zero
        let minimized = axBool(entry.element, kAXMinimizedAttribute as String) ?? false
        return [
            "ok": true,
            "x": Double(pt.x),
            "y": Double(pt.y),
            "width": Double(sz.width),
            "height": Double(sz.height),
            "minimized": minimized
        ]
    }

    /** グローバル top-left 座標（DIP）のディスプレイ一覧 */
    static func displays() -> [String: Any] {
        var count: UInt32 = 0
        CGGetActiveDisplayList(0, nil, &count)
        guard count > 0 else { return ["displays": []] }
        var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
        CGGetActiveDisplayList(count, &ids, &count)
        let list: [[String: Any]] = ids.prefix(Int(count)).map { id in
            let b = CGDisplayBounds(id)
            return [
                "id": Int(id),
                "x": Double(b.origin.x),
                "y": Double(b.origin.y),
                "width": Double(b.size.width),
                "height": Double(b.size.height),
                "isMain": CGDisplayIsMain(id) != 0
            ]
        }
        return ["displays": list]
    }

    /** CI 診断用: ブラウザーの AX ツリーをダンプする */
    static func dumpAx(_ args: [String: Any]) -> [String: Any] {
        let maxDepth = intValue(args["maxDepth"]) ?? 14
        let trusted = AXIsProcessTrusted()
        guard trusted else { return ["trusted": false, "trees": []] }
        var trees: [[String: Any]] = []
        for pid in browserPids() {
            enableAppAccessibility(pid)
            let appElem = AXUIElementCreateApplication(pid)
            var visited = 0
            func dumpNode(_ node: AXUIElement, depth: Int) -> [String: Any] {
                visited += 1
                var d: [String: Any] = ["role": axString(node, kAXRoleAttribute as String) ?? ""]
                if let sr = axString(node, kAXSubroleAttribute as String), !sr.isEmpty { d["subrole"] = sr }
                if let domId = axString(node, "AXDOMIdentifier") ?? axString(node, kAXIdentifierAttribute as String), !domId.isEmpty { d["domId"] = domId }
                if let t = axString(node, kAXTitleAttribute as String), !t.isEmpty { d["title"] = String(t.prefix(120)) }
                if let desc = axString(node, kAXDescriptionAttribute as String), !desc.isEmpty { d["desc"] = String(desc.prefix(120)) }
                if let v = axString(node, kAXValueAttribute as String), !v.isEmpty { d["value"] = String(v.prefix(120)) }
                else if let iv = axInt(node, kAXValueAttribute as String) { d["value"] = iv }
                if let en = axBool(node, kAXEnabledAttribute as String) { d["enabled"] = en }
                if let pt = axPoint(node, kAXPositionAttribute as String), let sz = axSize(node, kAXSizeAttribute as String) {
                    d["rect"] = [Int(pt.x), Int(pt.y), Int(sz.width), Int(sz.height)]
                }
                if depth < maxDepth && visited < 2500 {
                    let ch = axChildren(node)
                    if !ch.isEmpty {
                        d["children"] = ch.prefix(40).map { dumpNode($0, depth: depth + 1) }
                    }
                }
                return d
            }
            let wins = axChildren(appElem, kAXWindowsAttribute as String).map { dumpNode($0, depth: 0) }
            trees.append(["pid": Int(pid), "windows": wins])
        }
        return ["trusted": true, "trees": trees]
    }
}
#endif
