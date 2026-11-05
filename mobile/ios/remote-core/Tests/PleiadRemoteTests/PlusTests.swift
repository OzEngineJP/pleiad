// Pleiad Plus の純粋な部分の試験（Android の plus/*Test.kt の iOS 版）。認証の URL/状態・設定・セッション記録・券・一覧。
import XCTest
@testable import PleiadRemote

final class PlusAuthTests: XCTestCase {
    func testChallengeMatchesRfc7636AppendixB() {
        // RFC 7636 appendix B: this verifier must yield this challenge
        XCTAssertEqual("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
                       PlusAuth.challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"))
    }

    private func params(_ url: String) -> [String: String] {
        var q = [String: String]()
        for item in URLComponents(string: url)?.queryItems ?? [] { q[item.name] = item.value ?? "" }
        return q
    }

    func testLoginUrlCarriesPkceAndIosCallback() {
        let url = PlusAuth.loginUrl("https://account.pleiad.dev/login", state: "ST", codeChallenge: "CH", lang: "ja")
        let p = params(url)
        XCTAssertEqual("ios", p["client"])
        XCTAssertEqual("pleiad://auth", p["redirect_uri"])
        XCTAssertEqual("ST", p["state"])
        XCTAssertEqual("CH", p["code_challenge"])
        XCTAssertEqual("S256", p["code_challenge_method"])
        XCTAssertEqual("ja", p["lang"])
        XCTAssertTrue(url.contains("redirect_uri=pleiad://auth"))
    }

    func testLoginUrlFallsBackToEnglish() {
        XCTAssertTrue(PlusAuth.loginUrl("https://x/login", state: "s", codeChallenge: "c", lang: "fr").hasSuffix("lang=en"))
    }

    func testSchemeCallbackYieldsCodeAndState() {
        let cb = PlusAuth.parseCallback("pleiad://auth?code=CODE&state=ST")
        XCTAssertEqual("CODE", cb?.code)
        XCTAssertEqual("ST", cb?.state)
        XCTAssertNil(cb?.error)
    }

    func testCallbackWithErrorIsParsed() {
        let cb = PlusAuth.parseCallback("pleiad://auth?error=access_denied&state=ST")
        XCTAssertEqual("access_denied", cb?.error)
        XCTAssertNil(cb?.code)
    }

    func testUnrelatedLinksAreNotCallbacks() {
        for u in ["https://account.pleiad.dev/app/callback?code=x&state=y",
                  "pleiad://pair?v=1",
                  "pleiad://open?h=x",
                  "pleiad://plus/enable",
                  "http://pleiad/auth?code=x&state=y"] {
            XCTAssertNil(PlusAuth.parseCallback(u), u)
        }
    }

    func testStateMustMatchConstantTime() {
        XCTAssertTrue(PlusAuth.stateMatches("abc", "abc"))
        XCTAssertFalse(PlusAuth.stateMatches("abc", "abd"))
        XCTAssertFalse(PlusAuth.stateMatches("abc", nil))
        XCTAssertFalse(PlusAuth.stateMatches("abc", "abcd"))
    }

    func testPendingExpiresAfterTenMinutes() {
        let now: Int64 = 1_000_000_000
        let p = PlusAuth.Pending(verifier: "v", state: "s", createdAt: now)
        XCTAssertTrue(p.fresh(now))
        XCTAssertTrue(p.fresh(now + PlusAuth.PENDING_TTL_MS))
        XCTAssertFalse(p.fresh(now + PlusAuth.PENDING_TTL_MS + 1))
        // a pending from the "future" (clock moved back) is not trusted either
        XCTAssertFalse(p.fresh(now - 1))
    }

    func testPendingRoundTripsJson() {
        let p = PlusAuth.Pending(verifier: "verifier-1", state: "state-1", createdAt: 42)
        let back = PlusAuth.Pending.parse(p.json.serialized)
        XCTAssertEqual("verifier-1", back?.verifier)
        XCTAssertEqual("state-1", back?.state)
        XCTAssertEqual(42, back?.createdAt)
    }
}

final class PlusConfigTests: XCTestCase {
    private func config(state: String = "on", visibility: String = "optin") -> PlusConfig {
        PlusConfig(state: state, visibility: visibility, tokenProjectId: "test-project", tokenApiKey: "test-api-key",
                   loginUrl: "https://account.pleiad.dev/login", accountUrl: "https://account.pleiad.dev/account",
                   profileUrl: "https://account.pleiad.dev/profile", relayUrl: "wss://relay.pleiad.dev",
                   refreshUrl: "https://securetoken.googleapis.com/v1/token", minClientIOS: "0.32.0")
    }

