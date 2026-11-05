import UIKit
import Capacitor
import UserNotifications

@main
class AppDelegate: UIResponder, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // 通知のタップはここで受ける（前面表示は willPresent）。許可の要求はしない —— 入れる操作のときだけ。
        UNUserNotificationCenter.current().delegate = self
        PleiadShell.start()
        // 権限の戻し・トークンの回転・組の変化に登録を合わせる（条件が揃っていなければ中で何もしない）
        PleiadShell.push?.sync()
        return true
    }

    func application(_ application: UIApplication,
                     configurationForConnecting session: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let config = UISceneConfiguration(name: "Default Configuration", sessionRole: session.role)
        config.delegateClass = SceneDelegate.self
        return config
    }

    // ── APNs ──

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        PleiadShell.push?.apnsToken(deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        NSLog("Pleiad: APNs token: %@", String(describing: error))
    }

    /// 前面でも届いたものはそのまま見せる（見ている会話への送信はホスト側が presence で止めている）。
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .list, .sound])
    }

    /// 通知のタップ: 通知拡張が userInfo["pleiad"] = {h, s, b} に書いた行き先へ開く。
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        let info = response.notification.request.content.userInfo
        if let p = info["pleiad"] as? [String: Any], let h = p["h"] as? String {
            let s = p["s"] as? String ?? ""
            for scene in UIApplication.shared.connectedScenes {
                guard let ws = scene as? UIWindowScene else { continue }
                for w in ws.windows {
                    if let bridge = w.rootViewController as? PleiadBridgeViewController {
                        bridge.openNotification(hostId: h, session: s)
                        break
                    }
                }
            }
        }
        completionHandler()
    }
}
