package dev.pleiad.app.plus

// The Pleiad Plus session: only the refresh token is kept (sealed by the app); the ID token lives in memory and is
// refreshed 5 minutes before it expires. Concurrent asks share one refresh (single-flight). docs/plus.md "Android".

import dev.pleiad.app.remote.Http
import java.io.IOException
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject

/** What the app persists (sealed). The ID token is deliberately not part of it. */
data class SessionRecord(
    val refreshToken: String,
    val uid: String,
    val email: String,
    val tokenProjectId: String,
    val apiKey: String,
    val savedAt: Long,
) {
    fun toJson(): JSONObject = JSONObject()
        .put("refreshToken", refreshToken)
        .put("uid", uid)
        .put("email", email)
        .put("tokenProjectId", tokenProjectId)
        .put("apiKey", apiKey)
        .put("savedAt", savedAt)

    companion object {
        fun fromJson(o: JSONObject): SessionRecord = SessionRecord(
            o.getString("refreshToken"),
            o.getString("uid"),
            o.optString("email"),
            o.optString("tokenProjectId"),
            o.optString("apiKey"),
            o.optLong("savedAt"),
        )

        fun parse(text: String): SessionRecord? = try {
            fromJson(JSONObject(text))
        } catch (_: Exception) {
            null
        }
    }
}

data class PlusAccount(val email: String, val provider: String?, val status: String?, val devicesPerHost: Int?) {
    companion object {
        fun fromJson(o: JSONObject): PlusAccount {
            val limits = o.optJSONObject("limits")
            return PlusAccount(
                o.optString("email"),
                o.optString("provider").ifEmpty { null },
                o.optString("status").ifEmpty { null },
                limits?.let { if (it.has("devicesPerHost")) it.optInt("devicesPerHost") else null },
            )
        }
    }
}

/** The login code exchanged for tokens (POST /v1/auth/token). */
data class TokenBundle(
    val idToken: String,
    val refreshToken: String,
    val expiresAtMs: Long,
    val uid: String,
    val email: String,
    val tokenProjectId: String,
    val apiKey: String,
)

/** An HTTP error from the api (or the token refresh endpoint); `error.message`/`error.code` from the body when present. */
class PlusApiError(val status: Int, val code: String, val detail: String = "") : Exception("http $status $code")

object PlusApi {
    private val JSON = "application/json; charset=utf-8".toMediaType()
    private val FORM = "application/x-www-form-urlencoded".toMediaType()

    private fun body(o: JSONObject) = o.toString().toRequestBody(JSON)

    private fun errorFrom(r: okhttp3.Response): PlusApiError {
        val text = r.body?.string().orEmpty()
        val o = try { JSONObject(text) } catch (_: Exception) { JSONObject() }
        val e = o.optJSONObject("error")
        return PlusApiError(r.code, e?.optString("code") ?: "", e?.optString("message") ?: "")
    }

    private fun getJson(client: OkHttpClient, url: String, headers: Map<String, String> = emptyMap()): JSONObject {
        val req = Request.Builder().url(url).apply { for ((k, v) in headers) header(k, v) }.build()
        client.newCall(req).execute().use { r ->
            if (!r.isSuccessful) throw errorFrom(r)
            return JSONObject(r.body?.string().orEmpty().ifEmpty { "{}" })
        }
    }

    private fun postJson(client: OkHttpClient, url: String, payload: JSONObject, headers: Map<String, String> = emptyMap()): JSONObject {
        val req = Request.Builder().url(url).post(body(payload)).apply { for ((k, v) in headers) header(k, v) }.build()
        client.newCall(req).execute().use { r ->
            if (!r.isSuccessful) throw errorFrom(r)
            return JSONObject(r.body?.string().orEmpty().ifEmpty { "{}" })
        }
    }

    /** GET /v1/auth/config — no auth. Returns null on a body that is not a config; HTTP errors throw. */
    fun fetchConfig(client: OkHttpClient, apiBase: String, clientTag: String): PlusConfig {
        val o = getJson(client, "$apiBase/v1/auth/config", mapOf("X-Pleiad-Client" to clientTag))
        return PlusConfig.fromJson(o)
    }

