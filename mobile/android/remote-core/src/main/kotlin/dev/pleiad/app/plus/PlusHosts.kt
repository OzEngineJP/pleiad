package dev.pleiad.app.plus

import dev.pleiad.app.remote.HostRecord
import dev.pleiad.app.remote.HostRoute

data class PlusHost(
    val hostId: String,
    val publicKey: String,
    val name: String,
    val platform: String,
    val online: Boolean,
    val lastSeenAt: Long?,
    val createdAt: Long?,
)

/**
 * One row of the host list. [via] is the route a tap opens it with (HostRoute); [both] says the device is paired with the
 * host both ways (own relay and Plus). [online] is the Plus ledger's word, only when the row opens with Plus.
 */
data class ListedHost(val record: HostRecord?, val plus: PlusHost?, val via: String, val online: Boolean?, val both: Boolean = false)

/**
 * Combines the saved pairings and the current account list into one row per host. A host paired both ways stays one row
 * (approved 2026-10-21): it opens with Plus while the PC is online on the Plus ledger, else with the own relay
 * ([connectedVia]: the route of a host window that is connected now, which it keeps).
 */
object PlusHostList {
    fun combine(saved: List<HostRecord>, listed: List<PlusHost>, available: Boolean, connectedVia: Map<String, String> = emptyMap()): List<ListedHost> {
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
                available && (plusRecord != null || plus != null) -> {
                    val via = HostRoute.choose(ownRecord != null, true, plus?.online, connectedVia[id]) ?: "plus"
                    ListedHost(if (via == "own") ownRecord else plusRecord ?: ownRecord, plus, via, if (via == "plus") plus?.online else null, ownRecord != null)
                }
                ownRecord != null -> ListedHost(ownRecord, null, "own", null)
                else -> null
            }
        }
    }
}
