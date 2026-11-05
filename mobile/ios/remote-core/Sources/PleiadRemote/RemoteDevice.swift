import Foundation

// Swift port of core/remote/device.mjs and RemoteDevice.kt (docs/remote.md §3.1・§3.3・§7): the device's key, the
// paired hosts, pairing, and one loopback proxy per open host. No notifications on iOS (ADR 0086, ADR 0144).
//
//   SecretVault        device static key + per-host relay tokens (one JSON object). The iOS shell keeps it in the
//                      Keychain (kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly); tests use FileVault.
//   <dir>/hosts.json   { version: 1, hosts: [{ hostId, hostName, label, relayUrl, hostPublicKey, deviceId, port,
//                        pairedAt, lastConnectedAt, revokedAt }] }   (no secrets; same shape as the desktop's and Android's)
//   <dir>/static/<hostId>.bin  the host's web/ shell as last confirmed (StaticCache.swift, docs/remote.md §8.6)

/// Where the secrets live, as one opaque blob. The app's implementation is the Keychain (stage 2).
public protocol SecretVault {
    /// true when the blob is protected by the OS (Keychain), false for a plain file (tests).
    var protected: Bool { get }
    func load() throws -> Bytes?
    func save(_ data: Bytes) throws
}

/// A plain file (tests, non-Apple platforms). Not for the app: secrets would sit unprotected in the sandbox.
public final class FileVault: SecretVault {
    private let file: URL
    public let protected = false
    public init(file: URL) { self.file = file }
    public func load() throws -> Bytes? {
        guard FileManager.default.fileExists(atPath: file.path) else { return nil }
        return Bytes(try Data(contentsOf: file))
    }
    public func save(_ data: Bytes) throws { try Data(data).write(to: file, options: .atomic) }
}

public struct HostRecord: Hashable {
    public var hostId: String
    public var hostName: String
    public var label: String
    public var relayUrl: String
    public var hostPublicKey: String
    public var deviceId: String
    public var port: Int
    public var pairedAt: Int64?
    public var lastConnectedAt: Int64?
    public var revokedAt: Int64?
    /// The route this pairing uses: "own" (the PC's own relay) | "plus" (the official relay).
    public var via: String = "own"
    /// The Plus account the pairing was made with (nil for own-relay pairings). Not shown to the shell UI.
    public var uid: String?
    /// When the host said this device must be allowed again on its screen (cleared on the next connection).
    public var reapproveAt: Int64?

    public init(hostId: String, hostName: String, label: String, relayUrl: String, hostPublicKey: String, deviceId: String,
                port: Int, pairedAt: Int64?, lastConnectedAt: Int64?, revokedAt: Int64?, via: String = "own",
                uid: String? = nil, reapproveAt: Int64? = nil) {
        self.hostId = hostId
        self.hostName = hostName
        self.label = label
        self.relayUrl = relayUrl
        self.hostPublicKey = hostPublicKey
        self.deviceId = deviceId
        self.port = port
        self.pairedAt = pairedAt
        self.lastConnectedAt = lastConnectedAt
        self.revokedAt = revokedAt
        self.via = via
        self.uid = uid
        self.reapproveAt = reapproveAt
    }

    private static func time(_ v: Int64?) -> JSON { v.map { .int($0) } ?? .null }

    public var json: JSON {
        var o: JSON = ["hostId": .string(hostId), "hostName": .string(hostName), "label": .string(label), "relayUrl": .string(relayUrl),
         "hostPublicKey": .string(hostPublicKey), "deviceId": .string(deviceId), "port": .int(Int64(port)),
         "pairedAt": HostRecord.time(pairedAt), "lastConnectedAt": HostRecord.time(lastConnectedAt), "revokedAt": HostRecord.time(revokedAt),
         "via": .string(via), "uid": uid.map { .string($0) } ?? .null]
        if let reapproveAt { o.set("reapproveAt", .int(reapproveAt)) }
        return o
    }

    /// For the shell UI: no key material, no account id.
    public var publicJson: JSON {
        var o = json
        o.set("hostPublicKey", nil)
        o.set("uid", nil)
        return o
    }

