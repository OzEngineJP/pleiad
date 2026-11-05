import Dispatch
import Foundation

// Swift port of core/remote/device-link.mjs and DeviceLink.kt (docs/remote.md §3.2・§4.4・§7.4): one line from the
// device through the relay to the host, with reconnects and states. Loop-confined; the blocking relay handshake runs on
// a worker queue.
//
// state: connecting | connected | offline | host-offline | revoked | stopped
//        (Plus) reapprove: the host wants this device allowed again on its screen (readmission was refused). No retries
// Backoff 0.5 s -> 30 s doubling (±25 % jitter), reset after 10 s connected. Streams never survive a reconnect.
// (Plus) paused: Plus comes back on its own, so the line keeps asking, 5 s -> 30 s doubling, without showing "connecting".
// iOS suspends the app in the background, which kills the relay socket: back in the foreground the proxy calls
// checkNow() (ADR 0144).

public struct LinkStatus: Equatable {
    public var state: String
    public var since: Int64 = nowMs()
    public var retryAt: Int64?
    public var closeCode: Int?
    public var goaway: String?
    public var reason: String?
    public var httpStatus: Int?
    public var hostName = ""
    public var connectedAt: Int64?

    public init(_ state: String, closeCode: Int? = nil, goaway: String? = nil, reason: String? = nil, httpStatus: Int? = nil) {
        self.state = state
        self.closeCode = closeCode
        self.goaway = goaway
        self.reason = reason
        self.httpStatus = httpStatus
    }

    /// For the shell UI (plyRemote.status()), the same fields as the Android shell.
    public var json: JSON {
        var o: JSON = ["state": .string(state), "since": .int(since), "hostName": .string(hostName)]
        if let retryAt { o.set("retryAt", .int(retryAt)) }
        if let closeCode { o.set("closeCode", .int(Int64(closeCode))) }
        if let goaway { o.set("goaway", .string(goaway)) }
        if let reason { o.set("reason", .string(reason)) }
        if let connectedAt { o.set("connectedAt", .int(connectedAt)) }
        return o
    }
}

public struct LinkUnavailable: Error, CustomStringConvertible {
    public let state: String
    public var closeCode: Int?
    public var description: String { "link \(state)" }
}

public struct Backoff {
    public var minMs: Int
    public var maxMs: Int
    public var stableMs: Int
    public var pausedMinMs: Int
    public var pausedMaxMs: Int
    public init(minMs: Int = 500, maxMs: Int = 30_000, stableMs: Int = 10_000, pausedMinMs: Int = 5_000, pausedMaxMs: Int = 30_000) {
        self.minMs = minMs
        self.maxMs = maxMs
        self.stableMs = stableMs
        self.pausedMinMs = pausedMinMs
        self.pausedMaxMs = pausedMaxMs
    }
}

public enum LinkRules {
    public static func classifyClose(_ closeCode: Int? = nil, goaway: String? = nil, reason: String? = nil, via: String = "own") -> String {
        if via == "plus" && goaway == "revoked" { return "readmit" }
        if via == "plus" && closeCode == 4401 && (reason == "revoked" || reason == "device token") { return "readmit" }
        if via == "plus" && closeCode == 4401 && reason == "account" { return "blocked" }
        // the PC was removed from the Plus account: asking it to admit this device again cannot help
        if via == "plus" && closeCode == 4401 && reason == "host" { return "removed" }
        if via == "plus" && closeCode == 4401 && (reason == "token" || reason == "ticket") { return "offline" }
        // the relay takes tickets only and this connection had none: the app needs an update
        if via == "plus" && closeCode == 4401 && reason == "update required" { return "update" }
        if via == "plus" && closeCode == 4401 && reason == "plus off" { return "host-offline" }
        if via == "plus" && closeCode == 4401 && reason == "plus unavailable" { return "paused" }
        // Any other refusal (the host closed the handshake: it wants this device allowed again, or does not know the key):
        // ask the host again and show its answer, like the desktop's device link
        if via == "plus" && closeCode == 4401 { return "readmit" }
        if via == "plus" && closeCode == 4429 && reason == "account limit" { return "limit" }
        if via == "plus" && closeCode == 4429 && reason == "admit rate" { return "offline" }
        if goaway == "revoked" || closeCode == 4401 { return "revoked" }
        if goaway == "shutdown" || closeCode == 4404 || closeCode == 4408 { return "host-offline" }
        // The relay's authz plugin failed transiently (docs/remote.md §5.7). Retry after a while.
        if closeCode == 1013 { return "offline" }
        return "offline"
    }

