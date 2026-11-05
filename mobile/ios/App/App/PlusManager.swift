// Pleiad Plus のサインイン（docs/plus.md「iOS」。Android の PlusManager.kt）。
// config（起動時と前面のあいだ 5 分ごとに取り、失敗時は最後に取れたもの）、封印した pending/セッション、
// ログインの流れ（ASWebAuthenticationSession + PKCE、pleiad://auth 経由で戻る）を持つ。
// 画面が見るのは stateJson() だけ。ID トークンは Swift の中に留める（currentIdToken() は公式の中継が使う口）。
import Foundation
import PleiadRemote

final class PlusManager {
    private static let TICK_MS: TimeInterval = 5 * 60
    private static let ACCOUNT_MIN_INTERVAL_MS: Int64 = 60 * 1000

    private let store = PlusStore()
    private let session: PlusSession
    private let clientTag: String
    private let apiBase: String
    private let log: (String) -> Void

    private let worker = DispatchQueue(label: "pleiad-plus", qos: .userInitiated)
    private var ticker: DispatchSourceTimer?

    private var config: PlusConfig?
    private var started = false
    private var foreground = false
    private var lastAccountAt: Int64 = 0
    private var flowError: String?
    private var hosts: [PlusHost] = []
    private var hostsError: String?
    var onChanged: (() -> Void)?

    init(apiBase: String = "https://api.pleiad.dev", log: @escaping (String) -> Void = { _ in }) {
        self.apiBase = apiBase
        self.log = log
        let app = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? ""
        self.clientTag = "ios/\(app)"
        self.session = PlusSession(store: store.sessionStore(), log: log)
        self.config = store.config()
    }

    /// 一覧のページ（プラグイン）が載ったときに呼ぶ。WebView が張り直してもよいよう冪等。
    func start() {
        worker.async { [self] in
            if started { emit(); return }
            started = true
            let t = DispatchSource.makeTimerSource(queue: worker)
            t.schedule(deadline: .now() + Self.TICK_MS, repeating: Self.TICK_MS)
            t.setEventHandler { [weak self] in self?.tick() }
            t.resume()
            ticker = t
            refreshConfig()
            if session.signedIn() { fetchAccount() }
            emit()
        }
    }

    func setForeground(_ on: Bool) {
        worker.async { [self] in
            if on == foreground { return }
            foreground = on
            if on {
                refreshConfig()
                if session.signedIn() && now() - lastAccountAt > Self.ACCOUNT_MIN_INTERVAL_MS { fetchAccount() }
                emit()
            }
        }
    }

    private func tick() {
        if !foreground { return }
        do {
            refreshConfig()
            if session.signedIn() {
                _ = session.idToken(config?.refreshUrl)   // 前面のあいだ ID トークンを新しく保つ
                if now() - lastAccountAt > Self.ACCOUNT_MIN_INTERVAL_MS { fetchAccount() }
            }
        } catch {
            log("tick: \(error)")
        }
        emit()
    }

    private func refreshConfig() {
        let fetched = try? PlusApi.fetchConfig(apiBase, clientTag)
        if fetched == nil { log("config: unreachable") }
        config = PlusConfig.choose(fetched, config)
        if let fetched { store.saveConfig(fetched) }
        session.onConfig(config)   // 別のトークンプロジェクトなら封印したセッションを捨てる（再ログイン）
    }

    private func fetchAccount() {
        lastAccountAt = now()
        session.fetchAccount(apiBase, refreshUrl: config?.refreshUrl, clientTag: clientTag)
    }

    // ── ログイン ──

    /// ログインの試行を始めて認証画面の URL を返す（プラグインが ASWebAuthenticationSession で開く）。config 未着なら nil。
    func login(lang: String) -> String? {
        guard let cfg = config, !cfg.loginUrl.isEmpty else { return nil }
        let pending = PlusAuth.Pending(verifier: PlusAuth.b64url(randomBytes(32)), state: PlusAuth.b64url(randomBytes(32)), createdAt: now())
        store.savePending(pending)
        flowError = nil
        emit()
        return PlusAuth.loginUrl(cfg.loginUrl, state: pending.state, codeChallenge: PlusAuth.challenge(pending.verifier), lang: lang)
    }

