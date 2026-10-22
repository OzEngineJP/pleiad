package dev.pleiad.app.remote

// Kotlin port of core/remote/device.mjs (docs/remote.md §3.1・§3.3・§7): the device's key, the paired hosts, pairing,
// and one loopback proxy per open host.
//
//   <dir>/secrets.bin  device static key + per-host { token, key? }, sealed by a SecretCipher (Android Keystore in the app).
//                      key is the device key used for that host only (a revoked key never gets back in, so each pairing
//                      makes a new one; a record without key, written by an older version, uses deviceKey)
//   <dir>/hosts.json   { version: 1, hosts: [{ hostId, hostName, label, relayUrl, hostPublicKey, deviceId, port,
//                        pairedAt, lastConnectedAt, revokedAt, reapproveAt? }] }   (no secrets; same shape as the desktop's hosts.json)
//   <dir>/static/<hostId>.bin  the host's web/ shell as last confirmed (StaticCache.kt, docs/remote.md §8.6)

import java.io.File
import java.util.concurrent.ConcurrentHashMap
import org.json.JSONArray
import org.json.JSONObject

/** Seals the secrets file. The app uses an Android Keystore AES-GCM key; tests use [PlainCipher]. */
interface SecretCipher {
    val encrypted: Boolean
    fun seal(plain: ByteArray): ByteArray
    fun open(sealed: ByteArray): ByteArray
}

object PlainCipher : SecretCipher {
    override val encrypted = false
    override fun seal(plain: ByteArray) = plain
    override fun open(sealed: ByteArray) = sealed
}

data class HostRecord(
    val hostId: String,
    val hostName: String,
    val label: String,
    val relayUrl: String,
    val hostPublicKey: String,
    val deviceId: String,
    val port: Int,
    val pairedAt: Long?,
    val lastConnectedAt: Long?,
    val revokedAt: Long?,
    val via: String = "own",
    val uid: String? = null,
    /** When the host said this device must be allowed again on its screen (cleared on the next connection). */
    val reapproveAt: Long? = null,
) {
    fun toJson(): JSONObject = JSONObject()
        .put("hostId", hostId).put("hostName", hostName).put("label", label).put("relayUrl", relayUrl)
        .put("hostPublicKey", hostPublicKey).put("deviceId", deviceId).put("port", port)
        .put("pairedAt", pairedAt ?: JSONObject.NULL).put("lastConnectedAt", lastConnectedAt ?: JSONObject.NULL)
        .put("revokedAt", revokedAt ?: JSONObject.NULL)
        .put("via", via).put("uid", uid ?: JSONObject.NULL)
        .apply { if (reapproveAt != null) put("reapproveAt", reapproveAt) }

    /** For the shell UI: no key material. */
    fun toPublicJson(): JSONObject = toJson().apply { remove("hostPublicKey"); remove("uid") }

    companion object {
        private fun time(o: JSONObject, k: String): Long? = when (val v = o.opt(k)) {
            is Number -> v.toLong()
            is String -> try { java.time.Instant.parse(v).toEpochMilli() } catch (_: Exception) { null }
            else -> null
        }

        fun fromJson(o: JSONObject) = HostRecord(
            o.getString("hostId"), o.optString("hostName"), o.optString("label"), o.getString("relayUrl"),
            o.getString("hostPublicKey"), o.getString("deviceId"), o.optInt("port", 0),
            time(o, "pairedAt"), time(o, "lastConnectedAt"), time(o, "revokedAt"),
            o.optString("via", "own").ifEmpty { "own" }, o.optString("uid").ifEmpty { null }, time(o, "reapproveAt"),
        )
    }
}

class FileDeviceStore(val dir: File, private val cipher: SecretCipher = PlainCipher) {
    private val hostsFile = File(dir, "hosts.json")
    private val secretsFile = File(dir, "secrets.bin")
    private val lock = Any()
    private var keyPair: KeyPair? = null
    val encrypted get() = cipher.encrypted

    init { dir.mkdirs() }

    private fun writeAtomic(f: File, data: ByteArray) {
        val tmp = File(f.parentFile, "${f.name}.tmp")
        tmp.writeBytes(data)
        if (!tmp.renameTo(f)) { f.delete(); if (!tmp.renameTo(f)) throw java.io.IOException("cannot write ${f.name}") }
    }