    /// The state after asking the host to admit this device again failed (PairError.code; nil: no answer).
    public static func readmitFailedState(_ code: String?) -> String {
        switch code {
        case "plus-no-relay": return "blocked"
        case "plus-limit": return "limit"
        case "plus-reapprove": return "reapprove"
        case "plus-update": return "update"
        case "unknown-host": return "removed"
        case "plus-paused": return "paused"
        case "unreachable": return "offline"
        default: return "revoked"
        }
    }

    /**
     * The state after the relay ticket could not be taken (PairError.code), told like the relay's close reasons:
     * the PC was removed (unknown-host, 4401 'host'), the account cannot use the relay (plus-no-relay, 4401 'account')
     * stop, Plus being paused (plus-paused, 4401 'plus unavailable') waits for it; anything else is retried as offline.
     */
    public static func ticketFailedState(_ code: String?) -> String {
        switch code {
        case "plus-update": return "update"
        case "plus-signed-out": return "signed-out"
        case "unknown-host": return "removed"
        case "plus-no-relay": return "blocked"
        case "plus-paused": return "paused"
        default: return "offline"
        }
    }
}

public typealias ChannelFactory = (_ send: @escaping (Bytes) throws -> Void, _ transport: Transport, _ hello: JSON,
                                   _ buffered: @escaping () -> Int) -> Channel

public final class DeviceLink {
    /// Blocking handshakes run here (never on the loop).
    private static let workers = DispatchQueue(label: "pleiad-link", attributes: .concurrent)

    public let loop: Loop
    private let credsLock = NSLock()
    private var _creds: HostCreds
    private var keyPair: KeyPair
    private let app: String
    private let name: String
    private let shell: String
    private let backoff: Backoff
    private let connectTimeoutMs: Int
    private let channelFactory: ChannelFactory?
    private let log: (String) -> Void
    /// The ID token for a via "plus" connection (an api without tickets). Nil → signed-out.
    private let plusIdToken: (() -> String?)?
    /// Ask the host to admit this device again (a 4401 refusal); returns fresh credentials. Runs on a worker.
    private let plusReadmit: ((String) throws -> HostCreds?)?
    /// The relay ticket for one connection (docs/plus.md "Tickets"). Runs on a worker. Nil: the api has no tickets yet
    /// (use the ID token). Throws PairError("plus-update") when the app is too old for the api.
    private let plusTicket: ((String, KeyPair) throws -> String?)?

    public private(set) var channel: Channel?
    public private(set) var hostName = ""
    private var attempt = 0
    private var running = false
    private var generation = 0
    private var readmitAttempts = 0
    private var tokenFailures = 0
    private var pausedAttempts = 0
    private var retryTimer: Cancellable?
    private var stableTimer: Cancellable?
    private var socket: RelaySocket?
    private var connectedAt: Int64?
    private var statusListeners: [(id: Int, fn: (LinkStatus) -> Void)] = []
    private var nextListenerId = 0
    private let statusLock = NSLock()
    private var _status = LinkStatus("stopped")

    public init(loop: Loop, creds: HostCreds, keyPair: KeyPair, app: String = "", name: String = "", shell: String = "mobile",
                backoff: Backoff = Backoff(), connectTimeoutMs: Int = 15_000, channelFactory: ChannelFactory? = nil,
                log: @escaping (String) -> Void = { _ in },
                plusIdToken: (() -> String?)? = nil, plusReadmit: ((String) throws -> HostCreds?)? = nil,
                plusTicket: ((String, KeyPair) throws -> String?)? = nil) {
        self.loop = loop
        self._creds = creds
        self.keyPair = keyPair
        self.app = app
        self.name = name
        self.shell = shell
        self.backoff = backoff
        self.connectTimeoutMs = connectTimeoutMs
        self.channelFactory = channelFactory
        self.log = log
        self.plusIdToken = plusIdToken
        self.plusReadmit = plusReadmit
        self.plusTicket = plusTicket
    }

