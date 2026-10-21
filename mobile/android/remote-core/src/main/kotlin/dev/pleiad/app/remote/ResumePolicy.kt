package dev.pleiad.app.remote

/**
 * What the launcher start should do about the host the user was in last (docs/remote.md §8.2): open [hostId] with the
 * route [via], or [forget] the saved one.
 */
data class ResumeDecision(val hostId: String?, val forget: Boolean, val via: String? = null)

/**
 * Whether the app opens straight into the last host instead of showing the host list. Pure, so the rules are unit-tested.
 *
 * Opens only when the start is a fresh launcher start (not a restore after the system recreated the activity, not a
 * pleiad://pair link) and the saved host is still paired and not revoked. A saved host that no longer qualifies is
 * forgotten, so it is not checked again at every start. It reopens with the route it was open with ([savedVia]) while
 * that pairing is usable, else with the other one (HostRoute.reopen): a host paired only with Plus never falls to own.
 */
object ResumePolicy {
    /** What the launcher entry does with a tap: start the shell on a fresh task, or let the existing task show itself. */
    enum class LauncherRoute { START_SHELL, REVEAL_TASK }

    /**
     * The launcher entry is a trampoline that never stays (docs/remote.md §8.2). When the tap lands on a task that
     * already exists, the entry is not the task's root: stepping aside leaves whatever was on top — the host window
     * or the list — in front, so the running host window is never recreated by an icon tap. Only when the entry is
     * the task's root (a fresh start, or a restore whose stack is gone) does the start go on to the shell.
     */
    fun launcherRoute(isTaskRoot: Boolean): LauncherRoute =
        if (isTaskRoot) LauncherRoute.START_SHELL else LauncherRoute.REVEAL_TASK

    /**
     * Whether the intent that reached the shell is a launcher (re)start: ACTION_MAIN and not launched from history.
     * A singleTask root gets the launcher intent in onNewIntent when the task is brought forward again (the activities
     * above it — the host window — have already been finished), so both onCreate and onNewIntent check this.
     * Intent.ACTION_MAIN is "android.intent.action.MAIN"; kept as a literal so remote-core stays free of android deps.
     */
    fun isLauncherStart(action: String?, launchedFromHistory: Boolean): Boolean =
        action == "android.intent.action.MAIN" && !launchedFromHistory

    fun decide(saved: String?, hosts: List<HostRecord>, freshStart: Boolean, launcherStart: Boolean, savedVia: String? = null): ResumeDecision {
        if (saved.isNullOrEmpty()) return ResumeDecision(null, false)
        val via = HostRoute.reopen(saved, hosts, savedVia) ?: return ResumeDecision(null, true)
        if (!freshStart || !launcherStart) return ResumeDecision(null, false)
        return ResumeDecision(saved, false, via)
    }
}
