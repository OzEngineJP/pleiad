package dev.pleiad.app

// The shell's bridge to Pleiad Plus (docs/plus.md "Android"). Only the bundled shell page sees it.
// Methods: state() · login() (starts the Custom Tab; the result arrives as the `state` event) · logout() ·
// openAccount() · idToken() (for native callers; the page does not use it). Event: `state` (same shape as state()).

import android.net.Uri
import androidx.browser.customtabs.CustomTabsIntent
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.util.concurrent.Executors
import org.json.JSONObject

@CapacitorPlugin(name = "PleiadPlus")
class PleiadPlusPlugin : Plugin() {
    private val worker = Executors.newSingleThreadExecutor { r -> Thread(r, "pleiad-plus-plugin").also { it.isDaemon = true } }
    private val plus get() = (context.applicationContext as PleiadApp).plus

    override fun load() {
        plus.onChanged = {
            notifyListeners("state", JSObject(plus.stateJson().toString()))
        }
        plus.start()
    }

    @PluginMethod
    fun state(call: PluginCall) {
        call.resolve(JSObject(plus.stateJson().toString()))
    }

    @PluginMethod
    fun login(call: PluginCall) {
        worker.execute {
            val lang = context.resources.configuration.locales[0]?.language ?: "en"
            val url = plus.login(lang) ?: run {
                call.reject("plus is unavailable", "unavailable")
                return@execute
            }
            openTab(url, call)
        }
    }

    @PluginMethod
    fun logout(call: PluginCall) {
        worker.execute {
            plus.logout()
            call.resolve()
        }
    }

    @PluginMethod
    fun openAccount(call: PluginCall) {
        worker.execute {
            val url = plus.profileUrl() ?: run {
                call.reject("plus is unavailable", "unavailable")
                return@execute
            }
            openTab(url, call)
        }
    }

    @PluginMethod
    fun idToken(call: PluginCall) {
        worker.execute {
            val t = plus.currentIdToken()
            call.resolve(JSObject().put("idToken", t ?: JSONObject.NULL))
        }
    }

    private fun openTab(url: String, call: PluginCall) {
        val a = activity ?: run {
            call.reject("no activity", "internal")
            return
        }
        a.runOnUiThread {
            try {
                CustomTabsIntent.Builder().build().launchUrl(a, Uri.parse(url))
                call.resolve()
            } catch (e: Exception) {
                call.reject(e.message ?: "couldn't open the browser", "unreachable")
            }
        }
    }
}
