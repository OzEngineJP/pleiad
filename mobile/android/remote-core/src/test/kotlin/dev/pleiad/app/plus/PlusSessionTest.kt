package dev.pleiad.app.plus

import com.sun.net.httpserver.HttpServer
import java.net.InetSocketAddress
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** A tiny fake api: records requests and answers whatever `respond` returns. */
private class FakeApi {
    data class Hit(val method: String, val path: String, val query: String?, val body: String, val auth: String?)

    val hits = CopyOnWriteArrayList<Hit>()
    var respond: (Hit) -> Pair<Int, String> = { 200 to "{}" }
    private val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
    val url: String get() = "http://127.0.0.1:${server.address.port}"

    init {
        server.createContext("/") { ex ->
            val body = ex.requestBody.readBytes().toString(Charsets.UTF_8)
            val hit = Hit(ex.requestMethod, ex.requestURI.path, ex.requestURI.rawQuery, body, ex.requestHeaders.getFirst("Authorization"))
            hits.add(hit)
            val (status, text) = respond(hit)
            val bytes = text.toByteArray(Charsets.UTF_8)
            ex.sendResponseHeaders(status, if (bytes.isEmpty()) -1 else bytes.size.toLong())
            if (bytes.isNotEmpty()) ex.responseBody.use { it.write(bytes) }
            ex.close()
        }
        server.start()
    }

    fun stop() = server.stop(0)
}

private class FakeStore : PlusSession.SessionStore {
    var record: SessionRecord? = null
    val saves = CopyOnWriteArrayList<SessionRecord>()
    @Volatile var cleared = false
    override fun load() = record
    override fun save(r: SessionRecord) { record = r; saves.add(r); cleared = false }
    override fun clear() { record = null; cleared = true }
}

private const val TAG = "android/0.1.0-test"

private fun sessionOf(store: FakeStore, sleeps: MutableList<Long> = mutableListOf(), now: () -> Long = { 1_000_000L }) =
    PlusSession(store, nowMs = now, sleepMs = { sleeps.add(it) })

private fun bundle(idToken: String = "id-1", refreshToken: String = "refresh-1", expiresAtMs: Long = 1_000_000L + 3600_000) =
    TokenBundle(idToken, refreshToken, expiresAtMs, uid = "u1", email = "user@example.com", tokenProjectId = "test-project", apiKey = "test-api-key")

class PlusSessionTest {
    private val apis = mutableListOf<FakeApi>()

    @After fun tearDown() = apis.forEach { it.stop() }

    private fun api() = FakeApi().also { apis.add(it) }