    func testParsesOnlyTheFieldsTheClientUses() {
        // unknown fields (and a whole extra object) must be ignored, not fail
        let text = """
        {"state":"maintenance","token":{"projectId":"test-project","apiKey":"test-api-key","future":1},
         "urls":{"login":"https://a/login","account":"https://a/account","profile":"https://a/profile",
                 "relay":"wss://r","refresh":"https://f","extra":"x"},
         "minClient":{"desktop":"9.9.9","android":"0.32.0","ios":"0.32.0"},
         "signIn":{"apiKey":"page-only","providers":["google.com"]},"mode":"whatever"}
        """
        let c = PlusConfig.parse(text)
        XCTAssertEqual("maintenance", c?.state)
        XCTAssertEqual("test-project", c?.tokenProjectId)
        XCTAssertEqual("test-api-key", c?.tokenApiKey)
        XCTAssertEqual("https://a/login", c?.loginUrl)
        XCTAssertEqual("wss://r", c?.relayUrl)
        XCTAssertEqual("0.32.0", c?.minClientIOS)
        // nothing from signIn/mode leaks in: there is no place for it in the shape
        XCTAssertNil(c?.json["signIn"])
        XCTAssertNil(c?.json["mode"])
    }

    func testMissingSectionsTolerated() {
        let c = PlusConfig.parse(#"{"state":"off"}"#)
        XCTAssertEqual("off", c?.state)
        XCTAssertNil(PlusConfig.parse("not json"))
    }

    func testVisibilityDefaultsToOptin() {
        // absent or unknown → optin (hidden until the device opts in); only "public" shows the entrance
        XCTAssertEqual("optin", PlusConfig.parse(#"{"state":"on"}"#)?.visibility)
        XCTAssertEqual("optin", PlusConfig.parse(#"{"state":"on","visibility":"beta"}"#)?.visibility)
        XCTAssertEqual("public", PlusConfig.parse(#"{"state":"on","visibility":"public"}"#)?.visibility)
        let c = config(visibility: "public")
        XCTAssertEqual(c.json.serialized, PlusConfig.parse(c.json.serialized)?.json.serialized)
    }

    func testUnreadableFetchFallsBackToLastGood() {
        let saved = config(state: "on")
        XCTAssertEqual(saved.json.serialized, PlusConfig.choose(nil, saved)?.json.serialized)
        let fresh = config(state: "maintenance")
        XCTAssertEqual(fresh.json.serialized, PlusConfig.choose(fresh, saved)?.json.serialized)
        XCTAssertNil(PlusConfig.choose(nil, nil))
    }

    func testRoundTripsThroughJson() {
        let c = config()
        XCTAssertEqual(c.json.serialized, PlusConfig.parse(c.json.serialized)?.json.serialized)
        var v2 = c
        v2.admission = 2
        XCTAssertEqual(v2.json.serialized, PlusConfig.parse(v2.json.serialized)?.json.serialized)
    }

    func testAdmissionIsTheNumberOrAbsent() {
        // a number: the api issues tickets. Absent: an api from before tickets
        XCTAssertEqual(1, PlusConfig.parse(#"{"state":"on","admission":1}"#)?.admission)
        XCTAssertNil(PlusConfig.parse(#"{"state":"on"}"#)?.admission)
        XCTAssertNil(PlusConfig.parse(#"{"state":"on","admission":"2"}"#)?.admission)
        XCTAssertNil(config().json["admission"])
    }

    func testVersionComparesNumerically() {
        XCTAssertTrue(PlusVersion.isOlder("0.32.0", "0.32.10"))
        XCTAssertTrue(PlusVersion.isOlder("0.32.9", "0.32.10"))
        XCTAssertFalse(PlusVersion.isOlder("0.32.10", "0.32.10"))
        XCTAssertFalse(PlusVersion.isOlder("0.32.11", "0.32.10"))
        XCTAssertTrue(PlusVersion.isOlder("0.31.99-99", "0.32.0"))
        XCTAssertEqual(0, PlusVersion.compare("0.32", "0.32.0"))
    }
}

final class PlusSessionStoreTests: XCTestCase {
    private final class MemStore: PlusSession.SessionStore {
        var record: SessionRecord?
        var saves = 0
        var clears = 0
        func load() -> SessionRecord? { record }
        func save(_ r: SessionRecord) { record = r; saves += 1 }
        func clear() { record = nil; clears += 1 }
    }

    private func bundle(_ idToken: String = "id") -> TokenBundle {
        TokenBundle(idToken: idToken, refreshToken: "refresh", expiresAtMs: 9_999_999_999_999, uid: "u1", email: "u@x",
                    tokenProjectId: "test-project", apiKey: "k")
    }

    func testSessionRecordRoundTripsAndDropsTheIdToken() {
        // only the refresh token and the account identity are sealed; the ID token is fetched each time
        let s = PlusSession(store: MemStore())
        s.signIn(bundle())
        let rec = s.record()
        XCTAssertEqual("refresh", rec?.refreshToken)
        XCTAssertEqual("u1", rec?.uid)
        XCTAssertEqual("u@x", rec?.email)
        let back = SessionRecord.parse(rec!.json.serialized)
        XCTAssertEqual(rec?.json.serialized, back?.json.serialized)
        XCTAssertNil(back?.json["idToken"])
    }

    func testSignOutClearsTheSealedRecord() {
        let store = MemStore()
        let s = PlusSession(store: store)
        s.signIn(bundle())
        XCTAssertTrue(s.signedIn())
        s.signOut()
        XCTAssertFalse(s.signedIn())
        XCTAssertNil(store.record)
        XCTAssertEqual(1, store.clears)
    }

    func testDifferentTokenProjectDropsTheSession() {
        let store = MemStore()
        let s = PlusSession(store: store)
        s.signIn(bundle())
        var cfg = PlusConfig(state: "on", visibility: "public", tokenProjectId: "other", tokenApiKey: nil,
                             loginUrl: "", accountUrl: "", profileUrl: "", relayUrl: "", refreshUrl: "", minClientIOS: nil)
        s.onConfig(cfg)
        XCTAssertFalse(s.signedIn())          // the sealed session belonged to the old project: sign in again
        cfg.tokenProjectId = "test-project"
        s.signIn(bundle())
        s.onConfig(cfg)
        XCTAssertTrue(s.signedIn())
    }
}

final class PlusTicketIssuerTests: XCTestCase {
    private func issuer(post: @escaping (String, JSON) throws -> JSON, admission: Int? = nil) -> PlusTicketIssuer {
        PlusTicketIssuer(post: post, admission: { admission })
    }

    func testChallenge404MeansNoTicketsUntilTheCacheExpires() throws {
        var calls = 0
        let t = issuer(post: { _, _ in calls += 1; throw PlusApiError(404, "not_found") })
        XCTAssertNil(try t.issue(PlusTickets.PURPOSE_DEVICE, KeyPair(publicKey: Bytes(repeating: 1, count: 32), privateKey: Bytes(repeating: 2, count: 32)), "h"))
        XCTAssertNil(try t.issue(PlusTickets.PURPOSE_DEVICE, KeyPair(publicKey: Bytes(repeating: 1, count: 32), privateKey: Bytes(repeating: 2, count: 32)), "h"))
        XCTAssertEqual(1, calls)   // the second ask is answered from the "no tickets" memory, not the network
    }

    func testChallenge404ThrowsWhenTheConfigIssuesTickets() {
        // an api whose config says `admission` issues tickets, so a 404 means the host is not registered
        let t = issuer(post: { _, _ in throw PlusApiError(404, "not_found") }, admission: 2)
        XCTAssertThrowsError(try t.issue(PlusTickets.PURPOSE_DEVICE,
                                         KeyPair(publicKey: Bytes(repeating: 1, count: 32), privateKey: Bytes(repeating: 2, count: 32)), "h")) {
            XCTAssertEqual(404, ($0 as? PlusApiError)?.status)
        }
    }

    func testNon404ErrorsPropagate() {
        let t = issuer(post: { _, _ in throw PlusApiError(503, "paused") })
        XCTAssertThrowsError(try t.issue(PlusTickets.PURPOSE_DEVICE,
                                         KeyPair(publicKey: Bytes(repeating: 1, count: 32), privateKey: Bytes(repeating: 2, count: 32)), "h")) {
            XCTAssertEqual(503, ($0 as? PlusApiError)?.status)
        }
    }
}

final class PlusHostListTests: XCTestCase {
    private func record(_ hostId: String, _ via: String, revoked: Bool = false, unpaired: Bool = false) -> HostRecord {
        HostRecord(hostId: hostId, hostName: "PC", label: "", relayUrl: "https://relay.example", hostPublicKey: "key",
                   deviceId: unpaired ? "" : "device", port: 0, pairedAt: 1, lastConnectedAt: nil,
                   revokedAt: revoked ? 2 : nil, via: via, uid: via == "plus" ? "u" : nil)
    }
    private func listed(_ hostId: String, online: Bool = true) -> PlusHost {
        PlusHost(hostId: hostId, publicKey: "key", name: "PC", platform: "linux", online: online,
                 lastSeenAt: nil, createdAt: 1)
    }

    func testCombinesOwnOnlyPlusOnlyAndBoth() {
        XCTAssertEqual("own", PlusHostList.combine([record("h", "own")], [], true).single().via)
        XCTAssertEqual("plus", PlusHostList.combine([], [listed("h")], true).single().via)
        let both = PlusHostList.combine([record("h", "own"), record("h", "plus")], [listed("h")], true).single()
        XCTAssertEqual("plus", both.via)
        XCTAssertEqual(true, both.both)
        XCTAssertEqual(true, both.online)
    }

    // ToBe-A (2026-10-21): 両方の経路でペアリング済みのホストは 1 行で、Plus の台帳でオンラインのあいだだけ Plus で開く。
    func testAHostPairedBothWaysOpensWithPlusOnlyWhileThePcIsOnlineThere() {
        let both = [record("h", "own"), record("h", "plus")]
        XCTAssertEqual("plus", PlusHostList.combine(both, [listed("h")], true).single().via)
        var offline = PlusHostList.combine(both, [listed("h", online: false)], true)
        XCTAssertEqual(1, offline.count)
        XCTAssertEqual("own", offline[0].via)
        XCTAssertEqual("own", PlusHostList.combine(both, [], true).single().via)
        // つながっている窓は、台帳が何と言おうとその経路を保つ。
        XCTAssertEqual("own", PlusHostList.combine(both, [listed("h")], true, ["h": "own"]).single().via)
        XCTAssertEqual("plus", PlusHostList.combine(both, [listed("h", online: false)], true, ["h": "plus"]).single().via)
    }

    // Plus の台帳（いま読んだ GET /v1/hosts）から外れた PC は一覧から外れ、残った Plus のペアリングは忘れる。
    func testAPlusOnlyHostGoneFromTheLedgerLeavesTheList() {
        let saved = [record("h", "plus")]
        XCTAssertEqual(0, PlusHostList.combine(saved, [], true, [:], true).count)
        XCTAssertEqual(saved, PlusHostList.gone(saved, []))
        // 台帳にまだ居る: 残す。忘れるものは無い。
        XCTAssertEqual(1, PlusHostList.combine(saved, [listed("h")], true, [:], true).count)
        XCTAssertEqual([], PlusHostList.gone(saved, [listed("h")]))
    }

    // 読みに失敗したとき: 最後に取れた一覧（または空）は台帳の言葉ではないので、保存済みの Plus の行は残る。
    func testAFailedLedgerReadKeepsSavedPlusRows() {
        let row = PlusHostList.combine([record("h", "plus")], [], true, [:], false).single()
        XCTAssertEqual("plus", row.via)
    }

    // 自分の中継ともペアリング済み: そのホストは自分の中継の行として残り、Plus の記録だけが消える。
    func testAHostAlsoPairedWithTheOwnRelayStaysAsItsOwnRow() {
        let saved = [record("h", "own"), record("h", "plus")]
        let row = PlusHostList.combine(saved, [], true, ["h": "plus"], true).single()
        XCTAssertEqual("own", row.via)
        XCTAssertEqual("own", row.record?.via)
        XCTAssertEqual(false, row.both)
        XCTAssertNil(row.plus)
        XCTAssertEqual([record("h", "plus")], PlusHostList.gone(saved, []))
    }

    func testFailedListCanUseLastKnownPlusRowsAndUnavailableAccountHidesThem() {
        XCTAssertEqual(1, PlusHostList.combine([record("h", "plus")], [listed("h")], true).count)
        XCTAssertEqual(0, PlusHostList.combine([record("h", "plus")], [listed("h")], false).count)
        let own = PlusHostList.combine([record("h", "own"), record("h", "plus")], [listed("h")], false).single()
        XCTAssertEqual("own", own.via)
        XCTAssertNil(own.plus)
    }
}

final class HostRouteTests: XCTestCase {
    func testConnectedWindowKeepsItsRoute() {
        XCTAssertEqual("own", HostRoute.choose(hasOwn: true, hasPlus: true, plusOnline: true, connectedVia: "own"))
        XCTAssertEqual("plus", HostRoute.choose(hasOwn: true, hasPlus: true, plusOnline: false, connectedVia: "plus"))
    }

    func testPlusWhileOnlineOnTheLedgerElseOwn() {
        XCTAssertEqual("plus", HostRoute.choose(hasOwn: true, hasPlus: true, plusOnline: true))
        XCTAssertEqual("own", HostRoute.choose(hasOwn: true, hasPlus: true, plusOnline: false))
        XCTAssertEqual("own", HostRoute.choose(hasOwn: true, hasPlus: true, plusOnline: nil))
        // paired only with Plus never falls to own
        XCTAssertEqual("plus", HostRoute.choose(hasOwn: false, hasPlus: true, plusOnline: false))
        XCTAssertNil(HostRoute.choose(hasOwn: false, hasPlus: false, plusOnline: nil))
    }

    private func record(_ via: String, revoked: Bool = false, unpaired: Bool = false) -> HostRecord {
        HostRecord(hostId: "h", hostName: "n", label: "", relayUrl: "https://r", hostPublicKey: "aGVsbG8",
                   deviceId: unpaired ? "" : "d", port: 0, pairedAt: nil, lastConnectedAt: nil,
                   revokedAt: revoked ? 1 : nil, via: via)
    }

    func testReopenPrefersTheSavedRouteWhileUsable() {
        let both = [record("own"), record("plus")]
        XCTAssertEqual("plus", HostRoute.reopen("h", both, "plus"))
        XCTAssertEqual("own", HostRoute.reopen("h", both, "own"))
        XCTAssertEqual("own", HostRoute.reopen("h", both, nil))
        // the saved route's pairing is unusable → the other route, never nothing while one works
        XCTAssertEqual("plus", HostRoute.reopen("h", [record("own", revoked: true), record("plus")], "own"))
        XCTAssertEqual("own", HostRoute.reopen("h", [record("plus", unpaired: true), record("own")], "plus"))
        XCTAssertNil(HostRoute.reopen("h", [record("plus", revoked: true)], nil))
    }
}

final class PlusAdmissionErrorTests: XCTestCase {
    func testTicketErrorMapsLikeRelayCloseReasons() {
        XCTAssertEqual("plus-update", PlusAdmission.ticketError(PlusApiError(426, "update_required")).code)
        XCTAssertEqual("unknown-host", PlusAdmission.ticketError(PlusApiError(404, "x")).code)
        XCTAssertEqual("unknown-host", PlusAdmission.ticketError(PlusApiError(403, "host_removed")).code)
        XCTAssertEqual("plus-no-relay", PlusAdmission.ticketError(PlusApiError(403, "account_disabled")).code)
        XCTAssertEqual("plus-no-relay", PlusAdmission.ticketError(PlusApiError(403, "not_plus")).code)
        XCTAssertEqual("plus-paused", PlusAdmission.ticketError(PlusApiError(503, "x")).code)
        XCTAssertEqual("unreachable", PlusAdmission.ticketError(PlusApiError(500, "x")).code)
    }
}

private extension Array {
    /// Kotlin の single() 相当: ちょうど 1 要素であることも試す。
    func single() -> Element { precondition(count == 1, "expected one element, got \(count)"); return self[0] }
}
