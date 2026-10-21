package dev.pleiad.app.remote

// The notification line (docs/remote.md §5.6, §11-5, ADR 0086): one light WebSocket per host to the relay
// (`/v1/device/notify`), separate from the Noise channel that carries the conversation. The relay pushes the host's
// encrypted notices down this line (and keeps them for a few minutes while we are away); we decrypt, acknowledge
// (`{"type":"ack","i":n}` so the relay can drop them), and hand them on. The relay cannot read them.
//
// Light on purpose: no PING frames of our own in the channel sense, a WebSocket ping only every few minutes (OkHttp
// pingInterval, which also notices a dead line), reconnects with a long backoff.
//
// state: connecting | connected | offline | host-offline | revoked | stopped

import java.util.concurrent.ScheduledFuture
import java.util.concurrent.ScheduledThreadPoolExecutor
import java.util.concurrent.TimeUnit
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject

class NotifyLine(
    @Volatile var creds: HostCreds,
    private val key: ByteArray,
    private val onNotice: (PushNotice) -> Unit,
    private val onState: (String) -> Unit = {},
    private val backoff: Backoff = Backoff(5_000, 300_000, 60_000),
    private val pingMs: Long = 240_000,
    private val client: OkHttpClient = Http.client,
    private val log: (String) -> Unit = {},
    private val plusIdToken: (() -> String?)? = null,
    // The relay ticket (role device) for one connection (docs/plus.md "Tickets"); null: the api has no tickets yet
    private val plusTicket: ((HostCreds) -> String?)? = null,
) {
    private val timer = ScheduledThreadPoolExecutor(1) { r -> Thread(r, "pleiad-notify-line").also { it.isDaemon = true } }
        .apply { removeOnCancelPolicy = true }
    private val lock = Any()
    private var socket: WebSocket? = null
    private var generation = 0
    private var attempt = 0
    private var running = false
    private var retry: ScheduledFuture<*>? = null
    private var openedAt = 0L
    @Volatile var state = "stopped"; private set

    private fun setState(s: String) {
        if (state == s) return
        state = s
        try { onState(s) } catch (_: Exception) {}
    }

    fun start() = synchronized(lock) {
        if (running) return@synchronized
        running = true
        attempt = 0
        connect()
    }

    fun stop() = synchronized(lock) {
        running = false
        generation++
        retry?.cancel(false); retry = null
        socket?.close(1000, null)
        socket = null
        setState("stopped")
        timer.shutdownNow()
    }

    /** The network came back / the app came to the front: do not wait for the backoff. */
    fun retryNow() = synchronized(lock) {
        if (!running || state == "connected" || state == "connecting" || state == "revoked") return@synchronized
        retry?.cancel(false); retry = null
        connect()
    }

    fun updateCredentials(next: HostCreds) = synchronized(lock) {
        if (next == creds) return@synchronized
        creds = next
        if (!running) return@synchronized
        generation++
        retry?.cancel(false); retry = null
        socket?.cancel(); socket = null
        attempt = 0
        connect()
    }

    private fun connect() {
        val gen = ++generation
        setState("connecting")
        val c = creds
        if (c.via != "plus") return open(gen, c, null)
        // The ticket and the account token are fetched over the network, and connect() runs on the caller's thread (the
        // service starts the lines on the main thread): fetch them on the line's own thread, outside the lock.
        try {
            timer.execute {
                var failed = false
                val ticket = try { plusTicket?.invoke(c) } catch (e: Exception) { failed = true; log("notify line: ticket failed: ${e.javaClass.simpleName}"); null }
                val accountToken = if (ticket != null || failed) null else try { plusIdToken?.invoke() } catch (_: Exception) { null }
                synchronized(lock) {
                    if (gen != generation || !running) return@synchronized
                    when {
                        ticket != null -> open(gen, c, "x-pleiad-ticket" to ticket)
                        accountToken.isNullOrEmpty() -> schedule("offline")
                        else -> open(gen, c, "x-pleiad-account" to accountToken)
                    }
                }
            }
        } catch (_: java.util.concurrent.RejectedExecutionException) {}
    }

    /** account: the relay's account header for via "plus" (the ticket, or the ID token). */
    private fun open(gen: Int, c: HostCreds, account: Pair<String, String>?) {
        val url = try { PairingCodec.relayWsUrl(c.relayUrl, "/v1/device/notify") } catch (e: Exception) {
            log("notify line: ${e.message}"); return schedule("offline")
        }
        val http = client.newBuilder()
            .pingInterval(pingMs, TimeUnit.MILLISECONDS)
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .connectTimeout(15, TimeUnit.SECONDS)
            .build()
        val reqBuilder = Request.Builder().url(url)
            .header("authorization", "Bearer ${c.token}").header("x-pleiad-host", c.hostId).header("x-pleiad-device", c.deviceId)
        if (account != null) reqBuilder.header(account.first, account.second)
        val req = reqBuilder.build()
        socket = http.newWebSocket(req, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                synchronized(lock) { if (gen != generation || !running) { webSocket.close(1000, null); return }; openedAt = System.currentTimeMillis(); setState("connected") }
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                if (gen != generation) return
                val m = try { JSONObject(text) } catch (_: Exception) { return }
                if (m.optString("type") != "notify") return
                val i = m.optLong("i", -1)
                val notice = NotifyCrypto.open(key, creds.hostId, creds.deviceId, m.optString("blob"))
                // Acknowledge what we received even if it did not open (a notice that never opens must not be sent again forever)
                if (i >= 0) webSocket.send(JSONObject().put("type", "ack").put("i", i).toString())
                if (notice != null) try { onNotice(notice) } catch (e: Exception) { log("notify line: ${e.message}") }
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                try { webSocket.close(1000, null) } catch (_: Exception) {}
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = ended(gen, webSocket, code, reason)

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                ended(gen, webSocket, response?.let { -it.code } ?: 1006)
                response?.close()
            }
        })
    }

    /** code: a WebSocket close code, or -HTTP status when the upgrade was refused, or 1006. */
    private fun ended(gen: Int, ws: WebSocket, code: Int, reason: String = "") = synchronized(lock) {
        if (gen != generation || !running) return@synchronized
        if (socket === ws) socket = null
        val stable = state == "connected" && System.currentTimeMillis() - openedAt >= backoff.stableMs
        if (stable) attempt = 0
        when {
            // the relay did not take the ticket / the account token (expired, or the clock is off): take a fresh one later
            code == 4401 && creds.via == "plus" && (reason == "ticket" || reason == "token") -> schedule("offline")
            code == 4401 || code == -401 -> { running = false; setState("revoked") }
            code == 4404 || code == 4408 -> schedule("host-offline")
            code == 4409 -> { attempt = maxOf(attempt, 3); schedule("offline") }   // another line of ours took over: back off, don't fight
            else -> schedule("offline")
        }
    }

    private fun schedule(state: String) {
        if (!running) return
        val base = minOf(backoff.maxMs, backoff.minMs * (1L shl minOf(attempt, 20)))
        val delay = Math.round(base * (0.75 + Math.random() * 0.5))
        attempt++
        setState(state)
        val gen = generation
        retry = try {
            timer.schedule({ synchronized(lock) { if (gen == generation && running) { retry = null; connect() } } }, delay, TimeUnit.MILLISECONDS)
        } catch (_: java.util.concurrent.RejectedExecutionException) { null }
    }
}
