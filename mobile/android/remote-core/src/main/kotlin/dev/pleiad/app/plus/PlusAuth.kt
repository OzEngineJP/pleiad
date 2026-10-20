package dev.pleiad.app.plus

// Pleiad Plus sign-in for Android: the login page opens in a Custom Tab with PKCE (RFC 7636), and the app comes back
// through an App Link on https://account.pleiad.dev/app/callback — or, on builds whose App Link is not verified, the
// fallback pleiad://auth the page offers (docs/plus.md "Android").

import java.net.URI
import java.net.URLDecoder
import java.net.URLEncoder
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64
import org.json.JSONObject

object PlusAuth {
    /** How long a pending login attempt stays valid while the Custom Tab is open. */
    const val PENDING_TTL_MS = 10 * 60 * 1000L

    /** The redirect_uri sent to the login page — also used as the token exchange's redirectUri on either way back. */
    const val CALLBACK_URL = "https://account.pleiad.dev/app/callback"

    /** The fallback way back when the App Link cannot be verified (page shows "back to the app" as pleiad://auth?…). */
    const val FALLBACK_URL = "pleiad://auth"

    fun b64url(b: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(b)

    fun randomToken(random: SecureRandom = SecureRandom()): String {
        val b = ByteArray(32)
        random.nextBytes(b)
        return b64url(b)
    }

    /** base64url(SHA-256(verifier)) — RFC 7636 §4.2, no padding. */
    fun challenge(verifier: String): String =
        b64url(MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray(Charsets.US_ASCII)))

    /** <login>?client=android&redirect_uri=…&state=…&code_challenge=…&code_challenge_method=S256&lang=<ja|en> */
    fun loginUrl(loginBase: String, state: String, codeChallenge: String, lang: String): String {
        val enc = { s: String -> URLEncoder.encode(s, "UTF-8").replace("+", "%20") }
        val l = if (lang.lowercase().startsWith("ja")) "ja" else "en"
        return "$loginBase?client=android&redirect_uri=${enc(CALLBACK_URL)}&state=${enc(state)}" +
            "&code_challenge=${enc(codeChallenge)}&code_challenge_method=S256&lang=$l"
    }

    /** The in-flight login attempt, kept (sealed) so a return link still matches after the process was killed. */
    data class Pending(val verifier: String, val state: String, val createdAt: Long) {
        fun toJson(): JSONObject =
            JSONObject().put("verifier", verifier).put("state", state).put("createdAt", createdAt)

        fun fresh(now: Long): Boolean = now - createdAt in 0..PENDING_TTL_MS

        companion object {
            fun fromJson(o: JSONObject): Pending =
                Pending(o.getString("verifier"), o.getString("state"), o.getLong("createdAt"))

            fun parse(text: String): Pending? = try {
                fromJson(JSONObject(text))
            } catch (_: Exception) {
                null
            }
        }
    }

    data class Callback(val code: String?, val state: String?, val error: String?)

    /** Both ways back: the verified App Link and the page's pleiad://auth fallback. */
    fun isAuthCallback(url: String): Boolean {
        val u = parse(url) ?: return false
        return (u.scheme == "https" && u.host == "account.pleiad.dev" && u.path == "/app/callback") ||
            (u.scheme == "pleiad" && u.host == "auth")
    }

    fun parseCallback(url: String): Callback? {
        val u = parse(url) ?: return null
        if (!isAuthCallback(url)) return null
        val q = query(u)
        return Callback(q["code"], q["state"], q["error"])
    }

    /** Constant-time state compare (the pending value is the expected one). */
    fun stateMatches(expected: String, actual: String?): Boolean {
        if (actual == null) return false
        return MessageDigest.isEqual(
            expected.toByteArray(Charsets.UTF_8),
            actual.toByteArray(Charsets.UTF_8),
        )
    }

    private fun parse(url: String): URI? = try {
        URI(url)
    } catch (_: Exception) {
        null
    }

    private fun query(u: URI): Map<String, String> {
        val out = LinkedHashMap<String, String>()
        for (part in (u.rawQuery ?: "").split('&')) {
            if (part.isEmpty()) continue
            val i = part.indexOf('=')
            val k = URLDecoder.decode(if (i < 0) part else part.substring(0, i), "UTF-8")
            val v = if (i < 0) "" else URLDecoder.decode(part.substring(i + 1), "UTF-8")
            if (k !in out) out[k] = v
        }
        return out
    }
}
