import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

// Pleiad Plus for iOS: the Swift port of dev.pleiad.app.plus.* (docs/plus.md "iOS"). The login page opens in an
// ASWebAuthenticationSession (callbackURLScheme pleiad) with client=ios and redirect_uri=pleiad://auth; the app comes
// back through pleiad://auth?code=…&state=… (the SceneDelegate / offerLink path). Config is fetched from
// GET <api>/v1/auth/config, never baked into the app (no GoogleService-Info.plist).

// ── Sign-in (PlusAuth.kt) ──

public enum PlusAuth {
    /// How long a pending login attempt stays valid while the auth session is open.
    public static let PENDING_TTL_MS: Int64 = 10 * 60 * 1000

    /// The redirect_uri sent to the login page — also the token exchange's redirectUri.
    public static let CALLBACK_URL = "pleiad://auth"

    /// The OAuth client name this app reports.
    public static let CLIENT = "ios"

    /// base64url, no padding.
    public static func b64url(_ b: Bytes) -> String { Base64URL.encode(b) }

    /// base64url(SHA-256(verifier)) — RFC 7636 §4.2, no padding.
    public static func challenge(_ verifier: String) -> String {
        b64url(sha256(Bytes(verifier.utf8)))
    }

    /// <login>?client=ios&redirect_uri=<enc>&state=<state>&code_challenge=<c>&code_challenge_method=S256&lang=<ja|en>
    public static func loginUrl(_ loginBase: String, state: String, codeChallenge: String, lang: String) -> String {
        func enc(_ s: String) -> String { s.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed.subtracting(CharacterSet(charactersIn: "+&="))) ?? s }
        let l = lang.lowercased().hasPrefix("ja") ? "ja" : "en"
        return "\(loginBase)?client=\(CLIENT)&redirect_uri=\(enc(CALLBACK_URL))&state=\(enc(state))" +
            "&code_challenge=\(enc(codeChallenge))&code_challenge_method=S256&lang=\(l)"
    }

    /// The in-flight login attempt, kept (sealed) so a return link still matches after the process was killed.
    public struct Pending {
        public let verifier: String
        public let state: String
        public let createdAt: Int64

        public init(verifier: String, state: String, createdAt: Int64) {
            self.verifier = verifier
            self.state = state
            self.createdAt = createdAt
        }

        public var json: JSON { ["verifier": .string(verifier), "state": .string(state), "createdAt": .int(createdAt)] }

        public func fresh(_ now: Int64) -> Bool { (0...PlusAuth.PENDING_TTL_MS).contains(now - createdAt) }

        public static func from(_ o: JSON) -> Pending? {
            guard let v = o["verifier"]?.string, let s = o["state"]?.string, let c = o["createdAt"]?.int else { return nil }
            return Pending(verifier: v, state: s, createdAt: c)
        }

        public static func parse(_ text: String) -> Pending? {
            guard let o = try? JSON.parse(Bytes(text.utf8)) else { return nil }
            return from(o)
        }
    }

    public struct Callback {
        public let code: String?
        public let state: String?
        public let error: String?
    }

    /// The way back: pleiad://auth (the auth session's callbackURLScheme).
    public static func isAuthCallback(_ url: String) -> Bool {
        guard let u = URLComponents(string: url), let scheme = u.scheme, let host = u.host else { return false }
        return scheme.lowercased() == "pleiad" && host.lowercased() == "auth"
    }

    public static func parseCallback(_ url: String) -> Callback? {
        guard isAuthCallback(url), let u = URLComponents(string: url) else { return nil }
        var q = [String: String]()
        for item in u.queryItems ?? [] { if q[item.name] == nil { q[item.name] = item.value ?? "" } }
        return Callback(code: q["code"], state: q["state"], error: q["error"])
    }

    /// Constant-time state compare (the pending value is the expected one).
    public static func stateMatches(_ expected: String, _ actual: String?) -> Bool {
        guard let actual else { return false }
        return constantTimeEqual(Bytes(expected.utf8), Bytes(actual.utf8))
    }
}

// ── Config (PlusConfig.kt) ──

public struct PlusConfig {
    public var state: String             // on | maintenance | off
    public var visibility: String        // optin | public （欄が無い・知らない値は optin に倒す）
    public var tokenProjectId: String?
    public var tokenApiKey: String?
    public var loginUrl: String
    public var accountUrl: String
    public var profileUrl: String
    public var relayUrl: String
    public var refreshUrl: String
    public var minClientIOS: String?
    /// 受け入れの版（1 | 2）。数なら券を出す api（docs/plus.md「券」）。欄が無ければ券の口が無い前の版の api
    public var admission: Int?

    public init(state: String, visibility: String, tokenProjectId: String?, tokenApiKey: String?, loginUrl: String,
                accountUrl: String, profileUrl: String, relayUrl: String, refreshUrl: String, minClientIOS: String?, admission: Int? = nil) {
        self.state = state
        self.visibility = visibility
        self.tokenProjectId = tokenProjectId
        self.tokenApiKey = tokenApiKey
        self.loginUrl = loginUrl
        self.accountUrl = accountUrl
        self.profileUrl = profileUrl
        self.relayUrl = relayUrl
        self.refreshUrl = refreshUrl
        self.minClientIOS = minClientIOS
        self.admission = admission
    }

