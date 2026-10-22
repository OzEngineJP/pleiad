package dev.pleiad.app.remote

import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

// A line on the Plus route needs the account's ID token, and getting it may refresh it over the network (up to minutes
// of retries). The service starts the lines on the main thread, so start() must not wait for the token.
class NotifyLineTokenTest {
    private val hostId = "aaaaaaaaaaaaaaaaaaaaaaaaaa"
    private val key = ByteArray(32) { it.toByte() }
    private fun creds(via: String) =
        HostCreds(hostId, key, "http://127.0.0.1:9", "device-$via", "$via-token", "PC", via, if (via == "plus") "user-1" else null)

    @Test fun startDoesNotWaitForThePlusTokenOnTheCallersThread() {
        val release = CountDownLatch(1)
        val asked = CountDownLatch(1)
        var askedOn = ""
        val states = mutableListOf<String>()
        val line = NotifyLine(creds("plus"), key, onNotice = {}, onState = { synchronized(states) { states.add(it) } },
            backoff = Backoff(60_000, 60_000, 60_000), plusIdToken = {
                askedOn = Thread.currentThread().name
                asked.countDown()
                release.await(10, TimeUnit.SECONDS)
                null
            })
        try {
            val starter = Thread { line.start() }.apply { start() }
            starter.join(2_000)
            assertFalse("start() waited for the token", starter.isAlive)
            assertTrue(asked.await(2, TimeUnit.SECONDS))
            assertTrue("the token was fetched on $askedOn", askedOn.startsWith("pleiad-notify-line"))
            release.countDown()
            val end = System.currentTimeMillis() + 2_000
            while (line.state != "offline" && System.currentTimeMillis() < end) Thread.sleep(20)
            assertEquals("offline", line.state) // no token: wait and try again later
        } finally {
            release.countDown()
            line.stop()
        }
    }
}