    /// Numbers (ms) or ISO-8601 strings (as the desktop may write them).
    private static func readTime(_ v: JSON?) -> Int64? {
        switch v {
        case .int(let i)?: return i
        case .double(let d)?: return Int64(d)
        case .string(let s)?:
            let f = ISO8601DateFormatter()
            f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            if let d = f.date(from: s) ?? ISO8601DateFormatter().date(from: s) { return Int64((d.timeIntervalSince1970 * 1000).rounded()) }
            return nil
        default: return nil
        }
    }

    static func from(_ o: JSON) throws -> HostRecord {
        guard let hostId = o["hostId"]?.string, let relayUrl = o["relayUrl"]?.string,
              let key = o["hostPublicKey"]?.string, let deviceId = o["deviceId"]?.string else {
            throw StateError(description: "hosts.json has a broken entry")
        }
        return HostRecord(hostId: hostId, hostName: o["hostName"]?.string ?? "", label: o["label"]?.string ?? "", relayUrl: relayUrl,
                          hostPublicKey: key, deviceId: deviceId, port: Int(o["port"]?.int ?? 0),
                          pairedAt: readTime(o["pairedAt"]), lastConnectedAt: readTime(o["lastConnectedAt"]), revokedAt: readTime(o["revokedAt"]),
                          via: (o["via"]?.string).flatMap { $0.isEmpty ? nil : $0 } ?? "own",
                          uid: (o["uid"]?.string).flatMap { $0.isEmpty ? nil : $0 }, reapproveAt: readTime(o["reapproveAt"]))
    }
}

public final class DeviceStore {
    public let dir: URL
    private let hostsFile: URL
    private let vault: SecretVault
    private let lock = NSRecursiveLock()
    private var keyPair: KeyPair?

    public var protected: Bool { vault.protected }

    public init(dir: URL, vault: SecretVault? = nil) throws {
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        self.dir = dir
        hostsFile = dir.appendingPathComponent("hosts.json")
        self.vault = vault ?? FileVault(file: dir.appendingPathComponent("secrets.json"))
    }

    private func readSecrets() throws -> [String: JSON] {
        guard let b = try vault.load() else { return [:] }
        return try JSON.parse(b).object ?? [:]
    }

    private func writeSecrets(_ o: [String: JSON]) throws { try vault.save(JSON.object(o).data) }

    private func readHosts() throws -> [HostRecord] {
        guard FileManager.default.fileExists(atPath: hostsFile.path) else { return [] }
        let o = try JSON.parse(Bytes(try Data(contentsOf: hostsFile)))
        guard o["version"]?.int == 1, let arr = o["hosts"]?.array else { throw StateError(description: "hosts.json has an unexpected format") }
        return try arr.map(HostRecord.from)
    }

    private func writeHosts(_ list: [HostRecord]) throws {
        let o: JSON = ["version": 1, "hosts": .array(list.map(\.json))]
        try Data(o.data).write(to: hostsFile, options: .atomic)
    }

    /// The device static key (one for all hosts). Created on first use.
    public func identity() throws -> KeyPair {
        lock.lock(); defer { lock.unlock() }
        if let keyPair { return keyPair }
        var secrets = try readSecrets()
        let kp: KeyPair
        if let s = secrets["deviceKey"]?.string, let priv = Base64URL.decode(s), priv.count == 32 {
            kp = try KeyPair.fromPrivate(priv)
        } else {
            kp = KeyPair.generate()
            secrets["deviceKey"] = .string(Base64URL.encode(kp.privateKey))
            try writeSecrets(secrets)
        }
        keyPair = kp
        return kp
    }

    public func hosts() throws -> [HostRecord] {
        lock.lock(); defer { lock.unlock() }
        return try readHosts()
    }

    public func host(_ hostId: String, via: String = "own") throws -> HostRecord? { try hosts().first { $0.hostId == hostId && $0.via == via } }

    private func secretKeyOf(_ hostId: String, _ via: String) -> String { via == "plus" ? "plus:\(hostId)" : "host:\(hostId)" }
    private func pendingKeyOf(_ hostId: String) -> String { "plusPending:\(hostId)" }