    public var json: JSON {
        var o: JSON = [
            "state": .string(state),
            "visibility": .string(visibility),
            "token": .object(["projectId": tokenProjectId.map { .string($0) } ?? .null,
                              "apiKey": tokenApiKey.map { .string($0) } ?? .null]),
            "urls": .object(["login": .string(loginUrl), "account": .string(accountUrl), "profile": .string(profileUrl),
                             "relay": .string(relayUrl), "refresh": .string(refreshUrl)]),
            "minClient": .object(["ios": minClientIOS.map { .string($0) } ?? .null]),
        ]
        if let admission { o.set("admission", .int(Int64(admission))) }
        return o
    }

    public static func from(_ o: JSON) -> PlusConfig {
        let token = o["token"]?.object ?? [:]
        let urls = o["urls"]?.object ?? [:]
        let minClient = o["minClient"]?.object ?? [:]
        func s(_ v: JSON?) -> String { v?.string ?? "" }
        func ns(_ v: JSON?) -> String? { (v?.string).flatMap { $0.isEmpty ? nil : $0 } }
        return PlusConfig(
            state: s(o["state"]).isEmpty ? "on" : s(o["state"]),
            visibility: o["visibility"]?.string == "public" ? "public" : "optin",
            tokenProjectId: ns(token["projectId"]),
            tokenApiKey: ns(token["apiKey"]),
            loginUrl: s(urls["login"]),
            accountUrl: s(urls["account"]),
            profileUrl: s(urls["profile"]),
            relayUrl: s(urls["relay"]),
            refreshUrl: s(urls["refresh"]),
            minClientIOS: ns(minClient["ios"]),
            admission: o["admission"]?.int.map { Int($0) })
    }

    public static func parse(_ text: String) -> PlusConfig? {
        guard let o = try? JSON.parse(Bytes(text.utf8)) else { return nil }
        return from(o)
    }

    /// The freshly fetched config wins; keep the last good one when the fetch failed.
    public static func choose(_ fetched: PlusConfig?, _ saved: PlusConfig?) -> PlusConfig? { fetched ?? saved }
}

public enum PlusVersion {
    /// Numeric segment-wise compare ("0.32.10" > "0.32.0"; a suffix like "0.32.10-1234" is ignored).
    public static func compare(_ a: String, _ b: String) -> Int {
        let pa = a.split(separator: "-").first.map { String($0).split(separator: ".") } ?? []
        let pb = b.split(separator: "-").first.map { String($0).split(separator: ".") } ?? []
        for i in 0..<max(pa.count, pb.count) {
            let x = i < pa.count ? (Int64(pa[i]) ?? 0) : 0
            let y = i < pb.count ? (Int64(pb[i]) ?? 0) : 0
            if x != y { return x < y ? -1 : 1 }
        }
        return 0
    }

    /// True when this build is older than the server's minClient for ios.
    public static func isOlder(_ current: String, _ min: String) -> Bool { compare(current, min) < 0 }
}

// ── Session + api (PlusSession.kt) ──

/// What the app persists (sealed in the Keychain). The ID token is deliberately not part of it.
public struct SessionRecord {
    public var refreshToken: String
    public var uid: String
    public var email: String
    public var tokenProjectId: String
    public var apiKey: String
    public var savedAt: Int64

    public var json: JSON { ["refreshToken": .string(refreshToken), "uid": .string(uid), "email": .string(email),
                             "tokenProjectId": .string(tokenProjectId), "apiKey": .string(apiKey), "savedAt": .int(savedAt)] }

    public static func from(_ o: JSON) -> SessionRecord? {
        guard let rt = o["refreshToken"]?.string, let uid = o["uid"]?.string else { return nil }
        return SessionRecord(refreshToken: rt, uid: uid, email: o["email"]?.string ?? "",
                             tokenProjectId: o["tokenProjectId"]?.string ?? "", apiKey: o["apiKey"]?.string ?? "",
                             savedAt: o["savedAt"]?.int ?? 0)
    }

    public static func parse(_ text: String) -> SessionRecord? {
        guard let o = try? JSON.parse(Bytes(text.utf8)) else { return nil }
        return from(o)
    }
}

public struct PlusAccount {
    public var email: String
    public var provider: String?
    public var status: String?
    public var devicesPerHost: Int?

    public static func from(_ o: JSON) -> PlusAccount {
        PlusAccount(email: o["email"]?.string ?? "",
                    provider: (o["provider"]?.string).flatMap { $0.isEmpty ? nil : $0 },
                    status: (o["status"]?.string).flatMap { $0.isEmpty ? nil : $0 },
                    devicesPerHost: o["limits"]?["devicesPerHost"].flatMap { $0.int.map(Int.init) })
    }
}

/// The login code exchanged for tokens (POST /v1/auth/token).
public struct TokenBundle {
    public var idToken: String
    public var refreshToken: String
    public var expiresAtMs: Int64
    public var uid: String
    public var email: String
    public var tokenProjectId: String
    public var apiKey: String
}