    /// pleiad://auth の戻り。worker で回る; ページが無いうちに来てもよい。
    func onAuthLink(_ url: String) {
        worker.async { [self] in
            guard let cb = PlusAuth.parseCallback(url) else { return }
            let pending = store.pending()
            func fail(_ error: String) {
                flowError = error
                store.clearPending()
                emit()
            }
            guard cb.error == nil else { return fail("failed") }
            guard let pending, pending.fresh(now()) else { return fail("failed") }
            guard PlusAuth.stateMatches(pending.state, cb.state) else { return fail("failed") }
            guard let code = cb.code else { return fail("failed") }
            do {
                let t = try PlusApi.exchangeCode(apiBase, code: code, codeVerifier: pending.verifier,
                                                 redirectUri: PlusAuth.CALLBACK_URL, clientTag: clientTag)
                store.clearPending()
                flowError = nil
                session.signIn(t)
                emit()
                fetchAccount()
                emit()
            } catch let e as PlusApiError {
                log("token: http \(e.status) \(e.code)")
                fail(e.status == 400 ? "failed" : "unreachable")
            } catch {
                log("token: \(error)")
                fail("unreachable")
            }
        }
    }

    func logout() {
        worker.async { [self] in
            session.signOut()
            store.clearPending()
            flowError = nil
            emit()
        }
    }

    func profileUrl() -> String? { config.flatMap { $0.profileUrl.isEmpty ? nil : $0.profileUrl } }

    /// Kotlin の呼び出し側（公式の中継）が使う ID トークン。画面には出さない。
    func currentIdToken() -> String? { session.idToken(config?.refreshUrl, force: true) }

    /// 持っている ID トークンを期限ぎりぎりまで使う口（画面の呼び出しが 401 のあと currentIdToken を聞く）。
    func idToken() -> String? { session.idToken(config?.refreshUrl) }

    // 中継とホストの券（docs/plus.md「Tickets」）。ここでは期限ぎりぎりまで使い（接続のたびに券を取るので）、
    // 401 なら新しくしてもう一度だけ聞く。
    private lazy var tickets = PlusTicketIssuer(
        post: { [self] path, body in
            guard let first = session.idToken(config?.refreshUrl) else { throw PairError("plus-signed-out") }
            do {
                return try PlusApi.postAuthed(apiBase, idToken: first, clientTag: clientTag, path: path, payload: body)
            } catch let e as PlusApiError {
                guard e.status == 401 else { throw e }
                guard let again = currentIdToken() else { throw PairError("plus-signed-out") }
                return try PlusApi.postAuthed(apiBase, idToken: again, clientTag: clientTag, path: path, payload: body)
            }
        },
        admission: { [self] in config?.admission }
    )

    /// hostId へこの端末の鍵でつなぐための中継の券と受け入れの券。api に券が無ければ nil（ID トークンを使う）。
    /// PlusApiError（426: アプリを更新）・PairError("plus-signed-out") を投げる。ワーカーで呼ぶ（ブロックする）。
    func deviceTicket(_ hostId: String, keyPair: KeyPair) throws -> PlusTicket? {
        try tickets.issue(PlusTickets.PURPOSE_DEVICE, keyPair, hostId)
    }

    /// [read]: [hosts] はいま読んだ台帳（PlusHostList.combine の ledgerRead）。失敗時は最後に取れた一覧。
    struct HostsResult {
        var hosts: [PlusHost]
        var error: String?
        var read: Bool = false
    }

    private let hostsLock = NSLock()

