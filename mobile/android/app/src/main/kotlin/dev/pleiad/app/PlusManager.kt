package dev.pleiad.app

// Pleiad Plus sign-in for the shell (docs/plus.md "Android"). Holds the config (fetched at start and every 5 min
// while the app is in front, last-good otherwise), the sealed pending/session, and the login flow
// (Custom Tab + PKCE, back through the App Link or pleiad://auth). The page sees only state(); the ID token
// stays in Kotlin (currentIdToken() is the seam the official-relay work uses).

import android.content.Context
import dev.pleiad.app.plus.PlusAccount
import dev.pleiad.app.plus.PlusApi
import dev.pleiad.app.plus.PlusApiError
import dev.pleiad.app.plus.PlusAuth
import dev.pleiad.app.plus.PlusConfig
import dev.pleiad.app.plus.PlusSession
import dev.pleiad.app.plus.PlusTicket
import dev.pleiad.app.plus.PlusTicketIssuer
import dev.pleiad.app.plus.PlusTickets
import dev.pleiad.app.plus.PlusVersion
import dev.pleiad.app.plus.PlusHost
import dev.pleiad.app.remote.Http
import dev.pleiad.app.remote.KeyPair
import dev.pleiad.app.remote.PairError
import java.security.SecureRandom
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import org.json.JSONObject

class PlusManager(context: Context, private val log: (String) -> Unit = {}) {
    private val store = PlusStore(context)
    private val session = PlusSession(store.sessionStore(), log = log)
    private val random = SecureRandom()
    private val clientTag = "android/${BuildConfig.VERSION_NAME}"
    private val apiBase = BuildConfig.PLUS_API

    private val worker = Executors.newSingleThreadExecutor { r -> Thread(r, "plus-worker").also { it.isDaemon = true } }
    private val ticker = Executors.newSingleThreadScheduledExecutor { r -> Thread(r, "plus-tick").also { it.isDaemon = true } }

    @Volatile private var config: PlusConfig? = store.config()
    @Volatile private var started = false
    @Volatile private var foreground = false
    @Volatile private var lastAccountAt = 0L
    @Volatile private var flowError: String? = null
    @Volatile private var hosts: List<PlusHost> = emptyList()
    @Volatile private var hostsError: String? = null
    @Volatile var onChanged: (() -> Unit)? = null

    /** Called when the plugin loads (the shell page exists by then); the WebView can reload, so it's idempotent. */
    fun start() {
        if (started) {
            emit()
            return
        }
        started = true
        ticker.scheduleWithFixedDelay({ if (foreground) tick() }, TICK_MS, TICK_MS, TimeUnit.MILLISECONDS)
        worker.execute {
            refreshConfig()
            if (session.signedIn()) fetchAccount()
            emit()
        }
    }

    fun setForeground(on: Boolean) {
        if (on == foreground) return
        foreground = on
        if (on) {
            worker.execute {
                refreshConfig()
                // re-read the account when the app comes back, at most once a minute
                if (session.signedIn() && now() - lastAccountAt > ACCOUNT_MIN_INTERVAL_MS) fetchAccount()
                emit()
            }
        }
    }

    private fun tick() {
        try {
            refreshConfig()
            if (session.signedIn()) {
                session.idToken(config?.refreshUrl) // keeps the ID token fresh while the app is in front
                if (now() - lastAccountAt > ACCOUNT_MIN_INTERVAL_MS) fetchAccount()
            }
        } catch (e: Exception) {
            log("tick: ${e.javaClass.simpleName}")
        }
        emit()
    }

    private fun refreshConfig() {
        val fetched = try {
            PlusApi.fetchConfig(Http.client, apiBase, clientTag)
        } catch (e: Exception) {
            log("config: ${e.javaClass.simpleName}")
            null
        }
        config = PlusConfig.choose(fetched, config)
        fetched?.let(store::saveConfig)
        session.onConfig(config) // a different token project retires the sealed session (relogin)
    }

    private fun fetchAccount() {
        lastAccountAt = now()
        session.fetchAccount(apiBase, config?.refreshUrl, clientTag)
    }

    // ── login ──

    /** Start a login attempt and return the Custom Tab URL (the plugin opens it). Null when there is no config yet. */
    fun login(lang: String): String? {
        val cfg = config?.takeIf { it.loginUrl.isNotEmpty() } ?: return null
        // a second tap while one is in flight replaces the pending attempt
        val pending = PlusAuth.Pending(PlusAuth.randomToken(random), PlusAuth.randomToken(random), now())
        store.savePending(pending)
        flowError = null
        emit()
        return PlusAuth.loginUrl(cfg.loginUrl, pending.state, PlusAuth.challenge(pending.verifier), lang)
    }

    /** The App Link or pleiad://auth return. Runs on the worker; safe to call before the page exists. */
    fun onAuthLink(url: String) {
        worker.execute {
            val cb = PlusAuth.parseCallback(url) ?: return@execute
            val pending = store.pending()
            fun fail(error: String) {
                flowError = error
                store.clearPending()
                emit()
            }
            val code = cb.code
            when {
                cb.error != null -> fail("failed")
                pending == null || !pending.fresh(now()) -> fail("failed")
                !PlusAuth.stateMatches(pending.state, cb.state) -> fail("failed")
                code == null -> fail("failed")
                else -> try {
                    val t = PlusApi.exchangeCode(Http.client, apiBase, code, pending.verifier, PlusAuth.CALLBACK_URL, clientTag)
                    store.clearPending()
                    flowError = null
                    session.signIn(t)
                    emit()
                    fetchAccount()
                    emit()
                } catch (e: PlusApiError) {
                    log("token: http ${e.status} ${e.code}")
                    fail(if (e.status == 400) "failed" else "unreachable")
                } catch (e: Exception) {
                    log("token: ${e.javaClass.simpleName}")
                    fail("unreachable")
                }
            }
        }
    }