/// An HTTP error from the api (or the token refresh endpoint); error.code/error.message from the body when present.
public struct PlusApiError: Error, CustomStringConvertible {
    public let status: Int
    public let code: String
    public let detail: String
    public init(_ status: Int, _ code: String, _ detail: String = "") {
        self.status = status
        self.code = code
        self.detail = detail
    }
    public var description: String { "http \(status) \(code)".trimmingCharacters(in: .whitespaces) }
}

/// Blocking JSON HTTP for the Plus api (URLSession + a semaphore; always called off the main thread).
public enum PlusHttp {
    /// Returns the parsed body ({ } when empty). Throws PlusApiError on a non-2xx, the URLError otherwise.
    public static func request(_ method: String, _ url: String, headers: [String: String] = [:],
                               json: JSON? = nil, form: String? = nil, timeout: TimeInterval = 30) throws -> JSON {
        guard let u = URL(string: url) else { throw PlusApiError(0, "bad_url") }
        var req = URLRequest(url: u, timeoutInterval: timeout)
        req.httpMethod = method
        for (k, v) in headers { req.setValue(v, forHTTPHeaderField: k) }
        if let json {
            req.setValue("application/json; charset=utf-8", forHTTPHeaderField: "Content-Type")
            req.httpBody = Data(json.data)
        } else if let form {
            req.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
            req.httpBody = form.data(using: .utf8)
        }
        let sem = DispatchSemaphore(value: 0)
        var out: (Data?, URLResponse?, Error?) = (nil, nil, nil)
        let task = URLSession.shared.dataTask(with: req) { d, r, e in out = (d, r, e); sem.signal() }
        task.resume()
        // timed out: cancel and throw without reading out (the completion handler may still be writing it)
        if sem.wait(timeout: .now() + timeout + 5) == .timedOut {
            task.cancel()
            throw URLError(.timedOut)
        }
        if let e = out.2 { throw e }
        let res = out.1 as? HTTPURLResponse
        let status = res?.statusCode ?? 0
        let body = out.0 ?? Data()
        guard (200...299).contains(status) else {
            var code = "", detail = ""
            if let o = try? JSON.parse(Bytes(body)), let e = o["error"]?.object {
                code = e["code"]?.string ?? ""
                detail = e["message"]?.string ?? ""
            }
            throw PlusApiError(status, code, detail)
        }
        // Only an empty body is {}. A 200 that is not JSON (a proxy's HTML page) throws, as JSONObject(text) does on
        // Android: read as {}, the host list would look read and empty and the Plus pairings would be forgotten.
        guard !body.isEmpty else { return .object([:]) }
        return try JSON.parse(Bytes(body))
    }
}

public enum PlusApi {
    /// The admission mark (docs/plus.md "Tickets"): every request to the Plus api says this client takes tickets.
    /// Not sent to the token refresh endpoint (not the Plus api).
    public static let ADMISSION_HEADER = "X-Pleiad-Admission"
    public static let ADMISSION_MARK = "2"

    private static func apiHeaders(_ clientTag: String, _ extra: [String: String]) -> [String: String] {
        var h = extra
        h[ADMISSION_HEADER] = ADMISSION_MARK
        h["X-Pleiad-Client"] = clientTag
        return h
    }

    /// GET /v1/auth/config — no auth. HTTP errors throw.
    public static func fetchConfig(_ apiBase: String, _ clientTag: String) throws -> PlusConfig {
        PlusConfig.from(try PlusHttp.request("GET", "\(apiBase)/v1/auth/config", headers: apiHeaders(clientTag, [:])))
    }

    /// POST /v1/auth/token — the login code + PKCE verifier for tokens. Throws PlusApiError (e.g. 400 invalid_grant).
    public static func exchangeCode(_ apiBase: String, code: String, codeVerifier: String, redirectUri: String, clientTag: String) throws -> TokenBundle {
        let o = try PlusHttp.request("POST", "\(apiBase)/v1/auth/token", headers: apiHeaders(clientTag, [:]),
                                     json: ["code": .string(code), "codeVerifier": .string(codeVerifier), "redirectUri": .string(redirectUri)])
        guard let idToken = o["idToken"]?.string, let refreshToken = o["refreshToken"]?.string,
              let expiresAt = o["expiresAt"]?.int, let uid = o["uid"]?.string else { throw PlusApiError(502, "bad_response") }
        return TokenBundle(idToken: idToken, refreshToken: refreshToken, expiresAtMs: expiresAt, uid: uid,
                           email: o["email"]?.string ?? "", tokenProjectId: o["tokenProjectId"]?.string ?? "",
                           apiKey: o["apiKey"]?.string ?? "")
    }

    public struct RefreshResult {
        public var idToken: String
        public var refreshToken: String?
        public var expiresInSec: Int64
    }

