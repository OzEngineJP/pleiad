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
}
