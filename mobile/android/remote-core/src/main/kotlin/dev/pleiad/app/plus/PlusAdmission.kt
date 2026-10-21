package dev.pleiad.app.plus

import dev.pleiad.app.remote.Handshake
import dev.pleiad.app.remote.HostCreds
import dev.pleiad.app.remote.PAIRING_TTL_MS
import dev.pleiad.app.remote.PairError
import dev.pleiad.app.remote.Pairing
import dev.pleiad.app.remote.PairingCodec
import dev.pleiad.app.remote.Pattern
import dev.pleiad.app.remote.Pleiad
import dev.pleiad.app.remote.RelayClosed
import dev.pleiad.app.remote.RelaySocket
import dev.pleiad.app.remote.RelayTimeout
import dev.pleiad.app.remote.KeyPair
import org.json.JSONObject

/**
 * Connection to a listed host: prove the account identity inside the encrypted IK handshake (ADR 0245).
 * The account alone does not admit a key. mode "admit" (background reconnect) only works for a key the host
 * already allowed; mode "pair" (the person picked the host) goes to the approval window on the host's screen
 * with the same confirmation code as the QR pairing.
 */
object PlusAdmission {
    const val WAIT_MS = 20_000L
    const val MODE_ADMIT = "admit"
    const val MODE_PAIR = "pair"

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
        "approval" -> "plus-reapprove"      // the host has not allowed this key (or wants it allowed again)
        "revoked" -> "revoked"
        "rejected" -> "denied"
        else -> "couldnt-connect"
    }

    /**
     * mode "pair": after the handshake the host answers { waiting }; onCode(6 digits) is called and this waits
     * (up to the pairing TTL) for the person on the host's screen. handle.cancel() aborts (PairError("aborted")).
     */
    fun admit(host: PlusHost, relayUrl: String, idToken: String, keyPair: KeyPair, name: String, app: String,
              connectTimeoutMs: Long = 15_000, sleepMs: (Long) -> Unit = { Thread.sleep(it) },
              mode: String = MODE_ADMIT, onCode: (String) -> Unit = {}, handle: Pairing? = null,
              pairTimeoutMs: Long = PAIRING_TTL_MS + 30_000): HostCreds {
        val key = publicKey(host)
        val pairing = mode == MODE_PAIR
        val cancelled = { handle?.cancelled == true }
        repeat(2) { attempt ->
            if (cancelled()) throw PairError("aborted")
            val sock = RelaySocket(
                PairingCodec.relayWsUrl(relayUrl, "/v1/device"),
                mapOf("x-pleiad-host" to host.hostId, "x-pleiad-account" to idToken), connectTimeoutMs,
            )
            handle?.socket = sock
            if (cancelled()) sock.terminate()
            try {
                val opened = sock.awaitOpen()
                if (cancelled()) throw PairError("aborted")
                if (!opened.open) throw PairError("unreachable", opened.status?.toString() ?: "")
                val hs = Handshake(Pattern.IK, true, Pleiad.prologueFor(host.hostId), keyPair, remoteStatic = key)
                val hello = JSONObject().put("proto", 1).put("name", PairingCodec.cleanLabel(name)).put("platform", "android")
                    .put("app", app).put("plus", JSONObject().put("idToken", idToken))
                sock.send(hs.writeMessage(hello.toString().toByteArray(Charsets.UTF_8)))
                try { hs.readMessage(sock.next(connectTimeoutMs)) } catch (_: Exception) { throw PairError("couldnt-connect", "handshake") }
                val transport = hs.split()
                val code = Pleiad.confirmationCode(hs.handshakeHash)
                sock.send(transport.encrypt(JSONObject().put("type", if (pairing) MODE_PAIR else MODE_ADMIT).toString().toByteArray(Charsets.UTF_8)))
                val read = { waitMs: Long ->
                    try { JSONObject(String(transport.decrypt(sock.next(waitMs)), Charsets.UTF_8)) }
                    catch (e: RelayClosed) { if (cancelled()) throw PairError("aborted"); throw PairError("couldnt-connect", "closed-${e.code}", e.code) }
                    catch (_: RelayTimeout) { throw PairError(if (pairing) "timeout" else "couldnt-connect", "timeout") }
                }
                var reply = read(WAIT_MS)
                if (pairing && reply.optString("type") == "waiting") {
                    try { onCode(code) } catch (_: Exception) {}
                    reply = read(pairTimeoutMs)
                }
                when (reply.optString("type")) {
                    "denied" -> {
                        val reason = reply.optString("reason")
                        // the person is waiting on the screen: say "too many requests" now instead of sleeping
                        if (pairing && reason == "rate") throw PairError("rate")
                        val denied = deniedCode(reason, attempt)
                        if (denied == null) { sleepMs(60_000); return@repeat }
                        throw PairError(denied)
                    }
                    "expired" -> throw PairError("expired")
                    "approved" -> return HostCreds(host.hostId, key, relayUrl, reply.getString("deviceId"), reply.getString("token"),
                        PairingCodec.cleanLabel(reply.optString("hostName").ifEmpty { host.name }), "plus")
                    else -> throw PairError("couldnt-connect", "bad-response")
                }
            } catch (e: PairError) {
                if (cancelled() && e.code != "aborted") throw PairError("aborted")
                throw e
            } finally {
                handle?.socket = null
                if (sock.closed == null) sock.close(1000) else sock.terminate()
            }
        }
        throw PairError("plus-connecting")
    }
}
