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

    @Test fun theNotifyLineTellsAnUpdateFromARevocation() {
        assertEquals("update", NotifyLine.classifyClose(4401, "update required", "plus"))
        assertEquals("revoked", NotifyLine.classifyClose(4401, "", "plus"))
        assertEquals("offline", NotifyLine.classifyClose(4401, "ticket", "plus"))
        assertEquals("revoked", NotifyLine.classifyClose(4401, "update required", "own"))
        assertEquals("host-offline", NotifyLine.classifyClose(4404, "", "plus"))
    }
}