    /** POST /v1/auth/token — the login code + PKCE verifier for tokens. Throws PlusApiError (e.g. 400 invalid_grant). */
    fun exchangeCode(client: OkHttpClient, apiBase: String, code: String, codeVerifier: String, redirectUri: String, clientTag: String): TokenBundle {
        val o = postJson(
            client,
            "$apiBase/v1/auth/token",
            JSONObject().put("code", code).put("codeVerifier", codeVerifier).put("redirectUri", redirectUri),
            mapOf("X-Pleiad-Client" to clientTag),
        )
        return TokenBundle(
            idToken = o.getString("idToken"),
            refreshToken = o.getString("refreshToken"),
            expiresAtMs = o.getLong("expiresAt"),
            uid = o.getString("uid"),
            email = o.optString("email"),
            tokenProjectId = o.optString("tokenProjectId"),
            apiKey = o.optString("apiKey"),
        )
    }

    data class RefreshResult(val idToken: String, val refreshToken: String?, val expiresInSec: Long)

    /** POST <urls.refresh>?key=<apiKey> — grant_type=refresh_token form (the token endpoint from the config). */
    fun refresh(client: OkHttpClient, refreshUrl: String, apiKey: String, refreshToken: String): RefreshResult {
        val sep = if (refreshUrl.contains('?')) "&" else "?"
        val body = "grant_type=refresh_token&refresh_token=${java.net.URLEncoder.encode(refreshToken, "UTF-8")}"
            .toRequestBody(FORM)
        val req = Request.Builder().url("$refreshUrl${sep}key=${java.net.URLEncoder.encode(apiKey, "UTF-8")}").post(body).build()
        client.newCall(req).execute().use { r ->
            if (!r.isSuccessful) throw errorFrom(r)
            val o = JSONObject(r.body?.string().orEmpty().ifEmpty { "{}" })
            return RefreshResult(
                idToken = o.getString("id_token"),
                refreshToken = o.optString("refresh_token").ifEmpty { null },
                expiresInSec = o.optLong("expires_in"),
            )
        }
    }

    /** GET /v1/account with the ID token. */
    fun fetchAccount(client: OkHttpClient, apiBase: String, idToken: String, clientTag: String): PlusAccount {
        val o = getJson(
            client,
            "$apiBase/v1/account",
            mapOf("Authorization" to "Bearer $idToken", "X-Pleiad-Client" to clientTag),
        )
        return PlusAccount.fromJson(o)
    }
}

/**
 * Keeps the sealed session record and the in-memory ID token. All blocking calls run on the caller's thread
 * (the plugin's worker); `idToken()` is synchronized so concurrent asks share one refresh.
 */
