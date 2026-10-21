package dev.pleiad.app

import android.content.Intent
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.PermissionState
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback
import dev.pleiad.app.remote.LinkStatus
import dev.pleiad.app.remote.PairError
import dev.pleiad.app.remote.Pairing
import dev.pleiad.app.remote.PairingCodec
import dev.pleiad.app.remote.HostCreds
import dev.pleiad.app.remote.HostRoute
import dev.pleiad.app.plus.PlusAdmission
import dev.pleiad.app.plus.PlusHostList
import java.util.concurrent.Executors

/**
 * The host list's bridge to the device side (only the bundled shell page sees it; host pages never do).
 * Errors are rejected with a stable `code` (payload, relay-url, denied, expired, ticket, rate, host-offline, offline,
 * cancelled, aborted, timeout, handshake, bad-response, storage, unknown-host, plus-unpaired, plus-reapprove, plus-no-relay,
 * plus-paused, revoked);
 * the page translates them.
 * Events: `status` { hostId, state, ... }, `pairCode` { code } (QR pairing and admit()), `pairLink` {} (then call takePairLink()).
 */
@CapacitorPlugin(
    name = "PleiadRemote",
    permissions = [Permission(alias = "notifications", strings = [android.Manifest.permission.POST_NOTIFICATIONS])],
)
class PleiadRemotePlugin : Plugin() {
    companion object {
        private val worker = Executors.newCachedThreadPool { r -> Thread(r, "pleiad-plugin").also { it.isDaemon = true } }
        @Volatile private var instance: PleiadRemotePlugin? = null
        @Volatile private var pendingLink: String? = null

        fun offerLink(payload: String) {
            pendingLink = payload
            instance?.notifyListeners("pairLink", JSObject())   // the page then calls takePairLink()
        }
    }

    private val device get() = (context.applicationContext as PleiadApp).device
    @Volatile private var pairing: Pairing? = null
    private var permissionCallback: ((Boolean) -> Unit)? = null
    private val statusListener: (String, LinkStatus) -> Unit = { hostId, s ->
        notifyListeners("status", JSObject(s.toJson().put("hostId", hostId).toString()))
    }

    override fun load() {
        instance = this
        device.onStatus(statusListener)
    }

    override fun handleOnDestroy() {
        device.offStatus(statusListener)
        if (instance === this) instance = null
    }

    private fun bg(call: PluginCall, fn: () -> Unit) = worker.execute {
        try { fn() } catch (e: PairError) {
            call.reject(e.message, e.code, JSObject().put("detail", e.detail).put("closeCode", e.closeCode))
        } catch (e: IllegalArgumentException) {
            call.reject(e.message, if (e.message == "unknown-host") "unknown-host" else "internal")
        } catch (e: java.security.GeneralSecurityException) {
            call.reject(e.message, "storage")
        } catch (e: Exception) {
            call.reject(e.message ?: e.toString(), "internal")
        }
    }

    @PluginMethod
    fun info(call: PluginCall) = bg(call) {
        call.resolve(
            JSObject()
                .put("deviceName", (context.applicationContext as PleiadApp).deviceName())
                .put("app", BuildConfig.VERSION_NAME)
                .put("encrypted", device.store.encrypted),
        )
    }

