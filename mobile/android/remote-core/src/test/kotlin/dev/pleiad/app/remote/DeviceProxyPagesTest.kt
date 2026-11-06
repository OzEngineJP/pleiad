package dev.pleiad.app.remote

import org.junit.Assert.*
import org.junit.Test
import java.net.Socket

class DeviceProxyPagesTest {
    @Test fun pageBodyLimitsFollowTheNormalizedPath() {
        assertEquals(8L * 1024 * 1024, DeviceProxy.pageResponseLimit("/_pleiad/s/session/files"))
        assertEquals(8L * 1024 * 1024, DeviceProxy.pageResponseLimit("/a/../_pleiad/s/session/api/text"))
        assertEquals(8L * 1024 * 1024, DeviceProxy.pageResponseLimit("/%5fpleiad/s/session/files"))
        assertEquals(8L * 1024 * 1024, DeviceProxy.pageResponseLimit("/x/%2e%2e/_pleiad/s/session/files"))
        assertEquals(32L * 1024 * 1024, DeviceProxy.pageResponseLimit("/_pleiad/s/session/api/raw"))
        assertEquals(32L * 1024 * 1024, DeviceProxy.pageResponseLimit("/viz/key/index.html", true))
        assertEquals(0L, DeviceProxy.pageResponseLimit("/local-file"))
    }

    @Test fun listenersCheckHostsAndPageCookiesBeforeConnecting() {
        val loop = Loop("proxy-pages-test")
        val creds = HostCreds("h", ByteArray(32), "http://127.0.0.1:9", "d", "t", "desk")
        val px = DeviceProxy(loop, creds, KeyPair.generate(), requestWaitMs = 1)
        fun status(port: Int, host: String, path: String, headers: String = "", address: String = "127.0.0.1"): Int {
            Socket(address, port).use { s ->
                s.soTimeout = 3000
                s.getOutputStream().write("GET $path HTTP/1.1\r\nHost: $host\r\n$headers\r\n".toByteArray())
                return s.getInputStream().bufferedReader().readLine().split(' ')[1].toInt()
            }
        }
        try {
            px.start()
            assertTrue(px.isolatedPort > 0 && px.isolatedPort != px.port)
            assertEquals(401, status(px.port, "127.0.0.1:${px.port}", "/_pleiad/s/s/files?token=${px.token}"))
            assertEquals(401, status(px.port, "127.0.0.1:${px.port}", "/x/%2e%2e/_pleiad/s/s/files?token=${px.token}"))
            assertEquals(403, status(px.isolatedPort, "127.0.0.1:${px.isolatedPort}", "/viz/key/index.html"))
            assertEquals(403, status(px.isolatedPort, "localhost:${px.isolatedPort}", "/_pleiad/s/s/files"))
            // Valid paths reach the offline link; neither cookie nor query token opens a main-UI route on this origin.
            assertEquals(503, status(px.isolatedPort, "localhost:${px.isolatedPort}", "/viz/key/index.html", "Accept: text/html\r\n"))
            if (java.net.NetworkInterface.getByInetAddress(java.net.InetAddress.getByName("::1")) != null) {
                assertEquals(503, status(px.isolatedPort, "localhost:${px.isolatedPort}", "/viz/key/index.html", "Accept: text/html\r\n", "::1"))
            }
            assertEquals(403, status(px.isolatedPort, "localhost:${px.isolatedPort}", "/?token=${px.token}", "Cookie: ${DeviceProxy.PROXY_COOKIE}=${px.token}\r\n"))
        } finally {
            val main = px.port
            val isolated = px.isolatedPort
            px.close(); loop.shutdown()
            for (port in listOf(main, isolated)) {
                try { Socket("127.0.0.1", port).use { fail("listener still open") } } catch (_: java.io.IOException) {}
            }
        }
    }

    @Test fun isolatedListenerOnlyForwardsKeyedContentPaths() {
        assertTrue(DeviceProxy.isIsolatedPath("/viz/key/index.html"))
        assertTrue(DeviceProxy.isIsolatedPath("/f/key/a.html"))
        for (path in listOf("/", "/api/env", "/ws", "/_pleiad/s/session/files", "/viz/../../api/env", "//evil/viz/key")) {
            assertFalse(path, DeviceProxy.isIsolatedPath(path))
        }
    }
}