    @Test fun exchangeCodePostsVerifierAndReadsTokens() {
        val api = api()
        api.respond = {
            200 to """{"idToken":"id-9","refreshToken":"r-9","expiresAt":1761040000000,"uid":"u9","email":"user@example.com","tokenProjectId":"test-project","apiKey":"test-api-key"}"""
        }
        val t = PlusApi.exchangeCode(dev.pleiad.app.remote.Http.client, api.url, "code-1", "verifier-1", PlusAuth.CALLBACK_URL, TAG)
        assertEquals("id-9", t.idToken)
        assertEquals("r-9", t.refreshToken)
        assertEquals("test-project", t.tokenProjectId)
        val hit = api.hits.single()
        assertEquals("/v1/auth/token", hit.path)
        assertTrue(hit.body.contains(""""code":"code-1""""))
        assertTrue(hit.body.contains(""""codeVerifier":"verifier-1""""))
        assertTrue(hit.body.contains(""""redirectUri":"https://account.pleiad.dev/app/callback""""))
    }

    @Test fun refreshesWhenExpiryIsWithinFiveMinutes() {
        val api = api()
        api.respond = { 200 to """{"id_token":"id-new","refresh_token":"r-1","expires_in":3600}""" }
        val store = FakeStore()
        val s = sessionOf(store)
        s.signIn(bundle(expiresAtMs = 1_000_000L + 4 * 60_000L)) // inside the 5-minute margin
        assertEquals("id-new", s.idToken(api.url))
        val hit = api.hits.single()
        assertTrue(hit.query!!.contains("key=test-api-key"))
        assertTrue(hit.body.contains("grant_type=refresh_token"))
        assertTrue(hit.body.contains("refresh_token=refresh-1"))
    }

    @Test fun noRefreshWhileTokenIsFresh() {
        val api = api()
        val store = FakeStore()
        val s = sessionOf(store)
        s.signIn(bundle(expiresAtMs = 1_000_000L + 6 * 60_000L))
        assertEquals("id-1", s.idToken(api.url))
        assertTrue(api.hits.isEmpty())
    }

    @Test fun concurrentAsksShareOneRefresh() {
        val api = api()
        api.respond = {
            Thread.sleep(150)
            200 to """{"id_token":"id-new","expires_in":3600}"""
        }
        val store = FakeStore()
        val s = sessionOf(store)
        s.signIn(bundle(expiresAtMs = 1_000_000L + 4 * 60_000L))
        val gate = CountDownLatch(1)
        val out = CopyOnWriteArrayList<String?>()
        val threads = (1..3).map {
            Thread { gate.await(); out.add(s.idToken(api.url)) }.apply { start() }
        }
        gate.countDown()
        threads.forEach { it.join(10_000) }
        assertEquals(3, out.size)
        assertTrue(out.all { it == "id-new" })
        assertEquals(1, api.hits.size)
    }

    @Test fun rotatedRefreshTokenIsPersisted() {
        val api = api()
        api.respond = { 200 to """{"id_token":"id-new","refresh_token":"refresh-2","expires_in":3600}""" }
        val store = FakeStore()
        val s = sessionOf(store)
        s.signIn(bundle(expiresAtMs = 1_000_000L + 4 * 60_000L))
        assertEquals("id-new", s.idToken(api.url))
        assertEquals("refresh-2", store.record!!.refreshToken)
    }

    @Test fun fatalRefreshErrorsClearTheSession() {
        for (msg in listOf("TOKEN_EXPIRED", "USER_DISABLED", "USER_NOT_FOUND", "INVALID_REFRESH_TOKEN")) {
            val api = api()
            api.respond = { 400 to """{"error":{"code":400,"message":"$msg"}}""" }
            val store = FakeStore()
            val s = sessionOf(store)
            s.signIn(bundle(expiresAtMs = 1_000_000L + 4 * 60_000L))
            assertNull(msg, s.idToken(api.url))
            assertTrue(msg, store.cleared)
            assertFalse(msg, s.signedIn())
        }
    }

    @Test fun fiveXxRetriesFiveTimesWithOneMinuteGaps() {
        val api = api()
        api.respond = { 503 to "{}" }
        val store = FakeStore()
        val sleeps = mutableListOf<Long>()
        val s = sessionOf(store, sleeps)
        s.signIn(bundle(expiresAtMs = 1_000_000L + 4 * 60_000L))
        s.idToken(api.url)
        assertEquals(5, api.hits.size)
        assertEquals(List(4) { 60_000L }, sleeps)
        assertEquals("unreachable", s.error)
        // the budget is spent: a non-forced ask does not retry
        s.idToken(api.url)
        assertEquals(5, api.hits.size)
        // a UI poke tries again
        s.idToken(api.url, force = true)
        assertEquals(10, api.hits.size)
    }

    @Test fun networkErrorsRetryThenGiveUp() {
        val dead = api().also { it.stop() }.url
        val store = FakeStore()
        val sleeps = mutableListOf<Long>()
        val s = sessionOf(store, sleeps)
        s.signIn(bundle(expiresAtMs = 1_000_000L + 4 * 60_000L))
        s.idToken(dead)
        assertEquals(List(4) { 60_000L }, sleeps)
        assertEquals("unreachable", s.error)
        assertTrue(s.signedIn()) // a network problem does not drop the session
    }

    @Test fun mismatchedTokenProjectClearsSessionOnce() {
        val store = FakeStore()
        val s = sessionOf(store)
        s.signIn(bundle())
        assertTrue(s.signedIn())
        s.onConfig(configWithProject("test-project"))
        assertTrue(s.signedIn()) // same project: untouched
        s.onConfig(configWithProject("other-project"))
        assertTrue(store.cleared)
        assertEquals("relogin", s.error)
    }

    @Test fun storedRecordHasNoIdToken() {
        val store = FakeStore()
        val s = sessionOf(store)
        s.signIn(bundle(idToken = "id-secret"))
        val saved = store.saves.last().toJson()
        assertFalse(saved.has("idToken"))
        assertFalse(saved.toString().contains("id-secret"))
        assertEquals(
            setOf("refreshToken", "uid", "email", "tokenProjectId", "apiKey", "savedAt"),
            saved.keys().asSequence().toSet(),
        )
    }

    @Test fun accountIsRefreshedOnceOn401() {
        val api = api()
        var accountCalls = 0
        api.respond = { hit ->
            when (hit.path) {
                "/v1/account" -> {
                    accountCalls++
                    if (accountCalls == 1) 401 to """{"error":{"code":"unauthenticated","message":"no"}}"""
                    else 200 to """{"email":"user@example.com","provider":"google.com","status":"plus","limits":{"devicesPerHost":8}}"""
                }
                else -> 200 to """{"id_token":"id-new","expires_in":3600}""" // refresh endpoint
            }
        }
        val store = FakeStore()
        val s = sessionOf(store)
        s.signIn(bundle())
        s.fetchAccount(api.url, api.url, TAG)
        assertEquals(2, accountCalls)
        assertEquals("user@example.com", s.account!!.email)
        assertEquals("plus", s.account!!.status)
        assertEquals(8, s.account!!.devicesPerHost)
    }

    @Test fun account401TwiceSignsOut() {
        val api = api()
        api.respond = { hit ->
            if (hit.path == "/v1/account") 401 to """{"error":{"code":"unauthenticated","message":"no"}}"""
            else 200 to """{"id_token":"id-new","expires_in":3600}"""
        }
        val store = FakeStore()
        val s = sessionOf(store)
        s.signIn(bundle())
        s.fetchAccount(api.url, api.url, TAG)
        assertTrue(store.cleared)
    }

    private fun configWithProject(pid: String) = PlusConfig(
        state = "on", tokenProjectId = pid, tokenApiKey = "test-api-key",
        loginUrl = "https://account.pleiad.dev/login", accountUrl = "https://account.pleiad.dev/account",
        profileUrl = "https://account.pleiad.dev/profile", relayUrl = "wss://relay.pleiad.dev",
        refreshUrl = "https://example.com/refresh", minClientAndroid = null,
    )
}
