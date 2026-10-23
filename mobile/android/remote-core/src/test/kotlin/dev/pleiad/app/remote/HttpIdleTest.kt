package dev.pleiad.app.remote

import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.atomic.AtomicInteger
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

// The shared client after the app sat idle: the server has closed the kept-alive connection, but the client still has it
// in its pool. The first read must not fail on it; a POST must never be sent twice.
class HttpIdleTest {
    private val server = ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"))
    private val gets = AtomicInteger()
    private val posts = AtomicInteger()
    @Volatile private var dropPostWithoutAnswer = false
    private val base = "http://127.0.0.1:${server.localPort}"

    init {
        Thread {
            while (!server.isClosed) {
                val s = try { server.accept() } catch (_: Exception) { break }
                Thread { serve(s) }.apply { isDaemon = true }.start()
            }
        }.apply { isDaemon = true }.start()
    }

    /** HTTP/1.1 keep-alive that closes a connection idle for 200 ms (like a server's keep-alive timeout) */
    private fun serve(s: Socket) = s.use {
        s.soTimeout = 200
        val input = BufferedReader(InputStreamReader(s.getInputStream(), Charsets.ISO_8859_1))
        val out = s.getOutputStream()
        while (true) {
            val line = try { input.readLine() } catch (_: java.net.SocketTimeoutException) { return } ?: return
            if (line.isEmpty()) continue
            var length = 0
            while (true) {
                val h = input.readLine() ?: return
                if (h.isEmpty()) break
                if (h.lowercase().startsWith("content-length:")) length = h.substringAfter(':').trim().toInt()
            }
            repeat(length) { input.read() }
            if (line.startsWith("POST")) {
                posts.incrementAndGet()
                if (dropPostWithoutAnswer) return
            } else gets.incrementAndGet()
            out.write("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: keep-alive\r\n\r\nok".toByteArray())
            out.flush()
        }
    }

    @After fun close() { server.close() }

    private fun get(): String = Http.client.newCall(Request.Builder().url("$base/v1/hosts").build()).execute().use { it.body!!.string() }

    @Test fun theFirstReadAfterIdleDoesNotFail() {
        assertEquals("ok", get())
        Thread.sleep(600) // the server has closed the connection by now
        assertEquals("ok", get())
        assertEquals("ok", get())
        assertTrue("the reads reached the server: ${gets.get()}", gets.get() >= 3)
    }

    private fun post(): String = Http.client.newCall(
        Request.Builder().url("$base/v1/tickets").post("{}".toRequestBody("application/json".toMediaType())).build(),
    ).execute().use { it.body!!.string() }

    @Test fun aPostAfterIdleGoesOutOnAFreshConnection() {
        assertEquals("ok", get())
        Thread.sleep(600)
        assertEquals("ok", post())
        assertEquals("sent once", 1, posts.get())
    }

    @Test fun aPostTheServerTookIsNeverSentAgain() {
        assertEquals("ok", get())
        dropPostWithoutAnswer = true
        val failed = try { post(); false } catch (_: java.io.IOException) { true }
        Thread.sleep(200)
        assertTrue("the POST that got no answer fails", failed)
        assertEquals("sent once", 1, posts.get())
    }
}
