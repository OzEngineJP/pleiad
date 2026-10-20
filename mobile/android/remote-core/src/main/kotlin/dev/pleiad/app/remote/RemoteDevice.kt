package dev.pleiad.app.remote

// Kotlin port of core/remote/device.mjs (docs/remote.md §3.1・§3.3・§7): the device's key, the paired hosts, pairing,
// and one loopback proxy per open host.
//
//   <dir>/secrets.bin  device static key + per-host relay tokens, sealed by a SecretCipher (Android Keystore in the app)
//   <dir>/hosts.json   { version: 1, hosts: [{ hostId, hostName, label, relayUrl, hostPublicKey, deviceId, port,
//                        pairedAt, lastConnectedAt, revokedAt }] }   (no secrets; same shape as the desktop's hosts.json)
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
) {
    fun toJson(): JSONObject = JSONObject()
        .put("hostId", hostId).put("hostName", hostName).put("label", label).put("relayUrl", relayUrl)
        .put("hostPublicKey", hostPublicKey).put("deviceId", deviceId).put("port", port)
        .put("pairedAt", pairedAt ?: JSONObject.NULL).put("lastConnectedAt", lastConnectedAt ?: JSONObject.NULL)
        .put("revokedAt", revokedAt ?: JSONObject.NULL)
        .put("via", via).put("uid", uid ?: JSONObject.NULL)

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
            o.optString("via", "own").ifEmpty { "own" }, o.optString("uid").ifEmpty { null },
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

    fun credentials(hostId: String, via: String = "own"): HostCreds? = synchronized(lock) {
        val h = readHosts().find { it.hostId == hostId && it.via == via } ?: return null
        val key = if (via == "plus") "plus:$hostId" else "host:$hostId"
        val token = readSecrets().optJSONObject(key)?.optString("token")?.takeIf { it.isNotEmpty() } ?: return null
        HostCreds(h.hostId, PairingCodec.b64urlDecode(h.hostPublicKey), h.relayUrl, h.deviceId, token, h.hostName, via, h.uid)
    }

    fun saveHost(c: HostCreds, via: String = c.via, uid: String? = c.uid): HostRecord = synchronized(lock) {
        require(Regex("^[a-z2-7]{26}$").matches(c.hostId)) { "invalid hostId" }
        val secretKey = if (via == "plus") "plus:${c.hostId}" else "host:${c.hostId}"
        writeSecrets(readSecrets().put(secretKey, JSONObject().put("token", c.token)))
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
        secrets.remove(if (via == "plus") "plus:$hostId" else "host:$hostId")
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

    fun onStatus(fn: (hostId: String, status: LinkStatus) -> Unit) { listeners.add(fn) }
    fun offStatus(fn: (hostId: String, status: LinkStatus) -> Unit) { listeners.remove(fn) }

    /** Host list with the live state ("closed" when no proxy is open, "revoked" when the host removed us). */
    fun list(): List<Pair<HostRecord, LinkStatus?>> = store.hosts().map { h -> h to proxies[h.hostId]?.link?.status }

    /** Pair and save (blocking). An open proxy for the same host reconnects with the new credentials. */
    fun pair(payload: String, onCode: (String) -> Unit, handle: Pairing = Pairing()): HostRecord {
        val kp = store.identity()
        val creds = Pairing.pair(payload, kp, name, platform, app, onCode, handle)
        val rec = store.saveHost(creds)
        proxies[rec.hostId]?.let { px -> store.credentials(rec.hostId)?.let { px.retryNow(it) } }
        return rec
    }

    /** Open (or reuse) the host's proxy. Blocking (binds the port). */
    @Synchronized
    fun open(hostId: String, via: String = "own"): DeviceProxy {
        proxies[hostId]?.let { if (it.creds.via == via) return it else close(hostId) }
        val creds = store.credentials(hostId, via) ?: throw IllegalArgumentException("unknown-host")
        val rec = store.host(hostId, via)
        val px = DeviceProxy(
            loop, creds, store.identity(), rec?.port ?: 0, app, name, "mobile", backoff, connectTimeoutMs, requestWaitMs, texts, log,
            staticCacheFile(hostId), if (via == "plus") plusIdToken else null, if (via == "plus") plusReadmit else null,
        )
        px.onStatus { s ->
            try {
                if (s.state == "connected") store.updateHost(hostId, via) {
                    it.copy(lastConnectedAt = System.currentTimeMillis(), revokedAt = null, hostName = if (s.hostName.isNotEmpty()) PairingCodec.cleanLabel(s.hostName) else it.hostName)
                }
                if (s.state == "revoked") store.updateHost(hostId, via) { it.copy(revokedAt = System.currentTimeMillis()) }
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
        }
        return removed
    }

    fun closeAll() { for (k in proxies.keys.toList()) close(k) }
}
