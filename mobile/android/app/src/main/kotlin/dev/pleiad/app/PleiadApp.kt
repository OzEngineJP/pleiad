package dev.pleiad.app

import android.app.Application
import android.os.Build
import android.provider.Settings
import android.util.Log
import dev.pleiad.app.remote.FileDeviceStore
import dev.pleiad.app.remote.NotifyHub
import dev.pleiad.app.remote.ProxyTexts
import dev.pleiad.app.remote.RemoteDevice
import dev.pleiad.app.plus.PlusAdmission
import dev.pleiad.app.plus.PlusApiError
import dev.pleiad.app.remote.KeyPair
import dev.pleiad.app.remote.PairError
import java.io.File

/** Holds the one RemoteDevice (host list, pairing, proxies) shared by the host list and the host windows. */
class PleiadApp : Application() {
    lateinit var device: RemoteDevice
        private set

    /** Pleiad Plus sign-in (docs/plus.md "Android"). */
    val plus: PlusManager by lazy { PlusManager(this, log = { Log.i("Pleiad", it) }) }

    /** The notification lines and what arrives on them (ADR 0086). Started by [NotifyService]; idle until notifications are on. */
    val notifyHub: NotifyHub by lazy {
        NotifyHub(device.store, device.loop, BuildConfig.VERSION_NAME, deviceName(), NotifyPresenter(this), log = { Log.i("Pleiad", it) },
            plusIdToken = { plus.currentIdToken() }, plusTicket = ::relayTicket)
    }

    override fun onCreate() {
        super.onCreate()
        val texts = object : ProxyTexts {
            override fun locale() = resources.configuration.locales[0].language
            override fun title(state: String) = getString(when (state) {
                "revoked" -> R.string.remote_revoked
                "reapprove" -> R.string.remote_reapprove
                "blocked" -> R.string.remote_plus_blocked
                "limit" -> R.string.remote_plus_limit
                "paused" -> if (plus.stateJson().optString("plus") == "maintenance") R.string.remote_plus_maintenance else R.string.remote_plus_paused
                "signed-out" -> R.string.remote_plus_signed_out
                "update" -> R.string.remote_plus_update
                "removed" -> R.string.remote_plus_removed
                else -> R.string.remote_host_offline
            })
            override fun body(state: String) = getString(
                when (state) {
                    "revoked" -> R.string.remote_page_revoked
                    "reapprove" -> R.string.remote_page_reapprove
                    "blocked" -> R.string.remote_page_plus_blocked
                    "limit" -> R.string.remote_page_plus_limit
                    "paused" -> if (plus.stateJson().optString("plus") == "maintenance") R.string.remote_page_plus_maintenance else R.string.remote_page_plus_paused
                    "signed-out" -> R.string.remote_page_plus_signed_out
                    "update" -> R.string.remote_page_plus_update
                    "removed" -> R.string.remote_page_plus_removed
                    "host-offline" -> R.string.remote_page_host_offline
                    else -> R.string.remote_page_offline
                },
            )
            override fun tokenRequired() = getString(R.string.remote_token_required)
            override fun lost() = getString(R.string.remote_lost)
            override fun backToHosts() = getString(R.string.remote_back_to_hosts)
        }
        device = RemoteDevice(
            FileDeviceStore(File(noBackupFilesDir, "remote"), KeystoreCipher()),
            app = BuildConfig.VERSION_NAME,
            name = deviceName(),
            platform = "android",
            texts = texts,
            log = { Log.i("Pleiad", it) },
        )
        device.plusIdToken = { plus.currentIdToken() }
        device.plusTicket = ::relayTicket
        device.plusReadmit = { hostId ->
            val host = plus.cachedHosts().hosts.firstOrNull { it.hostId == hostId } ?: throw PairError("couldnt-connect")
            val token = plus.currentIdToken() ?: throw PairError("plus-signed-out")
            val relay = plus.currentRelayUrl() ?: throw PairError("unreachable")
            // reconnecting in the background: only a key the host already allowed gets back in (no approval window)
            device.admitPlus(hostId, PlusAdmission.MODE_ADMIT, plus.currentUid()) { kp ->
                PlusAdmission.admit(host, relay, token, kp, deviceName(), BuildConfig.VERSION_NAME,
                    ticket = { plus.deviceTicket(hostId, kp) }).copy(uid = plus.currentUid())
            }
            device.store.credentials(hostId, "plus")
        }
        registerActivityLifecycleCallbacks(object : ActivityLifecycleCallbacks {
            private var started = 0
            override fun onActivityStarted(activity: android.app.Activity) {
                if (++started == 1) plus.setForeground(true)
            }
            override fun onActivityStopped(activity: android.app.Activity) {
                if (--started == 0) plus.setForeground(false)
            }
            override fun onActivityCreated(activity: android.app.Activity, savedInstanceState: android.os.Bundle?) {}
            override fun onActivityResumed(activity: android.app.Activity) {}
            override fun onActivityPaused(activity: android.app.Activity) {}
            override fun onActivitySaveInstanceState(activity: android.app.Activity, outState: android.os.Bundle) {}
            override fun onActivityDestroyed(activity: android.app.Activity) {}
        })
    }

    /** The relay ticket (role device) for one connection; null when the api has no tickets yet. Blocking. */
    private fun relayTicket(hostId: String, keyPair: KeyPair): String? =
        try { plus.deviceTicket(hostId, keyPair)?.relay } catch (e: PlusApiError) { throw PlusAdmission.ticketError(e) }

    fun deviceName(): String =
        Settings.Global.getString(contentResolver, Settings.Global.DEVICE_NAME)?.takeIf { it.isNotBlank() }
            ?: "${Build.MANUFACTURER} ${Build.MODEL}".trim()
}