    public var creds: HostCreds {
        get { credsLock.lock(); defer { credsLock.unlock() }; return _creds }
        set { credsLock.lock(); _creds = newValue; credsLock.unlock() }
    }

    /// The last status (readable from any thread).
    public var status: LinkStatus {
        statusLock.lock(); defer { statusLock.unlock() }
        return _status
    }

    public var state: String { status.state }

    /// Listeners run on the loop.
    public func onStatus(_ fn: @escaping (LinkStatus) -> Void) {
        loop.exec { [self] in
            nextListenerId += 1
            statusListeners.append((nextListenerId, fn))
        }
    }

    private func addListener(_ fn: @escaping (LinkStatus) -> Void) -> Int {
        nextListenerId += 1
        statusListeners.append((nextListenerId, fn))
        return nextListenerId
    }

    private func removeListener(_ id: Int) { statusListeners.removeAll { $0.id == id } }

    private func setStatus(_ s: LinkStatus) {
        var st = s
        st.hostName = hostName
        st.connectedAt = s.state == "connected" ? connectedAt : nil
        statusLock.lock()
        _status = st
        statusLock.unlock()
        for l in statusListeners { l.fn(st) }
    }

    public func start() {
        loop.exec { [self] in
            if running { return }
            running = true
            attempt = 0
            connect()
        }
    }

    public func stop() {
        loop.exec { [self] in
            if !running && state == "stopped" { return }
            running = false
            generation += 1
            retryTimer?.cancel(); retryTimer = nil
            stableTimer?.cancel()
            let ch = channel
            channel = nil
            ch?.close(ChannelError("closed", "link stopped"))
            socket?.close(1000)
            socket = nil
            setStatus(LinkStatus("stopped"))
        }
    }

    /// Reconnect now ("retry", foreground again, or new credentials and key after re-pairing).
    public func retryNow(_ newCreds: HostCreds? = nil, _ newKeyPair: KeyPair? = nil) {
        loop.exec { [self] in reconnect(newCreds, newKeyPair, force: false) }
    }

    /// Back in the foreground: a link that still reads "connected" may sit on a socket the system killed while the app
    /// was suspended. PING it; without a PONG within timeoutMs, reconnect at once (instead of waiting for 3 missed
    /// PINGs, 60 s or more). offline / host-offline reconnect now; revoked and stopped stay as they are.
    public func checkNow(timeoutMs: Int = 3_000) {
        loop.exec { [self] in
            if !running || state == "revoked" || state == "stopped" { return }
            guard state == "connected", let ch = channel, !ch.closed else { return reconnect(nil, nil, force: false) }
            var answered = false
            let dead = { [weak self] in
                guard let self, self.channel === ch else { return }
                self.log("remote device: no PONG after resuming, reconnecting")
                self.reconnect(nil, nil, force: true)
            }
            ch.ping { err in
                if answered { return }
                answered = true
                if err != nil { dead() }
            }
            loop.schedule(timeoutMs) {
                if answered { return }
                answered = true
                dead()
            }
        }
    }

    /// Loop.
    private func reconnect(_ newCreds: HostCreds?, _ newKeyPair: KeyPair?, force: Bool) {
        // The same credentials again (the host list read again with an unchanged relay) are no reason to cut the line:
        // a stopped line stays stopped and a waiting one keeps its backoff
        if let newCreds, newKeyPair == nil, newCreds == creds { return }
        if let newCreds { creds = newCreds }
        if let newKeyPair { keyPair = newKeyPair }
        if !running { running = true; attempt = 0; connect(); return }
        if (state == "connecting" || state == "connected") && newCreds == nil && !force { return }
        generation += 1
        retryTimer?.cancel(); retryTimer = nil
        let ch = channel
        channel = nil
        ch?.close(ChannelError("closed", "reconnecting"))
        socket?.close(1000)
        socket = nil
        attempt = 0
        connect()
    }

