package dev.pleiad.app.plus

import dev.pleiad.app.remote.KeyPair
import dev.pleiad.app.remote.PairError
import dev.pleiad.app.remote.PairingCodec
import dev.pleiad.app.remote.Pleiad
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test

class PlusAdmissionTest {
    @Test fun hostIdMustMatchTheListedPublicKeyBeforeConnecting() {
        val key = KeyPair.generate().publicKey
        val host = PlusHost(Pleiad.hostIdFor(key), PairingCodec.b64urlEncode(key), "PC", "linux", true, null, null)
        assertEquals(key.toList(), PlusAdmission.publicKey(host).toList())
        val wrong = host.copy(hostId = "aaaaaaaaaaaaaaaaaaaaaaaaaa")
        assertEquals("couldnt-connect", assertThrows(PairError::class.java) { PlusAdmission.publicKey(wrong) }.code)
    }

    @Test fun deniedReasonsMapToTheSpecifiedOutcomes() {
        assertEquals("plus-no-relay", PlusAdmission.deniedCode("account", 0))
        assertEquals("plus-limit", PlusAdmission.deniedCode("devices", 0))
        assertEquals(null, PlusAdmission.deniedCode("rate", 0))
        assertEquals("plus-connecting", PlusAdmission.deniedCode("rate", 1))
        assertEquals("unreachable", PlusAdmission.deniedCode("unavailable", 0))
        assertEquals("plus-reapprove", PlusAdmission.deniedCode("approval", 0))
        assertEquals("revoked", PlusAdmission.deniedCode("revoked", 0))
        assertEquals("denied", PlusAdmission.deniedCode("rejected", 0))
        // the host takes tickets only and this version sent the ID token
        assertEquals("plus-update", PlusAdmission.deniedCode("update_required", 0))
    }

    @Test fun ticketFailuresMapToTheSpecifiedOutcomes() {
        assertEquals("plus-update", PlusAdmission.ticketError(PlusApiError(426, "update_required")).code)
        assertEquals("unknown-host", PlusAdmission.ticketError(PlusApiError(404, "not_found")).code)
        assertEquals("unknown-host", PlusAdmission.ticketError(PlusApiError(403, "host_removed")).code)
        // the account is disabled / not on Plus: like the relay's 4401 'account'
        assertEquals("plus-no-relay", PlusAdmission.ticketError(PlusApiError(403, "account_disabled")).code)
        assertEquals("plus-no-relay", PlusAdmission.ticketError(PlusApiError(403, "not_plus")).code)
        // Plus is paused: like the relay's 4401 'plus unavailable'
        assertEquals("plus-paused", PlusAdmission.ticketError(PlusApiError(503, "unavailable")).code)
        val other = PlusAdmission.ticketError(PlusApiError(500, "internal"))
        assertEquals("unreachable", other.code)
        assertEquals("ticket-500", other.detail)
        assertEquals("plus-update", PlusAdmission.handshakeClosed(4401, "update required").code)
        assertEquals("couldnt-connect", PlusAdmission.handshakeClosed(4401, "ticket").code)
    }

    @Test fun proofMatchesTheDesktop() {
        // the same inputs as core/plus/tickets.mjs proofFor gives gJCNGnow_8H31LdtWtwXoh-R8oG6Vy_Y05Mji-cYVOQ
        val proof = PlusTickets.proof(
            ByteArray(32) { 7 }, "abcdefghijklmnopqrstuvwxyz", PairingCodec.b64urlEncode(ByteArray(32) { 9 }),
            "rxhVyV5WGzRkxs5GodeRTeYYPPsWKc7PnOH4qCUzJ2s", PlusTickets.PURPOSE_DEVICE,
        )
        assertEquals("gJCNGnow_8H31LdtWtwXoh-R8oG6Vy_Y05Mji-cYVOQ", proof)
    }

    @Test fun issuerFallsBackOnlyForAnApiWithoutTickets() {
        var now = 0L
        var mark: Int? = null
        val calls = mutableListOf<String>()
        var tickets = false
        val post = { path: String, _: JSONObject ->
            calls += path
            when {
                !tickets -> throw PlusApiError(404, "not_found")
                path == "/v1/tickets/challenge" -> JSONObject().put("challengeId", "c").put("nonce", PairingCodec.b64urlEncode(ByteArray(32)))
                    .put("serverPublicKey", PairingCodec.b64urlEncode(KeyPair.generate().publicKey))
                else -> JSONObject().put("relay", "r.t.s").put("admission", "a.t.s")
            }
        }
        val issuer = PlusTicketIssuer(post, admission = { mark }, nowMs = { now })
        val kp = KeyPair.generate()
        assertNull(issuer.issue(PlusTickets.PURPOSE_DEVICE, kp, "h"))
        assertNull(issuer.issue(PlusTickets.PURPOSE_DEVICE, kp, "h"))
        assertEquals("an api without tickets is asked once, then not for a while", 1, calls.size)
        now += PlusTickets.UNSUPPORTED_MS + 1
        assertNull(issuer.issue(PlusTickets.PURPOSE_DEVICE, kp, "h"))
        assertEquals(2, calls.size)
        // the config says the api issues tickets: a 404 is the host's answer, not a missing api
        mark = 1
        assertEquals(404, assertThrows(PlusApiError::class.java) { issuer.issue(PlusTickets.PURPOSE_DEVICE, kp, "h") }.status)
        tickets = true
        assertEquals(PlusTicket("r.t.s", "a.t.s"), issuer.issue(PlusTickets.PURPOSE_DEVICE, kp, "h"))
    }
}
