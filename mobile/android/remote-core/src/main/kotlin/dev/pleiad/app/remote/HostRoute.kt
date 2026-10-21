package dev.pleiad.app.remote

/**
 * Which route (own relay or Pleiad Plus) a host is opened with, when the device has a pairing for it each way
 * (docs/remote.md §8.2, docs/plus.md "Android", approved 2026-10-21). Pure, so the rules are unit-tested.
 *
 * - A host window that is already connected keeps its route (opening it again must not drop that connection).
 * - Otherwise Plus while the PC is online on the Plus ledger, the own relay when it is not (or the ledger is unknown).
 * - A host paired only one way uses that way.
 */
object HostRoute {
    fun choose(hasOwn: Boolean, hasPlus: Boolean, plusOnline: Boolean?, connectedVia: String? = null): String? = when {
        connectedVia == "own" && hasOwn -> "own"
        connectedVia == "plus" && hasPlus -> "plus"
        hasPlus && (plusOnline == true || !hasOwn) -> "plus"
        hasOwn -> "own"
        else -> null
    }

    /** A saved record that can be opened: not revoked, and with device credentials (a Plus label placeholder has none). */
    fun usable(h: HostRecord): Boolean = h.revokedAt == null && h.deviceId.isNotEmpty()

    /**
     * The route to open [hostId] with when nothing on screen chose one (the last host at a launcher start, a tapped
     * notification): [preferred] when that pairing is usable, else own, else Plus. Null when there is no usable pairing.
     */
    fun reopen(hostId: String, hosts: List<HostRecord>, preferred: String?): String? {
        val vias = hosts.filter { it.hostId == hostId && usable(it) }.map { it.via }.toSet()
        return when {
            preferred != null && preferred in vias -> preferred
            "own" in vias -> "own"
            "plus" in vias -> "plus"
            else -> null
        }
    }
}
