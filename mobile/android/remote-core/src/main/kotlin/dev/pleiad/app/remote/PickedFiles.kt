package dev.pleiad.app.remote

/**
 * The uris a host page's file input gets back from the system picker's answer (docs/remote.md §8.2, attachments).
 * Pure: the activity passes the pieces of android.content.Intent / ClipData as [T], so no Android type leaks in
 * and the JVM tests use strings.
 *
 * Why not FileChooserParams.parseResult: a multiple choice arrives in the answer intent's ClipData while its
 * getData() stays null, and some WebView versions' parseResult reads only getData(), so picking several files
 * reached the page as a cancel (2026-10). A single pick may arrive either way.
 */
object PickedFiles {
    /**
     * [ok] = the picker's resultCode was RESULT_OK. [clip] = the uris in the answer intent's ClipData, in order
     * (empty when there is no ClipData); null items are dropped, and when none remain the answer is treated as a
     * single pick. [single] = the intent's getData(). Null = canceled / nothing picked.
     */
    fun <T : Any> of(ok: Boolean, clip: List<T?>, single: T?): List<T>? {
        if (!ok) return null
        val uris = clip.filterNotNull()
        if (uris.isNotEmpty()) return uris
        return single?.let { listOf(it) }
    }
}
