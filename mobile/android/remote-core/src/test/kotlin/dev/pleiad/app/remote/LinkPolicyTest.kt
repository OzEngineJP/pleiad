package dev.pleiad.app.remote

import java.net.URI
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The same cases as tests/unit/remote-links.mjs (desktop linkTarget). */
class LinkPolicyTest {
    private val proxy = 51234

    private fun of(url: String): LinkTarget {
        val u = URI(url)
        return LinkPolicy.classify(u.scheme, u.host, u.port, u.path, u.rawUserInfo != null, proxy)
    }

    @Test fun snapshotOnTheProxyOnly() {
        assertEquals(LinkTarget.SNAPSHOT, of("http://127.0.0.1:$proxy/visualization-snapshot?sessionId=s&id=i"))
        assertEquals(LinkTarget.BLOCKED, of("http://127.0.0.1:$proxy/"))
        assertEquals(LinkTarget.BLOCKED, of("http://127.0.0.1:$proxy/local-file?path=x"))
        assertEquals(LinkTarget.BLOCKED, of("http://127.0.0.1:$proxy/visualization-snapshot/x"))
        // Another port on the device is not this window's proxy
        assertEquals(LinkTarget.HOST_ONLY, of("http://127.0.0.1:${proxy + 1}/visualization-snapshot?id=i"))
        assertEquals(LinkTarget.HOST_ONLY, of("https://127.0.0.1:$proxy/visualization-snapshot?id=i"))
    }

    @Test fun webPagesGoToTheBrowser() {
        assertEquals(LinkTarget.EXTERNAL, of("https://example.com/a?b=c"))
        assertEquals(LinkTarget.EXTERNAL, of("http://example.org/"))
        assertEquals(LinkTarget.EXTERNAL, of("http://192.168.1.10:3000/"))
        assertEquals(LinkTarget.BLOCKED, of("https://user:pass@example.com/"))
        assertEquals(LinkTarget.BLOCKED, of("intent://scan/#Intent;scheme=zxing;end"))
        assertEquals(LinkTarget.BLOCKED, of("file:///sdcard/x.html"))
        assertEquals(LinkTarget.BLOCKED, of("javascript:alert(1)"))
    }

    @Test fun close1013RetriesAsOffline() {
        // The relay's authz plugin failed transiently (docs/remote.md §5.7). Not a revocation.
        assertEquals("offline", LinkRules.classifyClose(1013))
    }

    @Test fun plusCloseReasonsUseTheAccountLinkPolicy() {
        val cases = listOf(
            Triple(4404, "", "host-offline"),
            Triple(4401, "revoked", "readmit"),
            Triple(4401, "device token", "readmit"),
            Triple(4401, "account", "blocked"),
            Triple(4401, "token", "offline"),
            Triple(4401, "plus off", "host-offline"),
            Triple(4401, "plus unavailable", "paused"),
            Triple(4401, "host closed", "readmit"),
            Triple(4401, "", "readmit"),
            Triple(4429, "account limit", "limit"),
            Triple(4429, "admit rate", "offline"),
            Triple(1013, "", "offline"),
        )
        for ((code, reason, expected) in cases) assertEquals("$code $reason", expected, LinkRules.classifyClose(code, reason = reason, via = "plus"))
        assertEquals("revoked", LinkRules.classifyClose(4401, via = "own"))
        // the host dropped this device's channel (revoked, or it must be allowed again): ask the host again for its answer
        assertEquals("readmit", LinkRules.classifyClose(1000, goaway = "revoked", via = "plus"))
        assertEquals("revoked", LinkRules.classifyClose(1000, goaway = "revoked", via = "own"))
    }

    @Test fun loopbackIsTheHostsPc() {
        for (u in listOf("http://localhost:3000/", "http://LOCALHOST/", "http://app.localhost:5173/", "http://127.0.0.1:5173/",
            "http://127.1.2.3/", "http://0.0.0.0:8080/", "http://[::1]:3000/", "https://localhost./")) {
            assertEquals(u, LinkTarget.HOST_ONLY, of(u))
        }
        assertTrue(LinkPolicy.isLoopbackHost("::ffff:7f00:1"))
        assertTrue(LinkPolicy.isLoopbackHost("[::ffff:127.0.0.1]"))
        assertFalse(LinkPolicy.isLoopbackHost("localhost.example.com"))
        assertFalse(LinkPolicy.isLoopbackHost("128.0.0.1"))
        assertFalse(LinkPolicy.isLoopbackHost(null))
    }
}
