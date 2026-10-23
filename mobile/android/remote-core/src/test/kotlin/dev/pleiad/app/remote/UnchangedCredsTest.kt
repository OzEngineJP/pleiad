package dev.pleiad.app.remote

import java.util.Collections
import java.util.concurrent.atomic.AtomicInteger
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

// The app reads the host list again and again (the list screen, the Plus ticks) and hands the same credentials back each time.
// Unchanged credentials must not cut the line or start a new attempt; a stopped line stays stopped, a waiting one keeps its backoff.
// A paused Plus is waited out by the line itself, so it comes back soon after Plus does.
class UnchangedCredsTest {
    private val hostId = "aaaaaaaaaaaaaaaaaaaaaaaaaa"
    private val key = ByteArray(32) { it.toByte() }
    private val creds = HostCreds(hostId, key, "http://127.0.0.1:9", "device-plus", "plus-token", "PC", "plus", "user-1")

    /** The same record read from the store again: equal content, new arrays */
    private fun sameAgain() = creds.copy(hostPublicKey = key.copyOf())

    private fun waitFor(what: () -> Boolean) {
        val end = System.currentTimeMillis() + 3_000
        while (!what() && System.currentTimeMillis() < end) Thread.sleep(20)
    }

    @Test fun credentialsReadAgainAreEqual() {
        assertEquals(creds, sameAgain())
        assertEquals(creds.hashCode(), sameAgain().hashCode())
        assertNotEquals(creds, creds.copy(relayUrl = "http://127.0.0.1:10"))
        assertNotEquals(creds, creds.copy(hostPublicKey = ByteArray(32)))
    }

    @Test fun aStoppedLineStaysStoppedForTheSameCredentials() {
        val loop = Loop("test-loop")
        val asked = AtomicInteger()
        val link = DeviceLink(loop, creds, KeyPair.generate(), backoff = Backoff(10, 10, 10),
            plusTicket = { _, _ -> asked.incrementAndGet(); throw PairError("plus-no-relay") })
        try {
            link.start()
            waitFor { link.state == "blocked" }
            repeat(3) { link.retryNow(sameAgain()); Thread.sleep(50) }
            Thread.sleep(200)
            assertEquals("blocked", link.state)
            assertEquals("no new attempt", 1, asked.get())
            // a different relay is new credentials: try again
            link.retryNow(creds.copy(relayUrl = "http://127.0.0.1:10"))
            waitFor { asked.get() == 2 }
            assertEquals(2, asked.get())
        } finally {
            link.stop()
            loop.shutdown()
        }
    }

    @Test fun aWaitingLineKeepsItsBackoffForTheSameCredentials() {
        val loop = Loop("test-loop")
        val asked = AtomicInteger()
        val link = DeviceLink(loop, creds, KeyPair.generate(), backoff = Backoff(1_000, 1_000, 10),
            plusTicket = { _, _ -> asked.incrementAndGet(); throw java.io.IOException("refused") })
        try {
            link.start()
            waitFor { link.state == "offline" }
            // the list screen reads the hosts every couple of seconds while the line waits
            repeat(5) { link.retryNow(sameAgain()); Thread.sleep(60) }
            assertEquals("offline", link.state)
            assertEquals("waits for the backoff", 1, asked.get())
        } finally {
            link.stop()
            loop.shutdown()
        }
    }

    @Test fun theProxyIgnoresTheSameCredentials() {
        val loop = Loop("test-loop")
        val asked = AtomicInteger()
        val px = DeviceProxy(loop, creds, KeyPair.generate(), backoff = Backoff(10, 10, 10),
            plusTicket = { _, _ -> asked.incrementAndGet(); throw PairError("plus-no-relay") })
        try {
            px.start()
            waitFor { px.link.state == "blocked" }
            repeat(3) { px.updateCredentials(sameAgain()); Thread.sleep(50) }
            Thread.sleep(200)
            assertEquals("blocked", px.link.state)
            assertEquals("no new attempt", 1, asked.get())
        } finally {
            px.close()
            loop.shutdown()
        }
    }

    @Test fun theNotifyLineIgnoresTheSameCredentials() {
        val asked = AtomicInteger()
        val line = NotifyLine(creds, key, onNotice = {}, backoff = Backoff(1_000, 1_000, 10),
            plusTicket = { asked.incrementAndGet(); throw java.io.IOException("refused") })
        try {
            line.start()
            waitFor { line.state == "offline" }
            repeat(5) { line.updateCredentials(sameAgain()); Thread.sleep(60) }
            assertEquals("offline", line.state)
            assertEquals("waits for the backoff", 1, asked.get())
        } finally {
            line.stop()
        }
    }

    // Plus paused: the line asks again by itself, more slowly each time, stays "paused" in between, and connects when Plus is back
    @Test fun aPausedLineAsksAgainAndComesBackWithPlus() {
        val loop = Loop("test-loop")
        val asked = Collections.synchronizedList(mutableListOf<Long>())
        val back = AtomicInteger()
        val seen = Collections.synchronizedList(mutableListOf<String>())
        val link = DeviceLink(loop, creds, KeyPair.generate(), backoff = Backoff(10, 10, 10, pausedMinMs = 100, pausedMaxMs = 400),
            plusTicket = { _, _ ->
                asked.add(System.currentTimeMillis())
                if (asked.size < 4) throw PairError("plus-paused")
                back.incrementAndGet()
                throw PairError("plus-no-relay") // Plus is back; this account just cannot use the relay, which stops the test line
            })
        link.onStatus { seen.add(it.state) }
        try {
            link.start()
            waitFor { link.state == "blocked" }
            assertEquals("asked again until Plus was back", 4, asked.size)
            assertEquals(1, back.get())
            val gaps = (1 until asked.size).map { asked[it] - asked[it - 1] }
            assertTrue("slower each time: $gaps", gaps[1] > gaps[0] && gaps[2] > gaps[1])
            // only the first attempt shows "connecting"; the quiet ones keep "paused"
            assertEquals(listOf("connecting", "paused", "paused", "paused", "blocked"), seen.toList())
        } finally {
            link.stop()
            loop.shutdown()
        }
    }
}
