// 一覧とホストの窓で共有する RemoteDevice と PlusManager。シーンを作る前に初期化する（Android の PleiadApp）。
import UIKit
import PleiadRemote
enum PleiadShell {
    private(set) static var device: RemoteDevice?
    private(set) static var plus: PlusManager?
    private static var startError: Error?
    private(set) static var deviceName = ""

    @MainActor
    static func start() {
        if device != nil { return }
        deviceName = UIDevice.current.name
        let app = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? ""
        let plus = PlusManager(log: { NSLog("Pleiad: %@", $0) })
        do {
            let device = RemoteDevice(store: try openStore(), app: app, name: deviceName, platform: "ios", texts: ProxyWords(),
                                      log: { NSLog("Pleiad: %@", $0) })
            device.plusIdToken = { plus.currentIdToken() }
            device.plusTicket = { hostId, keyPair in
                do { return try plus.deviceTicket(hostId, keyPair: keyPair)?.relay }
                catch let e as PlusApiError { throw PlusAdmission.ticketError(e) }
            }
            device.plusReadmit = { hostId in
                guard let host = plus.cachedHosts().hosts.first(where: { $0.hostId == hostId }) else { throw PairError("couldnt-connect") }
                guard let token = plus.currentIdToken() else { throw PairError("plus-signed-out") }
                guard let relay = plus.currentRelayUrl() else { throw PairError("unreachable") }
                // バックグラウンドのつなぎ直し: ホストが許可済みの鍵だけが戻れる（承認の窓は出ない）
                try device.admitPlus(hostId, mode: PlusAdmission.MODE_ADMIT, uid: plus.currentUid()) { kp in
                    try PlusAdmission.admit(host, relayUrl: relay, idToken: token, keyPair: kp, name: deviceName, app: app,
                                            ticket: { try plus.deviceTicket(hostId, keyPair: kp) }).with(uid: plus.currentUid())
                }
                return try device.store.credentials(hostId, via: "plus")
            }
            self.plus = plus
            self.device = device
        } catch {
            startError = VaultError("remote store: \(error)")
        }
    }

    static func requireDevice() throws -> RemoteDevice {
        guard let device else { throw startError ?? VaultError("remote store unavailable") }
        return device
    }

    /// 一覧のページ（プラグイン）が載った: 公式の中継の URL を中継まわりへ渡し、設定の変化を拾い始める。
    static func startPlus() {
        guard let device, let plus else { return }
        plus.start()
        if let relay = plus.currentRelayUrl() { device.updatePlusRelay(relay) }
    }

    static func setForeground(_ on: Bool) { plus?.setForeground(on) }

    private static func openStore() throws -> DeviceStore {
        let fm = FileManager.default
        let support = try fm.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        var dir = support.appendingPathComponent("remote", isDirectory: true)
        let store = try DeviceStore(dir: dir, vault: KeychainVault())
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try dir.setResourceValues(values)
        return store
    }
}