    /**
     * The new key a Plus request uses after the host revoked this device's key. Kept until the host allows it: the host
     * remembers a denied key for a while, so asking again with the same key gets the same answer (not a new window).
     */
    public func pendingPlusKey(_ hostId: String) throws -> KeyPair {
        lock.lock(); defer { lock.unlock() }
        var secrets = try readSecrets()
        if let s = secrets[pendingKeyOf(hostId)]?.string, let priv = Base64URL.decode(s), !priv.isEmpty { return try KeyPair.fromPrivate(priv) }
        let kp = KeyPair.generate()
        secrets[pendingKeyOf(hostId)] = .string(Base64URL.encode(kp.privateKey))
        try writeSecrets(secrets)
        return kp
    }

    public func dropPendingPlusKey(_ hostId: String) throws {
        lock.lock(); defer { lock.unlock() }
        var secrets = try readSecrets()
        if secrets.removeValue(forKey: pendingKeyOf(hostId)) != nil { try writeSecrets(secrets) }
    }

    public func credentials(_ hostId: String, via: String = "own") throws -> HostCreds? {
        lock.lock(); defer { lock.unlock() }
        guard let h = try readHosts().first(where: { $0.hostId == hostId && $0.via == via }),
              let token = try readSecrets()[secretKeyOf(hostId, via)]?["token"]?.string, !token.isEmpty,
              let key = Base64URL.decode(h.hostPublicKey) else { return nil }
        return HostCreds(hostId: h.hostId, hostPublicKey: key, relayUrl: h.relayUrl, deviceId: h.deviceId, token: token,
                         hostName: h.hostName, via: via, uid: h.uid)
    }

    /// The device key used for that host's record (deviceKey when the record has none). Nil when there is no record.
    public func keyFor(_ hostId: String, via: String = "own") throws -> KeyPair? {
        let secret = try { lock.lock(); defer { lock.unlock() }; return try readSecrets()[secretKeyOf(hostId, via)] }()
        guard let secret, !(secret["token"]?.string ?? "").isEmpty else { return nil }
        if let s = secret["key"]?.string, !s.isEmpty, let priv = Base64URL.decode(s) { return try KeyPair.fromPrivate(priv) }
        return try identity()
    }

    /// keyPair is the device key used for this record (nil keeps using deviceKey, as older versions did).
    @discardableResult
    public func saveHost(_ c: HostCreds, via: String? = nil, uid: String? = nil, keyPair: KeyPair? = nil) throws -> HostRecord {
        lock.lock(); defer { lock.unlock() }
        let v = via ?? c.via
        let u = uid ?? c.uid
        guard c.hostId.utf8.count == 26, c.hostId.utf8.allSatisfy({ (97...122).contains($0) || (50...55).contains($0) }) else {
            throw StateError(description: "invalid hostId")
        }
        var secret: [String: JSON] = ["token": .string(c.token)]
        if let keyPair { secret["key"] = .string(Base64URL.encode(keyPair.privateKey)) }
        var secrets = try readSecrets()
        secrets[secretKeyOf(c.hostId, v)] = .object(secret)
        if v == "plus" { secrets.removeValue(forKey: pendingKeyOf(c.hostId)) }
        try writeSecrets(secrets)
        let list = try readHosts()
        let prev = list.first { $0.hostId == c.hostId && $0.via == v }
        let rec = HostRecord(hostId: c.hostId, hostName: PairingCodec.cleanLabel(c.hostName), label: prev?.label ?? "", relayUrl: c.relayUrl,
                             hostPublicKey: Base64URL.encode(c.hostPublicKey), deviceId: c.deviceId, port: prev?.port ?? 0,
                             pairedAt: nowMs(), lastConnectedAt: nil, revokedAt: nil, via: v, uid: u)
        try writeHosts(list.filter { !($0.hostId == c.hostId && $0.via == v) } + [rec])
        return rec
    }

    @discardableResult
    public func updateHost(_ hostId: String, via: String = "own", _ patch: (inout HostRecord) -> Void) throws -> HostRecord? {
        lock.lock(); defer { lock.unlock() }
        var list = try readHosts()
        guard let i = list.firstIndex(where: { $0.hostId == hostId && $0.via == via }) else { return nil }
        patch(&list[i])
        try writeHosts(list)
        return list[i]
    }

    @discardableResult
    public func removeHost(_ hostId: String, via: String = "own") throws -> HostRecord? {
        lock.lock(); defer { lock.unlock() }
        var secrets = try readSecrets()
        secrets[secretKeyOf(hostId, via)] = nil
        if via == "plus" { secrets.removeValue(forKey: pendingKeyOf(hostId)) }
        try writeSecrets(secrets)
        let list = try readHosts()
        let hit = list.first { $0.hostId == hostId && $0.via == via }
        try writeHosts(list.filter { !($0.hostId == hostId && $0.via == via) })
        return hit
    }

