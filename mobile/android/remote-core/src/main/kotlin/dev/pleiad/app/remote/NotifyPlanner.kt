package dev.pleiad.app.remote

// Decides what the notification shade should look like for each notice (docs/remote.md §11-5, ADR 0086). Pure state
// machine, no Android: the app turns [NotifyAction]s into notifications in its own language.
//
// Rules:
//   - one notification per conversation (a newer notice overwrites it); approvals / questions / failures are separate
//     "needs attention" notifications, completions are plain ones
//   - each completion keeps its own notification; from the second one a per-host bundle ("N conversations finished")
//     sits on top as the group summary. A new completion alerts once: the new child posts quietly and the bundle
//     alerts; every re-count of the bundle (a child opened / seen / overwritten) is quiet, and the bundle goes away
//     when fewer than two completions remain
//   - a cancel (decided somewhere / looked at somewhere) removes the notification; a cancel for a conversation we have no
//     state for (the service restarted since) still cancels, because cancelling a notification that is not there is harmless
//   - notices are applied once, in order: a sequence number not above the last one seen for a host is a replay
//   - the settings are applied again here (the host filters first, but the settings may have changed since)
//   - a device waiting on the host's approval window is its own "needs attention" notification (no conversation, no
//     buttons: it is allowed on the host's screen), removed when the host settles the request

class NotifyPlanner {
    private class Slot(var kind: String, var title: String, var host: String, var at: Long, val ids: MutableSet<String> = LinkedHashSet()) {
        /** Its own notification was posted (completions keep it even while a bundle sits on top). */
        var shown = false
    }

    private class HostState {
        var lastSeq = 0L
        /** session -> slot, oldest first (re-inserted when overwritten). */
        val slots = LinkedHashMap<String, Slot>()
        var bundled = false
        var host = ""
    }

    private val hosts = HashMap<String, HostState>()

    companion object {
        const val MAX_SLOTS = 100
        fun slotKey(hostId: String, session: String) = "$hostId|$session"
        fun bundleKey(hostId: String) = "$hostId|bundle"
        fun deviceKey(hostId: String, id: String) = "$hostId|device:$id"
        private fun attention(kind: String) = kind != NoticeKind.DONE
    }

    @Synchronized
    fun onNotice(n: PushNotice, s: NotifySettings): List<NotifyAction> {
        val h = hosts.getOrPut(n.hostId) { HostState() }
        if (n.seq <= h.lastSeq) return emptyList()
        h.lastSeq = n.seq
        if (n.host.isNotEmpty()) h.host = n.host
        return when (n.kind) {
            NoticeKind.CANCEL -> cancel(h, n)
            NoticeKind.APPROVAL, NoticeKind.QUESTION -> if (s.enabled && s.reply) post(h, n) else emptyList()
            NoticeKind.FAILED, NoticeKind.SCHEDULE_MISSED -> if (s.enabled && s.failed) post(h, n) else emptyList()
            NoticeKind.DONE -> if (s.enabled && s.done) post(h, n) else emptyList()
            NoticeKind.DEVICE -> if (s.enabled && s.reply && n.id != null) listOf(
                NotifyAction.Post(deviceKey(n.hostId, n.id), NoticeKind.DEVICE, n.hostId, h.host, "", n.title, n.at, attention = true),
            ) else emptyList()
            else -> emptyList()
        }
    }

    /**
     * The user opened a notification (tap). [bundle] = the "N conversations finished" one: all completions of the host
     * are acknowledged (their own notifications go too). Otherwise only that conversation's own notification — and the
     * bundle is re-counted.
     */
    @Synchronized
    fun opened(hostId: String, session: String?, bundle: Boolean): List<NotifyAction> {
        val h = hosts[hostId] ?: return emptyList()
        val out = ArrayList<NotifyAction>()
        if (bundle) {
            for ((s, slot) in h.slots.entries.toList()) if (slot.kind == NoticeKind.DONE) { h.slots.remove(s); out += NotifyAction.Cancel(slotKey(hostId, s)) }
            if (h.bundled) { h.bundled = false; out += NotifyAction.Cancel(bundleKey(hostId)) }
            return out
        }
        if (session != null) {
            val removed = h.slots.remove(session)
            if (removed?.kind == NoticeKind.DONE) {
                out += NotifyAction.Cancel(slotKey(hostId, session))
                out += syncDone(h, hostId, alert = false)
            }
        }
        return out
    }

    @Synchronized
    fun reset() { hosts.clear() }

