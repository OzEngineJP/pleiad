package dev.pleiad.app.plus

// Pleiad Plus tickets (docs/plus.md "Tickets"): a device takes a relay ticket (role device, for X-Pleiad-Ticket) and
// an admission ticket (for the Noise message 1) from POST /v1/tickets/challenge → POST /v1/tickets, proving it holds
// its key. Mirrors core/plus/tickets.mjs (issueTicket / createTicketIssuer).

import dev.pleiad.app.remote.KeyPair
import dev.pleiad.app.remote.PairingCodec
import dev.pleiad.app.remote.Pleiad
import dev.pleiad.app.remote.X25519
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec
import org.json.JSONObject

/** relay: the relay ticket. admission: the admission ticket (purpose "device" only). */
data class PlusTicket(val relay: String, val admission: String?)

object PlusTickets {
    const val PURPOSE_DEVICE = "device"
    const val UNSUPPORTED_MS = 5 * 60_000L
    private const val PROOF_INFO = "pleiad host proof v1"

    /** b64u(HMAC-SHA256(HKDF(X25519(privateKey, serverPublicKey), "pleiad host proof v1"), nonce ‖ hostId ‖ purpose)) */
    fun proof(privateKey: ByteArray, hostId: String, nonce: String, serverPublicKey: String, purpose: String): String {
        val k = Pleiad.hkdfLabel(X25519.dh(privateKey, PairingCodec.b64urlDecode(serverPublicKey)), PROOF_INFO)
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(k, "HmacSHA256"))
        mac.update(PairingCodec.b64urlDecode(nonce))
        mac.update(hostId.toByteArray(Charsets.UTF_8))
        mac.update(purpose.toByteArray(Charsets.UTF_8))
        return PairingCodec.b64urlEncode(mac.doFinal())
    }

    /**
     * challenge → proof → issue. post(path, body) calls the api with the ID token and throws PlusApiError.
     * A 404 on the challenge (an api without tickets) is rethrown as [Unsupported].
     */
    fun issue(post: (String, JSONObject) -> JSONObject, purpose: String, keyPair: KeyPair, hostId: String): PlusTicket {
        val ch = try {
            post("/v1/tickets/challenge", JSONObject().put("purpose", purpose).put("publicKey", PairingCodec.b64urlEncode(keyPair.publicKey)).put("hostId", hostId))
        } catch (e: PlusApiError) {
            if (e.status == 404) throw Unsupported(e)
            throw e
        }
        val proof = proof(keyPair.privateKey, hostId, ch.optString("nonce"), ch.optString("serverPublicKey"), purpose)
        val o = post("/v1/tickets", JSONObject().put("challengeId", ch.optString("challengeId")).put("proof", proof))
        val relay = o.optString("relay").ifEmpty { throw PlusApiError(502, "bad_response") }
        return PlusTicket(relay, o.optString("admission").ifEmpty { null })
    }

    class Unsupported(val cause404: PlusApiError) : Exception("tickets unsupported")
}

/**
 * Takes tickets. On an api without tickets (the challenge is 404 and the config has no `admission`) returns null and
 * keeps returning null for [PlusTickets.UNSUPPORTED_MS] (the caller falls back to the ID token). An api whose config
 * says `admission` issues tickets, so a 404 there is thrown (the host is not registered).
 */
class PlusTicketIssuer(
    private val post: (String, JSONObject) -> JSONObject,
    private val admission: () -> Int?,
    private val nowMs: () -> Long = { System.currentTimeMillis() },
) {
    @Volatile private var unsupportedUntil = 0L

    fun issue(purpose: String, keyPair: KeyPair, hostId: String): PlusTicket? {
        if (nowMs() < unsupportedUntil && admission() == null) return null
        return try {
            PlusTickets.issue(post, purpose, keyPair, hostId).also { unsupportedUntil = 0 }
        } catch (e: PlusTickets.Unsupported) {
            if (admission() == null) {
                unsupportedUntil = nowMs() + PlusTickets.UNSUPPORTED_MS
                null
            } else throw e.cause404
        }
    }
}