    /// The official relay's URL moved (the config says another one): rewrite every Plus record's relayUrl.
    public func updatePlusRelay(_ relayUrl: String) throws {
        lock.lock(); defer { lock.unlock() }
        var list = try readHosts()
        var changed = false
        for i in list.indices where list[i].via == "plus" && list[i].relayUrl != relayUrl {
            list[i].relayUrl = relayUrl
            changed = true
        }
        if changed { try writeHosts(list) }
    }

    /// A Plus row can be renamed before its first connection; this placeholder has no device credentials.
    @discardableResult
    public func savePlusLabel(_ hostId: String, publicKey: String, hostName: String, relayUrl: String, uid: String?, label: String) throws -> HostRecord {
        lock.lock(); defer { lock.unlock() }
        var list = try readHosts()
        if let i = list.firstIndex(where: { $0.hostId == hostId && $0.via == "plus" }) {
            list[i].label = PairingCodec.cleanLabel(label)
            list[i].hostName = PairingCodec.cleanLabel(hostName)
            list[i].relayUrl = relayUrl
            list[i].uid = uid
        } else {
            list.append(HostRecord(hostId: hostId, hostName: PairingCodec.cleanLabel(hostName), label: PairingCodec.cleanLabel(label),
                                   relayUrl: relayUrl, hostPublicKey: publicKey, deviceId: "", port: 0,
                                   pairedAt: nil, lastConnectedAt: nil, revokedAt: nil, via: "plus", uid: uid))
        }
        try writeHosts(list)
        return list.first { $0.hostId == hostId && $0.via == "plus" }!
    }
}

/// The device as a whole: host list, pairing, one proxy per open host.
public final class RemoteDevice {
    public let store: DeviceStore
    public let app: String
    public let name: String
    public let platform: String
    private let texts: ProxyTexts
    private let backoff: Backoff
    private let connectTimeoutMs: Int
    private let requestWaitMs: Int
    private let log: (String) -> Void
    public let loop = Loop()
    private let lock = NSRecursiveLock()
    private var proxies: [String: DeviceProxy] = [:]
    private var listeners: [Int: (String, LinkStatus) -> Void] = [:]
    private var nextListener = 0

    /// The ID token for a Plus connection (the app's PlusManager.currentIdToken). Force-refreshes near expiry.
    public var plusIdToken: (() -> String?)?
    /// Ask the host to admit this device again (mode "admit"); returns fresh credentials for the link (Android: PleiadApp).
    public var plusReadmit: ((String) throws -> HostCreds?)?
    /// The relay ticket for one connection to hostId with this key; nil: the api has no tickets yet (ID token).
    public var plusTicket: ((String, KeyPair) throws -> String?)?

    public init(store: DeviceStore, app: String, name: String, platform: String = "ios", texts: ProxyTexts = DefaultTexts(),
                backoff: Backoff = Backoff(), connectTimeoutMs: Int = 15_000, requestWaitMs: Int = 10_000,
                log: @escaping (String) -> Void = { _ in }) {
        self.store = store
        self.app = app
        self.name = name
        self.platform = platform
        self.texts = texts
        self.backoff = backoff
        self.connectTimeoutMs = connectTimeoutMs
        self.requestWaitMs = requestWaitMs
        self.log = log
    }

    /// 状態の購読を登録し、offStatus で解除するための番号を返す。
    @discardableResult
    public func onStatus(_ fn: @escaping (_ hostId: String, _ status: LinkStatus) -> Void) -> Int {
        lock.lock(); defer { lock.unlock() }
        nextListener += 1
        listeners[nextListener] = fn
        return nextListener
    }

    public func offStatus(_ token: Int) {
        lock.lock(); listeners[token] = nil; lock.unlock()
    }

    /// Host list with the live state ("closed" when no proxy is open, "revoked" when the host removed us). A record's
    /// state is its own route's proxy only.
    public func list() throws -> [(HostRecord, LinkStatus?)] {
        try store.hosts().map { h in (h, proxy(h.hostId).flatMap { $0.creds.via == h.via ? $0.link.status : nil }) }
    }

