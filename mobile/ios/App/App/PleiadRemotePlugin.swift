// 同梱の一覧用の API。Android と同じメソッド・応答・イベントを返す。通知は対象外（ADR 0086）。
import Foundation
import Capacitor
import PleiadRemote
@objc(PleiadRemotePlugin)
final class PleiadRemotePlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "PleiadRemotePlugin"
    let jsName = "PleiadRemote"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "info", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "list", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "parse", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pair", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "admit", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancelPair", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "open", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "rename", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "remove", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "takePairLink", returnType: CAPPluginReturnPromise),
    ]

    private static let worker = DispatchQueue(label: "pleiad-plugin", qos: .userInitiated, attributes: .concurrent)
    private static weak var instance: PleiadRemotePlugin?
    private static let linkLock = NSLock()
    private static var pendingLink: String?
    static func offerLink(_ payload: String) {
        linkLock.lock(); pendingLink = payload; linkLock.unlock()
        instance?.notifyListeners("pairLink", data: [:])
    }

    private let pairLock = NSLock()
    private var pairing: Pairing?
    private var statusToken: Int?

    override func load() {
        PleiadRemotePlugin.instance = self
        statusToken = PleiadShell.device?.onStatus { [weak self] hostId, s in
            self?.notifyListeners("status", data: ShellBridge.foundationObject(ShellBridge.statusEvent(hostId, s)))
        }
        PleiadShell.startPlus()
    }

    deinit {
        if let statusToken { PleiadShell.device?.offStatus(statusToken) }
    }

    private func bg(_ call: CAPPluginCall, _ fn: @escaping (RemoteDevice) throws -> Void) {
        PleiadRemotePlugin.worker.async {
            do { try fn(PleiadShell.requireDevice()) } catch {
                let f = ShellBridge.failure(error)
                call.reject(f.message, f.code, nil, f.data.map(ShellBridge.foundationObject))
            }
        }
    }

    private func forgetWhen(_ hostId: String) {
        let others = (try? PleiadShell.requireDevice().store.hosts()) ?? []
        if others.allSatisfy({ $0.hostId != hostId }) { ResumeStore.forget(hostId) }
    }

    @objc func info(_ call: CAPPluginCall) {
        bg(call) { device in
            call.resolve(["deviceName": PleiadShell.deviceName, "app": device.app, "encrypted": device.store.protected])
        }
    }

    @objc func list(_ call: CAPPluginCall) {
        bg(call) { device in
            guard let plus = PleiadShell.plus else {
                let hosts = try device.list().map { ShellBridge.foundation(ShellBridge.hostEntry($0.0, $0.1)) }
                return call.resolve(["hosts": hosts])
            }
            let usePlus = plus.plusUsable
            let fetched = usePlus ? plus.fetchHosts() : plus.cachedHosts()
            if let relay = plus.currentRelayUrl() { device.updatePlusRelay(relay) }
            // いま読んだ台帳から外れた PC は、こちらも忘れる（読みに失敗したときは忘れない）。自分の中継のペアリングは残る。
            let ledgerRead = usePlus && fetched.read
            if ledgerRead {
                for rec in PlusHostList.gone(try device.store.hosts(), fetched.hosts) {
                    _ = try device.remove(rec.hostId, via: "plus")
                    self.forgetWhen(rec.hostId)
                }
            }
            // 1 台 1 行。via はタップで開く経路（PlusHostList.combine）、both は両方の経路でペアリング済みの印。
            let rows = PlusHostList.combine(try device.store.hosts(), fetched.hosts, usePlus && fetched.error != "no-relay",
                                          device.connectedVia(), ledgerRead)
            var arr = [Any]()
            for row in rows {
                let h = row.record
                let plusHost = row.plus
                guard let hostId = h?.hostId ?? plusHost?.hostId else { continue }
                // ?? と && の右（autoclosure）には try を置けないので、先に読んでから組み合わせる
                let other: HostRecord? = row.both ? try device.store.host(hostId, via: row.via == "own" ? "plus" : "own") : nil
                let ownLabel = try device.store.host(hostId, via: "own")?.label
                var o = ShellBridge.foundationObject(h?.publicJson ?? [:])
                o["hostId"] = hostId
                let label = [h?.label, other?.label, ownLabel].compactMap { $0 }.first { !$0.isEmpty }
                o["hostName"] = label ?? plusHost?.name ?? h?.hostName ?? ""
                o["via"] = row.via
                o["both"] = row.both
                let lastConnected = [h?.lastConnectedAt, other?.lastConnectedAt].compactMap { $0 }.max()
                o["lastConnectedAt"] = lastConnected.map { $0 as Any } ?? NSNull()
                if let online = row.online { o["online"] = online }
                // その行の経路のプロキシの状態だけを出す（別の経路の窓の状態を見せない）
                let st = device.proxy(hostId).flatMap { $0.creds.via == row.via ? $0.link.status : nil }
                // Plus の行で、まだ許可の無い鍵（"unpaired"）かもう一度許可が要る鍵（"reapprove"。ADR 0248）は、
                // タップでホストの画面へ問い合わせる（admit()）。
                let plusRec: HostRecord? = row.via == "plus" ? try device.store.host(hostId, via: "plus") : nil
                let plusCreds = row.via == "plus" ? try device.store.credentials(hostId, via: "plus") : nil
                let idle: String
                if row.via == "plus" && plusRec?.reapproveAt != nil { idle = "reapprove" }
                else if h?.revokedAt != nil && h?.via == row.via { idle = "revoked" }
                else if row.via == "plus" && plusCreds == nil { idle = "unpaired" }
                else { idle = "closed" }
                o["state"] = st?.state ?? idle
                o["open"] = st != nil
                arr.append(o)
            }
            call.resolve(["hosts": arr, "plusError": (usePlus ? fetched.error : nil) ?? NSNull()])
        }
    }
    @objc func parse(_ call: CAPPluginCall) {
        bg(call) { device in
            let offer = try ShellBridge.offer(call.getString("payload")) { try device.store.host($0) != nil }
            call.resolve(ShellBridge.foundationObject(offer))
        }
    }
    @objc func pair(_ call: CAPPluginCall) {
        guard let payload = call.getString("payload") else { return call.reject("payload", "payload") }
        let handle = Pairing()
        pairLock.lock()
        pairing?.cancel()
        pairing = handle
        pairLock.unlock()
        bg(call) { [weak self] device in
            defer {
                if let self {
                    self.pairLock.lock()
                    if self.pairing === handle { self.pairing = nil }
                    self.pairLock.unlock()
                }
            }
            let rec = try device.pair(payload, onCode: { code in self?.notifyListeners("pairCode", data: ["code": code]) }, handle: handle)
            call.resolve(["host": ShellBridge.foundation(rec.publicJson)])
        }
    }

    // Plus のホストにこの端末の許可を求める（ADR 0248）。ホストの画面に QR と同じ確認コードが出て、それを pairCode でも送る。
    // ホストの画面で許可されると解決する。cancelPair() でやめる。
    @objc func admit(_ call: CAPPluginCall) {
        guard let hostId = call.getString("hostId") else { return call.reject("hostId", "unknown-host") }
        let handle = Pairing()
        pairLock.lock()
        pairing?.cancel()
        pairing = handle
        pairLock.unlock()
        bg(call) { [weak self] device in
            defer {
                if let self {
                    self.pairLock.lock()
                    if self.pairing === handle { self.pairing = nil }
                    self.pairLock.unlock()
                }
            }
            guard let plus = PleiadShell.plus else { throw UnknownHost() }
            guard let host = plus.cachedHosts().hosts.first(where: { $0.hostId == hostId }) else { throw UnknownHost() }
            // 券の呼び出しが 401 で ID トークンを取り直すので、待たせる前に無理に取り直さない
            guard let token = plus.idToken() else { throw PairError("plus-signed-out") }
            guard let relay = plus.currentRelayUrl() else { throw PairError("unreachable") }
            let uid = plus.currentUid()
            let rec = try device.admitPlus(hostId, mode: PlusAdmission.MODE_PAIR, uid: uid) { kp in
                try PlusAdmission.admit(host: host, relayUrl: relay, idToken: token, keyPair: kp, name: PleiadShell.deviceName,
                                        app: device.app, mode: PlusAdmission.MODE_PAIR,
                                        onCode: { code in self?.notifyListeners("pairCode", data: ["code": code]) },
                                        handle: handle,
                                        ticket: { try plus.deviceTicket(hostId, keyPair: kp) }).with(uid: uid)
            }
            call.resolve(["host": ShellBridge.foundation(rec.publicJson)])
        }
    }

    @objc func cancelPair(_ call: CAPPluginCall) {
        pairLock.lock()
        pairing?.cancel()
        pairing = nil
        pairLock.unlock()
        call.resolve()
    }

    @objc func open(_ call: CAPPluginCall) {
        guard let hostId = call.getString("hostId") else { return call.reject("hostId", "unknown-host") }
        let requested = call.getString("via").flatMap { $0 == "own" || $0 == "plus" ? $0 : nil }
        bg(call) { [weak self] device in
            guard let plus = PleiadShell.plus else {
                if try device.store.host(hostId) == nil { throw UnknownHost() }
                self?.presentHost(hostId, via: "own", call: call)
                return
            }
            let listed = plus.cachedHosts().hosts.first(where: { $0.hostId == hostId })
            let plusVisible = plus.plusUsable
            let hasOwn = try device.store.credentials(hostId, via: "own") != nil
            let plusRec = try device.store.host(hostId, via: "plus")
            let hasPlus = plusVisible && (plusRec != nil || listed != nil)
            // ページが経路をくれたときはそれ（一覧が選んだもの）。無いときは同じ規則: 接続中の窓は経路を保ち、
            // Plus の台帳でオンラインなら Plus、それ以外は自分の中継。「アカウントに見えるなら何でも Plus」ではない。
            guard let via = requested.flatMap({ ($0 == "own" && hasOwn) || ($0 == "plus" && hasPlus) ? $0 : nil })
                ?? HostRoute.choose(hasOwn: hasOwn, hasPlus: hasPlus, plusOnline: listed?.online,
                                    connectedVia: device.connectedVia()[hostId]) else { throw UnknownHost() }
            let current = device.proxy(hostId)?.link.status
            if via == "plus" {
                switch current?.state {
                case "signed-out": throw PairError("plus-signed-out")
                case "blocked": throw PairError("plus-no-relay")
                case "limit": throw PairError("plus-limit")
                case "update": throw PairError("plus-update")
                case "removed": throw PairError("plus-removed")
                default: break
                }
                // アカウントだけではこの端末は入れない（ADR 0248）: ページはまず admit() でホストに問い合わせる
                if try device.store.host(hostId, via: "plus")?.reapproveAt != nil { throw PairError("plus-reapprove") }
                if try device.store.credentials(hostId, via: "plus") == nil { throw PairError("plus-unpaired") }
            }
            if try device.store.credentials(hostId, via: via) == nil { throw UnknownHost() }
            _ = try device.open(hostId, via: via)
            self?.presentHost(hostId, via: via, call: call)
        }
    }

    private func presentHost(_ hostId: String, via: String, call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let root = self.bridge?.viewController as? PleiadBridgeViewController,
                  root.openHost(hostId, via: via) else { return call.reject("host window unavailable", "internal") }
            call.resolve()
        }
    }

    @objc func rename(_ call: CAPPluginCall) {
        bg(call) { device in
            let hostId = call.getString("hostId") ?? ""
            let via = call.getString("via") ?? "own"
            let label = call.getString("label") ?? ""
            let rec: HostRecord
            if via == "both" {
                // 両方の経路でペアリング済みのホストは 1 行: どちらの経路で開いても名前が出るよう両方の記録に入れる
                guard let own = try device.rename(hostId, label, via: "own") else { throw UnknownHost() }
                if try device.store.host(hostId, via: "plus") != nil { _ = try device.rename(hostId, label, via: "plus") }
                rec = own
            } else if try via == "plus" && device.store.host(hostId, via: "plus") == nil {
                guard let plus = PleiadShell.plus,
                      let host = plus.cachedHosts().hosts.first(where: { $0.hostId == hostId }) else { throw UnknownHost() }
                guard let relay = plus.currentRelayUrl() else { throw PairError("unreachable") }
                rec = try device.store.savePlusLabel(hostId, publicKey: host.publicKey, hostName: host.name, relayUrl: relay,
                                                     uid: plus.currentUid(), label: label)
            } else {
                guard let r = try device.rename(hostId, label, via: via) else { throw UnknownHost() }
                rec = r
            }
            call.resolve(["host": ShellBridge.foundation(rec.publicJson)])
        }
    }

    @objc func remove(_ call: CAPPluginCall) {
        bg(call) { device in
            let hostId = call.getString("hostId") ?? ""
            _ = try device.remove(hostId, via: call.getString("via") ?? "own")
            self.forgetWhen(hostId)
            call.resolve()
        }
    }
    @objc func takePairLink(_ call: CAPPluginCall) {
        PleiadRemotePlugin.linkLock.lock()
        let p = PleiadRemotePlugin.pendingLink
        PleiadRemotePlugin.pendingLink = nil
        PleiadRemotePlugin.linkLock.unlock()
        call.resolve(["payload": p.map { $0 as Any } ?? NSNull()])
    }
}
private struct UnknownHost: Error, CustomStringConvertible {
    var description: String { "unknown-host" }
}
