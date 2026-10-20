import UIKit
import Capacitor
import WebKit
import PleiadRemote
import os

/// 同梱のホスト一覧だけに Capacitor を渡す。ホストのページは別の WKWebView で開く。
final class PleiadBridgeViewController: CAPBridgeViewController {
    private static let linkLog = Logger(subsystem: Bundle.main.bundleIdentifier ?? "dev.pleiad.app", category: "link")
    var resumeOnLaunch = false
    private(set) var hostWindow: HostViewController?
    private var firstAppearance = true

    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(PleiadRemotePlugin())
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
                                        freshStart: true, launcherStart: true)
            if d.forget { ResumeStore.forget() }
            if let id = d.hostId { openHost(id) }
        } catch {
            // 保管を読めないときは一覧に残り、list() の失敗を共通画面に表示する。
        }
    }

    @discardableResult
    func openHost(_ hostId: String) -> Bool {
        guard let device = PleiadShell.device, hostWindow == nil, presentedViewController == nil, view.window != nil else { return false }
        let host = HostViewController(hostId: hostId, device: device)
        hostWindow = host
        host.onLeave = { [weak self, weak host] in
            host?.dismiss(animated: true) { self?.hostWindow = nil }
        }
        present(host, animated: true)
        return true
    }

    func offerLink(_ url: URL) {
        // ログインの戻り道。iOS ではまだ Pleiad Plus に対応しないので、記録だけして何もしない（クエリーは記録に出さない）。
        if ShellBridge.isAuthLink(scheme: url.scheme, host: url.host) {
            Self.linkLog.log("pleiad://auth is not supported yet")
            return
        }
        guard ShellBridge.isPairLink(scheme: url.scheme, host: url.host) else { return }
        resumeOnLaunch = false
        hostWindow?.leave(forget: false)
        PleiadRemotePlugin.offerLink(url.absoluteString)
    }
}