    /// POST <urls.refresh>?key=<apiKey> — grant_type=refresh_token form (the token endpoint from the config).
    public static func refresh(_ refreshUrl: String, apiKey: String, refreshToken: String) throws -> RefreshResult {
        func enc(_ s: String) -> String { s.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? s }
        let sep = refreshUrl.contains("?") ? "&" : "?"
        let o = try PlusHttp.request("POST", "\(refreshUrl)\(sep)key=\(enc(apiKey))",
                                     form: "grant_type=refresh_token&refresh_token=\(enc(refreshToken))")
        guard let t = o["id_token"]?.string else { throw PlusApiError(502, "bad_response") }
        return RefreshResult(idToken: t,
                             refreshToken: (o["refresh_token"]?.string).flatMap { $0.isEmpty ? nil : $0 },
                             expiresInSec: o["expires_in"]?.int ?? 0)
    }

    /// GET /v1/account with the ID token.
    public static func fetchAccount(_ apiBase: String, idToken: String, clientTag: String) throws -> PlusAccount {
        PlusAccount.from(try PlusHttp.request("GET", "\(apiBase)/v1/account",
                                              headers: apiHeaders(clientTag, ["Authorization": "Bearer \(idToken)"])))
    }

    /// POST <apiBase><path> with the ID token (the ticket calls). Throws PlusApiError.
    public static func postAuthed(_ apiBase: String, idToken: String, clientTag: String, path: String, payload: JSON) throws -> JSON {
        try PlusHttp.request("POST", "\(apiBase)\(path)", headers: apiHeaders(clientTag, ["Authorization": "Bearer \(idToken)"]), json: payload)
    }

    /// GET /v1/hosts with the current account token.
    public static func fetchHosts(_ apiBase: String, idToken: String, clientTag: String) throws -> [PlusHost] {
        let o = try PlusHttp.request("GET", "\(apiBase)/v1/hosts",
                                     headers: apiHeaders(clientTag, ["Authorization": "Bearer \(idToken)"]))
        return (o["hosts"]?.array ?? []).compactMap { h in
            guard let hostId = h["hostId"]?.string, let publicKey = h["publicKey"]?.string, !hostId.isEmpty, !publicKey.isEmpty else { return nil }
            func instant(_ name: String) -> Int64? {
                guard let s = h[name]?.string else { return nil }
                let f = ISO8601DateFormatter()
                f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
                if let d = f.date(from: s) ?? ISO8601DateFormatter().date(from: s) { return Int64((d.timeIntervalSince1970 * 1000).rounded()) }
                return nil
            }
            return PlusHost(hostId: hostId, publicKey: publicKey, name: h["name"]?.string ?? "", platform: h["platform"]?.string ?? "",
                            online: h["online"]?.bool ?? false, lastSeenAt: instant("lastSeenAt"), createdAt: instant("createdAt"))
        }
    }
}

/**
 * Keeps the sealed session record and the in-memory ID token. All blocking calls run on the caller's queue
 * (the manager's worker); `idToken()` is locked so concurrent asks share one refresh.
 * A refresh is one request per call: the gap between retries is a time to wait for, never a sleep while the
 * session is held (the screen's calls queue on the same lock).
 */
public final class PlusSession {
    public protocol SessionStore {
        func load() -> SessionRecord?
        func save(_ r: SessionRecord)
        func clear()
    }

    public static let EXPIRY_MARGIN_MS: Int64 = 5 * 60 * 1000      // refresh this long before the ID token expires
    public static let RETRY_DELAY_MS: Int64 = 60 * 1000            // between refresh retries on network errors / 5xx
    public static let MAX_ATTEMPTS = 5                             // total tries before giving up until the next screen poke
    public static let FATAL_REFRESH_ERRORS: Set<String> = ["TOKEN_EXPIRED", "USER_DISABLED", "USER_NOT_FOUND", "INVALID_REFRESH_TOKEN"]

    private let store: SessionStore
    private let nowMs: () -> Int64
    private let log: (String) -> Void
    private let lock = NSRecursiveLock()

    private var idTokenValue: String?
    private var idTokenExpiresAt: Int64 = 0
    private var accountValue: PlusAccount?
    private var errorValue: String?
    /// The last /v1/account read. Read from any thread (the screen's state and the plugin's list), written on the worker.
    public var account: PlusAccount? { lock.lock(); defer { lock.unlock() }; return accountValue }
    /// "failed" (the login itself failed) | "unreachable" | "relogin" | null.
    public var error: String? { lock.lock(); defer { lock.unlock() }; return errorValue }
    /// Failed refreshes in a row; at MAX_ATTEMPTS only a UI poke (force) tries again.
    private var failures = 0
    /// A background ask does not refresh again before this time (the gap after a failure).
    private var retryAt: Int64 = 0

    public init(store: SessionStore, nowMs: @escaping () -> Int64 = { Int64((Date().timeIntervalSince1970 * 1000).rounded()) },
                log: @escaping (String) -> Void = { _ in }) {
        self.store = store
        self.nowMs = nowMs
        self.log = log
    }

    public func record() -> SessionRecord? { store.load() }

    public func signedIn() -> Bool { store.load() != nil }

    /// Called whenever the (fresh or last-good) config is applied: a session sealed under a different token project is
    /// dropped once and the user is asked to sign in again.
    public func onConfig(_ config: PlusConfig?) {
        guard let s = store.load(), let pid = config?.tokenProjectId, pid != s.tokenProjectId else { return }
        signOut()
        lock.lock(); errorValue = "relogin"; lock.unlock()
    }

