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

    /** Web の中身（AXWebArea）を除いた Chrome 自身の UI 木から、許可ボタンとダイアログ文言を探す */
    private static func scanDialogInTree(_ root: AXUIElement, maxDepth: Int = 12) -> (allowButton: AXUIElement?, allowTitle: String?, hasDialogText: Bool) {
        var allowButton: AXUIElement?
        var allowTitle: String?
        var hasText = false
        var visited = 0

        func walk(_ node: AXUIElement, depth: Int) {
            if depth > maxDepth || visited > 600 { return }
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
            // port が指定されているのに待ち受けプロセスが引けない場合、ブラウザが 1 プロセスだけならそれを使う
            let all = browserPids()
            targetPids = all.count == 1 ? all : []
        } else {
            targetPids = browserPids()
        }

        guard AXIsProcessTrusted() else {
            // AX 無しでも CGWindowList で小さい新しい窓があれば返す
            let snap = windows(["port": port])
            if let list = snap["windows"] as? [[String: Any]] {
                for w in list {
                    guard let id = w["id"] as? String, !since.contains(id),
                          let pid = w["pid"] as? Int, targetPids.contains(pid_t(pid)),
                          let visible = w["visible"] as? Bool, visible,
                          let width = w["width"] as? Double, let height = w["height"] as? Double,
                          width >= minDialogWidth, width <= maxDialogWidth,
                          height >= minDialogHeight, height <= maxDialogHeight else { continue }
                    return ["dialog": w]
                }
            }
            return ["dialog": NSNull()]
        }

        for pid in targetPids {
            enableAppAccessibility(pid)
            let winDicts = collectAxWindows(for: pid)
            // 1. since に無い、小さい窓（またはダイアログ文言／Allow ボタンを持つ窓）
            for w in winDicts {
                guard let id = w["id"] as? String,
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

        // まず対象の窓の中から Allow / 許可する ボタンを探す
        let scan = scanDialogInTree(entry.element, maxDepth: 15)
        if let btn = scan.allowButton {
            let err = AXUIElementPerformAction(btn, kAXPressAction as CFString)
            if err == .success {
                return ["ok": true, "button": scan.allowTitle ?? "Allow", "method": "ax-press"]
            }
        }

        // ダイアログが親窓・兄弟窓としてぶら下がっている場合、同じ PID の他の AXWindow も探す
        let appElem = AXUIElementCreateApplication(entry.pid)
        for win in axChildren(appElem, kAXWindowsAttribute as String) {
            let s = scanDialogInTree(win, maxDepth: 15)
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
            if depth > 14 || visited > 800 { return }
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

    private static func findRemoteDebuggingCheckbox(in root: AXUIElement) -> (checkbox: AXUIElement, checked: Bool, label: String)? {
        var matches: [(checkbox: AXUIElement, checked: Bool, label: String, score: Int)] = []
        var visited = 0

        func collectText(_ node: AXUIElement, depth: Int = 0) -> String {
            if depth > 3 { return "" }
            var parts: [String] = []
            if let t = axString(node, kAXTitleAttribute as String), !t.isEmpty { parts.append(t) }
            if let d = axString(node, kAXDescriptionAttribute as String), !d.isEmpty { parts.append(d) }
            if let v = axString(node, kAXValueAttribute as String), !v.isEmpty { parts.append(v) }
            for c in axChildren(node) {
                let ct = collectText(c, depth: depth + 1)
                if !ct.isEmpty { parts.append(ct) }
            }
            return parts.joined(separator: " ")
        }

        func walk(_ node: AXUIElement, parent: AXUIElement?, depth: Int, inWebArea: Bool) {
            if depth > 30 || visited > 3000 { return }
            visited += 1
            let role = axString(node, kAXRoleAttribute as String) ?? ""
            let nowInWeb = inWebArea || role == "AXWebArea"
            if role == "AXCheckBox" {
                let ownText = collectText(node, depth: 1)
                let parentText = parent.map { collectText($0, depth: 1) } ?? ""
                let combined = "\(ownText) \(parentText)"
                let lower = combined.lowercased()
                let val = axInt(node, kAXValueAttribute as String) ?? ((axBool(node, kAXValueAttribute as String) == true) ? 1 : 0)
                var score = nowInWeb ? 10 : 0
                if lower.contains("remote debugging") || combined.contains("リモート デバッグ") || combined.contains("リモートデバッグ") || lower.contains("browser instance") {
                    score += 100
                }
                if lower.contains("discover usb") || lower.contains("discover network") || lower.contains("port forwarding") {
                    score -= 100
                }
                if score > 0 {
                    matches.append((node, val != 0, ownText.isEmpty ? parentText : ownText, score))
                }
            }
            for child in axChildren(node) {
                walk(child, parent: node, depth: depth + 1, inWebArea: nowInWeb)
            }
        }

        walk(root, parent: nil, depth: 0, inWebArea: false)
        guard let best = matches.max(by: { $0.score < $1.score }) else { return nil }
        return (best.checkbox, best.checked, best.label)
    }

    private static func postReturnToPid(_ pid: pid_t) {
        let src = CGEventSource(stateID: .hidSystemState)
        if let down = CGEvent(keyboardEventSource: src, virtualKey: CGKeyCode(kVK_Return), keyDown: true),
           let up = CGEvent(keyboardEventSource: src, virtualKey: CGKeyCode(kVK_Return), keyDown: false) {
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
     * { id: String, url?: String, navigate?: Bool, activateFallback?: Bool }
     */
    static func enableStep(_ args: [String: Any]) -> [String: Any] {
        guard AXIsProcessTrusted(), let id = args["id"] as? String else {
            return ["state": "error", "reason": "not-trusted-or-no-id"]
        }
        guard let entry = lookupWindow(id: id) else {
            return ["state": "error", "reason": "window-gone"]
        }
        let targetUrl = (args["url"] as? String) ?? "chrome://inspect/#remote-debugging"
        enableAppAccessibility(entry.pid)
        let title = axString(entry.element, kAXTitleAttribute as String) ?? ""

        // 1. すでにチェックボックスが見えていれば、状態を見て必要なら押す
        if let found = findRemoteDebuggingCheckbox(in: entry.element) {
            if found.checked {
                return ["state": "already-on", "checked": true, "label": found.label, "title": title]
            }
            let err = AXUIElementPerformAction(found.checkbox, kAXPressAction as CFString)
            usleep(120_000)
            let after = findRemoteDebuggingCheckbox(in: entry.element)?.checked ?? (err == .success)
            return ["state": "toggled", "checked": after, "axError": Int(err.rawValue), "label": found.label, "title": title]
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
            if let bar = findAddressBar(in: entry.element) {
                _ = AXUIElementSetAttributeValue(bar, kAXFocusedAttribute as CFString, kCFBooleanTrue)
                usleep(40_000)
                _ = AXUIElementSetAttributeValue(bar, kAXValueAttribute as CFString, targetUrl as CFTypeRef)
                usleep(40_000)
                let currentVal = axString(bar, kAXValueAttribute as String) ?? ""
                if !currentVal.contains("chrome://inspect") {
                    postHidKey(kVK_ANSI_L, flags: .maskCommand)
                    usleep(60_000)
                    try? InputDriver.shared.text(["text": targetUrl])
                    usleep(60_000)
                }
                postHidKey(kVK_Return)
                return ["state": "navigated-active", "prevFrontPid": Int(prevFrontPid), "title": title]
            } else {
                postHidKey(kVK_ANSI_L, flags: .maskCommand)
                usleep(80_000)
                try? InputDriver.shared.text(["text": targetUrl])
                usleep(60_000)
                postHidKey(kVK_Return)
                return ["state": "navigated-hotkey", "prevFrontPid": Int(prevFrontPid), "title": title]
            }
        }

        if doNavigate {
            if let bar = findAddressBar(in: entry.element) {
                _ = AXUIElementSetAttributeValue(bar, kAXFocusedAttribute as CFString, kCFBooleanTrue)
                _ = AXUIElementSetAttributeValue(bar, kAXValueAttribute as CFString, targetUrl as CFTypeRef)
                _ = AXUIElementPerformAction(bar, kAXConfirmAction as CFString)
                postReturnToPid(entry.pid)
                return ["state": "navigated-bg", "title": title]
            }
            return ["state": "no-address-bar", "title": title]
        }

        return ["state": "waiting", "title": title]
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
        let maxDepth = intValue(args["maxDepth"]) ?? 8
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
                if let t = axString(node, kAXTitleAttribute as String), !t.isEmpty { d["title"] = String(t.prefix(120)) }
                if let desc = axString(node, kAXDescriptionAttribute as String), !desc.isEmpty { d["desc"] = String(desc.prefix(120)) }
                if let v = axString(node, kAXValueAttribute as String), !v.isEmpty { d["value"] = String(v.prefix(120)) }
                else if let iv = axInt(node, kAXValueAttribute as String) { d["value"] = iv }
                if let pt = axPoint(node, kAXPositionAttribute as String), let sz = axSize(node, kAXSizeAttribute as String) {
                    d["rect"] = [Int(pt.x), Int(pt.y), Int(sz.width), Int(sz.height)]
                }
                if depth < maxDepth && visited < 500 {
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
