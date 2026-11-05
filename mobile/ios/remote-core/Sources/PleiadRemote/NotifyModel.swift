// Notifications while away (docs/remote.md §11-5, ADR 0086): the data shapes. The host encrypts a small, fixed-size
// notice per device (core/notify/crypto.mjs); the device decrypts it here, decides what to show (NotifyPlanner) and the
// app turns that into notifications in its own language. Nothing here touches the OS (the notification extension also
// links this file). Swift port of NotifyModel.kt.
import Foundation

/// The device's own notification settings (per device; the host also keeps a copy so it can filter before sending).
public struct NotifySettings: Equatable {
    public var enabled: Bool
    public var reply: Bool
    public var failed: Bool
    public var done: Bool
    /// Show the conversation title on the lock screen (default off: a generic sentence is shown instead).
    public var lockNames: Bool
    /// Do not notify about a conversation that is open on the PC (the host filters; this flag tells it to).
    public var skipPc: Bool

    public init(enabled: Bool = false, reply: Bool = true, failed: Bool = true, done: Bool = true,
                lockNames: Bool = false, skipPc: Bool = true) {
        self.enabled = enabled
        self.reply = reply
        self.failed = failed
        self.done = done
        self.lockNames = lockNames
        self.skipPc = skipPc
    }

    /// The shape the host's `notifyRegister` takes (core/notify/policy.mjs normalizeDeviceSettings).
    public var json: JSON {
        ["enabled": .bool(enabled), "reply": .bool(reply), "failed": .bool(failed), "done": .bool(done),
         "lockNames": .bool(lockNames), "skipPc": .bool(skipPc)]
    }

    public static func from(_ o: JSON?) -> NotifySettings {
        guard let o else { return NotifySettings() }
        let d = NotifySettings()
        return NotifySettings(enabled: o["enabled"]?.bool ?? d.enabled, reply: o["reply"]?.bool ?? d.reply,
                              failed: o["failed"]?.bool ?? d.failed, done: o["done"]?.bool ?? d.done,
                              lockNames: o["lockNames"]?.bool ?? d.lockNames, skipPc: o["skipPc"]?.bool ?? d.skipPc)
    }
}

public enum NoticeKind {
    public static let APPROVAL = "approval"
    public static let QUESTION = "question"
    public static let FAILED = "failed"
    public static let SCHEDULE_MISSED = "scheduleMissed"
    public static let DONE = "done"
    /// A new device waits on the host's approval window (ADR 0248). A notice only: it is allowed on the host's screen.
    public static let DEVICE = "device"
    public static let CANCEL = "cancel"
    static let all: Set<String> = [APPROVAL, QUESTION, FAILED, SCHEDULE_MISSED, DONE, DEVICE, CANCEL]
}

/// One decrypted notice. Titles are conversation names only (never message text).
public struct PushNotice: Equatable {
    public var seq: Int64
    public var at: Int64
    public var kind: String
    public var hostId: String
    public var host: String
    public var session: String
    public var title: String
    /// The approval / question id (approval, question, and cancel of an approval); the request id for [NoticeKind.DEVICE].
    public var id: String?
    /// For [NoticeKind.CANCEL]: "approval" (decided somewhere), "seen" (a completion / failure was looked at) or
    /// "device" (the device request was settled on the host).
    public var cancel: String?

    public init(seq: Int64, at: Int64, kind: String, hostId: String, host: String, session: String, title: String,
                id: String? = nil, cancel: String? = nil) {
        self.seq = seq
        self.at = at
        self.kind = kind
        self.hostId = hostId
        self.host = host
        self.session = session
        self.title = title
        self.id = id
        self.cancel = cancel
    }

    public static func from(_ o: JSON) -> PushNotice? {
        guard o["v"]?.int == 1 else { return nil }
        guard let kind = o["kind"]?.string, NoticeKind.all.contains(kind) else { return nil }
        guard let seq = o["seq"]?.int, seq > 0 else { return nil }
        return PushNotice(seq: seq, at: o["at"]?.int ?? 0, kind: kind,
                          hostId: o["hostId"]?.string ?? "", host: o["host"]?.string ?? "",
                          session: o["session"]?.string ?? "", title: o["title"]?.string ?? "",
                          id: (o["id"]?.string).flatMap { $0.isEmpty ? nil : $0 },
                          cancel: (o["cancel"]?.string).flatMap { $0.isEmpty ? nil : $0 })
    }
}

/// What the app should do to the notification shade. The app keys notifications by [key] (a stable id per key).
public enum NotifyAction: Equatable {
    /**
     * One conversation's notification (one per conversation: a newer one overwrites). [attention] = needs a reply or
     * failed (high-priority channel), otherwise the completion channel. [silent]: post without alerting (a completion
     * under a bundle — the bundle carries the alert — or a quiet re-post after a re-count).
     */
    public struct Post: Equatable {
        public var key: String
        public var kind: String
        public var hostId: String
        public var host: String
        public var session: String
        public var title: String
        public var at: Int64
        public var attention: Bool
        public var silent: Bool
        /// Number of approvals / questions pending in this conversation.
        public var pending: Int

        public init(key: String, kind: String, hostId: String, host: String, session: String, title: String,
                    at: Int64, attention: Bool, silent: Bool = false, pending: Int = 1) {
            self.key = key
            self.kind = kind
            self.hostId = hostId
            self.host = host
            self.session = session
            self.title = title
            self.at = at
            self.attention = attention
            self.silent = silent
            self.pending = pending
        }
    }

    /// "N conversations finished" for one host: the group summary on top of the completions' own notifications.
    public struct Bundle: Equatable {
        public var key: String
        public var hostId: String
        public var host: String
        public var count: Int
        /// Newest first.
        public var titles: [String]
        /// Opened when the bundle is tapped: the newest finished conversation.
        public var session: String
        public var at: Int64
        public var silent: Bool

        public init(key: String, hostId: String, host: String, count: Int, titles: [String], session: String,
                    at: Int64, silent: Bool = false) {
            self.key = key
            self.hostId = hostId
            self.host = host
            self.count = count
            self.titles = titles
            self.session = session
            self.at = at
            self.silent = silent
        }
    }

    public struct Cancel: Equatable {
        public var key: String
        public init(key: String) { self.key = key }
    }

    case post(Post)
    case bundle(Bundle)
    case cancel(Cancel)

    public var key: String {
        switch self {
        case .post(let p): return p.key
        case .bundle(let b): return b.key
        case .cancel(let c): return c.key
        }
    }
}