    /// アカウントのホスト一覧を取り直す。つながらないときは最後に取れた一覧を返す。
    @discardableResult
    func fetchHosts() -> HostsResult {
        hostsLock.lock(); defer { hostsLock.unlock() }
        let account = session.account
        if config?.state != "on" || account?.status != "plus" {
            hosts = []
            hostsError = nil
            return HostsResult(hosts: [])
        }
        do {
            guard var token = idToken() else { return HostsResult(hosts: hosts, error: "signed-out") }
            let latest: [PlusHost]
            do {
                latest = try PlusApi.fetchHosts(apiBase, idToken: token, clientTag: clientTag)
            } catch let e as PlusApiError {
                guard e.status == 401 else { throw e }
                guard let t = currentIdToken() else {
                    session.signOut(); hosts = []; return HostsResult(hosts: [])
                }
                token = t
                do {
                    latest = try PlusApi.fetchHosts(apiBase, idToken: token, clientTag: clientTag)
                } catch let e2 as PlusApiError {
                    if e2.status == 401 { session.signOut(); hosts = []; return HostsResult(hosts: []) }
                    throw e2
                }
            }
            hosts = latest
            hostsError = nil
            return HostsResult(hosts: latest, read: true)
        } catch let e as PlusApiError {
            if e.status == 403 && (e.code == "not_plus" || e.code == "account_disabled") {
                hosts = []
                hostsError = "no-relay"
                return HostsResult(hosts: [], error: "no-relay")
            }
            log("hosts: http \(e.status) \(e.code)")
            hostsError = "unreachable"
            return HostsResult(hosts: hosts, error: "unreachable")
        } catch {
            log("hosts: \(error)")
            hostsError = "unreachable"
            return HostsResult(hosts: hosts, error: "unreachable")
        }
    }

    func cachedHosts() -> HostsResult { hostsLock.lock(); defer { hostsLock.unlock() }; return HostsResult(hosts: hosts, error: hostsError) }
    func currentRelayUrl() -> String? { config.flatMap { $0.relayUrl.isEmpty ? nil : $0.relayUrl } }
    func currentUid() -> String? { session.record()?.uid }

    /// pleiad://plus/enable|disable: この端末の印を付けて状態を出し直す。
    func setEntrance(_ on: Bool) {
        worker.async { [self] in
            if store.entrance() == on { return }
            store.saveEntrance(on)
            emit()
        }
    }

    // ── 画面に出す状態 ──

    func stateJson() -> JSON {
        let app = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? ""
        // visibility が optin のあいだ、入口はこの端末に印（pleiad://plus/enable）があるときだけ出す
        let visible = config?.visibility == "public" || store.entrance()
        let plus: String
        switch config {
        case nil: plus = visible ? "unknown" : "off"
        case let cfg? where cfg.state == "off" || !visible: plus = "off"
        case let cfg? where cfg.state == "maintenance": plus = "maintenance"
        case let cfg? where cfg.minClientIOS != nil && PlusVersion.isOlder(app, cfg.minClientIOS!): plus = "update"
        default: plus = "on"
        }
        let pending = store.pending()
        let login: String
        if let p = pending, p.fresh(now()) { login = "pending" }
        else if session.signedIn() { login = "in" }
        else { login = "out" }
        let account = session.account
        return [
            "plus": .string(plus),
            "login": .string(login),
            "status": account?.status.map { .string($0) } ?? .null,
            "email": (account?.email).map { .string($0) } ?? session.record().map { .string($0.email) } ?? .null,
            "provider": (account?.provider).map { .string($0) } ?? .null,
            "error": (flowError ?? session.error).map { .string($0) } ?? .null,
        ]
    }

    /// 中継を使えるアカウント（プラグインの list/open が読む）。
    var plusUsable: Bool {
        let s = stateJson()
        return s["plus"]?.string == "on" && s["login"]?.string == "in" && s["status"]?.string == "plus"
    }

    private func emit() { onChanged?() }
    private func now() -> Int64 { Int64((Date().timeIntervalSince1970 * 1000).rounded()) }
}