    private fun post(h: HostState, n: PushNotice): List<NotifyAction> {
        val hostId = n.hostId
        val old = h.slots.remove(n.session)
        val slot = Slot(n.kind, n.title, h.host, n.at)
        if (attention(n.kind) && n.kind != NoticeKind.FAILED && n.kind != NoticeKind.SCHEDULE_MISSED) {
            // approvals / questions already waiting in this conversation stay counted
            if (old != null && attention(old.kind) && old.kind != NoticeKind.FAILED && old.kind != NoticeKind.SCHEDULE_MISSED) slot.ids += old.ids
            slot.ids += n.id ?: "?"
        }
        h.slots[n.session] = slot
        while (h.slots.size > MAX_SLOTS) h.slots.remove(h.slots.keys.first())
        val out = ArrayList<NotifyAction>()
        if (attention(n.kind)) {
            slot.shown = true
            out += NotifyAction.Post(
                slotKey(hostId, n.session), n.kind, hostId, h.host, n.session, n.title, n.at, attention = true,
                pending = maxOf(1, slot.ids.size),
            )
            if (old != null && old.kind == NoticeKind.DONE) out += syncDone(h, hostId, alert = false)
        } else {
            out += syncDone(h, hostId, alert = true)
        }
        return out
    }

    private fun cancel(h: HostState, n: PushNotice): List<NotifyAction> {
        val hostId = n.hostId
        val slot = h.slots[n.session]
        val key = slotKey(hostId, n.session)
        return when (n.cancel) {
            "approval" -> when {
                slot == null -> listOf(NotifyAction.Cancel(key))
                slot.kind != NoticeKind.APPROVAL && slot.kind != NoticeKind.QUESTION -> emptyList()
                else -> {
                    if (n.id != null) slot.ids.remove(n.id) else slot.ids.clear()
                    if (slot.ids.isEmpty()) { h.slots.remove(n.session); listOf(NotifyAction.Cancel(key)) }
                    else listOf(NotifyAction.Post(key, slot.kind, hostId, h.host, n.session, slot.title, slot.at, attention = true, silent = true, pending = slot.ids.size))
                }
            }
            "device" -> if (n.id != null) listOf(NotifyAction.Cancel(deviceKey(hostId, n.id))) else emptyList()
            "seen" -> when {
                slot == null -> listOf(NotifyAction.Cancel(key))
                slot.kind == NoticeKind.DONE || slot.kind == NoticeKind.FAILED || slot.kind == NoticeKind.SCHEDULE_MISSED -> {
                    h.slots.remove(n.session)
                    listOf<NotifyAction>(NotifyAction.Cancel(key)) + (if (slot.kind == NoticeKind.DONE) syncDone(h, hostId, alert = false) else emptyList())
                }
                else -> emptyList()
            }
            else -> emptyList()
        }
    }

    /**
     * Brings the completions of one host to the right shape: each keeps its own notification, and from the second one a
     * bundle sits on top. [alert] marks a newly arrived completion: it sounds once (the first alone, then the bundle —
     * the new child posts quietly). Re-counts after a removal are quiet.
     */
    private fun syncDone(h: HostState, hostId: String, alert: Boolean): List<NotifyAction> {
        val dones = h.slots.entries.filter { it.value.kind == NoticeKind.DONE }
        val out = ArrayList<NotifyAction>()
        when {
            dones.isEmpty() -> if (h.bundled) { h.bundled = false; out += NotifyAction.Cancel(bundleKey(hostId)) }
            dones.size == 1 -> {
                val (session, slot) = dones[0]
                if (h.bundled) { h.bundled = false; out += NotifyAction.Cancel(bundleKey(hostId)) }
                if (!slot.shown || alert) {
                    // Overwriting its own earlier notification keeps it quiet; a first showing alerts
                    slot.shown = true
                    out += NotifyAction.Post(slotKey(hostId, session), NoticeKind.DONE, hostId, h.host, session, slot.title, slot.at, attention = false, silent = !alert)
                }
            }
            else -> {
                for ((session, slot) in dones) if (!slot.shown) {
                    // Each completion keeps a row under the bundle; the bundle carries the alert for a new one
                    slot.shown = true
                    out += NotifyAction.Post(slotKey(hostId, session), NoticeKind.DONE, hostId, h.host, session, slot.title, slot.at, attention = false, silent = true)
                }
                val newest = dones.last()
                h.bundled = true
                out += NotifyAction.Bundle(bundleKey(hostId), hostId, h.host, dones.size, dones.reversed().map { it.value.title }, newest.key, newest.value.at, silent = !alert)
            }
        }
        return out
    }
}
