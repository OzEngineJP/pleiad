package dev.pleiad.app.remote

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ResumePolicyTest {
    private fun host(id: String, revokedAt: Long? = null, via: String = "own") = HostRecord(id, "pc-$id", "", "https://relay.example", "key", "dev", 0, 1L, 2L, revokedAt, via)
    private val hosts = listOf(host("a"), host("b", revokedAt = 5L))

    private fun decide(saved: String?, fresh: Boolean = true, launcher: Boolean = true, list: List<HostRecord> = hosts, via: String? = null) =
        ResumePolicy.decide(saved, list, fresh, launcher, via)

    @Test fun opensTheSavedHostOnAFreshLauncherStart() {
        assertEquals(ResumeDecision("a", false, "own"), decide("a"))
    }

    // The last host reopens with the route it was open with; a host paired only with Plus reopens with Plus (not "own").
    @Test fun reopensWithTheSavedRouteWhileThatPairingIsUsable() {
        assertEquals(ResumeDecision("p", false, "plus"), decide("p", list = listOf(host("p", via = "plus"))))
        val both = listOf(host("a"), host("a", via = "plus"))
        assertEquals(ResumeDecision("a", false, "plus"), decide("a", list = both, via = "plus"))
        assertEquals(ResumeDecision("a", false, "own"), decide("a", list = both, via = null))
        assertEquals(ResumeDecision("a", false, "own"), decide("a", list = listOf(host("a"), host("a", 5L, "plus")), via = "plus"))
        // A Plus label placeholder (renamed before the first connection) has no device credentials
        val placeholder = host("p", via = "plus").copy(deviceId = "")
        assertEquals(ResumeDecision(null, true), decide("p", list = listOf(placeholder), via = "plus"))
    }

    @Test fun showsTheListWhenNothingIsSaved() {
        assertEquals(ResumeDecision(null, false), decide(null))
        assertEquals(ResumeDecision(null, false), decide(""))
    }

    @Test fun showsTheListWhenRestoredOrOpenedByAPairLink() {
        assertEquals(ResumeDecision(null, false), decide("a", fresh = false))
        assertEquals(ResumeDecision(null, false), decide("a", launcher = false))
    }

    @Test fun forgetsAHostThatIsGoneOrRevoked() {
        assertEquals(ResumeDecision(null, true), decide("gone"))
        assertEquals(ResumeDecision(null, true), decide("b"))
        assertEquals(ResumeDecision(null, true), decide("a", list = emptyList()))
        // Even when it would not have opened anyway: it does not qualify any more
        assertEquals(ResumeDecision(null, true), decide("b", fresh = false))
    }

    // The shell is singleTask: an ACTION_MAIN that reaches it on an existing task (e.g. an explicit component start —
    // the icon's tap is routed by the launcher entry) comes back through onNewIntent, and the same check must open
    // the last host again (the windows above the shell were finished by the system).

    @Test fun aLauncherIntentIsAStart() {
        assertTrue(ResumePolicy.isLauncherStart("android.intent.action.MAIN", launchedFromHistory = false))
    }

    @Test fun linksAndHistoryRestoresAreNotLauncherStarts() {
        assertFalse(ResumePolicy.isLauncherStart("android.intent.action.VIEW", launchedFromHistory = false))
        assertFalse(ResumePolicy.isLauncherStart(null, launchedFromHistory = false))
        assertFalse(ResumePolicy.isLauncherStart("android.intent.action.MAIN", launchedFromHistory = true))
    }

    // The launcher entry is a trampoline: a tap on a task that already has windows only brings it forward (the host
    // window stays alive); a tap on a fresh task goes on to the shell, which runs the resume check above.

    @Test fun aTapOnAnExistingTaskRevealsIt() {
        assertEquals(ResumePolicy.LauncherRoute.REVEAL_TASK, ResumePolicy.launcherRoute(isTaskRoot = false))
    }

    @Test fun aTapOnAFreshTaskStartsTheShell() {
        assertEquals(ResumePolicy.LauncherRoute.START_SHELL, ResumePolicy.launcherRoute(isTaskRoot = true))
    }
}
