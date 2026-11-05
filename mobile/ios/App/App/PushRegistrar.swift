// APNs の届け先の面倒を見る（docs/remote.md §11-5 の iOS・計画書）。
//
// 届く条件がそろうとき（通知の設定が入・OS の許可あり・Plus にサインイン）:
//   1. 有効な Plus の組ごとに、端末の通知鍵と設定を E2E の中でホストに登録する（NotifyRegistrar —— 鍵は中継の
//      通知線を通さない）。
//   2. APNs の端末トークンを api の PUT /v1/push/apns に { hostId, deviceId, token, env, bundle } で結ぶ。
//      api は中身を知らない —— 届くのはホストが暗号化した丸ごとの塊で、開けるのはこの端末だけ。
// 条件が崩れた（設定を切・許可の剥奪・サインアウト）ときは DELETE /v1/push/apns で解く。自分の中継だけの組は
// 対象外: 登録も api への結び付けもしない。
import Foundation
import UIKit
import UserNotifications
import PleiadRemote

final class PushRegistrar {
    private let store: DeviceStore
    private let registrar: NotifyRegistrar
    private let idToken: () -> String?
    private let apiBase: String
    private let clientTag: String
    private let bundle: String
    private let env: String
    private let log: (String) -> Void

    private let worker = DispatchQueue(label: "pleiad-push", qos: .utility)
    private var token: String?                    // APNs の端末トークン（16進）
    private var registered: [String: String] = [:]  // hostId -> "deviceId|token"（api に結んだ印）
    private var pushedToken: String?              // この起動で PUT に使ったトークン（DELETE はそれで解く）

    init(store: DeviceStore, registrar: NotifyRegistrar, idToken: @escaping () -> String?,
         apiBase: String, clientTag: String, bundle: String, env: String, log: @escaping (String) -> Void = { _ in }) {
        self.store = store
        self.registrar = registrar
        self.idToken = idToken
        self.apiBase = apiBase
        self.clientTag = clientTag
        self.bundle = bundle
        self.env = env
        self.log = log
    }

    /// AppDelegate が APNs の端末トークンを受け取った。変わったら結び直し。
    func apnsToken(_ data: Data) {
        let t = data.map { String(format: "%02x", $0) }.joined()
        worker.async { [self] in
            if t == token { return }
            token = t
            registered.removeAll()
            syncLocked()
        }
    }

    /// 設定・許可・サインイン・組が変わったかもしれない: 登録をあるべき姿に合わせる。どのスレッドからでも呼べる。
    func sync() {
        worker.async { [self] in syncLocked() }
    }

    /// 組が外れた（剥奪・削除・台帳から消えた）。api 側の掃除は api の役目（device-revoke の出来事で消す）。
    /// こちらは結んだ印を忘れるだけ —— 次の sync で結び直されることはない。
    func hostGone(_ hostId: String) {
        worker.async { [self] in registered.removeValue(forKey: hostId) }
    }

    /// 登録を解く。サインアウトの直前に呼ぶ（呼ぶ側が ID トークンをまだ持っているうちに取っておく）。
    func unregister() {
        let auth = idToken()
        worker.async { [self] in unregisterLocked(idToken: auth) }
    }

    // ── worker の中 ──

    private func syncLocked() {
        let settings = store.notifySettings()
        guard settings.enabled, permissionGranted() else {
            return unregisterLocked(idToken: idToken())
        }
        DispatchQueue.main.async { UIApplication.shared.registerForRemoteNotifications() }
        guard let token else { return }   // トークンが届いたら apnsToken() からもう一度
        let key: Bytes
        do { key = try store.notifyKey() } catch { log("push: keychain: \(error)"); return }
        for h in (try? store.hosts()) ?? [] where h.via == "plus" && HostRoute.usable(h) {
            guard let creds = try? store.credentials(h.hostId, via: "plus") else { continue }
            switch registrar.register(creds: creds, key: key, settings: settings) {
            case .done(let enabled):
                guard enabled else { continue }
                let mark = "\(creds.deviceId)|\(token)"
                if registered[h.hostId] == mark { continue }
                guard let auth = idToken() else { log("push: signed out"); return }
                do {
                    _ = try PlusHttp.request("PUT", "\(apiBase)/v1/push/apns", headers: headers(auth), json: [
                        "hostId": .string(h.hostId), "deviceId": .string(creds.deviceId),
                        "token": .string(token), "env": .string(env), "bundle": .string(bundle)])
                    registered[h.hostId] = mark
                    pushedToken = token
                } catch { log("push \(h.hostId): \(error)") }
            case .unsupported:
                log("push \(h.hostId): notifications unsupported")
            case .failed(let state, let detail):
                log("push \(h.hostId): \(state)\(detail.map { " (\($0))" } ?? "")")
            }
        }
    }

    private func unregisterLocked(idToken auth: String?) {
        registered.removeAll()
        guard let t = pushedToken else { return }
        pushedToken = nil
        guard let auth else { return }
        do {
            _ = try PlusHttp.request("DELETE", "\(apiBase)/v1/push/apns", headers: headers(auth),
                                     json: ["token": .string(t)])
        } catch { log("push unregister: \(error)") }
    }

    private func headers(_ auth: String) -> [String: String] {
        ["Authorization": "Bearer \(auth)",
         "X-Pleiad-Client": clientTag,
         PlusApi.ADMISSION_HEADER: PlusApi.ADMISSION_MARK]
    }

    private func permissionGranted() -> Bool {
        let sem = DispatchSemaphore(value: 0)
        var granted = false
        UNUserNotificationCenter.current().getNotificationSettings { s in
            granted = s.authorizationStatus == .authorized
            sem.signal()
        }
        _ = sem.wait(timeout: .now() + 10)
        return granted
    }
}
