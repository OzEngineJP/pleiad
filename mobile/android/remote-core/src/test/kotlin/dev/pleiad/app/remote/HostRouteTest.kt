package dev.pleiad.app.remote

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

// A host paired both ways (own relay and Pleiad Plus) is one row; each place that opens it picks one route and uses
// that route's credentials only (docs/remote.md §8.2, approved 2026-10-21).
class HostRouteTest {
    @get:Rule val temp = TemporaryFolder()
    private val hostId = "aaaaaaaaaaaaaaaaaaaaaaaaaa"
    private val key = ByteArray(32) { it.toByte() }
    private var device: RemoteDevice? = null

    private fun creds(via: String, token: String = "$via-token") =
        HostCreds(hostId, key, "http://127.0.0.1:9", "device-$via", token, "PC", via, if (via == "plus") "user-1" else null)

    private fun device(vararg via: String) = RemoteDevice(FileDeviceStore(temp.newFolder()), "kt-test", "kt-phone", backoff = Backoff(60_000, 60_000, 60_000))
        .also { d -> device = d; for (v in via) d.store.saveHost(creds(v)) }

    @After fun closeAll() { device?.closeAll() }

    @Test fun plusOnlyWhileThePcIsOnlineThereAndAConnectedWindowKeepsItsRoute() {
        assertEquals("plus", HostRoute.choose(hasOwn = true, hasPlus = true, plusOnline = true))
        assertEquals("own", HostRoute.choose(hasOwn = true, hasPlus = true, plusOnline = false))
        assertEquals("own", HostRoute.choose(hasOwn = true, hasPlus = true, plusOnline = null))
        assertEquals("plus", HostRoute.choose(hasOwn = false, hasPlus = true, plusOnline = false))
        assertEquals("own", HostRoute.choose(hasOwn = true, hasPlus = false, plusOnline = true))
        assertEquals("own", HostRoute.choose(hasOwn = true, hasPlus = true, plusOnline = true, connectedVia = "own"))
        assertEquals("plus", HostRoute.choose(hasOwn = true, hasPlus = true, plusOnline = false, connectedVia = "plus"))
        assertNull(HostRoute.choose(hasOwn = false, hasPlus = false, plusOnline = true))
    }

    @Test fun aWindowOpenedWithoutARouteTakesTheOpenProxysRouteElseOwnElsePlus() {
        val d = device("own", "plus")
        assertEquals("own", d.routeFor(hostId))
        assertEquals("plus", d.routeFor(hostId, preferred = "plus"))
        d.open(hostId, "plus")
        assertEquals("plus", d.routeFor(hostId))
        assertEquals("plus", device("plus").routeFor(hostId))
    }

    @Test fun pairingOneRouteDoesNotRedialTheOtherRoutesWindowWithItsCredentials() {
        val d = device("plus")
        d.open(hostId, "plus")
        d.repaired(d.store.saveHost(creds("own")))
        assertEquals("plus", d.proxy(hostId)?.creds?.via)
        assertEquals("plus-token", d.proxy(hostId)?.creds?.token)
        d.repaired(d.store.saveHost(creds("plus", "plus-token-2")))
        assertEquals("plus-token-2", d.proxy(hostId)?.creds?.token)
    }

    @Test fun removingTheOtherRouteKeepsTheOpenWindow() {
        val d = device("own", "plus")
        d.open(hostId, "plus")
        d.remove(hostId, "own")
        assertEquals("plus", d.proxy(hostId)?.creds?.via)
        d.store.saveHost(creds("own"))
        d.remove(hostId, "plus")
        assertNull(d.proxy(hostId))
    }

    @Test fun aRecordsStateIsOnlyItsOwnRoutesWindow() {
        val d = device("own", "plus")
        d.open(hostId, "plus")
        val states = d.list().associate { it.first.via to it.second }
        assertNull(states["own"])
        assertEquals(true, states["plus"] != null)
    }
}