    @PluginMethod
    fun list(call: PluginCall) = bg(call) {
        val app = context.applicationContext as PleiadApp
        val plusState = app.plus.stateJson()
        val usePlus = plusState.optString("plus") == "on" && plusState.optString("login") == "in" && plusState.optString("status") == "plus"
        val fetched = if (usePlus) app.plus.fetchHosts() else app.plus.cachedHosts()
        app.plus.currentRelayUrl()?.let {
            device.updatePlusRelay(it)
            app.notifyHub.plusRelayChanged()
        }
        // A PC gone from the Plus ledger read just now is forgotten here too (not when the read failed). Its own-relay pairing stays.
        val ledgerRead = usePlus && fetched.read
        if (ledgerRead) {
            val gone = PlusHostList.gone(device.store.hosts(), fetched.hosts)
            for (rec in gone) {
                device.remove(rec.hostId, "plus")
                if (device.store.hosts().none { it.hostId == rec.hostId }) ResumeStore(context).forget(rec.hostId)
            }
            if (gone.isNotEmpty()) app.notifyHub.hostsChanged()
        }
        // One row per host; `via` is the route a tap opens with (PlusHostList.combine), `both` that the device is paired each way.
        val rows = PlusHostList.combine(device.store.hosts(), fetched.hosts, usePlus && fetched.error != "no-relay", device.connectedVia(), ledgerRead)
        val arr = JSArray()
        for (row in rows) {
            val h = row.record
            val plusHost = row.plus
            val hostId = h?.hostId ?: plusHost?.hostId ?: continue
            val other = if (row.both) device.store.host(hostId, if (row.via == "own") "plus" else "own") else null
            val o = JSObject((h?.toPublicJson() ?: org.json.JSONObject()).toString())
            o.put("hostId", hostId)
            o.put("hostName", h?.label?.takeIf { it.isNotEmpty() }
                ?: other?.label?.takeIf { it.isNotEmpty() }
                ?: device.store.host(hostId, "own")?.label?.takeIf { it.isNotEmpty() }
                ?: plusHost?.name ?: h?.hostName.orEmpty())
            o.put("via", row.via)
            o.put("both", row.both)
            o.put("lastConnectedAt", listOfNotNull(h?.lastConnectedAt, other?.lastConnectedAt).maxOrNull() ?: org.json.JSONObject.NULL)
            if (row.online != null) o.put("online", row.online)
            // Only a proxy on the row's route speaks for it: an own window's state must not show on a Plus row, nor the reverse.
            val st = device.proxy(hostId)?.takeIf { it.creds.via == row.via }?.link?.status
            // A Plus row the host has not allowed yet ("unpaired") or wants allowed again ("reapprove", ADR 0248):
            // tapping it asks on the host's screen (admit()) instead of opening.
            val plusRec = if (row.via == "plus") device.store.host(hostId, "plus") else null
            val idle = when {
                row.via == "plus" && plusRec?.reapproveAt != null -> "reapprove"
                h?.revokedAt != null && h.via == row.via -> "revoked"
                row.via == "plus" && device.store.credentials(hostId, "plus") == null -> "unpaired"
                else -> "closed"
            }
            o.put("state", st?.state ?: idle)
            o.put("open", st != null)
            arr.put(o)
        }
        call.resolve(JSObject().put("hosts", arr).put("plusError", if (usePlus) fetched.error ?: org.json.JSONObject.NULL else org.json.JSONObject.NULL))
    }

    /** Check a pasted / scanned payload before pairing (for the confirmation step). */
    @PluginMethod
    fun parse(call: PluginCall) = bg(call) {
        val o = PairingCodec.parse(call.getString("payload"))
        val known = device.store.host(o.hostId) != null
        call.resolve(JSObject().put("hostId", o.hostId).put("hostName", PairingCodec.cleanLabel(o.hostName)).put("relayUrl", o.relayUrl).put("known", known))
    }

    /** Resolves when the host approved. `pairCode` is emitted as soon as the confirmation code is known. */
    @PluginMethod(returnType = PluginMethod.RETURN_PROMISE)
    fun pair(call: PluginCall) {
        val payload = call.getString("payload") ?: return call.reject("payload", "payload")
        val handle = Pairing()
        pairing?.cancel()
        pairing = handle
        bg(call) {
            try {
                val rec = device.pair(payload, { code -> notifyListeners("pairCode", JSObject().put("code", code)) }, handle)
                (context.applicationContext as PleiadApp).notifyHub.hostsChanged()
                call.resolve(JSObject().put("host", JSObject(rec.toPublicJson().toString())))
            } finally {
                if (pairing === handle) pairing = null
            }
        }
    }

