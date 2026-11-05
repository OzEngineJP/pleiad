// Decides what the notification shade should look like for each notice (docs/remote.md §11-5, ADR 0086). Pure state
// machine: the app turns NotifyActions into notifications in its own language. Swift port of NotifyPlanner.kt.
//
// Rules:
//   - one notification per conversation (a newer notice overwrites it); approvals / questions / failures are separate
//     "needs attention" notifications, completions are plain ones
//   - each completion keeps its own notification; from the second one a per-host bundle ("N conversations finished")
//     sits on top as the group summary. A new completion alerts once: the new child posts quietly and the bundle
//     alerts; every re-count of the bundle (a child opened / seen / overwritten) is quiet, and the bundle goes away
//     when fewer than two completions remain
//   - a cancel (decided somewhere / looked at somewhere) removes the notification; a cancel for a conversation we have no
//     state for still cancels, because cancelling a notification that is not there is harmless
//   - notices are applied once, in order: a sequence number not above the last one seen for a host is a replay
//   - the settings are applied again here (the host filters first, but the settings may have changed since)
//   - a device waiting on the host's approval window is its own "needs attention" notification (no conversation, no
//     buttons: it is allowed on the host's screen), removed when the host settles the request

import Foundation

public final class NotifyPlanner {
    private final class Slot {
        var kind: String
        var title: String
        var host: String
        var at: Int64
        var ids: Set<String> = []
        /// Its own notification was posted (completions keep it even while a bundle sits on top).
        var shown = false
        init(kind: String, title: String, host: String, at: Int64) {
            self.kind = kind
            self.title = title
            self.host = host
            self.at = at
        }
    }

    private final class HostState {
        var lastSeq: Int64 = 0
        /// session -> slot, oldest first (re-inserted when overwritten).
        var slots: [(String, Slot)] = []
        var bundled = false
        var host = ""

        func slot(_ s: String) -> Slot? { slots.first { $0.0 == s }?.1 }

        @discardableResult
        func remove(_ s: String) -> Slot? {
            guard let i = slots.firstIndex(where: { $0.0 == s }) else { return nil }
            return slots.remove(at: i).1
        }
    }

    private var hosts: [String: HostState] = [:]
    private let lock = NSLock()

    public static let MAX_SLOTS = 100
    public static func slotKey(_ hostId: String, _ session: String) -> String { "\(hostId)|\(session)" }
    public static func bundleKey(_ hostId: String) -> String { "\(hostId)|bundle" }
    public static func deviceKey(_ hostId: String, _ id: String) -> String { "\(hostId)|device:\(id)" }
    private static func attention(_ kind: String) -> Bool { kind != NoticeKind.DONE }

    public init() {}

    public func onNotice(_ n: PushNotice, _ s: NotifySettings) -> [NotifyAction] {
        lock.lock(); defer { lock.unlock() }
        let h: HostState
        if let existing = hosts[n.hostId] { h = existing } else { h = HostState(); hosts[n.hostId] = h }
        if n.seq <= h.lastSeq { return [] }
        h.lastSeq = n.seq
        if !n.host.isEmpty { h.host = n.host }
        switch n.kind {
        case NoticeKind.CANCEL:
            return cancel(h, n)
        case NoticeKind.APPROVAL, NoticeKind.QUESTION:
            return s.enabled && s.reply ? post(h, n) : []
        case NoticeKind.FAILED, NoticeKind.SCHEDULE_MISSED:
            return s.enabled && s.failed ? post(h, n) : []
        case NoticeKind.DONE:
            return s.enabled && s.done ? post(h, n) : []
        case NoticeKind.DEVICE:
            guard s.enabled && s.reply, let id = n.id else { return [] }
            return [.post(.init(key: NotifyPlanner.deviceKey(n.hostId, id), kind: NoticeKind.DEVICE, hostId: n.hostId,
                                host: h.host, session: "", title: n.title, at: n.at, attention: true))]
        default:
            return []
        }
    }

    /**
     * The user opened a notification (tap). [bundle] = the "N conversations finished" one: all completions of the host
     * are acknowledged (their own notifications go too). Otherwise only that conversation's own notification — and the
     * bundle is re-counted.
     */
    public func opened(_ hostId: String, _ session: String?, _ bundle: Bool) -> [NotifyAction] {
        lock.lock(); defer { lock.unlock() }
        guard let h = hosts[hostId] else { return [] }
        var out: [NotifyAction] = []
        if bundle {
            for (s, slot) in h.slots where slot.kind == NoticeKind.DONE {
                _ = h.remove(s)
                out.append(.cancel(.init(key: NotifyPlanner.slotKey(hostId, s))))
            }
            if h.bundled { h.bundled = false; out.append(.cancel(.init(key: NotifyPlanner.bundleKey(hostId)))) }
            return out
        }
        if let session {
            if let removed = h.remove(session), removed.kind == NoticeKind.DONE {
                out.append(.cancel(.init(key: NotifyPlanner.slotKey(hostId, session))))
                out += syncDone(h, hostId, alert: false)
            }
        }
        return out
    }