    private fun readSecrets(): JSONObject {
        if (!secretsFile.exists()) return JSONObject()
        return JSONObject(String(cipher.open(secretsFile.readBytes()), Charsets.UTF_8))
    }

    private fun writeSecrets(o: JSONObject) = writeAtomic(secretsFile, cipher.seal(o.toString().toByteArray(Charsets.UTF_8)))

    private fun readHosts(): MutableList<HostRecord> {
        if (!hostsFile.exists()) return mutableListOf()
        val o = JSONObject(hostsFile.readText(Charsets.UTF_8))
        if (o.optInt("version") != 1) throw IllegalStateException("hosts.json has an unexpected format")
        val arr = o.getJSONArray("hosts")
        var migrated = false
        val records = MutableList(arr.length()) {
            val item = arr.getJSONObject(it)
            if (!item.has("via")) migrated = true
            HostRecord.fromJson(item)
        }
        if (migrated) writeHosts(records)
        return records
    }

    private fun writeHosts(list: List<HostRecord>) {
        val arr = JSONArray()
        for (h in list) arr.put(h.toJson())
        writeAtomic(hostsFile, JSONObject().put("version", 1).put("hosts", arr).toString(2).toByteArray(Charsets.UTF_8))
    }

    /** The device static key (one for all hosts). Created on first use. */
    fun identity(): KeyPair = synchronized(lock) {
        keyPair?.let { return it }
        val secrets = readSecrets()
        val priv = secrets.optString("deviceKey").takeIf { it.isNotEmpty() }?.let { PairingCodec.b64urlDecode(it) }
            ?: KeyPair.generate().privateKey.also { writeSecrets(secrets.put("deviceKey", PairingCodec.b64urlEncode(it))) }
        KeyPair.fromPrivate(priv).also { keyPair = it }
    }

    // ── Notifications while away (docs/remote.md §11-5): the device's notification key (one for all hosts; the AAD binds
    //    each notice to a host and this device), the settings, and whether the "turn on notifications?" band was dismissed ──

    private val notifyFile = File(dir, "notify.json")

    /** The device's notification key. Created on first use, sealed with the other secrets. */
    fun notifyKey(): ByteArray = synchronized(lock) {
        val secrets = readSecrets()
        secrets.optString("notifyKey").takeIf { it.isNotEmpty() }?.let { return PairingCodec.b64urlDecode(it) }
        NotifyCrypto.generateKey().also { writeSecrets(secrets.put("notifyKey", PairingCodec.b64urlEncode(it))) }
    }

    private fun readNotify(): JSONObject = if (notifyFile.exists()) {
        try { JSONObject(notifyFile.readText(Charsets.UTF_8)) } catch (_: Exception) { JSONObject() }
    } else JSONObject()

    fun notifySettings(): NotifySettings = synchronized(lock) { NotifySettings.fromJson(readNotify()) }

    fun saveNotifySettings(s: NotifySettings): NotifySettings = synchronized(lock) {
        val o = readNotify()
        val merged = s.toJson()
        for (k in merged.keys()) o.put(k, merged.get(k))
        writeAtomic(notifyFile, o.toString(2).toByteArray(Charsets.UTF_8))
        s
    }

    fun notifyBandDismissed(): Boolean = synchronized(lock) { readNotify().optBoolean("bandDismissed", false) }

    fun setNotifyBandDismissed(value: Boolean) = synchronized(lock) {
        writeAtomic(notifyFile, readNotify().put("bandDismissed", value).toString(2).toByteArray(Charsets.UTF_8))
    }

    fun hosts(): List<HostRecord> = synchronized(lock) { readHosts() }
    fun host(hostId: String, via: String = "own"): HostRecord? = hosts().find { it.hostId == hostId && it.via == via }

    private fun secretKeyOf(hostId: String, via: String) = if (via == "plus") "plus:$hostId" else "host:$hostId"
    private fun pendingKeyOf(hostId: String) = "plusPending:$hostId"