    /**
     * Ask a Plus host to allow this device (ADR 0248): the host shows its approval window with the same confirmation code,
     * emitted here as `pairCode`. Resolves when the person on the host's screen allowed it; cancelPair() aborts.
     */
    @PluginMethod(returnType = PluginMethod.RETURN_PROMISE)
    fun admit(call: PluginCall) {
        val hostId = call.getString("hostId") ?: return call.reject("hostId", "unknown-host")
        val handle = Pairing()
        pairing?.cancel()
        pairing = handle
        bg(call) {
            try {
                val app = context.applicationContext as PleiadApp
                val host = app.plus.cachedHosts().hosts.find { it.hostId == hostId } ?: throw IllegalArgumentException("unknown-host")
                val token = app.plus.currentIdToken() ?: throw PairError("plus-signed-out")
                val relay = app.plus.currentRelayUrl() ?: throw PairError("unreachable")
                val uid = app.plus.currentUid()
                val rec = device.admitPlus(hostId, PlusAdmission.MODE_PAIR, uid) { kp ->
                    PlusAdmission.admit(host, relay, token, kp, app.deviceName(), BuildConfig.VERSION_NAME, mode = PlusAdmission.MODE_PAIR,
                        onCode = { code -> notifyListeners("pairCode", JSObject().put("code", code)) }, handle = handle,
                        ticket = { app.plus.deviceTicket(hostId, kp) }).copy(uid = uid)
                }
                app.notifyHub.hostsChanged()
                call.resolve(JSObject().put("host", JSObject(rec.toPublicJson().toString())))
            } finally {
                if (pairing === handle) pairing = null
            }
        }
    }

    @PluginMethod
    fun cancelPair(call: PluginCall) {
        pairing?.cancel()
        pairing = null
        call.resolve()
    }

    @PluginMethod
    fun open(call: PluginCall) {
        val hostId = call.getString("hostId") ?: return call.reject("hostId", "unknown-host")
        val requested = call.getString("via")?.takeIf { it == "own" || it == "plus" }
        bg(call) {
            val app = context.applicationContext as PleiadApp
            val state = app.plus.stateJson()
            val listed = app.plus.cachedHosts().hosts.find { it.hostId == hostId }
            val plusVisible = state.optString("plus") == "on" && state.optString("login") == "in" && state.optString("status") == "plus"
            val hasOwn = device.store.credentials(hostId, "own") != null
            val hasPlus = plusVisible && (device.store.host(hostId, "plus") != null || listed != null)
            // The row's route when the page gives one (the list chose it), else the same rule: a connected window keeps its route,
            // Plus while the PC is online on the Plus ledger, otherwise own. Not "Plus whenever the account can see the host".
            val via = requested?.takeIf { (it == "own" && hasOwn) || (it == "plus" && hasPlus) }
                ?: HostRoute.choose(hasOwn, hasPlus, listed?.online, device.connectedVia()[hostId])
                ?: throw IllegalArgumentException("unknown-host")
            val current = device.proxy(hostId)?.link?.status
            if (via == "plus" && current?.state == "signed-out") throw PairError("plus-signed-out")
            if (via == "plus" && current?.state == "blocked") throw PairError("plus-no-relay")
            if (via == "plus" && current?.state == "limit") throw PairError("plus-limit")
            if (via == "plus" && current?.state == "update") throw PairError("plus-update")
            if (via == "plus" && current?.state == "removed") throw PairError("plus-removed")
            // The account alone does not let this device in (ADR 0248): the page first asks the host with admit().
            if (via == "plus" && device.store.host(hostId, "plus")?.reapproveAt != null) throw PairError("plus-reapprove")
            if (via == "plus" && device.store.credentials(hostId, "plus") == null) throw PairError("plus-unpaired")
            if (device.store.credentials(hostId, via) == null) throw IllegalArgumentException("unknown-host")
            device.open(hostId, via)
            val i = Intent(context, HostActivity::class.java).putExtra(HostActivity.EXTRA_HOST_ID, hostId).putExtra(HostActivity.EXTRA_VIA, via)
            activity.runOnUiThread { activity.startActivity(i) }
            call.resolve()
        }
    }

