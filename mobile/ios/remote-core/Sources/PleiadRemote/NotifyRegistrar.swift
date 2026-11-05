// Registers this device's notification key and settings with a host (docs/remote.md §11-5, ADR 0086). Swift port of
// NotifyRegistrar.kt.
//
// The key (the device makes it) must reach the host through the end-to-end channel, never through the relay's notify
// line. So this opens a short-lived Noise channel to the host (a DeviceLink, like the host window uses), opens `/ws`
// through the host's firewall, sends one `notifyRegister` command, waits for the reply and closes. The host binds the key
// to the device the channel was authenticated for. Hosts that predate notifications do not say `notify: 1` in `ready`
// and are not sent anything.

import Foundation

public enum RegisterResult: Equatable {
    /// Registered; the value is the host's view of the settings.
    case done(enabled: Bool)
    /// The host is too old for notifications (no `notify` in ready).
    case unsupported
    /// Could not reach the host or it refused. The state is the link state or "timeout" / "refused" / "closed" / "error".
    case failed(state: String, detail: String?)
}

public final class NotifyRegistrar {
    private let loop: Loop
    /// The device key the host knows for these credentials (each pairing has its own key).
    private let keyFor: (HostCreds) throws -> KeyPair
    private let app: String
    private let name: String
    private let connectTimeoutMs: Int
    private let log: (String) -> Void
    private let plusIdToken: (() -> String?)?
    private let plusTicket: ((String, KeyPair) throws -> String?)?

    public init(loop: Loop, keyFor: @escaping (HostCreds) throws -> KeyPair, app: String, name: String,
                connectTimeoutMs: Int = 15_000, log: @escaping (String) -> Void = { _ in },
                plusIdToken: (() -> String?)? = nil, plusTicket: ((String, KeyPair) throws -> String?)? = nil) {
        self.loop = loop
        self.keyFor = keyFor
        self.app = app
        self.name = name
        self.connectTimeoutMs = connectTimeoutMs
        self.log = log
        self.plusIdToken = plusIdToken
        self.plusTicket = plusTicket
    }

    /// Blocking (never call on the loop).
    public func register(creds: HostCreds, key: Bytes, settings: NotifySettings, timeoutMs: Int = 30_000) -> RegisterResult {
        let keyPair: KeyPair
        do { keyPair = try keyFor(creds) } catch { return .failed(state: "error", detail: String(describing: error)) }
        let link = DeviceLink(loop: loop, creds: creds, keyPair: keyPair, app: app, name: name, shell: "mobile",
                              backoff: Backoff(minMs: 500, maxMs: 2_000, stableMs: 1_000),
                              connectTimeoutMs: connectTimeoutMs, log: log,
                              plusIdToken: plusIdToken, plusTicket: plusTicket)
        let done = DispatchSemaphore(value: 0)
        var result: RegisterResult = .failed(state: "timeout", detail: nil)
        var finished = false
        var stream: Stream?
        var timer: Cancellable?
        func finish(_ r: RegisterResult) {   // loop
            if finished { return }
            finished = true
            result = r
            timer?.cancel()
            if let stream, !stream.destroyed { stream.close(1000) }
            done.signal()
        }
        let id = "notify-register"
        self.loop.exec {
            timer = self.loop.schedule(timeoutMs) { finish(.failed(state: "timeout", detail: nil)) }
            link.start()
            link.ready(self.connectTimeoutMs + 5_000) { ch, err in
                guard let ch else { return finish(.failed(state: err?.state ?? "offline", detail: nil)) }
                do {
                    let st = try ch.openWs(["path": .string("/ws"), "protocols": .array([])])
                    stream = st
                    st.listener.onReject = { status in finish(.failed(state: "refused", detail: "http \(status)")) }
                    st.listener.onReset = { code, _ in finish(.failed(state: "refused", detail: "reset \(code)")) }
                    st.listener.onClose = { code, _ in finish(.failed(state: "closed", detail: "\(code)")) }
                    st.listener.onMessage = { data, text, release in
                        release()
                        if !text || finished { return }
                        guard let m = try? JSON.parse(data) else { return }
                        switch m["kind"]?.string {
                        case "ready":
                            if m["notify"]?.int != 1 { return finish(.unsupported) }
                            let cmd: JSON = ["kind": .string("command"), "command": .string("notifyRegister"), "id": .string(id),
                                             "args": .object(["key": .string(NotifyCrypto.encodeKey(key)), "settings": settings.json])]
                            st.send(cmd.data, text: true)
                        case "response":
                            if m["id"]?.string == id {
                                if m["ok"]?.bool == true { finish(.done(enabled: m["result"]?["enabled"]?.bool ?? false)) }
                                else { finish(.failed(state: "refused", detail: m["error"]?.string)) }
                            }
                        default: break
                        }
                    }
                } catch {
                    finish(.failed(state: "error", detail: String(describing: error)))
                }
            }
        }
        _ = done.wait(timeout: .now() + .milliseconds(timeoutMs + 5_000))
        link.stop()
        return result
    }
}
