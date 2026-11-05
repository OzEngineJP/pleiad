import UIKit
import Capacitor
import WebKit
import PleiadRemote

/// 同梱のホスト一覧だけに Capacitor を渡す。ホストのページは別の WKWebView で開く。
final class PleiadBridgeViewController: CAPBridgeViewController {
    var resumeOnLaunch = false
    private(set) var hostWindow: HostViewController?
    private var firstAppearance = true
    /// 通知のタップの行き先（開いてからその会話を渡す）。窓の交代のあいだ覚えておく。
    private var notifyTarget: (hostId: String, session: String)?

    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(PleiadRemotePlugin())
        bridge?.registerPluginInstance(PleiadPlusPlugin())
        bridge?.registerPluginInstance(QRScannerPlugin())
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        guard firstAppearance else { return }
        firstAppearance = false
        if notifyTarget != nil { openNotifyTarget(); return }
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
            host?.dismiss(animated: true) {
                self?.hostWindow = nil
                self?.openNotifyTarget()
            }
        }
        present(host, animated: true)
        return true
    }

    /// 通知のタップ（AppDelegate から）: そのホストの窓を開き、名指しの会話を渡す（web/mobile-notify.mjs の行き先）。
    func openNotification(hostId: String, session: String) {
        resumeOnLaunch = false
        notifyTarget = (hostId, session)
        if hostWindow?.hostId == hostId {   // 同じホストの窓が開いていれば、それに渡すだけ
            notifyTarget = nil
            hostWindow?.openSession(session)
            return
        }
        if let w = hostWindow { w.leave(forget: false) }   // 別ホストの窓は畳んでから開き直す（onLeave が続きを呼ぶ）
        else { openNotifyTarget() }
    }

    private func openNotifyTarget() {
        guard let t = notifyTarget else { return }
        notifyTarget = nil
        guard let device = PleiadShell.device,
              let via = HostRoute.reopen(t.hostId, (try? device.store.hosts()) ?? []),
              openHost(t.hostId, via: via) else { return }
        hostWindow?.openSession(t.session)
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
        // pleiad://open?h=<hostId>&s=<会話>: 通知と同じ行き先（タップの経路は AppDelegate → openNotification）
        if url.scheme?.lowercased() == "pleiad", url.host?.lowercased() == "open" {
            let q = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
            if let h = q.first(where: { $0.name == "h" })?.value, !h.isEmpty {
                openNotification(hostId: h, session: q.first(where: { $0.name == "s" })?.value ?? "")
            }
            return
        }
        guard ShellBridge.isPairLink(scheme: url.scheme, host: url.host) else { return }
        resumeOnLaunch = false
        hostWindow?.leave(forget: false)
        PleiadRemotePlugin.offerLink(url.absoluteString)
    }
}