    @PluginMethod
    fun rename(call: PluginCall) = bg(call) {
        val hostId = call.getString("hostId") ?: ""
        val via = call.getString("via") ?: "own"
        val label = call.getString("label") ?: ""
        val rec = if (via == "both") {
            // One row for a host paired both ways: both records carry the name, so whichever route opens shows it.
            (device.rename(hostId, label, "own") ?: throw IllegalArgumentException("unknown-host"))
                .also { if (device.store.host(hostId, "plus") != null) device.rename(hostId, label, "plus") }
        } else if (via == "plus" && device.store.host(hostId, "plus") == null) {
            val host = (context.applicationContext as PleiadApp).plus.cachedHosts().hosts.firstOrNull { it.hostId == hostId }
                ?: throw IllegalArgumentException("unknown-host")
            val app = context.applicationContext as PleiadApp
            val relay = app.plus.currentRelayUrl() ?: throw PairError("unreachable")
            device.store.savePlusLabel(hostId, host.publicKey, host.name, relay, app.plus.currentUid(), label)
            device.store.host(hostId, "plus")!!
        } else device.rename(hostId, label, via) ?: throw IllegalArgumentException("unknown-host")
        call.resolve(JSObject().put("host", JSObject(rec.toPublicJson().toString())))
    }

    @PluginMethod
    fun remove(call: PluginCall) = bg(call) {
        val hostId = call.getString("hostId") ?: ""
        device.remove(hostId, call.getString("via") ?: "own")
        ResumeStore(context).forget(hostId)
        (context.applicationContext as PleiadApp).notifyHub.hostsChanged()
        call.resolve()
    }

    // ── Notifications while away (ADR 0086): the app's 通知 screen ──

    /** { settings, permission, enabled, dismissed, lines } */
    @PluginMethod
    fun notifyState(call: PluginCall) = bg(call) { call.resolve(JSObject(NotifyControl.state(context).toString())) }

    /** Change some settings (reply / failed / done / lockNames / skipPc, or enabled = false). Turning on goes through notifyEnable. */
    @PluginMethod
    fun notifyUpdate(call: PluginCall) = bg(call) {
        val patch = org.json.JSONObject(call.data.toString())
        patch.remove("enabled")?.let { if (it == false) patch.put("enabled", false) }   // only "off" is accepted here
        call.resolve(JSObject(NotifyControl.update(context, patch).toString()))
    }

    /** Ask for the permission if needed, turn notifications on, start the service, guide about battery optimization (once). */
    @PluginMethod
    fun notifyEnable(call: PluginCall) {
        NotifyControl.enable(activity, ask = { cb ->
            permissionCallback = cb
            requestPermissionForAlias("notifications", call, "notifyPermissionResult")
        }, done = { result -> call.resolve(JSObject(result.toString())) })
    }

    @PermissionCallback
    private fun notifyPermissionResult(call: PluginCall) {
        val cb = permissionCallback
        permissionCallback = null
        cb?.invoke(getPermissionState("notifications") == PermissionState.GRANTED)
    }

    /** The system's page for this app's notifications (after the permission was refused). */
    @PluginMethod
    fun notifyOpenSystemSettings(call: PluginCall) {
        NotifyControl.openSystemSettings(context)
        call.resolve()
    }

    /** A pleiad://pair link the app was opened with (once). */
    @PluginMethod
    fun takePairLink(call: PluginCall) {
        val p = pendingLink
        pendingLink = null
        call.resolve(JSObject().put("payload", p))
    }
}
