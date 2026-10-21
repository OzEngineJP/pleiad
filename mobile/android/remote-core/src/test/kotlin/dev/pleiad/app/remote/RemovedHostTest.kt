package dev.pleiad.app.remote

import java.util.concurrent.atomic.AtomicInteger
import org.junit.Assert.assertEquals
import org.junit.Test

// A PC that was removed from the Plus account gets no more tickets (404, or 403 host_removed: PairError("unknown-host")).
// Retrying cannot help, so the links stop with "removed" instead of waiting as "offline".
class RemovedHostTest {
    private val hostId = "aaaaaaaaaaaaaaaaaaaaaaaaaa"
    private val key = ByteArray(32) { it.toByte() }
    private val creds = HostCreds(hostId, key, "http://127.0.0.1:9", "device-plus", "plus-token", "PC", "plus", "user-1")

    private fun waitFor(what: () -> Boolean) {
        val end = System.currentTimeMillis() + 3_000
        while (!what() && System.currentTimeMillis() < end) Thread.sleep(20)
    }

    @Test fun theDeviceLinkStopsWhenThePcWasRemoved() {
        val loop = Loop("test-loop")
        val asked = AtomicInteger()
        val link = DeviceLink(loop, creds, KeyPair.generate(), backoff = Backoff(10, 10, 10),
            plusTicket = { _, _ -> asked.incrementAndGet(); throw PairError("unknown-host") })
        try {
            link.start()
            waitFor { link.state == "removed" }
            Thread.sleep(200)
            assertEquals("removed", link.state)
            assertEquals("no retries", 1, asked.get())
        } finally {
            link.stop()
            loop.shutdown()
        }
    }

    @Test fun theNotifyLineStopsWhenThePcWasRemoved() {
        val asked = AtomicInteger()
        val line = NotifyLine(creds, key, onNotice = {}, backoff = Backoff(10, 10, 10),
            plusTicket = { asked.incrementAndGet(); throw PairError("unknown-host") })
        try {
            line.start()
            waitFor { line.state == "removed" }
            Thread.sleep(200)
            assertEquals("removed", line.state)
            assertEquals("no retries", 1, asked.get())
        } finally {
            line.stop()
        }
    }

    // A disabled account / an account not on Plus (PairError("plus-no-relay")) stops like the relay's 4401 'account';
    // Plus being paused (PairError("plus-paused")) is told as "paused", like the relay's 4401 'plus unavailable'
    @Test fun theDeviceLinkStopsWhenTheAccountOrPlusIsStopped() {
        for ((code, want) in listOf("plus-no-relay" to "blocked", "plus-paused" to "paused")) {
            val loop = Loop("test-loop")
            val asked = AtomicInteger()
            val link = DeviceLink(loop, creds, KeyPair.generate(), backoff = Backoff(10, 10, 10),
                plusTicket = { _, _ -> asked.incrementAndGet(); throw PairError(code) })
            try {
                link.start()
                waitFor { link.state == want }
                Thread.sleep(200)
                assertEquals(code, want, link.state)
                assertEquals("$code: no retries", 1, asked.get())
            } finally {
                link.stop()
                loop.shutdown()
            }
        }
    }

    @Test fun theNotifyLineStopsWhenTheAccountIsStopped() {
        val asked = AtomicInteger()
        val line = NotifyLine(creds, key, onNotice = {}, backoff = Backoff(10, 10, 10),
            plusTicket = { asked.incrementAndGet(); throw PairError("plus-no-relay") })
        try {
            line.start()
            waitFor { line.state == "blocked" }
            Thread.sleep(200)
            assertEquals("blocked", line.state)
            assertEquals("no retries", 1, asked.get())
        } finally {
            line.stop()
        }
    }

    // Nothing restarts a stopped notification line when Plus comes back, so a paused Plus is waited out with the backoff
    @Test fun theNotifyLineWaitsWhilePlusIsPaused() {
        val asked = AtomicInteger()
        val seen = java.util.Collections.synchronizedSet(mutableSetOf<String>())
        val line = NotifyLine(creds, key, onNotice = {}, onState = { seen.add(it) }, backoff = Backoff(10, 10, 10),
            plusTicket = { asked.incrementAndGet(); throw PairError("plus-paused") })
        try {
            line.start()
            waitFor { asked.get() >= 3 }
            assertEquals(true, "paused" in seen)
            assertEquals("keeps asking", true, asked.get() >= 3)
        } finally {
            line.stop()
        }
    }

    // The relay closes a removed PC's lines with 4401 'host': not a revocation to readmit, the PC is gone
    @Test fun aRemovedPcAndAStoppedAccountAreToldApartFromARevocation() {
        assertEquals("removed", LinkRules.classifyClose(4401, reason = "host", via = "plus"))
        assertEquals("removed", NotifyLine.classifyClose(4401, "host", "plus"))
        assertEquals("blocked", NotifyLine.classifyClose(4401, "account", "plus"))
        assertEquals("paused", NotifyLine.classifyClose(4401, "plus unavailable", "plus"))
        assertEquals("revoked", NotifyLine.classifyClose(4401, "host", "own"))
    }

    // Asking the host to admit this device again, or taking the ticket, fails the same way as the relay's close reasons
    @Test fun readmitAndTicketFailuresAreToldLikeTheRelayCloses() {
        assertEquals("removed", LinkRules.readmitFailedState("unknown-host"))
        assertEquals("blocked", LinkRules.readmitFailedState("plus-no-relay"))
        assertEquals("paused", LinkRules.readmitFailedState("plus-paused"))
        assertEquals("revoked", LinkRules.readmitFailedState(null))
        assertEquals("removed", LinkRules.ticketFailedState("unknown-host"))
        assertEquals("blocked", LinkRules.ticketFailedState("plus-no-relay"))
        assertEquals("paused", LinkRules.ticketFailedState("plus-paused"))
        assertEquals("offline", LinkRules.ticketFailedState("unreachable"))
    }

    @Test fun theNotifyLineTellsAnUpdateFromARevocation() {
        assertEquals("update", NotifyLine.classifyClose(4401, "update required", "plus"))
        assertEquals("revoked", NotifyLine.classifyClose(4401, "", "plus"))
        assertEquals("offline", NotifyLine.classifyClose(4401, "ticket", "plus"))
        assertEquals("revoked", NotifyLine.classifyClose(4401, "update required", "own"))
        assertEquals("host-offline", NotifyLine.classifyClose(4404, "", "plus"))
    }
}
