package dev.pleiad.app.plus

import dev.pleiad.app.remote.Backoff
import dev.pleiad.app.remote.FileDeviceStore
import dev.pleiad.app.remote.HostCreds
import dev.pleiad.app.remote.KeyPair
import dev.pleiad.app.remote.PairError
import dev.pleiad.app.remote.RemoteDevice
import java.io.BufferedReader
import java.io.File
import java.io.InputStreamReader
import java.net.Socket
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import okhttp3.OkHttpClient
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test

/**
 * Kotlin Android device -> local Plus API -> authenticated relay -> fake host. The account alone does not admit a key:
 * a new key waits on the host's approval window (the fake host reports it as `pair-request`; the test answers).
 */
class PlusInteropTest {
    private lateinit var process: Process
    private lateinit var input: BufferedReader
    private lateinit var ready: JSONObject
    private lateinit var dir: File
    private lateinit var device: RemoteDevice
    private lateinit var listedHost: PlusHost
    private var token: String = ""
    private val pending = ArrayDeque<JSONObject>()
    private val readmitCount = AtomicInteger()
    private val admittedAgain = CountDownLatch(1)

    private fun event(name: String, timeoutMs: Long = 15_000): JSONObject {
        synchronized(pending) {
            pending.firstOrNull { it.optString("event") == name }?.let { pending.remove(it); return it }
        }
        val end = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < end) {
            val line = input.readLine() ?: throw AssertionError("fake host ended before '$name'")
            val obj = JSONObject(line)
            when (obj.optString("event")) {
                "error" -> throw AssertionError("fake host: ${obj.optString("message")}")
                name -> return obj
                else -> synchronized(pending) { pending.addLast(obj) }
            }
        }
        throw AssertionError("fake host did not emit '$name'")
    }

    private fun send(command: String) {
        process.outputStream.write("$command\n".toByteArray())
        process.outputStream.flush()
    }

    @Before fun setUp() {
        val mode = System.getProperty("pleiad.interop") ?: "auto"
        assumeTrue(mode != "off")
        val repo = File(System.getProperty("pleiad.repo") ?: "../../..")
        val script = File(repo, "mobile/scripts/fake-plus-host.mjs")
        val node = if (System.getProperty("os.name").lowercase().contains("win")) "node.exe" else "node"
        process = try {
            ProcessBuilder(node, script.absolutePath).directory(repo).redirectErrorStream(false).start()
        } catch (e: Exception) {
            assumeTrue("node not available: ${e.message}", false)
            return
        }
        input = BufferedReader(InputStreamReader(process.inputStream))
        Thread { process.errorStream.use { it.copyTo(java.io.OutputStream.nullOutputStream()) } }.apply { isDaemon = true; start() }
        ready = event("ready", 90_000)
        token = ready.getString("idToken")
        listedHost = PlusHost(
            ready.getString("hostId"), ready.getString("publicKey"), ready.getString("hostName"),
            "linux", true, null, null,
        )
        dir = kotlin.io.path.createTempDirectory("android-host-device").toFile()
        device = RemoteDevice(
            FileDeviceStore(dir), app = "kt-plus-test", name = "kt-plus-phone",
            backoff = Backoff(100, 500, 500), connectTimeoutMs = 4_000, requestWaitMs = 4_000,
        )
        device.plusIdToken = { token }
        device.plusReadmit = { hostId ->
            readmitCount.incrementAndGet()
            device.admitPlus(hostId, PlusAdmission.MODE_ADMIT, ready.getString("uid")) { kp -> admit(keyPair = kp) }
            admittedAgain.countDown()
            device.store.credentials(hostId, "plus")
        }
    }

    @After fun tearDown() {
        if (::device.isInitialized) device.closeAll()
        if (::process.isInitialized) {
            try { send("quit") } catch (_: Exception) {}
            if (!process.waitFor(15, TimeUnit.SECONDS)) process.destroyForcibly()
        }
        if (::dir.isInitialized) dir.deleteRecursively()
    }

    private fun admit(idToken: String = token, keyPair: KeyPair = device.store.identity(),
                      mode: String = PlusAdmission.MODE_ADMIT, onCode: (String) -> Unit = {},
                      ticket: (() -> PlusTicket?)? = null): HostCreds =
        PlusAdmission.admit(
            listedHost, ready.getString("relayUrl"), idToken, keyPair, "kt-plus-phone", "kt-plus-test",
            connectTimeoutMs = 4_000, sleepMs = {}, mode = mode, onCode = onCode, pairTimeoutMs = 20_000,
            ticket = ticket,
        )

    /** Tickets from the local Plus API, as PlusManager takes them (the ID token, X-Pleiad-Admission). */
    private fun ticketIssuer(admission: Int? = 2): PlusTicketIssuer {
        val client = OkHttpClient()
        return PlusTicketIssuer(
            post = { path, body -> PlusApi.postAuthed(client, ready.getString("apiUrl"), token, "kt-plus-test", path, body) },
            admission = { admission },
        )
    }

    private fun lastDeviceSeen(): JSONObject {
        send("seen 1")
        val seen = event("seen").getJSONArray("seen")
        return seen.getJSONObject(seen.length() - 1)
    }

    /** Runs [run] in the background, waits for the host's approval window and answers it ("approve" / "deny"). */
    private fun <T> answered(answer: String, run: ((String) -> Unit) -> T): T {
        val code = AtomicReference<String>()
        val result = CompletableFuture.supplyAsync { run { code.set(it) } }
        val request = event("pair-request")
        assertEquals("plus", request.optString("via"))
        val end = System.currentTimeMillis() + 5_000
        while (code.get() == null && System.currentTimeMillis() < end) Thread.sleep(20)
        assertEquals("the device shows the code of the host's window", request.getString("code"), code.get())
        send("$answer ${request.getString("id")}")
        event(if (answer == "approve") "approved" else "denied")
        return try { result.get(20, TimeUnit.SECONDS) } catch (e: ExecutionException) { throw e.cause ?: e }
    }

    private fun pairPlus(onCode: (String) -> Unit) =
        device.admitPlus(listedHost.hostId, PlusAdmission.MODE_PAIR, ready.getString("uid")) { kp ->
            admit(keyPair = kp, mode = PlusAdmission.MODE_PAIR, onCode = onCode)
        }

    private fun waitState(want: String, timeoutMs: Long = 12_000) {
        val end = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < end) {
            if (device.proxy(listedHost.hostId)?.link?.state == want) return
            Thread.sleep(30)
        }
        throw AssertionError("state '$want' not reached (was ${device.proxy(listedHost.hostId)?.link?.state})")
    }

    private fun get(port: Int, path: String): Pair<Int, String> = Socket("127.0.0.1", port).use { socket ->
        socket.soTimeout = 10_000
        socket.getOutputStream().write("GET $path HTTP/1.1\r\nHost: 127.0.0.1:$port\r\nConnection: close\r\n\r\n".toByteArray())
        val bytes = socket.getInputStream().readBytes()
        val raw = String(bytes, Charsets.ISO_8859_1)
        val split = raw.indexOf("\r\n\r\n")
        val status = raw.substring(0, split).lineSequence().first().split(' ')[1].toInt()
        status to String(bytes.copyOfRange(split + 4, bytes.size), Charsets.UTF_8)
    }

    @Test fun admitsConnectsProxiesHttpAndHandlesDenialsAndReadmission() {
        val invalid = assertThrows(PairError::class.java) {
            PlusAdmission.admit(
                listedHost.copy(hostId = "aaaaaaaaaaaaaaaaaaaaaaaaaa"), "ws://127.0.0.1:1", token,
                device.store.identity(), "kt-plus-phone", "kt-plus-test", connectTimeoutMs = 300,
            )
        }
        assertEquals("host-key", invalid.detail)

        send("loose on")
        val account = assertThrows(PairError::class.java) { admit(ready.getString("otherIdToken")) }
        assertEquals("plus-no-relay", account.code)
        send("loose off")

        // the same account's token does not admit a key the host has not allowed (background reconnect: no window)
        assertEquals("plus-reapprove", assertThrows(PairError::class.java) { admit() }.code)

        send("limit 0")
        assertEquals("plus-limit", assertThrows(PairError::class.java) { admit(mode = PlusAdmission.MODE_PAIR) }.code)
        send("unavailable")
        assertEquals("unreachable", assertThrows(PairError::class.java) { admit(mode = PlusAdmission.MODE_PAIR) }.code)
        send("restore")
        send("rate-on")
        event("rate-ready")
        assertEquals("rate", assertThrows(PairError::class.java) { admit(mode = PlusAdmission.MODE_PAIR) }.code)
        send("rate-off")
        event("rate-restored")

        // declined on the host's screen: that key may not ask again for a while
        val other = KeyPair.generate()
        assertEquals("denied", assertThrows(PairError::class.java) {
            answered("deny") { onCode -> admit(keyPair = other, mode = PlusAdmission.MODE_PAIR, onCode = onCode) }
        }.code)
        assertEquals("denied", assertThrows(PairError::class.java) { admit(keyPair = other, mode = PlusAdmission.MODE_PAIR) }.code)

        // allowed on the host's screen
        val rec = answered("approve") { onCode -> pairPlus(onCode) }
        assertEquals("plus", rec.via)
        val firstKey = device.store.keyFor(listedHost.hostId, "plus")!!
        val proxy = device.open(listedHost.hostId, "plus")
        waitState("connected")
        val (status, body) = get(proxy.port, "/?token=${proxy.token}")
        assertEquals(200, status)
        assertTrue(body.contains("Fake Plus Host"))
        assertTrue(body.contains("GET /"))

        val firstDeviceId = device.store.credentials(listedHost.hostId, "plus")!!.deviceId
        send("close-device $firstDeviceId")
        assertTrue("the relay found the approved device connection", event("closed-revoked").optInt("count") > 0)
        assertTrue(
            "the revoked device was admitted again (status=${device.proxy(listedHost.hostId)?.link?.status}, calls=${readmitCount.get()})",
            admittedAgain.await(15, TimeUnit.SECONDS),
        )
        waitState("connected")
        // an allowed key gets a new relay token for the same device record, without the window
        assertEquals(firstDeviceId, device.store.credentials(listedHost.hostId, "plus")!!.deviceId)
        assertEquals(1, readmitCount.get())

        // revoked on the host: the account's token does not bring that key back
        send("revoke $firstDeviceId")
        event("revoked")
        waitState("revoked")
        assertEquals("one readmission attempt is made after the revocation", 2, readmitCount.get())
        val again = assertThrows(PairError::class.java) { admit(keyPair = firstKey) }
        assertEquals(again.detail, "revoked", again.code)
        assertNotNull(device.store.host(listedHost.hostId, "plus")!!.revokedAt)

        // asking again uses a new key, which goes to the window
        answered("approve") { onCode -> pairPlus(onCode) }
        assertNotEquals(firstKey.publicKey.toList(), device.store.keyFor(listedHost.hostId, "plus")!!.publicKey.toList())
        assertNotEquals(firstDeviceId, device.store.credentials(listedHost.hostId, "plus")!!.deviceId)
    }

    @Test fun ticketsAdmitAndConnectAndTheIdTokenAsksForAnUpdate() {
        val issuer = ticketIssuer()
        val hostId = listedHost.hostId
        device.plusTicket = { hid, kp -> issuer.issue(PlusTickets.PURPOSE_DEVICE, kp, hid)?.relay }

        // the host takes tickets only; the relay still lets the ID token through
        send("v2-on host")
        event("v2-ready")
        assertEquals("plus-update", assertThrows(PairError::class.java) { admit(mode = PlusAdmission.MODE_PAIR) }.code)
        // the relay takes tickets only too
        send("v2-on")
        event("v2-ready")
        assertEquals("plus-update", assertThrows(PairError::class.java) { admit(mode = PlusAdmission.MODE_PAIR) }.code)
        assertEquals("update required", lastDeviceSeen().optString("reason"))

        // with tickets: the window, then the link
        val rec = answered("approve") { onCode ->
            device.admitPlus(hostId, PlusAdmission.MODE_PAIR, ready.getString("uid")) { kp ->
                admit(keyPair = kp, mode = PlusAdmission.MODE_PAIR, onCode = onCode,
                    ticket = { issuer.issue(PlusTickets.PURPOSE_DEVICE, kp, hostId) })
            }
        }
        assertEquals("plus", rec.via)
        val proxy = device.open(hostId, "plus")
        waitState("connected")
        val seen = lastDeviceSeen()
        assertEquals("ticket", seen.optString("by"))
        assertTrue(seen.optBoolean("ok"))
        val (status, body) = get(proxy.port, "/?token=${proxy.token}")
        assertEquals(200, status)
        assertTrue(body.contains("Fake Plus Host"))

        // an allowed key comes back without the window, with new tickets
        val key = device.store.keyFor(hostId, "plus")!!
        val again = admit(keyPair = key, ticket = { issuer.issue(PlusTickets.PURPOSE_DEVICE, key, hostId) })
        assertEquals(rec.deviceId, again.deviceId)

        // the api asks for an update
        send("ticket-fail 426")
        event("ticket-fail")
        assertEquals("plus-update", assertThrows(PairError::class.java) {
            admit(keyPair = key, ticket = { issuer.issue(PlusTickets.PURPOSE_DEVICE, key, hostId) })
        }.code)
    }
}
