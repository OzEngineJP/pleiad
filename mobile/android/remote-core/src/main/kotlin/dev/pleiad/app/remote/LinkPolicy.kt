package dev.pleiad.app.remote

// Where a link pressed in the host window goes on this device (docs/remote.md §8.5).
// The same rules as desktop/remote-windows.cjs (linkTarget) and web/host-only-links.mjs (isHostOnlyUrl).
// Pure: the app passes the pieces of android.net.Uri, the JVM tests pass strings.

enum class LinkTarget {
    /** A web page: the device's default browser */
    EXTERNAL,
    /** localhost / loopback: it means the host's PC, but on this device it would open the device itself */
    HOST_ONLY,
    /** Anything else (other schemes, credentials in the URL, pages of this window's proxy): nothing opens */
    BLOCKED,
}

object LinkPolicy {
    private val LOOPBACK_V4 = Regex("^127(\\.\\d{1,3}){3}$")

    fun isLoopbackHost(host: String?): Boolean {
        val h = (host ?: return false).lowercase().removeSurrounding("[", "]").removeSuffix(".")
        return h == "localhost" || h.endsWith(".localhost") || LOOPBACK_V4.matches(h) || h == "0.0.0.0" ||
            h == "::1" || h == "::" || h.startsWith("::ffff:127.") || h.startsWith("::ffff:7f")
    }

    fun isIsolatedPage(scheme: String?, host: String?, port: Int, path: String?, hasUserInfo: Boolean, isolatedPort: Int): Boolean =
        scheme == "http" && host == "localhost" && isolatedPort in 1..65535 && port == isolatedPort && !hasUserInfo &&
            path != null && DeviceProxy.isIsolatedPath(path)

    /**
     * @param port -1 when the URL has none
     * @param proxyPort the port of this window's in-app proxy (http://127.0.0.1:<proxyPort>)
     */
    fun classify(scheme: String?, host: String?, port: Int, path: String?, hasUserInfo: Boolean, proxyPort: Int, isolatedPort: Int = -1): LinkTarget {
        val s = scheme?.lowercase() ?: return LinkTarget.BLOCKED
        if (s != "http" && s != "https") return LinkTarget.BLOCKED
        if (host.isNullOrEmpty() || hasUserInfo) return LinkTarget.BLOCKED
        // The app owns this origin. It is an iframe target, never an external host-PC link.
        if (isIsolatedPage(s, host, port, path, hasUserInfo, isolatedPort)) return LinkTarget.BLOCKED
        val effectivePort = if (port == -1) (if (s == "https") 443 else 80) else port
        // The host UI's own pages (the proxy's cookie lives only in this app)
        if (s == "http" && host == "127.0.0.1" && effectivePort == proxyPort) return LinkTarget.BLOCKED
        return if (isLoopbackHost(host)) LinkTarget.HOST_ONLY else LinkTarget.EXTERNAL
    }
}