    fun logout() {
        worker.execute {
            session.signOut()
            store.clearPending()
            flowError = null
            emit()
        }
    }

    fun profileUrl(): String? = config?.profileUrl?.ifEmpty { null }

    /** The ID token for Kotlin callers (the official relay). Never exposed to the shell page. */
    fun currentIdToken(): String? = session.idToken(config?.refreshUrl, force = true)

    /** The ID token it has, refreshed only near its expiry: for calls the screen waits on (a 401 then asks currentIdToken). */
    fun idToken(): String? = session.idToken(config?.refreshUrl)

    // Tickets for the relay and the host (docs/plus.md "Tickets"). The ID token is refreshed only near its expiry here
    // (one connection asks for a ticket each time); a 401 refreshes it and asks once more.
    private val tickets = PlusTicketIssuer(
        post = { path, body ->
            val first = session.idToken(config?.refreshUrl) ?: throw PairError("plus-signed-out")
            try { PlusApi.postAuthed(Http.client, apiBase, first, clientTag, path, body) }
            catch (e: PlusApiError) {
                if (e.status != 401) throw e
                val again = currentIdToken() ?: throw PairError("plus-signed-out")
                PlusApi.postAuthed(Http.client, apiBase, again, clientTag, path, body)
            }
        },
        admission = { config?.admission },
    )

    /**
     * The relay ticket and the admission ticket for connecting to hostId with this device key. Null when the api has
     * no tickets yet (use the ID token). Throws PlusApiError (426: update the app) or PairError("plus-signed-out").
     * Blocking: call from a worker.
     */
    fun deviceTicket(hostId: String, keyPair: KeyPair): PlusTicket? = tickets.issue(PlusTickets.PURPOSE_DEVICE, keyPair, hostId)

    /** [read]: [hosts] is the ledger read just now, not the last known list (PlusHostList.combine's ledgerRead). */
    data class HostsResult(val hosts: List<PlusHost>, val error: String? = null, val read: Boolean = false)

    /** Refresh the account host list. On transient failures, return the last successful list. */
    @Synchronized
    fun fetchHosts(): HostsResult {
        val account = session.account
        if (config?.state != "on" || account?.status != "plus") {
            hosts = emptyList()
            hostsError = null
            return HostsResult(emptyList())
        }
        return try {
            var token = idToken() ?: return HostsResult(hosts, "signed-out")
            val latest = try {
                PlusApi.fetchHosts(Http.client, apiBase, token, clientTag)
            } catch (e: PlusApiError) {
                if (e.status != 401) throw e
                token = currentIdToken() ?: run { session.signOut(); hosts = emptyList(); return HostsResult(emptyList()) }
                try { PlusApi.fetchHosts(Http.client, apiBase, token, clientTag) }
                catch (e2: PlusApiError) { if (e2.status == 401) { session.signOut(); hosts = emptyList(); return HostsResult(emptyList()) }; throw e2 }
            }
            hosts = latest
            hostsError = null
            HostsResult(latest, read = true)
        } catch (e: PlusApiError) {
            if (e.status == 403 && e.code in setOf("not_plus", "account_disabled")) {
                hosts = emptyList()
                hostsError = "no-relay"
                HostsResult(emptyList(), "no-relay")
            } else {
                log("hosts: http ${e.status} ${e.code}".trim())
                hostsError = "unreachable"
                HostsResult(hosts, "unreachable")
            }
        } catch (e: Exception) {
            log("hosts: ${e.javaClass.simpleName}")
            hostsError = "unreachable"
            HostsResult(hosts, "unreachable")
        }
    }

    fun cachedHosts(): HostsResult = HostsResult(hosts, hostsError)
    fun currentRelayUrl(): String? = config?.relayUrl?.ifEmpty { null }
    fun currentUid(): String? = session.record()?.uid

    /** pleiad://plus/enable|disable: set this device's mark and re-emit the state */
    fun setEntrance(on: Boolean) {
        if (store.entrance() == on) return
        store.saveEntrance(on)
        emit()
    }

    // ── state for the page ──

    fun stateJson(): JSONObject {
        val cfg = config
        val minClient = cfg?.minClientAndroid
        // While visibility is optin, the entrance stays hidden until this device
        // has the mark (set by the pleiad://plus/enable link).
        val visible = cfg?.visibility == "public" || store.entrance()
        val plus = when {
            cfg == null -> if (visible) "unknown" else "off"
            cfg.state == "off" || !visible -> "off"
            cfg.state == "maintenance" -> "maintenance"
            minClient != null && PlusVersion.isOlder(BuildConfig.VERSION_NAME, minClient) -> "update"
            else -> "on"
        }
        val pending = store.pending()
        val login = when {
            pending != null && pending.fresh(now()) -> "pending"
            session.signedIn() -> "in"
            else -> "out"
        }
        val account: PlusAccount? = session.account
        return JSONObject()
            .put("plus", plus)
            .put("login", login)
            .put("status", account?.status ?: JSONObject.NULL)
            .put("email", account?.email ?: session.record()?.email ?: JSONObject.NULL)
            .put("provider", account?.provider ?: JSONObject.NULL)
            .put("error", flowError ?: session.error ?: JSONObject.NULL)
    }

    private fun emit() {
        onChanged?.invoke()
    }

    private fun now() = System.currentTimeMillis()

    companion object {
        private const val TICK_MS = 5 * 60 * 1000L
        private const val ACCOUNT_MIN_INTERVAL_MS = 60 * 1000L
    }
}
