package dev.pleiad.app.plus

import dev.pleiad.app.remote.Backoff
import dev.pleiad.app.remote.FileDeviceStore
import dev.pleiad.app.remote.PairError
import dev.pleiad.app.remote.RemoteDevice
import java.io.BufferedReader
import java.io.File
import java.io.InputStreamReader
import java.net.Socket
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test

/** Kotlin Android device -> local Plus API -> authenticated relay -> fake host. */
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
            val replacement = PlusAdmission.admit(
                listedHost, ready.getString("relayUrl"), token, device.store.identity(), "kt-plus-phone", "kt-plus-test",
                connectTimeoutMs = 4_000, sleepMs = {},
            )
            assertEquals(hostId, replacement.hostId)
            device.store.saveHost(replacement, via = "plus", uid = ready.getString("uid"))
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

    private fun admit(idToken: String = token, sleepMs: (Long) -> Unit = {}): dev.pleiad.app.remote.HostCreds =
        PlusAdmission.admit(
            listedHost, ready.getString("relayUrl"), idToken, device.store.identity(), "kt-plus-phone", "kt-plus-test",
            connectTimeoutMs = 4_000, sleepMs = sleepMs,
        )

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

        send("limit 0")
        assertEquals("plus-limit", assertThrows(PairError::class.java) { admit() }.code)
        send("unavailable")
        assertEquals("unreachable", assertThrows(PairError::class.java) { admit() }.code)
        send("restore")
        send("rate-on")
        event("rate-ready")
        val sleeps = mutableListOf<Long>()
        assertEquals("plus-connecting", assertThrows(PairError::class.java) { admit(sleepMs = { sleeps += it }) }.code)
        assertEquals(listOf(60_000L), sleeps)
        send("rate-off")
        event("rate-restored")

        val admitted = admit()
        assertEquals("plus", admitted.via)
        device.store.saveHost(admitted, via = "plus", uid = ready.getString("uid"))
        assertEquals(admitted.deviceId, device.store.credentials(listedHost.hostId, "plus")!!.deviceId)
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
        val nextDeviceId = device.store.credentials(listedHost.hostId, "plus")!!.deviceId
        assertTrue(nextDeviceId != firstDeviceId)
        assertEquals(1, readmitCount.get())

        send("limit 0")
        send("close-device $nextDeviceId")
        event("closed-revoked")
        waitState("limit")
        assertEquals("one readmission attempt is made after the second revocation", 2, readmitCount.get())
        assertNotNull(device.store.host(listedHost.hostId, "plus"))
    }
}
