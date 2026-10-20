package dev.pleiad.app.plus

import dev.pleiad.app.remote.Handshake
import dev.pleiad.app.remote.HostCreds
import dev.pleiad.app.remote.PairError
import dev.pleiad.app.remote.PairingCodec
import dev.pleiad.app.remote.Pattern
import dev.pleiad.app.remote.Pleiad
import dev.pleiad.app.remote.RelayClosed
import dev.pleiad.app.remote.RelaySocket
import dev.pleiad.app.remote.RelayTimeout
import dev.pleiad.app.remote.KeyPair
import org.json.JSONObject

/** First connection to a listed host: prove the account identity inside the encrypted IK handshake. */
object PlusAdmission {
    const val WAIT_MS = 20_000L

    internal fun publicKey(host: PlusHost): ByteArray {
        val key = try { PairingCodec.b64urlDecode(host.publicKey) } catch (_: Exception) { byteArrayOf() }
        if (key.size != 32 || host.hostId != Pleiad.hostIdFor(key)) throw PairError("couldnt-connect", "host-key")
        return key
    }

    /** Null means wait 60 seconds and make the one permitted retry. */
    internal fun deniedCode(reason: String, attempt: Int): String? = when (reason) {
        "account" -> "plus-no-relay"
        "devices" -> "plus-limit"
        "rate" -> if (attempt == 0) null else "plus-connecting"
        "unavailable" -> "unreachable"
        else -> "couldnt-connect"
    }

    fun admit(host: PlusHost, relayUrl: String, idToken: String, keyPair: KeyPair, name: String, app: String,
              connectTimeoutMs: Long = 15_000, sleepMs: (Long) -> Unit = { Thread.sleep(it) }): HostCreds {
        val key = publicKey(host)
        repeat(2) { attempt ->
            val sock = RelaySocket(
                PairingCodec.relayWsUrl(relayUrl, "/v1/device"),
                mapOf("x-pleiad-host" to host.hostId, "x-pleiad-account" to idToken), connectTimeoutMs,
            )
            try {
                val opened = sock.awaitOpen()
                if (!opened.open) throw PairError("unreachable", opened.status?.toString() ?: "")
                val hs = Handshake(Pattern.IK, true, Pleiad.prologueFor(host.hostId), keyPair, remoteStatic = key)
                val hello = JSONObject().put("proto", 1).put("name", PairingCodec.cleanLabel(name)).put("platform", "android")
                    .put("app", app).put("plus", JSONObject().put("idToken", idToken))
                sock.send(hs.writeMessage(hello.toString().toByteArray(Charsets.UTF_8)))
                try { hs.readMessage(sock.next(connectTimeoutMs)) } catch (_: Exception) { throw PairError("couldnt-connect", "handshake") }
                val transport = hs.split()
                sock.send(transport.encrypt(JSONObject().put("type", "admit").toString().toByteArray(Charsets.UTF_8)))
                val reply = try { JSONObject(String(transport.decrypt(sock.next(WAIT_MS)), Charsets.UTF_8)) }
                catch (e: RelayClosed) { throw PairError("couldnt-connect", "closed-${e.code}", e.code) }
                catch (_: RelayTimeout) { throw PairError("couldnt-connect", "timeout") }
                when (reply.optString("type")) {
                    "denied" -> {
                        val code = deniedCode(reply.optString("reason"), attempt)
                        if (code == null) { sleepMs(60_000); return@repeat }
                        throw PairError(code)
                    }
                    "approved" -> return HostCreds(host.hostId, key, relayUrl, reply.getString("deviceId"), reply.getString("token"),
                        PairingCodec.cleanLabel(reply.optString("hostName").ifEmpty { host.name }), "plus")
                    else -> throw PairError("couldnt-connect", "bad-response")
                }
            } finally { sock.close(1000) }
        }
        throw PairError("plus-connecting")
    }
}