    /**
     * The new key a Plus request uses after the host revoked this device's key. Kept until the host allows it: the host
     * remembers a denied key for a while, so asking again with the same key gets the same answer (not a new window).
     */
    fun pendingPlusKey(hostId: String): KeyPair = synchronized(lock) {
        val secrets = readSecrets()
        secrets.optString(pendingKeyOf(hostId)).takeIf { it.isNotEmpty() }?.let { return KeyPair.fromPrivate(PairingCodec.b64urlDecode(it)) }
        KeyPair.generate().also { writeSecrets(secrets.put(pendingKeyOf(hostId), PairingCodec.b64urlEncode(it.privateKey))) }
    }

    fun dropPendingPlusKey(hostId: String) = synchronized(lock) {
        val secrets = readSecrets()
        if (secrets.remove(pendingKeyOf(hostId)) != null) writeSecrets(secrets)
    }

    fun credentials(hostId: String, via: String = "own"): HostCreds? = synchronized(lock) {
        val h = readHosts().find { it.hostId == hostId && it.via == via } ?: return null
        val token = readSecrets().optJSONObject(secretKeyOf(hostId, via))?.optString("token")?.takeIf { it.isNotEmpty() } ?: return null
        HostCreds(h.hostId, PairingCodec.b64urlDecode(h.hostPublicKey), h.relayUrl, h.deviceId, token, h.hostName, via, h.uid)
    }

    /** The device key used for that host's record (deviceKey when the record has none). Null when there is no record. */
    fun keyFor(hostId: String, via: String = "own"): KeyPair? {
        val secret = synchronized(lock) { readSecrets().optJSONObject(secretKeyOf(hostId, via)) } ?: return null
        if (secret.optString("token").isEmpty()) return null
        val key = secret.optString("key")
        return if (key.isNotEmpty()) KeyPair.fromPrivate(PairingCodec.b64urlDecode(key)) else identity()
    }

    /** keyPair is the device key used for this record (null keeps using deviceKey, as older versions did). */
    fun saveHost(c: HostCreds, via: String = c.via, uid: String? = c.uid, keyPair: KeyPair? = null): HostRecord = synchronized(lock) {
        require(Regex("^[a-z2-7]{26}$").matches(c.hostId)) { "invalid hostId" }
        val secret = JSONObject().put("token", c.token)
        if (keyPair != null) secret.put("key", PairingCodec.b64urlEncode(keyPair.privateKey))
        val secrets = readSecrets().put(secretKeyOf(c.hostId, via), secret)
        if (via == "plus") secrets.remove(pendingKeyOf(c.hostId))
        writeSecrets(secrets)
        val list = readHosts()
        val prev = list.find { it.hostId == c.hostId && it.via == via }
        val rec = HostRecord(
            c.hostId, PairingCodec.cleanLabel(c.hostName), prev?.label ?: "", c.relayUrl, PairingCodec.b64urlEncode(c.hostPublicKey),
            c.deviceId, prev?.port ?: 0, System.currentTimeMillis(), null, null, via, uid,
        )
        val kept = list.filterNot { it.hostId == c.hostId && (it.via == via || via == "plus" && it.via == "plus") }
        writeHosts(kept + rec)
        rec
    }

    fun updateHost(hostId: String, via: String = "own", patch: (HostRecord) -> HostRecord): HostRecord? = synchronized(lock) {
        val list = readHosts()
        val i = list.indexOfFirst { it.hostId == hostId && it.via == via }
        if (i < 0) return null
        val rec = patch(list[i])
        list[i] = rec
        writeHosts(list)
        rec
    }

    fun removeHost(hostId: String, via: String = "own"): HostRecord? = synchronized(lock) {
        val secrets = readSecrets()
        secrets.remove(secretKeyOf(hostId, via))
        if (via == "plus") secrets.remove(pendingKeyOf(hostId))
        writeSecrets(secrets)
        val list = readHosts()
        val hit = list.find { it.hostId == hostId && it.via == via }
        writeHosts(list.filterNot { it.hostId == hostId && it.via == via })
        hit
    }

    fun updatePlusRelay(relayUrl: String) = synchronized(lock) {
        val list = readHosts()
        var changed = false
        val updated = list.map { if (it.via == "plus" && it.relayUrl != relayUrl) { changed = true; it.copy(relayUrl = relayUrl) } else it }
        if (changed) writeHosts(updated)
    }