    /// The usable channel: at once when connected, after the attempt when connecting (max ms), otherwise fail at once
    /// with LinkUnavailable(state). The callback runs on the loop.
    public func ready(_ ms: Int, _ cb: @escaping (Channel?, LinkUnavailable?) -> Void) {
        loop.exec { [self] in
            if state == "connected", let ch = channel, !ch.closed { return cb(ch, nil) }
            if state != "connecting" { return cb(nil, LinkUnavailable(state: state, closeCode: status.closeCode)) }
            var done = false
            var timer: Cancellable?
            var listenerId = 0
            listenerId = addListener { [weak self] s in
                guard let self, !done, s.state != "connecting" else { return }
                done = true
                self.removeListener(listenerId)
                timer?.cancel()
                if s.state == "connected", let c = self.channel { cb(c, nil) } else { cb(nil, LinkUnavailable(state: s.state, closeCode: s.closeCode)) }
            }
            timer = loop.schedule(ms) { [weak self] in
                guard !done else { return }
                done = true
                self?.removeListener(listenerId)
                cb(nil, LinkUnavailable(state: "offline"))
            }
        }
    }

    private func scheduleRetry(_ state: String, _ detail: LinkStatus) {
        if !running { return }
        var d = detail
        d.since = nowMs()
        if state == "readmit" && creds.via == "plus" && plusReadmit != nil {
            if readmitAttempts >= 1 {
                running = false
                d.state = "revoked"
                setStatus(d)
                return
            }
            readmitAttempts += 1
            generation += 1
            let gen = generation
            setStatus(LinkStatus("connecting"))
            let hostId = creds.hostId
            let readmit = plusReadmit!
            DeviceLink.workers.async { [weak self] in
                var replacement: HostCreds?
                var error: PairError?
                do { replacement = try readmit(hostId) } catch let e as PairError { error = e } catch {}
                self?.loop.post {
                    guard let self, gen == self.generation, self.running else { return }
                    if let replacement {
                        self.creds = replacement
                        self.attempt = 0
                        self.connect()
                    } else {
                        self.running = false
                        var failed = LinkStatus(LinkRules.readmitFailedState(error?.code))
                        failed.reason = error?.code ?? "readmit-failed"
                        self.setStatus(failed)
                    }
                }
            }
            return
        }
        if creds.via == "plus" && detail.closeCode == 4401 && (detail.reason == "token" || detail.reason == "ticket") {
            tokenFailures += 1
            if tokenFailures >= 2 {
                running = false
                d.state = "blocked"
                setStatus(d)
                return
            }
        }
        if state == "paused" && creds.via == "plus" {
            // Plus comes back on its own: ask again, slower each time but within half a minute, and keep showing "paused"
            let delay = min(backoff.pausedMaxMs, backoff.pausedMinMs * (1 << min(pausedAttempts, 20)))
            pausedAttempts += 1
            let now = nowMs()
            d.state = state
            d.since = status.state == "paused" ? status.since : now
            d.retryAt = now + Int64(delay)
            setStatus(d)
            let gen = generation
            retryTimer = loop.schedule(delay) { [weak self] in
                guard let self else { return }
                self.retryTimer = nil
                if gen == self.generation && self.running { self.connect(quiet: true) }
            }
            return
        }
        if ["revoked", "reapprove", "blocked", "limit", "readmit", "signed-out", "update", "removed"].contains(state) {
            running = false
            d.state = state
            setStatus(d)
            return
        }
        let base = min(backoff.maxMs, backoff.minMs * (1 << min(attempt, 20)))
        let delay = Int((Double(base) * (0.75 + Double.random(in: 0..<0.5))).rounded())
        attempt += 1
        d.state = state
        d.retryAt = nowMs() + Int64(delay)
        setStatus(d)
        let gen = generation
        retryTimer = loop.schedule(delay) { [weak self] in
            guard let self else { return }
            self.retryTimer = nil
            if gen == self.generation && self.running { self.connect() }
        }
    }

