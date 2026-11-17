package dev.pleiad.app

import android.content.Intent
import android.graphics.Bitmap
import android.os.Bundle
import android.webkit.WebView
import com.getcapacitor.BridgeActivity
import com.getcapacitor.BridgeWebViewClient
import dev.pleiad.app.remote.ResumePolicy

/**
 * The shell: the bundled host list (mobile/www) in Capacitor's WebView. Only this WebView has the Capacitor bridge;
 * host pages open in HostActivity's plain WebView (docs/remote.md §8.2).
 */
class MainActivity : BridgeActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        // Before Capacitor builds its WebView, so the host window is already queued when the list would first draw
        resumeLastHost(intent, freshStart = savedInstanceState == null)
        registerPlugin(PleiadRemotePlugin::class.java)
        registerPlugin(PleiadPlusPlugin::class.java)
        super.onCreate(savedInstanceState)
        keepFirstPageListeners()
        takePairLink(intent)
        takeOpenLink(intent)
        takeAuthLink(intent)
        takePlusLink(intent)
        NotifyService.sync(this)
    }

    /**
     * Capacitor clears every plugin's listeners in onPageStarted (bridge.reset), meant for a navigation away from an old page.
     * The WebView posts that callback to the main thread, while the page's addListener calls arrive on the plugin thread, so
     * on a busy start the first page's reset can land after the list registered its listeners and wipe them (Plus "state",
     * so the list never re-lists hosts after sign-in). This bridge's first page start has no older page whose listeners
     * could be stale, so it skips the reset; later starts (reload, error page) reset as before. Capacitor's own
     * onPageStarted WebViewListener hook is skipped once too: no installed plugin uses it (SystemBars uses onPageCommitVisible).
     */
    private fun keepFirstPageListeners() {
        bridge.setWebViewClient(object : BridgeWebViewClient(bridge) {
            private var first = true

            override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
                if (first) {
                    first = false
                    return
                }
                super.onPageStarted(view, url, favicon)
            }
        })
    }

    /**
     * A launcher start opens the host the user was in last (HostActivity on top; the list stays underneath). Not on a restore
     * (savedInstanceState) and not for a pleiad://pair link. ResumePolicy decides; the user's way back to the list is the
     * host window's "back to hosts", which forgets the host (ResumeStore).
     */
    private fun resumeLastHost(startIntent: Intent?, freshStart: Boolean) {
        val store = ResumeStore(this)
        val saved = store.hostId() ?: return
        val device = (application as PleiadApp).device
        val fromHistory = startIntent != null && startIntent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY != 0
        val d = ResumePolicy.decide(saved, device.store.hosts(), freshStart, ResumePolicy.isLauncherStart(startIntent?.action, fromHistory), store.via())
        if (d.forget) store.forget()
        d.hostId?.let { startActivity(Intent(this, HostActivity::class.java).putExtra(HostActivity.EXTRA_HOST_ID, it).putExtra(HostActivity.EXTRA_VIA, d.via)) }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        // BridgeActivity's onCreate replays the launch intent through onNewIntent — onCreate already handled it, and
        // acting on it again would open a second host window. Only a genuinely new intent (an ACTION_MAIN that lands
        // here on an existing task — the icon's tap is routed by LauncherActivity, docs/remote.md §8.2 — or a link)
        // counts; by then the system has already finished whatever was on top, so treat it as a launcher start and
        // reopen the host the user was in (a system restore comes with FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY).
        if (intent === getIntent()) return
        resumeLastHost(intent, freshStart = true)
        takePairLink(intent)
        takeOpenLink(intent)
        takeAuthLink(intent)
        takePlusLink(intent)
    }

    /**
     * The Pleiad Plus sign-in return: the verified App Link (https://account.pleiad.dev/app/callback) or the page's
     * pleiad://auth fallback on builds whose App Link is not verified (docs/plus.md "Android"). Handled once.
     */
    private fun takeAuthLink(intent: Intent?) {
        val data = intent?.data ?: return
        val url = data.toString()
        if (!dev.pleiad.app.plus.PlusAuth.isAuthCallback(url)) return
        intent.data = null
        (application as PleiadApp).plus.onAuthLink(url)
    }

    /**
     * pleiad://open?h=<hostId>&s=<sessionId> (a notification was tapped, ADR 0086): open that host's window on that conversation.
     * The notification system forgets the tapped notification; the planner is told so a bundle can shrink or go.
     * No route is given: the host window keeps an open proxy's route, else takes own, else Plus (RemoteDevice.routeFor).
     */
    private fun takeOpenLink(intent: Intent?) {
        val (hostId, session, bundle) = NotifyControl.parseOpen(this, intent?.data) ?: return
        intent?.data = null   // handled once (a recreated activity must not open it again)
        (application as PleiadApp).notifyHub.opened(hostId, session.takeIf { it.isNotEmpty() }, bundle)
        startActivity(
            Intent(this, HostActivity::class.java).putExtra(HostActivity.EXTRA_HOST_ID, hostId)
                .apply { if (session.isNotEmpty()) putExtra(HostActivity.EXTRA_OPEN_SESSION, session) }
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP),
        )
    }

    /** pleiad://pair?... opened from the system camera or another app: hand it to the host list (it asks before pairing). */
    private fun takePairLink(intent: Intent?) {
        val data = intent?.data ?: return
        if (data.scheme == "pleiad" && data.host == "pair") PleiadRemotePlugin.offerLink(data.toString())
    }

    /**
     * pleiad://plus/enable|disable: the Plus entrance mark on this device (docs/plus.md "入口を出すリンク").
     * enable shows the entrance while the api says visibility is optin; disable clears it. Handled once.
     */
    private fun takePlusLink(intent: Intent?) {
        val data = intent?.data ?: return
        if (data.scheme != "pleiad" || data.host != "plus") return
        val on = when (data.path?.removeSuffix("/")) {
            "/enable" -> true
            "/disable" -> false
            else -> return   // other pleiad://plus/… links are ignored
        }
        intent.data = null
        (application as PleiadApp).plus.setEntrance(on)
    }
}