    public func signIn(_ t: TokenBundle) {
        store.save(SessionRecord(refreshToken: t.refreshToken, uid: t.uid, email: t.email,
                                 tokenProjectId: t.tokenProjectId, apiKey: t.apiKey, savedAt: nowMs()))
        lock.lock()
        idTokenValue = t.idToken
        idTokenExpiresAt = t.expiresAtMs
        errorValue = nil
        failures = 0
        retryAt = 0
        lock.unlock()
    }

    public func signOut() {
        store.clear()
        lock.lock()
        idTokenValue = nil
        idTokenExpiresAt = 0
        accountValue = nil
        lock.unlock()
    }

    /// The current ID token; refreshes when it expires within EXPIRY_MARGIN_MS. Nil when signed out.
    /// A failed refresh hands back the token it has. force (the screen asked): try now, once.
    public func idToken(_ refreshUrl: String?, force: Bool = false) -> String? {
        lock.lock()
        guard let s = store.load() else { lock.unlock(); return nil }
        let t = idTokenValue
        if !force, let t, idTokenExpiresAt - nowMs() > PlusSession.EXPIRY_MARGIN_MS { lock.unlock(); return t }
        if !force && (failures >= PlusSession.MAX_ATTEMPTS || nowMs() < retryAt) { lock.unlock(); return t }
        guard let url = refreshUrl else { lock.unlock(); return t }
        refreshOnce(url, s)
        let result = idTokenValue
        lock.unlock()
        return result
    }

    /// Lock held.
    private func refreshOnce(_ refreshUrl: String, _ cur: SessionRecord) {
        do {
            let r = try PlusApi.refresh(refreshUrl, apiKey: cur.apiKey, refreshToken: cur.refreshToken)
            idTokenValue = r.idToken
            idTokenExpiresAt = nowMs() + r.expiresInSec * 1000
            if let rt = r.refreshToken, rt != cur.refreshToken {
                var next = cur
                next.refreshToken = rt
                store.save(next)
            }
            errorValue = nil
            failures = 0
            retryAt = 0
            return
        } catch let e as PlusApiError {
            if e.status == 400 && PlusSession.FATAL_REFRESH_ERRORS.contains(e.detail) {
                log("refresh: permanent error \(e.detail); signed out")
                store.clear()
                idTokenValue = nil
                idTokenExpiresAt = 0
                accountValue = nil
                errorValue = nil   // signed out, not an error banner
                return
            }
            log("refresh: \(e)")
        } catch {
            log("refresh: \(type(of: error))")
        }
        errorValue = "unreachable"
        failures = min(failures + 1, PlusSession.MAX_ATTEMPTS)
        retryAt = nowMs() + PlusSession.RETRY_DELAY_MS
    }

    /// GET /v1/account. On 401 the ID token is refreshed once and the read retried; a second 401 signs out.
    /// Call from the worker queue.
    public func fetchAccount(_ apiBase: String, refreshUrl: String?, clientTag: String) {
        lock.lock(); defer { lock.unlock() }
        var t = idToken(refreshUrl)
        if t == nil { accountValue = nil; return }
        do {
            accountValue = try PlusApi.fetchAccount(apiBase, idToken: t!, clientTag: clientTag)
        } catch let e as PlusApiError {
            if e.status == 401 {
                t = idTokenUnlocked(refreshUrl)
                guard let token = t else { signOutUnlocked(); return }
                do {
                    accountValue = try PlusApi.fetchAccount(apiBase, idToken: token, clientTag: clientTag)
                    return
                } catch let e2 as PlusApiError {
                    if e2.status == 401 { signOutUnlocked(); return }
                    log("account: \(e2)")
                } catch {
                    log("account: \(type(of: error))")
                }
                errorValue = "unreachable"
                return
            }
            log("account: \(e)")
            errorValue = "unreachable"
        } catch {
            log("account: \(type(of: error))")
            self.errorValue = "unreachable"
        }
    }

    /// Lock held: force a refresh (idToken() with force under the same lock would deadlock on NSLock, so inline it).
    private func idTokenUnlocked(_ refreshUrl: String?) -> String? {
        guard let s = store.load() else { return nil }
        guard let url = refreshUrl else { return idTokenValue }
        refreshOnce(url, s)
        return idTokenValue
    }

    private func signOutUnlocked() {
        store.clear()
        idTokenValue = nil
        idTokenExpiresAt = 0
        accountValue = nil
    }
}

// ── Tickets (PlusTickets.kt) ──

/// relay: the relay ticket. admission: the admission ticket (purpose "device" only).
public struct PlusTicket {
    public var relay: String
    public var admission: String?
}

public enum PlusTickets {
    public static let PURPOSE_DEVICE = "device"
    public static let UNSUPPORTED_MS: Int64 = 5 * 60_000
    private static let PROOF_INFO = "pleiad host proof v1"

