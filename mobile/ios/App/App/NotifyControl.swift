// 離れている間の通知（ADR 0086 iOS）: アプリの設定画面（プラグイン）とホスト窓の帯が共有する状態と「入にする」流れ。
// Android の NotifyControl。iOS は背面で WebSocket を保てないので、届くのは APNs だけ —— Pleiad Plus の経路で組んだ
// ホストが対象（自分の中継だけのホストは対象外。state の plusOnly / targets が画面にそれを伝える）。
// 許可はインストール時に尋ねず、入れる操作のときだけ尋ねる。
import Foundation
import UIKit
import UserNotifications
import PleiadRemote

enum NotifyControl {
    /// { settings, permission: "granted"|"missing", enabled, dismissed, plusOnly, targets }
    static func state(_ done: @escaping ([String: Any]) -> Void) {
        UNUserNotificationCenter.current().getNotificationSettings { s in
            done(state(granted: s.authorizationStatus == .authorized))
        }
    }

    private static func state(granted: Bool) -> [String: Any] {
        guard let device = PleiadShell.device else { return ["permission": granted ? "granted" : "missing"] }
        let store = device.store
        let s = store.notifySettings()
        // iOS で届くのは Pleiad Plus の経路だけ: 有効な Plus の組が通知の対象になる
        let targets = ((try? store.hosts()) ?? []).filter { $0.via == "plus" && HostRoute.usable($0) }.count
        return ["settings": ["enabled": s.enabled, "reply": s.reply, "failed": s.failed, "done": s.done,
                             "lockNames": s.lockNames, "skipPc": s.skipPc],
                "permission": granted ? "granted" : "missing",
                "enabled": s.enabled && granted,
                "dismissed": store.notifyBandDismissed(),
                "plusOnly": true,
                "targets": targets]
    }

    /// 設定の一部を足し合わせる（enabled は「切」だけ通る。入は enable から）。
    static func update(_ patch: [String: Any], _ done: @escaping ([String: Any]) -> Void) {
        guard let device = PleiadShell.device else { return state(done) }
        var s = device.store.notifySettings()
        if let v = patch["enabled"] as? Bool, !v { s.enabled = false }
        if let v = patch["reply"] as? Bool { s.reply = v }
        if let v = patch["failed"] as? Bool { s.failed = v }
        if let v = patch["done"] as? Bool { s.done = v }
        if let v = patch["lockNames"] as? Bool { s.lockNames = v }
        if let v = patch["skipPc"] as? Bool { s.skipPc = v }
        try? device.store.saveNotifySettings(s)
        PleiadShell.push?.sync()
        state(done)
    }

    /// 通知を入にする: 許可がまだならここで尋ね（インストール時には尋ねない）、入れて登録を合わせる。
    /// done に { ok, permission, state }。
    static func enable(_ done: @escaping ([String: Any]) -> Void) {
        func finish(_ ok: Bool) {
            state { done(["ok": ok, "permission": ok ? "granted" : "missing", "state": $0]) }
        }
        func proceed() {
            guard let device = PleiadShell.device else { return finish(false) }
            var s = device.store.notifySettings()
            s.enabled = true
            try? device.store.saveNotifySettings(s)
            DispatchQueue.main.async { UIApplication.shared.registerForRemoteNotifications() }
            PleiadShell.push?.sync()
            finish(true)
        }
        let center = UNUserNotificationCenter.current()
        center.getNotificationSettings { s in
            switch s.authorizationStatus {
            case .authorized, .ephemeral:
                proceed()
            case .notDetermined:
                center.requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in
                    if granted { proceed() } else { finish(false) }
                }
            default:
                // denied / provisional: 端末の設定で戻してもらう（画面が「端末の設定を開く」を出す）
                finish(false)
            }
        }
    }

    /// 帯の「あとで」: 覚えておいて帯はもう出さない（アプリの通知の設定は残る）。
    static func dismissBand() {
        try? PleiadShell.device?.store.setNotifyBandDismissed(true)
    }

    /// 端末の設定のアプリのページ（許可を断られたあと）。
    static func openSystemSettings() {
        DispatchQueue.main.async {
            guard let u = URL(string: UIApplication.openSettingsURLString) else { return }
            UIApplication.shared.open(u)
        }
    }
}
