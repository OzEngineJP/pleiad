package dev.pleiad.app.remote

import java.io.File
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class RemoteDeviceStoreTest {
    @get:Rule val temp = TemporaryFolder()
    private val hostId = "aaaaaaaaaaaaaaaaaaaaaaaaaa"
    private val key = ByteArray(32) { it.toByte() }

    private fun creds(via: String, relay: String, token: String) = HostCreds(hostId, key, relay, "device-$via", token, "Computer", via,
        if (via == "plus") "user-1" else null)

    @Test fun readsOldHostsAndLeavesOwnSecretKeyUsable() {
        val dir = temp.newFolder()
        File(dir, "hosts.json").writeText(
            JSONObject().put("version", 1).put("hosts", org.json.JSONArray().put(JSONObject()
                .put("hostId", hostId).put("hostName", "Old PC").put("label", "").put("relayUrl", "http://127.0.0.1:8787")
                .put("hostPublicKey", PairingCodec.b64urlEncode(key)).put("deviceId", "device-old").put("port", 50001)
                .put("pairedAt", 1).put("lastConnectedAt", JSONObject.NULL).put("revokedAt", JSONObject.NULL))).toString())
        File(dir, "secrets.bin").writeText(JSONObject().put("host:$hostId", JSONObject().put("token", "old-token")).toString())
        val store = FileDeviceStore(dir)
        assertEquals("own", store.hosts().single().via)
        assertEquals("old-token", store.credentials(hostId)?.token)
        store.hosts()
        assertEquals("own", JSONObject(File(dir, "hosts.json").readText()).getJSONArray("hosts").getJSONObject(0).getString("via"))
    }

    @Test fun ownAndPlusRecordsUseSeparateSecretsAndPlusIsUniquePerHost() {
        val store = FileDeviceStore(temp.newFolder())
        store.saveHost(creds("own", "https://relay.example", "own-secret"))
        store.saveHost(creds("plus", "https://plus-relay.example", "plus-secret"))
        store.saveHost(creds("plus", "https://plus-relay-2.example", "new-plus-secret"))
        assertEquals(setOf("own", "plus"), store.hosts().map { it.via }.toSet())
        assertEquals("own-secret", store.credentials(hostId, "own")?.token)
        assertEquals("new-plus-secret", store.credentials(hostId, "plus")?.token)
        assertEquals("user-1", store.host(hostId, "plus")?.uid)
    }

    @Test fun relayChangeUpdatesOnlyPlusRecordAndKeepsPairingCredentials() {
        val store = FileDeviceStore(temp.newFolder())
        store.saveHost(creds("own", "https://own-relay.example", "own-secret"))
        store.saveHost(creds("plus", "https://old-plus-relay.example", "plus-secret"))
        store.updatePlusRelay("https://new-plus-relay.example")
        assertEquals("https://own-relay.example", store.host(hostId, "own")?.relayUrl)
        assertEquals("https://new-plus-relay.example", store.host(hostId, "plus")?.relayUrl)
        assertEquals("plus-secret", store.credentials(hostId, "plus")?.token)
        assertEquals("device-plus", store.credentials(hostId, "plus")?.deviceId)
    }

    @Test fun eachRecordKeepsItsOwnDeviceKey() {
        val store = FileDeviceStore(temp.newFolder())
        assertNull(store.keyFor(hostId, "plus"))
        store.saveHost(creds("own", "https://relay.example", "own-secret"))
        assertArrayEquals("older records use deviceKey", store.identity().publicKey, store.keyFor(hostId, "own")!!.publicKey)
        val kp = KeyPair.generate()
        store.saveHost(creds("plus", "https://plus-relay.example", "plus-secret"), keyPair = kp)
        assertArrayEquals(kp.publicKey, store.keyFor(hostId, "plus")!!.publicKey)
        assertArrayEquals(kp.publicKey, FileDeviceStore(store.dir).keyFor(hostId, "plus")!!.publicKey)
        store.updateHost(hostId, "plus") { it.copy(reapproveAt = 5) }
        assertEquals(5L, FileDeviceStore(store.dir).host(hostId, "plus")!!.reapproveAt)
    }

    @Test fun plusAdmissionTriesTheAllowedKeyAndAsksWithANewKeyAfterARevocation() {
        val device = RemoteDevice(FileDeviceStore(temp.newFolder()), app = "test", name = "phone")
        try {
            val own = KeyPair.generate()
            device.store.saveHost(creds("own", "https://relay.example", "own-secret"), keyPair = own)
            val tried = mutableListOf<KeyPair>()
            // the host already allowed this host's QR key: it is tried first
            device.admitPlus(hostId, "admit", "user-1") { kp -> tried += kp; creds("plus", "https://plus.example", "t1") }
            assertArrayEquals(own.publicKey, tried.single().publicKey)
            assertArrayEquals(own.publicKey, device.store.keyFor(hostId, "plus")!!.publicKey)
            // background reconnect of a revoked key: stays revoked
            tried.clear()
            assertEquals("revoked", assertThrows(PairError::class.java) {
                device.admitPlus(hostId, "admit", "user-1") { kp -> tried += kp; throw PairError("revoked") }
            }.code)
            assertEquals(1, tried.size)
            // the person asks again: a new key goes to the approval window
            tried.clear()
            device.admitPlus(hostId, "pair", "user-1") { kp ->
                tried += kp
                if (kp.publicKey.contentEquals(own.publicKey)) throw PairError("revoked") else creds("plus", "https://plus.example", "t2")
            }
            assertEquals(2, tried.size)
            assertFalse(tried[1].publicKey.contentEquals(own.publicKey))
            assertArrayEquals(tried[1].publicKey, device.store.keyFor(hostId, "plus")!!.publicKey)
            assertEquals("t2", device.store.credentials(hostId, "plus")!!.token)
        } finally { device.closeAll() }
    }
}
