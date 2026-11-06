// 殻とプロキシの案内。共通の web の辞書と同じ文言を使う。
import Foundation
import PleiadRemote
enum ShellTexts {
    static var isJapanese: Bool { Bundle.main.preferredLocalizations.first?.hasPrefix("ja") == true }

    private static func pick(_ en: String, _ ja: String) -> String { isJapanese ? ja : en }

    static var revoked: String { pick("This device was revoked on the host", "この端末はホストで取り消されました") }
    static var hostOffline: String { pick("Can't reach the host", "ホストにつながりません") }
    static var reapprove: String { pick("This device needs to be allowed again on the host", "この端末はホストでもう一度の許可が要ります") }
    static var plusBlocked: String { pick("This account can't use the official relay", "このアカウントでは公式の中継を使えません") }
    static var plusLimit: String { pick("This account has reached its limit", "このアカウントの上限に達しています") }
    static var plusPaused: String { pick("Pleiad Plus is temporarily unavailable", "Pleiad Plus は今使えません") }
    static var plusMaintenance: String { pick("Pleiad Plus is under maintenance", "Pleiad Plus はメンテナンス中です") }
    static var plusSignedOut: String { pick("Not signed in", "ログインしていません") }
    static var plusUpdate: String { pick("Please update Pleiad", "Pleiad を更新してください") }
    static var plusRemoved: String { pick("This PC was removed from the Plus account", "この PC は Plus のアカウントから外されています") }
    static var pageRevoked: String { pick("Pair this device again.", "もう一度ペアリングしてください。") }
    static var pageReapprove: String {
        pick("Select this PC in the host list and get it allowed on the host's screen.",
             "ホストの一覧でこの PC を押し、ホストの画面で許可を受けてください。")
    }
    static var pagePlusBlocked: String { pick("This account can't use the official relay.", "このアカウントでは公式の中継を使えません。") }
    static var pagePlusLimit: String { pick("This account has reached its limit.", "このアカウントの上限に達しています。") }
    static var pagePlusPaused: String {
        pick("Pleiad Plus is temporarily unavailable. The connection will resume when it is available.",
             "Pleiad Plus は今使えません。利用できるようになると接続を再開します。")
    }
    static var pagePlusMaintenance: String {
        pick("Pleiad Plus is under maintenance. The connection will resume when it is available.",
             "Pleiad Plus はメンテナンス中です。利用できるようになると接続を再開します。")
    }
    static var pagePlusSignedOut: String {
        pick("Sign in to Pleiad Plus to connect to this host.", "このホストにつなぐには Pleiad Plus にログインしてください。")
    }
    static var pagePlusUpdate: String {
        pick("This version of Pleiad can't use the official relay. Please update Pleiad.",
             "この版の Pleiad では公式の中継を使えません。Pleiad を更新してください。")
    }
    static var pagePlusRemoved: String {
        pick("On that PC, select \"Register this PC again\" under Settings › Pleiad Plus to connect again.",
             "その PC の 設定 › Pleiad Plus で「この PC を登録し直す」を押すと、またつなげます。")
    }
    static var pageHostOffline: String {
        pick("Make sure Pleiad is running on the host. This page opens automatically once connected.",
             "ホストの Pleiad が起動しているか確かめてください。つながり次第、自動で開きます。")
    }
    static var pageOffline: String {
        pick("Can't reach the relay. Check your network. This page opens automatically once connected.",
             "中継につながりません。ネットワークを確かめてください。つながり次第、自動で開きます。")
    }
    static var tokenRequired: String { pick("A token is required (open this from the app)", "トークンが要る（アプリから開いてください）") }
    static var lost: String { pick("Lost the connection to the host", "ホストとの接続が切れました") }
    static var backToHosts: String { pick("Back to hosts", "ホスト一覧に戻る") }
    static var hostOpenFailed: String { pick("Couldn't open this host. Go back and try again.", "このホストを開けませんでした。戻ってもう一度試してください。") }
    static var linkHostOnly: String { pick("localhost links open only on the host's PC.", "localhost のリンクはホストの PC でだけ開けます。") }
    static var scanCancel: String { pick("Cancel", "キャンセル") }
    static var scanHint: String { pick("Point the camera at the QR code on the host", "ホストに出ている QR コードにカメラを向けてください") }
}
struct ProxyWords: ProxyTexts {
    func locale() -> String { ShellTexts.isJapanese ? "ja" : "en" }
    func title(_ state: String) -> String {
        switch state {
        case "revoked": return ShellTexts.revoked
        case "reapprove": return ShellTexts.reapprove
        case "blocked": return ShellTexts.plusBlocked
        case "limit": return ShellTexts.plusLimit
        case "paused":
            return PleiadShell.plus?.stateJson()["plus"]?.string == "maintenance" ? ShellTexts.plusMaintenance : ShellTexts.plusPaused
        case "signed-out": return ShellTexts.plusSignedOut
        case "update": return ShellTexts.plusUpdate
        case "removed": return ShellTexts.plusRemoved
        default: return ShellTexts.hostOffline
        }
    }
    func body(_ state: String) -> String {
        switch state {
        case "revoked": return ShellTexts.pageRevoked
        case "reapprove": return ShellTexts.pageReapprove
        case "blocked": return ShellTexts.pagePlusBlocked
        case "limit": return ShellTexts.pagePlusLimit
        case "paused":
            return PleiadShell.plus?.stateJson()["plus"]?.string == "maintenance" ? ShellTexts.pagePlusMaintenance : ShellTexts.pagePlusPaused
        case "signed-out": return ShellTexts.pagePlusSignedOut
        case "update": return ShellTexts.pagePlusUpdate
        case "removed": return ShellTexts.pagePlusRemoved
        case "host-offline": return ShellTexts.pageHostOffline
        default: return ShellTexts.pageOffline
        }
    }
    func tokenRequired() -> String { ShellTexts.tokenRequired }
    func lost() -> String { ShellTexts.lost }
    func backToHosts() -> String { ShellTexts.backToHosts }
}
