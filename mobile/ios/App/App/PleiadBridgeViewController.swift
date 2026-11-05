import UIKit
import Capacitor
import WebKit
import PleiadRemote

/// 同梱のホスト一覧だけに Capacitor を渡す。ホストのページは別の WKWebView で開く。
final class PleiadBridgeViewController: CAPBridgeViewController {
    var resumeOnLaunch = false
    private(set) var hostWindow: HostViewController?
    private var firstAppearance = true

    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(PleiadRemotePlugin())
        bridge?.registerPluginInstance(PleiadPlusPlugin())
        bridge?.registerPluginInstance(QRScannerPlugin())
        // 通知は iOS の対象外（ADR 0086）。共通の www を変えずに入口を隠す。
        let script = "document.getElementById('notifyOpen')?.setAttribute('hidden', '');"
        webView?.configuration.userContentController.addUserScript(
            WKUserScript(source: script, injectionTime: .atDocumentEnd, forMainFrameOnly: true))
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        guard firstAppearance else { return }
        firstAppearance = false
        guard resumeOnLaunch else { return }
        do {
            let d = ResumePolicy.decide(saved: ResumeStore.hostId(), hosts: try PleiadShell.requireDevice().store.hosts(),
                                      freshStart: true, launcherStart: true, savedVia: ResumeStore.via())
            if d.forget { ResumeStore.forget() }
            if let id = d.hostId { openHost(id, via: d.via ?? "own") }
        } catch {
            // 保管を読めないときは一覧に残り、list() の失敗を共通画面に表示する。
        }
    }

    @discardableResult
    func openHost(_ hostId: String, via: String) -> Bool {
        guard let device = PleiadShell.device, hostWindow == nil, presentedViewController == nil, view.window != nil else { return false }
        let host = HostViewController(hostId: hostId, via: via, device: device)
        hostWindow = host
        host.onLeave = { [weak self, weak host] in
            host?.dismiss(animated: true) { self?.hostWindow = nil }
        }
        present(host, animated: true)
        return true
    }

    func offerLink(_ url: URL) {
        // Pleiad Plus ログインの戻り道（ASWebAuthenticationSession が届かないときのフォールバックでもある）。
        // state の検証は PlusManager の中で行う。
        if ShellBridge.isAuthLink(scheme: url.scheme, host: url.host) {
            resumeOnLaunch = false
            PleiadShell.plus?.onAuthLink(url.absoluteString)
            return
        }
        // pleiad://plus/enable|disable: この端末の入口の印（docs/plus.md「入口を出すリンク」）
        if url.scheme?.lowercased() == "pleiad", url.host?.lowercased() == "plus" {
            switch url.path.hasSuffix("/") ? String(url.path.dropLast()) : url.path {
            case "/enable": PleiadShell.plus?.setEntrance(true)
            case "/disable": PleiadShell.plus?.setEntrance(false)
            default: break   // その他の pleiad://plus/… は無視
            }
            return
        }
        guard ShellBridge.isPairLink(scheme: url.scheme, host: url.host) else { return }
        resumeOnLaunch = false
        hostWindow?.leave(forget: false)
        PleiadRemotePlugin.offerLink(url.absoluteString)
    }
}
