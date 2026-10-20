package dev.pleiad.app

// Pleiad Plus persistence (docs/plus.md "Android"). SharedPreferences "plus":
//   config  — the last /v1/auth/config the api returned (plain JSON; nothing secret in it)
//   pending — the in-flight login's verifier/state, sealed with the Keystore (survives the Custom Tab)
//   session — the session record, sealed with the Keystore. Only the refresh token is kept; the ID token never is.

import android.content.Context
import android.util.Base64
import dev.pleiad.app.plus.PlusAuth
import dev.pleiad.app.plus.PlusConfig
import dev.pleiad.app.plus.PlusSession
import dev.pleiad.app.plus.SessionRecord
import org.json.JSONObject

class PlusStore(context: Context) {
    private val prefs = context.getSharedPreferences("plus", Context.MODE_PRIVATE)
    private val cipher = KeystoreCipher("pleiad-account-session")

    fun config(): PlusConfig? = prefs.getString("config", null)?.let(PlusConfig::parse)

    fun saveConfig(c: PlusConfig) {
        prefs.edit().putString("config", c.toJson().toString()).apply()
    }

    private fun seal(o: JSONObject): String =
        Base64.encodeToString(cipher.seal(o.toString().toByteArray(Charsets.UTF_8)), Base64.NO_WRAP)

    private fun unseal(s: String?): JSONObject? {
        if (s == null) return null
        return try {
            JSONObject(String(cipher.open(Base64.decode(s, Base64.DEFAULT)), Charsets.UTF_8))
        } catch (_: Exception) {
            null
        }
    }

    fun pending(): PlusAuth.Pending? = unseal(prefs.getString("pending", null))?.let {
        try {
            PlusAuth.Pending.fromJson(it)
        } catch (_: Exception) {
            null
        }
    }

    fun savePending(p: PlusAuth.Pending) {
        prefs.edit().putString("pending", seal(p.toJson())).apply()
    }

    fun clearPending() {
        prefs.edit().remove("pending").apply()
    }

    fun sessionStore(): PlusSession.SessionStore = object : PlusSession.SessionStore {
        override fun load(): SessionRecord? = unseal(prefs.getString("session", null))?.let {
            try {
                SessionRecord.fromJson(it)
            } catch (_: Exception) {
                null
            }
        }

        override fun save(r: SessionRecord) {
            prefs.edit().putString("session", seal(r.toJson())).apply()
        }

        override fun clear() {
            prefs.edit().remove("session").apply()
        }
    }
}
