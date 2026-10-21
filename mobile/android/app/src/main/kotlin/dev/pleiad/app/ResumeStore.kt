package dev.pleiad.app

import android.content.Context

/**
 * The host the user was in last, so a launcher start opens it instead of the host list (ResumePolicy, docs/remote.md §8.2).
 * Only the host id and the route it was open with (own / plus; no secret). Set when a host window opens; forgotten when
 * the user goes back to the list or removes the host.
 */
class ResumeStore(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences("resume", Context.MODE_PRIVATE)

    fun hostId(): String? = prefs.getString(KEY, null)

    /** The route the saved host was open with (null when saved before routes were kept). */
    fun via(): String? = prefs.getString(VIA, null)

    fun remember(hostId: String, via: String) {
        prefs.edit().putString(KEY, hostId).putString(VIA, via).apply()
    }

    /** Forget the saved host: any (hostId = null) or only if it is [hostId]. */
    fun forget(hostId: String? = null) {
        if (hostId == null || prefs.getString(KEY, null) == hostId) prefs.edit().remove(KEY).remove(VIA).apply()
    }

    private companion object {
        const val KEY = "hostId"
        const val VIA = "via"
    }
}
