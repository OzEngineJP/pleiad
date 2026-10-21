package dev.pleiad.app.remote

import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

// One notification line per host, on one route (own or Plus) with that route's credentials (docs/remote.md §11-5).
// A host paired both ways must not have its own line switched to the Plus credentials, and a Plus-only host gets a line.
class NotifyHubRouteTest {
    @get:Rule val temp = TemporaryFolder()
    private val hostId = "aaaaaaaaaaaaaaaaaaaaaaaaaa"
    private val key = ByteArray(32) { it.toByte() }

    private fun creds(via: String, relay: String = "http://127.0.0.1:9") =
        HostCreds(hostId, key, relay, "device-$via", "$via-token", "PC", via, if (via == "plus") "user-1" else null)

    private fun store(vararg via: String) = FileDeviceStore(temp.newFolder()).apply {
        for (v in via) saveHost(creds(v))
        saveNotifySettings(NotifySettings(enabled = true))
    }

    private fun hub(store: FileDeviceStore) = NotifyHub(store, Loop(), "kt-test", "kt-phone", object : NotifySink {
        override fun act(actions: List<NotifyAction>, settings: NotifySettings) {}
    }, lineBackoff = Backoff(60_000, 60_000, 60_000), plusIdToken = { null })

    @Suppress("UNCHECKED_CAST")
    private fun line(hub: NotifyHub): HostCreds? {
        val f = NotifyHub::class.java.getDeclaredField("lines").apply { isAccessible = true }
        return (f.get(hub) as Map<String, NotifyLine>)[hostId]?.creds
    }

    private fun <T> using(hub: NotifyHub, fn: () -> T): T = try { hub.start(); fn() } finally { hub.stop() }

    @Test fun aPlusOnlyHostGetsALineWithThePlusCredentials() {
        val hub = hub(store("plus"))
        using(hub) {
            assertEquals("plus", line(hub)?.via)
            assertEquals("plus-token", line(hub)?.token)
        }
    }

    @Test fun aPlusRelayChangeDoesNotMoveTheOwnLineToThePlusCredentials() {
        val s = store("own", "plus")
        val hub = hub(s)
        using(hub) {
            assertEquals("own", line(hub)?.via)
            s.updatePlusRelay("https://plus-relay-2.example")
            hub.plusRelayChanged()
            assertEquals("own", line(hub)?.via)
            assertEquals("own-token", line(hub)?.token)
        }
    }

    @Test fun theLineMovesToTheRouteThatIsLeftWhenOneIsRemoved() {
        val s = store("own", "plus")
        val hub = hub(s)
        using(hub) {
            s.removeHost(hostId, "own")
            hub.hostsChanged()
            assertEquals("plus", line(hub)?.via)
            assertEquals("plus-token", line(hub)?.token)
        }
    }
}
