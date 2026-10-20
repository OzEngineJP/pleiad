package dev.pleiad.app.plus

import dev.pleiad.app.remote.HostRecord

data class PlusHost(
    val hostId: String,
    val publicKey: String,
    val name: String,
    val platform: String,
    val online: Boolean,
    val lastSeenAt: Long?,
    val createdAt: Long?,
)

data class ListedHost(val record: HostRecord?, val plus: PlusHost?, val via: String, val online: Boolean?)

/** Combines the saved pairings and the current account list into one row per host. */
object PlusHostList {
    fun combine(saved: List<HostRecord>, listed: List<PlusHost>, available: Boolean): List<ListedHost> {
        val savedById = saved.groupBy { it.hostId }
        val listedById = if (available) listed.associateBy { it.hostId } else emptyMap()
        val ids = LinkedHashSet<String>()
        saved.forEach { ids.add(it.hostId) }
        listed.forEach { if (available) ids.add(it.hostId) }
        return ids.mapNotNull { id ->
            val rows = savedById[id].orEmpty()
            val plusRecord = rows.firstOrNull { it.via == "plus" }
            val ownRecord = rows.firstOrNull { it.via == "own" }
            val plus = listedById[id]
            when {
                available && (plusRecord != null || plus != null) -> ListedHost(plusRecord ?: ownRecord, plus, if (ownRecord != null) "both" else "plus", plus?.online)
                ownRecord != null -> ListedHost(ownRecord, null, "own", null)
                else -> null
            }
        }
    }
}
