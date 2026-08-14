package com.anathemastudio.zelari.companion.data

import android.net.Uri

data class CompanionPairing(
    val url: String,
    val token: String,
)

/**
 * Accepts Desktop QR payloads:
 *   zelari://pair?v=1&url=http%3A%2F%2F100.x.y.z%3A7421&token=…
 *   {"url":"http://100.x.y.z:7421","token":"…"}
 *   http://100.x.y.z:7421
 *   100.x.y.z:7421
 */
fun parsePairingPayload(raw: String): CompanionPairing? {
    val s = raw.trim().trim('"', '\'')
    if (s.isEmpty()) return null

    if (s.startsWith("zelari://pair") || s.startsWith("zelari-code://pair")) {
        val uri = Uri.parse(s)
        val url = uri.getQueryParameter("url") ?: return null
        return CompanionPairing(
            url = normalizeHostUrl(url),
            token = uri.getQueryParameter("token").orEmpty().trim(),
        )
    }

    if (s.startsWith("{")) {
        return try {
            val obj = com.google.gson.JsonParser.parseString(s).asJsonObject
            val url = obj.get("url")?.asString ?: return null
            CompanionPairing(
                url = normalizeHostUrl(url),
                token = obj.get("token")?.asString.orEmpty().trim(),
            )
        } catch (_: Exception) {
            null
        }
    }

    if (s.startsWith("http://", ignoreCase = true) ||
        s.startsWith("https://", ignoreCase = true) ||
        s.matches(Regex("""^\d{1,3}(\.\d{1,3}){3}(:\d+)?(/.*)?$"""))
    ) {
        val uri = Uri.parse(normalizeHostUrl(s.substringBefore(' ')))
        val token = uri.getQueryParameter("token").orEmpty()
        val stripped = uri.buildUpon().clearQuery().fragment("").build().toString()
        return CompanionPairing(url = normalizeHostUrl(stripped), token = token)
    }

    return null
}

fun normalizeHostUrl(raw: String): String {
    var s = raw.trim().trim('"', '\'')
    if (s.isEmpty()) return s
    if (!s.contains("://")) s = "http://$s"
    return s.trimEnd('/')
}

fun isLoopbackHost(url: String): Boolean {
    return try {
        val host = Uri.parse(normalizeHostUrl(url)).host?.lowercase() ?: return false
        host == "127.0.0.1" || host == "localhost" || host == "::1" || host == "[::1]"
    } catch (_: Exception) {
        false
    }
}

fun describeConnectFailure(url: String, err: Throwable): String {
    val msg = err.message.orEmpty()
    val loopback = if (isLoopbackHost(url)) {
        " 127.0.0.1 on the phone is THIS device, not the PC. Scan the Desktop QR or use the Tailscale IP (100.x)."
    } else {
        ""
    }
    return when {
        err is java.net.ConnectException || msg.contains("Failed to connect", ignoreCase = true) ->
            "Cannot reach $url.$loopback Is Zelari Desktop → Connections → companion serve running, bound for Tailscale/LAN (not 127.0.0.1), and is Tailscale up on both devices?"
        err is java.net.SocketTimeoutException || msg.contains("timeout", ignoreCase = true) ->
            "Timeout reaching $url.$loopback Check Tailscale is connected on phone and PC (`tailscale status`)."
        err is java.net.UnknownHostException ->
            "Host not found for $url. Prefer the Tailscale IPv4 from Desktop QR (`tailscale ip -4`)."
        msg.contains("CLEARTEXT", ignoreCase = true) ->
            "HTTP blocked by Android. Use http:// and a tailnet/LAN address."
        else -> (msg.ifBlank { err.javaClass.simpleName }) + loopback
    }
}
