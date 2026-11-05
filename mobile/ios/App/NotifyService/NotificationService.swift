// APNs で届く通知の拡張（docs/remote.md §11-5 の iOS、ADR 0086）。iOS は背面で中継の線を保てないので、
// ホストが暗号化した通知の塊を APNs が運び、この拡張が端末の中でだけ開いて文を作る。
// api・中継・Apple は中身を知らない —— 開けるのは共有 Keychain グループの通知鍵を持つこの端末だけ。
// 鍵が読めない・開けない・自分宛てでないときは一般文「新しい通知があります」のまま届ける。
import UserNotifications
import PleiadRemote

final class NotificationService: UNNotificationServiceExtension {
    private var handler: ((UNNotificationContent) -> Void)?
    private var best: UNMutableNotificationContent?
    /// 同じ起動の中でのホストごとの最新の通し番号（古いものは捨てる）。拡張は呼び出しごとに作り直されうるので、
    /// 届け済みの整理でも古いものを消す。
    private static var lastSeqs: [String: Int64] = [:]
    private static let seqsLock = NSLock()

    override func didReceive(_ request: UNNotificationRequest,
                             withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
        handler = contentHandler
        guard let mutable = request.content.mutableCopy() as? UNMutableNotificationContent else {
            return contentHandler(request.content)
        }
        best = mutable
        let info = request.content.userInfo
        guard let p = info["p"] as? [String: Any],
              let h = p["h"] as? String, let d = p["d"] as? String, let b = p["b"] as? String else {
            return finish()   // 私たちの形でない → 一般文のまま
        }
        var notice: PushNotice?
        if let key = try? NotifyKeychain().load() {
            notice = NotifyCrypto.open(key: key, hostId: h, deviceId: d, blob: b)
        }
        guard let notice, notice.kind != NoticeKind.CANCEL else { return finish() }   // 取り消しは届いたまま（アプリが整える）
        Self.seqsLock.lock()
        let stale = notice.seq <= (Self.lastSeqs[h] ?? 0)
        Self.lastSeqs[h] = max(Self.lastSeqs[h] ?? 0, notice.seq)
        Self.seqsLock.unlock()
        if stale { return finish() }
        // 題は会話名（端末の言葉の「何があったか」が本文）、小題はホスト名 —— Android の NotifyPresenter と同じ型
        let device = notice.kind == NoticeKind.DEVICE
        let untitled = NSLocalizedString("notify_untitled", comment: "no conversation name")
        mutable.title = device ? bodyText(notice) : (notice.title.isEmpty ? untitled : notice.title)
        mutable.body = device ? String(format: NSLocalizedString("notify_device_body", comment: ""), notice.title.isEmpty ? "?" : notice.title)
                              : bodyText(notice)
        if !notice.host.isEmpty { mutable.subtitle = notice.host }
        mutable.threadIdentifier = "pleiad-notices:\(h)"
        var userInfo = mutable.userInfo
        userInfo["pleiad"] = ["h": h, "s": notice.session, "seq": NSNumber(value: notice.seq)]
        mutable.userInfo = userInfo
        tidy(h: h, session: notice.session, seq: notice.seq)
        finish()
    }

    override func serviceExtensionTimeWillExpire() {
        if let handler, let best { handler(best) }
    }

    private func finish() {
        if let handler, let best { handler(best) }
    }

    private func bodyText(_ n: PushNotice) -> String {
        let key: String
        switch n.kind {
        case NoticeKind.APPROVAL, NoticeKind.DEVICE: key = "notify_approval"
        case NoticeKind.QUESTION: key = "notify_question"
        case NoticeKind.FAILED: key = "notify_failed"
        case NoticeKind.SCHEDULE_MISSED: key = "notify_schedule_missed"
        default: key = "notify_done"
        }
        return NSLocalizedString(key, comment: "")
    }

    /// 同じ会話の古い届け済みを消す（1 会話 1 通知を保つ）。読めないときはそのまま —— スレッドで畳まれるだけ。
    private func tidy(h: String, session: String, seq: Int64) {
        UNUserNotificationCenter.current().getDeliveredNotifications { list in
            var drop: [String] = []
            for n in list {
                guard let p = n.request.content.userInfo["pleiad"] as? [String: Any],
                      p["h"] as? String == h else { continue }
                let oldSeq = (p["seq"] as? NSNumber)?.int64Value ?? 0
                if (p["s"] as? String == session && oldSeq <= seq) || oldSeq <= seq && (p["s"] as? String).isNilOrEmpty {
                    drop.append(n.request.identifier)
                }
            }
            if !drop.isEmpty { UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: drop) }
        }
    }
}

private extension Optional where Wrapped == String {
    var isNilOrEmpty: Bool { (self ?? "").isEmpty }
}

/// 共有アクセスグループの通知鍵を読むだけの口。アプリ側は KeychainVault(account: "notify", accessGroup: 共有) で書く;
/// この拡張のアクセスグループは共有だけなので、グループの指定は要らない。
private struct NotifyKeychain {
    func load() throws -> Bytes? {
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                              kSecAttrService as String: "dev.pleiad.app.remote",
                              kSecAttrAccount as String: "notify",
                              kSecAttrSynchronizable as String: kCFBooleanFalse as Any,
                              kSecReturnData as String: true,
                              kSecMatchLimit as String: kSecMatchLimitOne]
        var out: CFTypeRef?
        let st = SecItemCopyMatching(q as CFDictionary, &out)
        if st == errSecItemNotFound { return nil }
        guard st == errSecSuccess, let data = out as? Data else { throw VaultError("keychain read \(st)") }
        return Bytes(data)
    }
}
