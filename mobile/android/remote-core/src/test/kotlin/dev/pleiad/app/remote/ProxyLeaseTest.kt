package dev.pleiad.app.remote

import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

// The host windows keep the host's proxy open (leases, docs/remote.md §8.2): a window that finishes must not close
// a proxy another window has already started using — the race that left the new window on net::ERR_EMPTY_RESPONSE
// after a notification tap. Forced closes (unpairing, a route switch, sign-out) still win over the windows' holds.
class ProxyLeaseTest {
    @get:Rule val temp = TemporaryFolder()
    private val hostId = "aaaaaaaaaaaaaaaaaaaaaaaaaa"
    private val key = ByteArray(32) { it.toByte() }

    private fun device(): RemoteDevice {
        val d = RemoteDevice(FileDeviceStore(temp.newFolder()), app = "test", name = "phone")
        d.store.saveHost(HostCreds(hostId, key, "http://127.0.0.1:9", "device-own", "own-secret", "PC", "own"))
        d.store.saveHost(HostCreds(hostId, key, "http://127.0.0.1:9", "device-plus", "plus-secret", "PC", "plus", "user-1"))
        return d
    }

    @Test fun aWindowLeavingKeepsTheProxyAnotherWindowIsUsing() {
        val device = device()
        try {
            val (oldWindow, newWindow) = Any() to Any()
            val px = device.open(hostId, "own", oldWindow)
            assertSame("the new window reuses the open proxy", px, device.open(hostId, "own", newWindow))
            device.release(oldWindow)
            assertFalse("the old window's close must not cut the new window's load", px.closed)
            assertSame(px, device.proxy(hostId))
        } finally { device.closeAll() }
    }

    @Test fun theLastWindowLeavingClosesTheProxy() {
        val device = device()
        try {
            val (w1, w2) = Any() to Any()
            val px = device.open(hostId, "own", w1)
            device.open(hostId, "own", w2)
            device.release(w1)
            device.release(w2)
            assertTrue(px.closed)
            assertNull(device.proxy(hostId))
        } finally { device.closeAll() }
    }

    @Test fun aReleaseBeforeTheNextOpenJustCloses() {
        val device = device()
        try {
            // the old window's release lands before the new window opens: the proxy is gone, the open makes a fresh one
            val w1 = Any()
            val px1 = device.open(hostId, "own", w1)
            device.release(w1)
            assertTrue(px1.closed)
            val px2 = device.open(hostId, "own", Any())
            assertNotSame(px1, px2)
            assertFalse(px2.closed)
            assertSame(px2, device.proxy(hostId))
        } finally { device.closeAll() }
    }

    @Test fun removeClosesTheProxyWindowsAreUsing() {
        val device = device()
        try {
            val w = Any()
            val px = device.open(hostId, "own", w)
            device.remove(hostId, "own")
            assertTrue("unpairing wins over the windows' holds", px.closed)
            assertNull(device.proxy(hostId))
            device.release(w)   // a late release after the forced close is a no-op
        } finally { device.closeAll() }
    }

    @Test fun aRouteSwitchReplacesTheProxyEvenWithAWindowHoldingIt() {
        val device = device()
        try {
            val (w1, w2) = Any() to Any()
            val own = device.open(hostId, "own", w1)
            val plus = device.open(hostId, "plus", w2)
            assertNotSame(own, plus)
            assertTrue(own.closed)
            device.release(w1)   // the replaced proxy's release is a no-op
            assertFalse(plus.closed)
            assertSame(plus, device.proxy(hostId))
            device.release(w2)
            assertTrue(plus.closed)
        } finally { device.closeAll() }
    }

    @Test fun aReopenAfterAForcedCloseMovesTheHoldToTheNewProxy() {
        val device = device()
        try {
            val w = Any()
            val px1 = device.open(hostId, "own", w)
            device.close(hostId)   // e.g. sign-out: the forced close forgets the hold
            assertTrue(px1.closed)
            // the window retries (HostActivity's onReceivedError): it holds the new proxy, not the dead one
            val px2 = device.open(hostId, "own", w)
            assertNotSame(px1, px2)
            device.release(w)
            assertTrue(px2.closed)
            assertNull(device.proxy(hostId))
        } finally { device.closeAll() }
    }

    @Test fun aProxyOpenedWithoutAWindowIsNotHeldByReleases() {
        val device = device()
        try {
            val px = device.open(hostId, "own")   // the host list's "open" only makes sure the proxy exists
            device.release(Any())
            assertFalse(px.closed)
            assertSame(px, device.proxy(hostId))
        } finally { device.closeAll() }
    }
}