    /**
     * Loop. Starts one attempt; the blocking part runs on a worker, the result comes back to the loop.
     * quiet: asking again while Plus is paused keeps "paused" until a ticket is given.
     */
    private func connect(quiet: Bool = false) {
        generation += 1
        let gen = generation
        let c = creds
        let ticket = plusTicket
        if !quiet || c.via != "plus" || ticket == nil { setStatus(LinkStatus("connecting")) }
        if c.via == "plus", let ticket {
            // a ticket is taken over the network: on a worker, then open on the loop
            let kp = keyPair
            DeviceLink.workers.async { [weak self] in
                var relay: String?
                var failed: String?
                do { relay = try ticket(c.hostId, kp) }
                catch let e as PairError {
                    failed = LinkRules.ticketFailedState(e.code)
                    self?.log("remote device: ticket failed: \(e.code)")
                } catch {
                    failed = "offline"
                    self?.log("remote device: ticket failed: \(error)")
                }
                self?.loop.post {
                    guard let self, gen == self.generation, self.running else { return }
                    if let f = failed { return self.scheduleRetry(f, LinkStatus(f, reason: "ticket")) }
                    if quiet { self.setStatus(LinkStatus("connecting")) }
                    if let relay {
                        self.open(c, gen, ("x-pleiad-ticket", relay))
                    } else {
                        self.withIdToken(c, gen)
                    }
                }
            }
            return
        }
        if c.via == "plus" { withIdToken(c, gen) } else { open(c, gen, nil) }
    }

    /// Loop. The connection with the ID token (an api without tickets).
    private func withIdToken(_ c: HostCreds, _ gen: Int) {
        guard let accountToken = plusIdToken?(), !accountToken.isEmpty else {
            running = false
            setStatus(LinkStatus("signed-out"))
            return
        }
        open(c, gen, ("x-pleiad-account", accountToken))
    }

    /// Loop. account: the relay's account header for via "plus" (the ticket, or the ID token).
    private func open(_ c: HostCreds, _ gen: Int, _ account: (String, String)?) {
        let live = { [weak self] () -> Bool in
            guard let self else { return false }
            return gen == self.generation && self.running
        }
        let url: String
        do {
            url = try PairingCodec.relayWsUrl(c.relayUrl, "/v1/device")
        } catch {
            log("remote device: \(error)")
            scheduleRetry("offline", LinkStatus("offline", reason: "url"))
            return
        }
        var headers = ["authorization": "Bearer \(c.token)", "x-pleiad-host": c.hostId, "x-pleiad-device": c.deviceId]
        if let account { headers[account.0] = account.1 }
        let sock = RelaySocket(
            url: url,
            headers: headers,
            openTimeoutMs: connectTimeoutMs
        )
        socket = sock
        let fail: (String, LinkStatus) -> Void = { [weak self] st, detail in
            sock.close(1000)
            guard let self else { return }
            if self.socket === sock { self.socket = nil }
            if live() { self.scheduleRetry(st, detail) }
        }
        let keyPair = self.keyPair
        let payload: JSON = ["proto": 1, "name": .string(name), "app": .string(app)]
        let timeout = connectTimeoutMs
        DeviceLink.workers.async { [weak self] in
            let o = sock.awaitOpen()
            if !o.open {
                self?.loop.post {
                    if !live() { sock.close(); return }
                    let closeCode = o.closeCode.flatMap { $0 == 1006 ? nil : $0 }
                    let detail: LinkStatus
                    if let closeCode { detail = LinkStatus("", closeCode: closeCode) }
                    else if let st = o.status { detail = LinkStatus("", httpStatus: st) }
                    else { detail = LinkStatus("", reason: o.error) }
                    fail(closeCode != nil ? LinkRules.classifyClose(closeCode, reason: "", via: c.via) : "offline", detail)
                }
                return
            }
            var transport: Transport?
            var failure: (String, LinkStatus)?
            do {
                let hs = try Handshake(.IK, initiator: true, prologue: Pleiad.prologueFor(c.hostId), staticKey: keyPair, remoteStatic: c.hostPublicKey)
                _ = sock.send(try hs.writeMessage(payload.data))
                _ = try hs.readMessage(try sock.next(timeout))
                transport = try hs.split()
            } catch let e as RelayClosed {
                failure = (LinkRules.classifyClose(e.code, reason: e.reason, via: c.via), LinkStatus("", closeCode: e.code, reason: e.reason.isEmpty ? nil : e.reason))
            } catch is RelayTimeout {
                failure = ("host-offline", LinkStatus("", reason: "timeout"))
            } catch {
                // The host's key does not match: treat like revoked (possible impersonation), don't retry
                self?.log("remote device: handshake failed: \(error)")
                failure = ("revoked", LinkStatus("", reason: "handshake"))
            }
            self?.loop.post {
                guard let self, live() else { sock.close(); return }
                if let f = failure { return fail(f.0, f.1) }
                self.attach(sock, transport!, live, fail)
            }
        }
    }

