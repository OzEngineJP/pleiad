package dev.pleiad.app.plus

import java.net.URI
import java.net.URLDecoder
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PlusAuthTest {

    @Test fun challengeMatchesRfc7636AppendixB() {
        // RFC 7636 appendix B: this verifier must yield this challenge
        assertEquals(
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
            PlusAuth.challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
        )
    }

    @Test fun randomTokensAreBase64url() {
        val v = PlusAuth.randomToken()
        assertEquals(43, v.length) // 32 bytes, unpadded base64url
        assertTrue(v.matches(Regex("[A-Za-z0-9_-]+")))
    }

    private fun params(url: String): Map<String, String> {
        val q = URI(url).rawQuery ?: return emptyMap()
        return q.split('&').associate {
            val i = it.indexOf('=')
            URLDecoder.decode(it.substring(0, i), "UTF-8") to URLDecoder.decode(it.substring(i + 1), "UTF-8")
        }
    }

    @Test fun loginUrlCarriesPkceAndCallback() {
        val url = PlusAuth.loginUrl(
            "https://account.pleiad.dev/login",
            state = "ST",
            codeChallenge = "CH",
            lang = "ja",
        )
        val p = params(url)
        assertEquals("android", p["client"])
        assertEquals(PlusAuth.CALLBACK_URL, p["redirect_uri"])
        assertEquals("ST", p["state"])
        assertEquals("CH", p["code_challenge"])
        assertEquals("S256", p["code_challenge_method"])
        assertEquals("ja", p["lang"])
        // the redirect_uri is percent-encoded in the query
        assertTrue(url.contains("redirect_uri=https%3A%2F%2Faccount.pleiad.dev%2Fapp%2Fcallback"))
    }

    @Test fun loginUrlFallsBackToEnglish() {
        assertTrue(PlusAuth.loginUrl("https://x/login", "s", "c", "fr").endsWith("lang=en"))
    }

    @Test fun appLinkCallbackYieldsCodeAndState() {
        val cb = PlusAuth.parseCallback("https://account.pleiad.dev/app/callback?code=CODE&state=ST")
        assertNotNull(cb)
        assertEquals("CODE", cb!!.code)
        assertEquals("ST", cb.state)
        assertNull(cb.error)
    }

    @Test fun fallbackSchemeCallbackYieldsCodeAndState() {
        val cb = PlusAuth.parseCallback("pleiad://auth?code=CODE&state=ST")
        assertNotNull(cb)
        assertEquals("CODE", cb!!.code)
        assertEquals("ST", cb.state)
    }

    @Test fun callbackWithErrorIsParsed() {
        val cb = PlusAuth.parseCallback("https://account.pleiad.dev/app/callback?error=access_denied&state=ST")
        assertEquals("access_denied", cb!!.error)
        assertNull(cb.code)
    }

    @Test fun unrelatedLinksAreNotCallbacks() {
        for (u in listOf(
            "https://account.pleiad.dev/app/other?code=x&state=y",
            "https://evil.example/app/callback?code=x&state=y",
            "pleiad://pair?v=1",
            "pleiad://open?h=x",
            "http://account.pleiad.dev/app/callback?code=x&state=y",
        )) {
            assertNull(u, PlusAuth.parseCallback(u))
        }
    }

    @Test fun stateMustMatchConstantTime() {
        assertTrue(PlusAuth.stateMatches("abc", "abc"))
        assertFalse(PlusAuth.stateMatches("abc", "abd"))
        assertFalse(PlusAuth.stateMatches("abc", null))
        assertFalse(PlusAuth.stateMatches("abc", "abcd"))
    }

    @Test fun pendingExpiresAfterTenMinutes() {
        val now = 1_000_000_000L
        val p = PlusAuth.Pending("v", "s", now)
        assertTrue(p.fresh(now))
        assertTrue(p.fresh(now + PlusAuth.PENDING_TTL_MS))
        assertFalse(p.fresh(now + PlusAuth.PENDING_TTL_MS + 1))
        // a pending from the "future" (clock moved back) is not trusted either
        assertFalse(p.fresh(now - 1))
    }

    @Test fun pendingRoundTripsJson() {
        val p = PlusAuth.Pending("verifier-1", "state-1", 42L)
        val back = PlusAuth.Pending.parse(p.toJson().toString())
        assertEquals(p, back)
    }
}