class PlusSession(
    private val store: SessionStore,
    private val client: OkHttpClient = Http.client,
    private val nowMs: () -> Long = { System.currentTimeMillis() },
    private val sleepMs: (Long) -> Unit = { Thread.sleep(it) },
    private val log: (String) -> Unit = {},
) {
    interface SessionStore {
        fun load(): SessionRecord?
        fun save(r: SessionRecord)
        fun clear()
    }

    companion object {
        const val EXPIRY_MARGIN_MS = 5 * 60 * 1000L      // refresh this long before the ID token expires
        const val RETRY_DELAY_MS = 60 * 1000L            // between refresh retries on network errors / 5xx
        const val MAX_ATTEMPTS = 5                       // total tries before giving up until the next screen poke
        val FATAL_REFRESH_ERRORS = setOf("TOKEN_EXPIRED", "USER_DISABLED", "USER_NOT_FOUND", "INVALID_REFRESH_TOKEN")
    }

    @Volatile private var idToken: String? = null
    @Volatile private var idTokenExpiresAt: Long = 0
    @Volatile var account: PlusAccount? = null
        private set

    /** "failed" (the login itself failed) | "unreachable" | "relogin" | null. */
    @Volatile var error: String? = null
        private set

    /** Set when the retry budget was spent; only a UI poke (force) tries again. */
    @Volatile private var exhausted = false

    fun record(): SessionRecord? = store.load()

    fun signedIn(): Boolean = store.load() != null

    /**
     * Called whenever the (fresh or last-good) config is applied: a session sealed under a different token project is
     * dropped once and the user is asked to sign in again.
     */
    fun onConfig(config: PlusConfig?) {
        val s = store.load() ?: return
        val pid = config?.tokenProjectId ?: return
        if (pid != s.tokenProjectId) {
            signOut()
            error = "relogin"
        }
    }

    fun signIn(t: TokenBundle) {
        store.save(SessionRecord(t.refreshToken, t.uid, t.email, t.tokenProjectId, t.apiKey, nowMs()))
        idToken = t.idToken
        idTokenExpiresAt = t.expiresAtMs
        error = null
        exhausted = false
    }

    fun signOut() {
        store.clear()
        idToken = null
        idTokenExpiresAt = 0
        account = null
    }

    /** The current ID token; refreshes when it expires within [EXPIRY_MARGIN_MS]. Null when signed out. */
    @Synchronized
    fun idToken(refreshUrl: String?, force: Boolean = false): String? {
        val s = store.load() ?: return null
        val t = idToken
        if (!force && t != null && idTokenExpiresAt - nowMs() > EXPIRY_MARGIN_MS) return t
        if (exhausted && !force) return t // retry budget spent: hand back what we have until a UI poke
        val url = refreshUrl ?: return t
        refreshWithRetry(url, s)
        return idToken
    }

    private fun refreshWithRetry(refreshUrl: String, first: SessionRecord) {
        var cur = first
        repeat(MAX_ATTEMPTS) { attempt ->
            try {
                val r = PlusApi.refresh(client, refreshUrl, cur.apiKey, cur.refreshToken)
                idToken = r.idToken
                idTokenExpiresAt = nowMs() + r.expiresInSec * 1000
                if (r.refreshToken != null && r.refreshToken != cur.refreshToken) {
                    cur = cur.copy(refreshToken = r.refreshToken)
                    store.save(cur)
                }
                error = null
                exhausted = false
                return
            } catch (e: PlusApiError) {
                if (e.status == 400 && e.detail in FATAL_REFRESH_ERRORS) {
                    log("refresh: permanent error ${e.detail}; signed out")
                    signOut()
                    error = null // signed out, not an error banner
                    return
                }
                log("refresh: http ${e.status} ${e.code}".trim())
                error = "unreachable"
            } catch (e: IOException) {
                log("refresh: network error")
                error = "unreachable"
            } catch (e: Exception) {
                log("refresh: ${e.javaClass.simpleName}")
                error = "unreachable"
            }
            if (attempt < MAX_ATTEMPTS - 1) sleepMs(RETRY_DELAY_MS)
        }
        exhausted = true
    }

    /**
     * GET /v1/account. On 401 the ID token is refreshed once and the read retried; a second 401 signs out.
     * Call from the worker thread.
     */
    @Synchronized
    fun fetchAccount(apiBase: String, refreshUrl: String?, clientTag: String) {
        var t = idToken(refreshUrl) ?: run { account = null; return }
        try {
            account = PlusApi.fetchAccount(client, apiBase, t, clientTag)
        } catch (e: PlusApiError) {
            if (e.status == 401) {
                t = idToken(refreshUrl, force = true) ?: run { signOut(); return }
                try {
                    account = PlusApi.fetchAccount(client, apiBase, t, clientTag)
                    return
                } catch (e2: PlusApiError) {
                    if (e2.status == 401) { signOut(); return }
                    log("account: http ${e2.status} ${e2.code}".trim())
                    error = "unreachable"
                    return
                } catch (e2: Exception) {
                    log("account: ${e2.javaClass.simpleName}")
                    error = "unreachable"
                    return
                }
            }
            log("account: http ${e.status} ${e.code}".trim())
            error = "unreachable"
        } catch (e: Exception) {
            log("account: ${e.javaClass.simpleName}")
            error = "unreachable"
        }
    }
}