    /// b64u(HMAC-SHA256(HKDF(X25519(privateKey, serverPublicKey), "pleiad host proof v1"), nonce ‖ hostId ‖ purpose))
    public static func proof(privateKey: Bytes, hostId: String, nonce: String, serverPublicKey: String, purpose: String) throws -> String {
        guard let server = PairingCodec.b64urlDecode(serverPublicKey), let n = PairingCodec.b64urlDecode(nonce) else {
            throw PairError("couldnt-connect", "ticket")
        }
        let k = Pleiad.hkdfLabel(try X25519.dh(privateKey, server), PROOF_INFO)
        var msg = n
        msg.append(contentsOf: hostId.utf8)
        msg.append(contentsOf: purpose.utf8)
        return PairingCodec.b64urlEncode(hmac(k, msg))
    }

    /// A 404 on the challenge (an api without tickets).
    public struct Unsupported: Error { public let cause404: PlusApiError }

    /**
     * challenge → proof → issue. post(path, body) calls the api with the ID token and throws PlusApiError.
     * A 404 on the challenge (an api without tickets) is rethrown as Unsupported.
     */
    public static func issue(post: (String, JSON) throws -> JSON, purpose: String, keyPair: KeyPair, hostId: String) throws -> PlusTicket {
        let ch: JSON
        do {
            ch = try post("/v1/tickets/challenge", ["purpose": .string(purpose), "publicKey": .string(PairingCodec.b64urlEncode(keyPair.publicKey)), "hostId": .string(hostId)])
        } catch let e as PlusApiError {
            if e.status == 404 { throw Unsupported(cause404: e) }
            throw e
        }
        let p = try proof(privateKey: keyPair.privateKey, hostId: hostId, nonce: ch["nonce"]?.string ?? "",
                          serverPublicKey: ch["serverPublicKey"]?.string ?? "", purpose: purpose)
        let o = try post("/v1/tickets", ["challengeId": .string(ch["challengeId"]?.string ?? ""), "proof": .string(p)])
        guard let relay = o["relay"]?.string, !relay.isEmpty else { throw PlusApiError(502, "bad_response") }
        return PlusTicket(relay: relay, admission: (o["admission"]?.string).flatMap { $0.isEmpty ? nil : $0 })
    }
}

/**
 * Takes tickets. On an api without tickets (the challenge is 404 and the config has no `admission`) returns nil and
 * keeps returning nil for UNSUPPORTED_MS (the caller falls back to the ID token). An api whose config says `admission`
 * issues tickets, so a 404 there is thrown (the host is not registered).
 */
public final class PlusTicketIssuer {
    private let post: (String, JSON) throws -> JSON
    private let admission: () -> Int?
    private let nowMs: () -> Int64
    // links of several hosts ask from their own queues
    private let lock = NSLock()
    private var unsupportedUntilValue: Int64 = 0
    private var unsupportedUntil: Int64 {
        get { lock.lock(); defer { lock.unlock() }; return unsupportedUntilValue }
        set { lock.lock(); unsupportedUntilValue = newValue; lock.unlock() }
    }

    public init(post: @escaping (String, JSON) throws -> JSON, admission: @escaping () -> Int?,
                nowMs: @escaping () -> Int64 = { Int64((Date().timeIntervalSince1970 * 1000).rounded()) }) {
        self.post = post
        self.admission = admission
        self.nowMs = nowMs
    }

    public func issue(_ purpose: String, _ keyPair: KeyPair, _ hostId: String) throws -> PlusTicket? {
        if nowMs() < unsupportedUntil && admission() == nil { return nil }
        do {
            let t = try PlusTickets.issue(post: post, purpose: purpose, keyPair: keyPair, hostId: hostId)
            unsupportedUntil = 0
            return t
        } catch let e as PlusTickets.Unsupported {
            if admission() == nil {
                unsupportedUntil = nowMs() + PlusTickets.UNSUPPORTED_MS
                return nil
            }
            throw e.cause404
        }
    }
}

// ── Host list (PlusHosts.kt) ──

public struct PlusHost {
    public var hostId: String
    public var publicKey: String
    public var name: String
    public var platform: String
    public var online: Bool
    public var lastSeenAt: Int64?
    public var createdAt: Int64?
}

/// One row of the host list. via is the route a tap opens it with (HostRoute); both says the device is paired with the
/// host both ways (own relay and Plus). online is the Plus ledger's word, only when the row opens with Plus.
public struct ListedHost {
    public var record: HostRecord?
    public var plus: PlusHost?
    public var via: String
    public var online: Bool?
    public var both: Bool
}

/**
 * Combines the saved pairings and the current account list into one row per host. A host paired both ways stays one row
 * (approved 2026-10-21): it opens with Plus while the PC is online on the Plus ledger, else with the own relay
 * (connectedVia: the route of a host window that is connected now, which it keeps).
 *
 * ledgerRead: listed is the Plus ledger read just now (GET /v1/hosts succeeded). A saved Plus pairing whose host is no
 * longer on it is not listed (a host also paired with the own relay stays as its own-relay row), and gone names those
 * records so the caller forgets them. When the read failed, listed is only the last known list, so saved rows stay.
 */
