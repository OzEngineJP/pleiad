package dev.pleiad.app.plus

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PlusConfigTest {

    private fun config(state: String = "on", visibility: String = "optin") = PlusConfig(
        state = state,
        visibility = visibility,
        tokenProjectId = "test-project",
        tokenApiKey = "test-api-key",
        loginUrl = "https://account.pleiad.dev/login",
        accountUrl = "https://account.pleiad.dev/account",
        profileUrl = "https://account.pleiad.dev/profile",
        relayUrl = "wss://relay.pleiad.dev",
        refreshUrl = "https://securetoken.googleapis.com/v1/token",
        minClientAndroid = "0.32.0",
    )

    @Test fun parsesOnlyTheFieldsTheClientUses() {
        // unknown fields (and a whole extra object) must be ignored, not fail
        val text = """{
            "state": "maintenance",
            "token": {"projectId": "test-project", "apiKey": "test-api-key", "future": 1},
            "urls": {"login": "https://a/login", "account": "https://a/account", "profile": "https://a/profile",
                     "relay": "wss://r", "refresh": "https://f", "extra": "x"},
            "minClient": {"desktop": "9.9.9", "android": "0.32.0", "ios": "0.32.0"},
            "signIn": {"apiKey": "page-only", "providers": ["google.com"]},
            "mode": "whatever"
        }"""
        val c = PlusConfig.parse(text)!!
        assertEquals("maintenance", c.state)
        assertEquals("test-project", c.tokenProjectId)
        assertEquals("test-api-key", c.tokenApiKey)
        assertEquals("https://a/login", c.loginUrl)
        assertEquals("wss://r", c.relayUrl)
        assertEquals("0.32.0", c.minClientAndroid)
        // nothing from signIn/mode leaks in: there is no place for it in the shape
        assertFalse(c.toJson().has("signIn"))
        assertFalse(c.toJson().has("mode"))
    }

    @Test fun missingSectionsTolerated() {
        val c = PlusConfig.parse("""{"state":"off"}""")!!
        assertEquals("off", c.state)
        assertNull(c.tokenProjectId)
        assertNull(c.minClientAndroid)
        assertNull(PlusConfig.parse("not json"))
    }

    @Test fun visibilityDefaultsToOptin() {
        // absent or unknown → optin (hidden until the device opts in); only "public" shows the entrance
        assertEquals("optin", PlusConfig.parse("""{"state":"on"}""")!!.visibility)
        assertEquals("optin", PlusConfig.parse("""{"state":"on","visibility":"beta"}""")!!.visibility)
        assertEquals("public", PlusConfig.parse("""{"state":"on","visibility":"public"}""")!!.visibility)
        val c = config(visibility = "public")
        assertEquals(c, PlusConfig.parse(c.toJson().toString()))
    }

    @Test fun unreadableFetchFallsBackToLastGood() {
        val saved = config("on")
        assertEquals(saved, PlusConfig.choose(fetched = null, saved = saved))
        val fresh = config("maintenance")
        assertEquals(fresh, PlusConfig.choose(fetched = fresh, saved = saved))
        assertNull(PlusConfig.choose(fetched = null, saved = null))
    }

    @Test fun roundTripsThroughJson() {
        val c = config()
        assertEquals(c, PlusConfig.parse(c.toJson().toString()))
        val v2 = c.copy(admission = 2)
        assertEquals(v2, PlusConfig.parse(v2.toJson().toString()))
    }

    @Test fun admissionIsTheNumberOrAbsent() {
        // a number: the api issues tickets. Absent: an api from before tickets
        assertEquals(1, PlusConfig.parse("""{"state":"on","admission":1}""")!!.admission)
        assertNull(PlusConfig.parse("""{"state":"on"}""")!!.admission)
        assertNull(PlusConfig.parse("""{"state":"on","admission":"2"}""")!!.admission)
        assertFalse(config().toJson().has("admission"))
    }

    @Test fun versionComparesNumerically() {
        // "0.32.10" must sort after "0.32.0" — a string compare would get this wrong
        assertTrue(PlusVersion.isOlder("0.32.0", "0.32.10"))
        assertTrue(PlusVersion.isOlder("0.32.9", "0.32.10"))
        assertFalse(PlusVersion.isOlder("0.32.10", "0.32.10"))
        assertFalse(PlusVersion.isOlder("0.32.11", "0.32.10"))
        assertFalse(PlusVersion.isOlder("0.32.0", "0.32.0"))
        // versionName carries the build suffix "<version>-<versionCode>"
        assertFalse(PlusVersion.isOlder("0.32.10-1234", "0.32.10"))
        assertTrue(PlusVersion.isOlder("0.31.99-99", "0.32.0"))
        assertEquals(0, PlusVersion.compare("0.32", "0.32.0"))
    }
}
