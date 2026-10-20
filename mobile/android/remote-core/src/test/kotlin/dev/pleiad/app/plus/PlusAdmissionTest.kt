package dev.pleiad.app.plus

import dev.pleiad.app.remote.KeyPair
import dev.pleiad.app.remote.PairError
import dev.pleiad.app.remote.PairingCodec
import dev.pleiad.app.remote.Pleiad
import org.junit.Assert.assertEquals
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
    }
}
