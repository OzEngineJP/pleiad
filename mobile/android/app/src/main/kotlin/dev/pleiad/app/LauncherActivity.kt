package dev.pleiad.app

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import dev.pleiad.app.remote.ResumePolicy

/**
 * The launcher entry (docs/remote.md §8.2). It never stays: on a fresh task it passes the start on to
 * the shell (MainActivity), which decides about the last host (ResumePolicy); on a task that already
 * exists it only steps aside, so whatever was on top — the host window or the list — comes forward
 * untouched, like returning from the recent apps list. This is what a singleTask shell cannot do:
 * the system finishes everything above the root before the launcher intent even reaches it.
 */
class LauncherActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (ResumePolicy.launcherRoute(isTaskRoot) == ResumePolicy.LauncherRoute.START_SHELL) {
            val i = Intent(this, MainActivity::class.java).setAction(intent.action).setData(intent.data)
            if (intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY != 0) {
                i.addFlags(Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY)
            }
            startActivity(i)
        }
        finish()
    }
}