    public func reset() {
        lock.lock(); defer { lock.unlock() }
        hosts.removeAll()
    }

    private func post(_ h: HostState, _ n: PushNotice) -> [NotifyAction] {
        let hostId = n.hostId
        let old = h.remove(n.session)
        let slot = Slot(kind: n.kind, title: n.title, host: h.host, at: n.at)
        if NotifyPlanner.attention(n.kind) && n.kind != NoticeKind.FAILED && n.kind != NoticeKind.SCHEDULE_MISSED {
            // approvals / questions already waiting in this conversation stay counted
            if let old, NotifyPlanner.attention(old.kind) && old.kind != NoticeKind.FAILED && old.kind != NoticeKind.SCHEDULE_MISSED {
                slot.ids.formUnion(old.ids)
            }
            slot.ids.insert(n.id ?? "?")
        }
        h.slots.append((n.session, slot))
        while h.slots.count > NotifyPlanner.MAX_SLOTS { h.slots.removeFirst() }
        var out: [NotifyAction] = []
        if NotifyPlanner.attention(n.kind) {
            slot.shown = true
            out.append(.post(.init(key: NotifyPlanner.slotKey(hostId, n.session), kind: n.kind, hostId: hostId, host: h.host,
                                   session: n.session, title: n.title, at: n.at, attention: true,
                                   pending: max(1, slot.ids.count))))
            if old?.kind == NoticeKind.DONE { out += syncDone(h, hostId, alert: false) }
        } else {
            out += syncDone(h, hostId, alert: true)
        }
        return out
    }

    private func cancel(_ h: HostState, _ n: PushNotice) -> [NotifyAction] {
        let hostId = n.hostId
        let slot = h.slot(n.session)
        let key = NotifyPlanner.slotKey(hostId, n.session)
        switch n.cancel {
        case "approval":
            guard let slot else { return [.cancel(.init(key: key))] }
            guard slot.kind == NoticeKind.APPROVAL || slot.kind == NoticeKind.QUESTION else { return [] }
            if let id = n.id { slot.ids.remove(id) } else { slot.ids.removeAll() }
            if slot.ids.isEmpty {
                _ = h.remove(n.session)
                return [.cancel(.init(key: key))]
            }
            return [.post(.init(key: key, kind: slot.kind, hostId: hostId, host: h.host, session: n.session,
                                title: slot.title, at: slot.at, attention: true, silent: true, pending: slot.ids.count))]
        case "device":
            guard let id = n.id else { return [] }
            return [.cancel(.init(key: NotifyPlanner.deviceKey(hostId, id)))]
        case "seen":
            guard let slot else { return [.cancel(.init(key: key))] }
            guard slot.kind == NoticeKind.DONE || slot.kind == NoticeKind.FAILED || slot.kind == NoticeKind.SCHEDULE_MISSED else { return [] }
            _ = h.remove(n.session)
            var out: [NotifyAction] = [.cancel(.init(key: key))]
            if slot.kind == NoticeKind.DONE { out += syncDone(h, hostId, alert: false) }
            return out
        default:
            return []
        }
    }

    /**
     * Brings the completions of one host to the right shape: each keeps its own notification, and from the second one a
     * bundle sits on top. [alert] marks a newly arrived completion: it sounds once (the first alone, then the bundle —
     * the new child posts quietly). Re-counts after a removal are quiet.
     */
    private func syncDone(_ h: HostState, _ hostId: String, alert: Bool) -> [NotifyAction] {
        let dones = h.slots.filter { $0.1.kind == NoticeKind.DONE }
        var out: [NotifyAction] = []
        if dones.isEmpty {
            if h.bundled { h.bundled = false; out.append(.cancel(.init(key: NotifyPlanner.bundleKey(hostId)))) }
        } else if dones.count == 1 {
            let (session, slot) = dones[0]
            if h.bundled { h.bundled = false; out.append(.cancel(.init(key: NotifyPlanner.bundleKey(hostId)))) }
            if !slot.shown || alert {
                // Overwriting its own earlier notification keeps it quiet; a first showing alerts
                slot.shown = true
                out.append(.post(.init(key: NotifyPlanner.slotKey(hostId, session), kind: NoticeKind.DONE, hostId: hostId,
                                       host: h.host, session: session, title: slot.title, at: slot.at,
                                       attention: false, silent: !alert)))
            }
        } else {
            for (session, slot) in dones where !slot.shown {
                // Each completion keeps a row under the bundle; the bundle carries the alert for a new one
                slot.shown = true
                out.append(.post(.init(key: NotifyPlanner.slotKey(hostId, session), kind: NoticeKind.DONE, hostId: hostId,
                                       host: h.host, session: session, title: slot.title, at: slot.at,
                                       attention: false, silent: true)))
            }
            let newest = dones[dones.count - 1]
            h.bundled = true
            out.append(.bundle(.init(key: NotifyPlanner.bundleKey(hostId), hostId: hostId, host: h.host, count: dones.count,
                                     titles: dones.reversed().map { $0.1.title }, session: newest.0, at: newest.1.at,
                                     silent: !alert)))
        }
        return out
    }
}
