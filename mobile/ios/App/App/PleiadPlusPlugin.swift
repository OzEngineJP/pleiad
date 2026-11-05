// 殻から Pleiad Plus への橋（docs/plus.md「iOS」。Android の PleiadPlusPlugin.kt）。同梱の一覧ページだけが見る。
// メソッド: state() · login()（ASWebAuthenticationSession で認証画面を開く; 結果は `state` イベントで届く）·
// logout() · openAccount()。イベント: `state`（state() と同じ形）。ID トークンはネイティブの中に留める。
import Foundation
import UIKit
import AuthenticationServices
import Capacitor
import PleiadRemote

@objc(PleiadPlusPlugin)
final class PleiadPlusPlugin: CAPPlugin, CAPBridgedPlugin, ASWebAuthenticationPresentationContextProviding {
    let identifier = "PleiadPlusPlugin"
    let jsName = "PleiadPlus"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "state", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "login", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "logout", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openAccount", returnType: CAPPluginReturnPromise),
    ]

    // main だけが触る
    private var authSession: ASWebAuthenticationSession?
    private var loginSeq = 0

    override func load() {
        PleiadShell.plus?.onChanged = { [weak self] in
            guard let s = PleiadShell.plus?.stateJson() else { return }
            self?.notifyListeners("state", data: ShellBridge.foundationObject(s))
            PleiadShell.device?.retryPausedPlus()
        }
        PleiadShell.startPlus()
    }

    @objc func state(_ call: CAPPluginCall) {
        guard let s = PleiadShell.plus?.stateJson() else { return call.reject("plus is unavailable", "unavailable") }
        call.resolve(ShellBridge.foundationObject(s))
    }

    @objc func login(_ call: CAPPluginCall) {
        guard let plus = PleiadShell.plus else { return call.reject("plus is unavailable", "unavailable") }
        let lang = NSLocale.preferredLanguages.first ?? "en"
        plus.login(lang: lang) { [weak self] urlString in
            DispatchQueue.main.async {
                guard let self, let urlString, let url = URL(string: urlString) else {
                    return call.reject("plus is unavailable", "unavailable")
                }
                self.present(url, plus: plus, call: call)
            }
        }
    }

    /// main で呼ぶ。前の試行のセッションは閉じ、その知らせは数に合わないので捨てる（新しい試行の pending を消さない）。
    private func present(_ url: URL, plus: PlusManager, call: CAPPluginCall) {
        authSession?.cancel()
        loginSeq += 1
        let seq = loginSeq
        // callbackURLScheme "pleiad": 認証画面が pleiad://auth に飛ぶとセッションが URL を受け取って閉じる。
        // Safari とクッキーを共有する（アカウントの画面でログイン済みならそのまま）。
        let session = ASWebAuthenticationSession(url: url, callbackURLScheme: "pleiad") { [weak self] callback, error in
            DispatchQueue.main.async {
                guard let self, self.loginSeq == seq else { return }
                self.authSession = nil
                if let callback {
                    plus.onAuthLink(callback.absoluteString)
                } else if let err = error as? ASWebAuthenticationSessionError, err.code == .canceledLogin {
                    plus.cancelLogin()   // 閉じられた: 画面を「ログイン」に戻す
                } else if let error {
                    NSLog("Pleiad: auth session: %@", error.localizedDescription)
                    plus.onAuthLink("pleiad://auth?error=failed")
                }
            }
        }
        session.presentationContextProvider = self
        session.prefersEphemeralWebBrowserSession = false
        authSession = session
        if session.start() {
            call.resolve()
        } else {
            authSession = nil
            plus.cancelLogin()
            call.reject("couldn't open the browser", "unreachable")
        }
    }

    @objc func logout(_ call: CAPPluginCall) {
        PleiadShell.plus?.logout()
        call.resolve()
    }

    @objc func openAccount(_ call: CAPPluginCall) {
        guard let urlString = PleiadShell.plus?.profileUrl(), let url = URL(string: urlString) else {
            return call.reject("plus is unavailable", "unavailable")
        }
        DispatchQueue.main.async {
            UIApplication.shared.open(url) { ok in
                ok ? call.resolve() : call.reject("couldn't open the browser", "unreachable")
            }
        }
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        bridge?.viewController?.view.window ?? UIWindow()
    }
}