    /// The route of each host window that is connected now (HostRoute: opening the host again keeps it).
    public func connectedVia() -> [String: String] {
        lock.lock(); defer { lock.unlock() }
        return proxies.compactMapValues { $0.link.status.state == "connected" ? $0.creds.via : nil }
    }

    /// The route to open [hostId] with when nothing chose one: the open proxy's, else [preferred], else own, else Plus.
    public func routeFor(_ hostId: String, preferred: String? = nil) throws -> String? {
        lock.lock()
        if let v = proxies[hostId]?.creds.via { lock.unlock(); return v }
        lock.unlock()
        return HostRoute.reopen(hostId, try store.hosts(), preferred)
    }

    /// Pair and save (blocking). An open proxy for the same host reconnects with the new credentials.
    @discardableResult
    public func pair(_ payload: String, onCode: (String) -> Void, handle: Pairing = Pairing()) throws -> HostRecord {
        let kp = try store.identity()
        let creds = try Pairing.pair(payload: payload, keyPair: kp, name: name, platform: platform, app: app, onCode: onCode, handle: handle)
        let rec = try store.saveHost(creds)
        repaired(rec)
        return rec
    }

    /**
     * Get admitted by a Plus host and save (blocking; docs/remote.md §3.4). [run] does the admission with the given key.
     *   mode "admit": background reconnect of a key the host already allowed (no window on the host).
     *   mode "pair":  the person picked the host; an unknown key goes to the approval window on the host's screen.
     * Key order: the Plus record's key, then this host's QR record's key (already allowed: no window), then deviceKey.
     * In "pair" mode a revoked key is replaced by a new one once (that one goes to the approval window). The new key is
     * kept until the host allows it, so asking again after a deny gets the host's answer for that key (no new window).
     */
    @discardableResult
    public func admitPlus(_ hostId: String, mode: String, uid: String?, run: (KeyPair) throws -> HostCreds) throws -> HostRecord {
        let first = try store.keyFor(hostId, via: "plus") ?? (try store.keyFor(hostId, via: "own")) ?? store.identity()
        var used = first
        let creds: HostCreds
        do {
            creds = try run(first)
        } catch let e as PairError {
            guard mode == PlusAdmission.MODE_PAIR && e.code == "revoked" else { throw e }
            used = try store.pendingPlusKey(hostId)
            do {
                creds = try run(used)
            } catch let e2 as PairError {
                // the kept key was allowed and then revoked without this device saving it: start over with another new key
                guard e2.code == "revoked" else { throw e2 }
                try store.dropPendingPlusKey(hostId)
                used = try store.pendingPlusKey(hostId)
                creds = try run(used)
            }
        }
        let rec = try store.saveHost(creds, via: "plus", uid: uid, keyPair: used)
        if mode == PlusAdmission.MODE_PAIR { repaired(rec, keyPair: used) }
        return rec
    }

    /// A new pairing was saved: an open proxy on the same route reconnects with it. A proxy on the other route keeps its own credentials.
    private func repaired(_ rec: HostRecord, keyPair: KeyPair? = nil) {
        lock.lock()
        let px = proxies[rec.hostId]
        lock.unlock()
        guard let px, px.creds.via == rec.via else { return }
        do {
            if let c = try store.credentials(rec.hostId, via: rec.via) { px.retryNow(c, keyPair) }
        } catch { log("remote device: \(error)") }
    }

