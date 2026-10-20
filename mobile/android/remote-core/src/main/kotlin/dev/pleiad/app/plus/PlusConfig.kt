package dev.pleiad.app.plus

// Pleiad Plus sign-in config: read from GET /v1/auth/config at startup and every 5 min while the app is in front
// (docs/plus.md "Android"). Only the fields the client uses are parsed; unknown fields are ignored.

import org.json.JSONObject

data class PlusConfig(
    val state: String,              // on | maintenance | off
    val tokenProjectId: String?,
    val tokenApiKey: String?,
    val loginUrl: String,
    val accountUrl: String,
    val profileUrl: String,
    val relayUrl: String,
    val refreshUrl: String,
    val minClientAndroid: String?,
) {
    fun toJson(): JSONObject = JSONObject()
        .put("state", state)
        .put("token", JSONObject().put("projectId", tokenProjectId).put("apiKey", tokenApiKey))
        .put(
            "urls",
            JSONObject()
                .put("login", loginUrl)
                .put("account", accountUrl)
                .put("profile", profileUrl)
                .put("relay", relayUrl)
                .put("refresh", refreshUrl),
        )
        .put("minClient", JSONObject().put("android", minClientAndroid))

    companion object {
        fun fromJson(o: JSONObject): PlusConfig {
            val token = o.optJSONObject("token") ?: JSONObject()
            val urls = o.optJSONObject("urls") ?: JSONObject()
            val minClient = o.optJSONObject("minClient") ?: JSONObject()
            return PlusConfig(
                state = o.optString("state", "on").ifEmpty { "on" },
                tokenProjectId = token.optString("projectId").ifEmpty { null },
                tokenApiKey = token.optString("apiKey").ifEmpty { null },
                loginUrl = urls.optString("login"),
                accountUrl = urls.optString("account"),
                profileUrl = urls.optString("profile"),
                relayUrl = urls.optString("relay"),
                refreshUrl = urls.optString("refresh"),
                minClientAndroid = minClient.optString("android").ifEmpty { null },
            )
        }

        fun parse(text: String): PlusConfig? = try {
            fromJson(JSONObject(text))
        } catch (_: Exception) {
            null
        }

        /** The freshly fetched config wins; keep the last good one when the fetch failed. */
        fun choose(fetched: PlusConfig?, saved: PlusConfig?): PlusConfig? = fetched ?: saved
    }
}

object PlusVersion {
    /**
     * Numeric segment-wise compare ("0.32.10" > "0.32.0"; a suffix like "0.32.10-1234" is ignored —
     * the app's versionName is "<version>-<versionCode>").
     */
    fun compare(a: String, b: String): Int {
        val pa = a.substringBefore('-').split('.')
        val pb = b.substringBefore('-').split('.')
        for (i in 0 until maxOf(pa.size, pb.size)) {
            val x = pa.getOrNull(i)?.toLongOrNull() ?: 0L
            val y = pb.getOrNull(i)?.toLongOrNull() ?: 0L
            if (x != y) return if (x < y) -1 else 1
        }
        return 0
    }

    /** True when this build is older than the server's minClient for android. */
    fun isOlder(current: String, min: String): Boolean = compare(current, min) < 0
}