    /// Loop. The handshake is done: build the channel, attach listeners, THEN drain queued messages, then HELLO.
    private func attach(_ sock: RelaySocket, _ transport: Transport, _ live: @escaping () -> Bool, _ fail: @escaping (String, LinkStatus) -> Void) {
        let hello: JSON = ["app": .string(app), "shell": .string(shell)]
        let send: (Bytes) throws -> Void = { b in
            if !sock.send(b) { throw StateError(description: "relay socket refused the message") }
        }
        let buffered = { sock.bufferedAmount() }
        let ch = channelFactory?(send, transport, hello, buffered)
            ?? Channel(loop: loop, role: "device", send: send, transport: transport, hello: hello, bufferedAmount: buffered)
        var goaway: String?
        var settled = false
        var helloDone = false
        var helloTimer: Cancellable?

        func onHelloResult(_ h: JSON?, timedOut: Bool) {
            if helloDone { return }
            helloDone = true
            helloTimer?.cancel()
            if !live() { ch.close(); sock.close(); return }
            guard let h else {
                ch.close()
                // Wait up to 1 s for the relay's close code to classify the failure
                let finish = { [weak self] (closed: RelayClosed?) in
                    self?.loop.post {
                        if !live() { return }
                        let cc = closed.flatMap { $0.code == 1006 ? nil : $0.code }
                        let state = timedOut && cc == nil ? "host-offline" : LinkRules.classifyClose(cc, goaway: goaway, reason: closed?.reason, via: self?.creds.via ?? "own")
                        fail(state, LinkStatus("", closeCode: cc, goaway: goaway, reason: timedOut ? "timeout" : closed?.reason))
                    }
                }
                var answered = false
                let t = loop.schedule(1000) {
                    if !answered { answered = true; finish(sock.closed) }
                }
                sock.onClose { [weak self] cl in
                    self?.loop.post {
                        if !answered { answered = true; t.cancel(); finish(cl) }
                    }
                }
                return
            }
            settled = true
            channel = ch
            hostName = h["hostName"]?.string ?? ""
            connectedAt = nowMs()
            stableTimer?.cancel()
            stableTimer = loop.schedule(backoff.stableMs) { [weak self] in
                if let self, self.channel === ch { self.attempt = 0 }
            }
            setStatus(LinkStatus("connected"))
            if let closedAlready = sock.closed, channel === ch {
                channel = nil
                if live() && state == "connected" {
                    scheduleRetry(LinkRules.classifyClose(closedAlready.code == 1006 ? nil : closedAlready.code, goaway: goaway,
                                                        reason: closedAlready.reason, via: self.creds.via),
                                  LinkStatus("", closeCode: closedAlready.code, reason: closedAlready.reason))
                }
            }
        }

        let listener = ChannelListener()
        listener.onHello = { h in onHelloResult(h, timedOut: false) }
        listener.onGoaway = { code, _ in goaway = code }
        listener.onClose = { _ in
            sock.close(1000)
            if !helloDone { onHelloResult(nil, timedOut: false) }
        }
        ch.listener = listener
        helloTimer = loop.schedule(connectTimeoutMs) { onHelloResult(nil, timedOut: true) }
        sock.onClose { [weak self] closed in
            self?.loop.post {
                guard let self else { return }
                ch.close(ChannelError("transport", "relay connection lost"))
                if settled {
                    if self.channel === ch { self.channel = nil }
                    self.stableTimer?.cancel()
                    if self.socket === sock { self.socket = nil }
                    if !live() { return }
                    if self.state != "connected" { return }   // handled already (e.g. closed right after HELLO)
                    let cc = closed.code == 1006 ? nil : closed.code
                    self.scheduleRetry(LinkRules.classifyClose(cc, goaway: goaway, reason: closed.reason, via: self.creds.via),
                                       LinkStatus("", closeCode: cc, goaway: goaway, reason: closed.reason.isEmpty ? nil : closed.reason))
                }
            }
        }
        // Listeners are attached: now hand over queued messages (HELLO may already be among them) and later ones, in order.
        let rx = loop
        sock.drainTo { b in rx.post { ch.receive(b) } }
        ch.start()
    }
}