public enum PlusHostList {
    /// Saved Plus pairings whose host the ledger read just now no longer lists.
    public static func gone(_ saved: [HostRecord], _ listed: [PlusHost]) -> [HostRecord] {
        let ids = Set(listed.map(\.hostId))
        return saved.filter { $0.via == "plus" && !ids.contains($0.hostId) }
    }

    public static func combine(_ saved: [HostRecord], _ listed: [PlusHost], _ available: Bool,
                               _ connectedVia: [String: String] = [:], _ ledgerRead: Bool = false) -> [ListedHost] {
        let dropped: Set<HostRecord> = (available && ledgerRead) ? Set(gone(saved, listed)) : []
        let kept = saved.filter { !dropped.contains($0) }
        let savedById = Dictionary(grouping: kept, by: \.hostId)
        // a duplicate hostId keeps the last row, like associateBy (uniqueKeysWithValues traps on duplicates)
        let listedById = available ? Dictionary(listed.map { ($0.hostId, $0) }, uniquingKeysWith: { _, b in b }) : [:]
        var ids = [String]()
        var seen = Set<String>()
        for h in kept where seen.insert(h.hostId).inserted { ids.append(h.hostId) }
        for h in listed where available && seen.insert(h.hostId).inserted { ids.append(h.hostId) }
        return ids.compactMap { id in
            let rows = savedById[id] ?? []
            let plusRecord = rows.first { $0.via == "plus" }
            let ownRecord = rows.first { $0.via == "own" }
            let plus = listedById[id]
            if available && (plusRecord != nil || plus != nil) {
                let via = HostRoute.choose(hasOwn: ownRecord != nil, hasPlus: true, plusOnline: plus?.online, connectedVia: connectedVia[id]) ?? "plus"
                return ListedHost(record: via == "own" ? ownRecord : (plusRecord ?? ownRecord), plus: plus, via: via,
                                  online: via == "plus" ? plus?.online : nil, both: ownRecord != nil)
            }
            if let ownRecord { return ListedHost(record: ownRecord, plus: nil, via: "own", online: nil, both: false) }
            return nil
        }
    }
}

// ── Admission (PlusAdmission.kt) ──

/**
 * Connection to a listed host: prove the account identity inside the encrypted IK handshake (ADR 0248).
 * With a ticket (docs/plus.md "Tickets") the relay gets the relay ticket and message 1 carries the admission ticket;
 * without one (an api that has no tickets yet) both carry the ID token.
 * The account alone does not admit a key. mode "admit" (background reconnect) only works for a key the host
 * already allowed; mode "pair" (the person picked the host) goes to the approval window on the host's screen
 * with the same confirmation code as the QR pairing.
 */
public enum PlusAdmission {
    public static let WAIT_MS = 20_000
    public static let MODE_ADMIT = "admit"
    public static let MODE_PAIR = "pair"

    static func publicKey(_ host: PlusHost) throws -> Bytes {
        let key = PairingCodec.b64urlDecode(host.publicKey) ?? Bytes()
        guard key.count == 32, host.hostId == (try? Pleiad.hostIdFor(key)) else { throw PairError("couldnt-connect", "host-key") }
        return key
    }

    /// Nil means wait 60 seconds and make the one permitted retry.
    static func deniedCode(_ reason: String, _ attempt: Int) -> String? {
        switch reason {
        case "account": return "plus-no-relay"
        case "devices": return "plus-limit"
        case "rate": return attempt == 0 ? nil : "plus-connecting"
        case "unavailable": return "unreachable"
        case "approval": return "plus-reapprove"      // the host has not allowed this key (or wants it allowed again)
        case "revoked": return "revoked"
        case "rejected": return "denied"
        case "update_required": return "plus-update"  // the host takes tickets only
        default: return "couldnt-connect"
        }
    }

    /**
     * A failed ticket issue, told like the relay's close reasons: 426 → update the app; 404 / 403 host_removed → the host
     * is not on the account (any more; 4401 'host'); 403 account_disabled / not_plus → the account cannot use the relay
     * (4401 'account'); 503 → Plus is paused (4401 'plus unavailable'); else unreachable.
     */
    public static func ticketError(_ e: PlusApiError) -> PairError {
        if e.status == 426 { return PairError("plus-update", e.code) }
        if e.status == 404 || (e.status == 403 && e.code == "host_removed") { return PairError("unknown-host", e.code) }
        if e.status == 403 && (e.code == "account_disabled" || e.code == "not_plus") { return PairError("plus-no-relay", e.code) }
        if e.status == 503 { return PairError("plus-paused", e.code) }
        return PairError("unreachable", "ticket-\(e.status)")
    }

    /// The relay closed during the handshake: 4401 'update required' means the relay takes tickets only.
    static func handshakeClosed(_ code: Int, _ reason: String) -> PairError {
        if code == 4401 && reason == "update required" { return PairError("plus-update", "relay", closeCode: code) }
        return PairError("couldnt-connect", "handshake", closeCode: code)
    }