    /** A Plus row can be renamed before its first connection; this placeholder has no device credentials. */
    fun savePlusLabel(hostId: String, publicKey: String, hostName: String, relayUrl: String, uid: String?, label: String) = synchronized(lock) {
        val list = readHosts()
        val i = list.indexOfFirst { it.hostId == hostId && it.via == "plus" }
        if (i >= 0) list[i] = list[i].copy(label = PairingCodec.cleanLabel(label), hostName = PairingCodec.cleanLabel(hostName), relayUrl = relayUrl, uid = uid)
        else list.add(HostRecord(hostId, PairingCodec.cleanLabel(hostName), PairingCodec.cleanLabel(label), relayUrl, publicKey, "", 0, null, null, null, "plus", uid))
        writeHosts(list)
    }
}

/** The device as a whole: host list, pairing, one proxy per open host. */
class RemoteDevice(
    val store: FileDeviceStore,
    val app: String,
    val name: String,
    val platform: String = "android",
    private val texts: ProxyTexts = DefaultTexts,
    private val backoff: Backoff = Backoff(),
    private val connectTimeoutMs: Long = 15_000,
    private val requestWaitMs: Long = 10_000,
    private val log: (String) -> Unit = {},
) {
    val loop = Loop()
    private val proxies = ConcurrentHashMap<String, DeviceProxy>()
    private val listeners = java.util.concurrent.CopyOnWriteArrayList<(String, LinkStatus) -> Unit>()
    @Volatile var plusIdToken: (() -> String?)? = null
    @Volatile var plusReadmit: ((String) -> HostCreds?)? = null
    /** The relay ticket (role device) for one connection to hostId with this key; null: the api has no tickets yet. */
    @Volatile var plusTicket: ((hostId: String, keyPair: KeyPair) -> String?)? = null

    fun onStatus(fn: (hostId: String, status: LinkStatus) -> Unit) { listeners.add(fn) }
    fun offStatus(fn: (hostId: String, status: LinkStatus) -> Unit) { listeners.remove(fn) }

    /** Host list with the live state ("closed" when no proxy is open, "revoked" when the host removed us). A record's state is its own route's proxy only. */
    fun list(): List<Pair<HostRecord, LinkStatus?>> = store.hosts().map { h -> h to proxies[h.hostId]?.takeIf { it.creds.via == h.via }?.link?.status }

    /** The route of each host window that is connected now (HostRoute: opening the host again keeps it). */
    fun connectedVia(): Map<String, String> = proxies.filterValues { it.link.status.state == "connected" }.mapValues { it.value.creds.via }

    /** The route to open [hostId] with when nothing chose one: the open proxy's, else [preferred], else own, else Plus. */
    fun routeFor(hostId: String, preferred: String? = null): String? =
        proxies[hostId]?.creds?.via ?: HostRoute.reopen(hostId, store.hosts(), preferred)

    /**
     * Pair and save (blocking). Each pairing makes a new device key (a revoked key is refused even with a QR code,
     * and the code is single-use). An open proxy for the same host reconnects with the new credentials and key.
     */
    fun pair(payload: String, onCode: (String) -> Unit, handle: Pairing = Pairing()): HostRecord {
        val kp = KeyPair.generate()
        val creds = Pairing.pair(payload, kp, name, platform, app, onCode, handle)
        val rec = store.saveHost(creds, keyPair = kp)
        repaired(rec, kp)
        return rec
    }

    /**
     * Get admitted by a Plus host and save (blocking; docs/remote.md §3.4). [run] does the admission with the given key.
     *   mode "admit": background reconnect of a key the host already allowed (no window on the host).
     *   mode "pair":  the person picked the host; an unknown key goes to the approval window on the host's screen.
     * Key order: the Plus record's key, then this host's QR record's key (already allowed: no window), then deviceKey.
     * In "pair" mode a revoked key is replaced by a new one once (that one goes to the approval window). The new key is kept
     * until the host allows it, so asking again after a deny gets the host's answer for that key (no new window within its wait).
     */
    fun admitPlus(hostId: String, mode: String, uid: String?, run: (KeyPair) -> HostCreds): HostRecord {
        val first = store.keyFor(hostId, "plus") ?: store.keyFor(hostId, "own") ?: store.identity()
        var used = first
        val creds = try { run(first) } catch (e: PairError) {
            if (!(mode == "pair" && e.code == "revoked")) throw e
            used = store.pendingPlusKey(hostId)
            try { run(used) } catch (e2: PairError) {
                // the kept key was allowed and then revoked without this device saving it: start over with another new key
                if (e2.code != "revoked") throw e2
                store.dropPendingPlusKey(hostId)
                used = store.pendingPlusKey(hostId)
                run(used)
            }
        }
        val rec = store.saveHost(creds, via = "plus", uid = uid, keyPair = used)
        if (mode == "pair") repaired(rec, used)
        return rec
    }

    /** A new pairing was saved: an open proxy on the same route reconnects with it. A proxy on the other route keeps its own credentials. */
    internal fun repaired(rec: HostRecord, keyPair: KeyPair? = null) {
        val px = proxies[rec.hostId] ?: return
        if (px.creds.via != rec.via) return
        store.credentials(rec.hostId, rec.via)?.let { px.retryNow(it, keyPair) }
    }

    /** Open (or reuse) the host's proxy. Blocking (binds the port). */
    @Synchronized
    fun open(hostId: String, via: String = "own"): DeviceProxy {
        proxies[hostId]?.let { if (it.creds.via == via) return it else close(hostId) }
        val creds = store.credentials(hostId, via) ?: throw IllegalArgumentException("unknown-host")
        val rec = store.host(hostId, via)
        val px = DeviceProxy(
            loop, creds, store.keyFor(hostId, via) ?: store.identity(), rec?.port ?: 0, app, name, "mobile", backoff, connectTimeoutMs, requestWaitMs, texts, log,
            staticCacheFile(hostId), if (via == "plus") plusIdToken else null, if (via == "plus") plusReadmit else null,
            if (via == "plus") plusTicket else null,
        )
        px.onStatus { s ->
            try {
                if (s.state == "connected") store.updateHost(hostId, via) {
                    it.copy(lastConnectedAt = System.currentTimeMillis(), revokedAt = null, reapproveAt = null,
                        hostName = if (s.hostName.isNotEmpty()) PairingCodec.cleanLabel(s.hostName) else it.hostName)
                }
                if (s.state == "revoked") store.updateHost(hostId, via) { it.copy(revokedAt = System.currentTimeMillis()) }
                if (s.state == "reapprove") store.updateHost(hostId, via) { it.copy(reapproveAt = System.currentTimeMillis()) }
            } catch (e: Exception) { log("remote device: ${e.message}") }
            for (l in listeners) try { l(hostId, s) } catch (_: Exception) {}
        }
        px.start()
        if (px.port != (rec?.port ?: 0)) store.updateHost(hostId, via) { it.copy(port = px.port) }
        proxies[hostId] = px
        return px
    }

    fun proxy(hostId: String): DeviceProxy? = proxies[hostId]

    fun updatePlusRelay(relayUrl: String) {
        store.updatePlusRelay(relayUrl)
        for ((hostId, px) in proxies) if (px.creds.via == "plus") {
            store.credentials(hostId, "plus")?.let(px::updateCredentials)
        }
    }

    fun retryPausedPlus() {
        for (px in proxies.values) if (px.creds.via == "plus" && px.link.state == "paused") px.link.retryNow()
    }

    private fun staticCacheFile(hostId: String) = File(store.dir, "static/$hostId.bin")

    fun close(hostId: String) { proxies.remove(hostId)?.close() }

    fun rename(hostId: String, label: String, via: String = "own") = store.updateHost(hostId, via) { it.copy(label = PairingCodec.cleanLabel(label)) }

    /** Forget the pairing here (the host still lists the device until it is revoked there). */
    fun remove(hostId: String, via: String = "own"): HostRecord? {
        val removed = store.removeHost(hostId, via)
        if (store.hosts().none { it.hostId == hostId }) {
            close(hostId)
            staticCacheFile(hostId).delete()
        } else if (proxies[hostId]?.creds?.via == via) close(hostId)   // its credentials are gone; the other route stays paired
        return removed
    }

    fun closeAll() { for (k in proxies.keys.toList()) close(k) }
}