    /// Open (or reuse) the host's proxy on the given route. Blocking (binds the port).
    public func open(_ hostId: String, via: String = "own") throws -> DeviceProxy {
        lock.lock(); defer { lock.unlock() }
        if let px = proxies[hostId] {
            if px.creds.via == via { return px }
            px.close()
            proxies.removeValue(forKey: hostId)
        }
        guard let creds = try store.credentials(hostId, via: via) else { throw StateError(description: "unknown-host") }
        let rec = try store.host(hostId, via: via)
        let keyPair = try (store.keyFor(hostId, via: via) ?? store.identity())
        let px = DeviceProxy(loop: loop, creds: creds, keyPair: keyPair, wantPort: rec?.port ?? 0, app: app, name: name,
                             shell: "mobile", backoff: backoff, connectTimeoutMs: connectTimeoutMs, requestWaitMs: requestWaitMs,
                             texts: texts, log: log, staticCacheFile: staticCacheFile(hostId),
                             plusIdToken: via == "plus" ? plusIdToken : nil,
                             plusReadmit: via == "plus" ? plusReadmit : nil,
                             plusTicket: via == "plus" ? plusTicket : nil)
        px.onStatus { [weak self] s in
            guard let self else { return }
            do {
                if s.state == "connected" {
                    try self.store.updateHost(hostId, via: via) {
                        $0.lastConnectedAt = nowMs()
                        $0.revokedAt = nil
                        $0.reapproveAt = nil
                        if !s.hostName.isEmpty { $0.hostName = PairingCodec.cleanLabel(s.hostName) }
                    }
                }
                if s.state == "revoked" { try self.store.updateHost(hostId, via: via) { $0.revokedAt = nowMs() } }
                if s.state == "reapprove" { try self.store.updateHost(hostId, via: via) { $0.reapproveAt = nowMs() } }
            } catch {
                self.log("remote device: \(error)")
            }
            self.lock.lock()
            let ls = self.listeners.sorted { $0.key < $1.key }.map(\.value)
            self.lock.unlock()
            for l in ls { l(hostId, s) }
        }
        try px.start()
        if px.port != (rec?.port ?? 0) { try store.updateHost(hostId, via: via) { $0.port = px.port } }
        proxies[hostId] = px
        return px
    }

    /// The official relay's URL moved: rewrite the records and hand fresh credentials to open Plus proxies.
    public func updatePlusRelay(_ relayUrl: String) {
        do {
            try store.updatePlusRelay(relayUrl)
            lock.lock()
            let open = proxies
            lock.unlock()
            for (hostId, px) in open where px.creds.via == "plus" {
                if let c = try store.credentials(hostId, via: "plus") { px.updateCredentials(c) }
            }
        } catch { log("remote device: \(error)") }
    }

    /// Plus came back: paused Plus lines try again now.
    public func retryPausedPlus() {
        lock.lock()
        let open = proxies.values
        lock.unlock()
        for px in open where px.creds.via == "plus" && px.link.state == "paused" { px.link.retryNow() }
    }

    public func proxy(_ hostId: String) -> DeviceProxy? {
        lock.lock(); defer { lock.unlock() }
        return proxies[hostId]
    }

    public func close(_ hostId: String) {
        lock.lock()
        let px = proxies.removeValue(forKey: hostId)
        lock.unlock()
        px?.close()
    }

    /// 未登録のホストなら nil。
    @discardableResult
    public func rename(_ hostId: String, _ label: String, via: String = "own") throws -> HostRecord? {
        try store.updateHost(hostId, via: via) { $0.label = PairingCodec.cleanLabel(label) }
    }

    /// Forget the pairing here (the host still lists the device until it is revoked there).
    @discardableResult
    public func remove(_ hostId: String, via: String = "own") throws -> HostRecord? {
        let removed = try store.removeHost(hostId, via: via)
        if try store.hosts().allSatisfy({ $0.hostId != hostId }) {
            close(hostId)
            try? FileManager.default.removeItem(at: staticCacheFile(hostId))
        } else if proxy(hostId)?.creds.via == via {
            close(hostId)   // its credentials are gone; the other route stays paired
        }
        return removed
    }

    private func staticCacheFile(_ hostId: String) -> URL {
        store.dir.appendingPathComponent("static", isDirectory: true).appendingPathComponent("\(hostId).bin")
    }

    /// The app became active again: every open proxy listens again and reconnects (ADR 0144). Returns the hosts whose
    /// proxy had to move to another port (their WebView must load the new `url`).
    public func resumeForeground() -> [String] {
        lock.lock()
        let open = proxies
        lock.unlock()
        var moved: [String] = []
        for (hostId, px) in open {
            do {
                if try px.resumeForeground() {
                    moved.append(hostId)
                    try store.updateHost(hostId, via: px.creds.via) { $0.port = px.port }
                }
            } catch {
                log("remote device: cannot listen again for \(hostId): \(error)")
            }
        }
        return moved
    }

    public func closeAll() {
        lock.lock()
        let all = proxies
        proxies = [:]
        lock.unlock()
        for px in all.values { px.close() }
    }
}