    /**
     * mode "pair": after the handshake the host answers { waiting }; onCode(6 digits) is called and this waits
     * (up to the pairing TTL) for the person on the host's screen. handle.cancel() aborts (PairError("aborted")).
     * ticket: a fresh ticket per try (a ticket is used once). Nil result: the api has no tickets yet (ID token).
     */
    public static func admit(host: PlusHost, relayUrl: String, idToken: String?, keyPair: KeyPair, name: String, app: String,
                             connectTimeoutMs: Int = 15_000, sleepMs: (Int) -> Void = { Thread.sleep(forTimeInterval: Double($0) / 1000) },
                             mode: String = MODE_ADMIT, onCode: (String) -> Void = { _ in }, handle: Pairing? = nil,
                             pairTimeoutMs: Int = PAIRING_TTL_MS + 30_000,
                             ticket: (() throws -> PlusTicket?)? = nil) throws -> HostCreds {
        let key = try publicKey(host)
        let pairing = mode == MODE_PAIR
        let cancelled = { handle?.cancelled == true }
        for attempt in 0..<2 {
            if cancelled() { throw PairError("aborted") }
            let t: PlusTicket?
            do {
                t = try ticket?()
            } catch let e as PlusApiError {
                throw ticketError(e)
            } catch let e as PairError {
                throw e
            } catch {
                throw PairError("unreachable", "ticket")
            }
            if t == nil && (idToken ?? "").isEmpty { throw PairError("plus-signed-out") }
            let proof: JSON
            if let t {
                guard let adm = t.admission else { throw PairError("couldnt-connect", "ticket") }
                proof = ["ticket": .string(adm)]
            } else {
                proof = ["idToken": .string(idToken!)]
            }
            let headers: [String: String] = t != nil
                ? ["x-pleiad-host": host.hostId, "x-pleiad-ticket": t!.relay]
                : ["x-pleiad-host": host.hostId, "x-pleiad-account": idToken!]
            if cancelled() { throw PairError("aborted") }
            let sock = RelaySocket(url: try PairingCodec.relayWsUrl(relayUrl, "/v1/device"), headers: headers, openTimeoutMs: connectTimeoutMs)
            handle?.socket = sock
            if cancelled() { sock.terminate() }
            defer {
                handle?.socket = nil
                if sock.closed == nil { sock.close(1000) } else { sock.terminate() }
            }
            do {
                let opened = sock.awaitOpen()
                if cancelled() { throw PairError("aborted") }
                if !opened.open { throw PairError("unreachable", opened.status.map(String.init) ?? "") }
                let hs = try Handshake(.IK, initiator: true, prologue: Pleiad.prologueFor(host.hostId), staticKey: keyPair, remoteStatic: key)
                let hello: JSON = ["proto": 1, "name": .string(PairingCodec.cleanLabel(name)), "platform": "ios",
                                   "app": .string(app), "plus": proof]
                _ = sock.send(try hs.writeMessage(hello.data))
                do {
                    _ = try hs.readMessage(try sock.next(connectTimeoutMs))
                } catch let e as RelayClosed {
                    // the relay did not take the ticket: take a fresh one and try once more
                    if t != nil && e.code == 4401 && e.reason == "ticket" && attempt == 0 { continue }
                    throw handshakeClosed(e.code, e.reason ?? "")
                } catch {
                    throw PairError("couldnt-connect", "handshake")
                }
                let transport = try hs.split()
                let code = try Pleiad.confirmationCode(hs.handshakeHash)
                let admitType: JSON = ["type": .string(pairing ? MODE_PAIR : MODE_ADMIT)]
                _ = sock.send(try transport.encrypt(admitType.data))
                let read = { (waitMs: Int) throws -> JSON in
                    do {
                        return try JSON.parse(try transport.decrypt(try sock.next(waitMs)))
                    } catch let e as RelayClosed {
                        if cancelled() { throw PairError("aborted") }
                        throw PairError("couldnt-connect", "closed-\(e.code)", closeCode: e.code)
                    } catch is RelayTimeout {
                        throw PairError(pairing ? "timeout" : "couldnt-connect", "timeout")
                    }
                }
                var reply = try read(WAIT_MS)
                if pairing && reply["type"]?.string == "waiting" {
                    try? onCode(code)
                    reply = try read(pairTimeoutMs)
                }
                switch reply["type"]?.string {
                case "denied":
                    let reason = reply["reason"]?.string ?? ""
                    // the person is waiting on the screen: say "too many requests" now instead of sleeping
                    if pairing && reason == "rate" { throw PairError("rate") }
                    guard let denied = deniedCode(reason, attempt) else { sleepMs(60_000); continue }
                    throw PairError(denied)
                case "expired": throw PairError("expired")
                case "approved":
                    guard let deviceId = reply["deviceId"]?.string, let token = reply["token"]?.string else { throw PairError("couldnt-connect", "bad-response") }
                    return HostCreds(hostId: host.hostId, hostPublicKey: key, relayUrl: relayUrl, deviceId: deviceId, token: token,
                                     hostName: PairingCodec.cleanLabel((reply["hostName"]?.string).flatMap { $0.isEmpty ? nil : $0 } ?? host.name), via: "plus")
                default: throw PairError("couldnt-connect", "bad-response")
                }
            } catch let e as PairError {
                if cancelled() && e.code != "aborted" { throw PairError("aborted") }
                throw e
            }
        }
        throw PairError("plus-connecting")
    }
}
