package com.anathemastudio.zelari.companion.data

import com.google.gson.Gson
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.sse.EventSource
import okhttp3.sse.EventSourceListener
import okhttp3.sse.EventSources
import java.util.concurrent.TimeUnit

class ZelariApi(
    private var baseUrl: String,
    private var token: String,
) {
    private val gson = Gson()
    private val client = OkHttpClient.Builder()
        .connectTimeout(20, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.SECONDS) // SSE
        .writeTimeout(30, TimeUnit.SECONDS)
        .callTimeout(0, TimeUnit.SECONDS)
        .build()

    private val jsonMedia = "application/json; charset=utf-8".toMediaType()

    fun update(baseUrl: String, token: String) {
        this.baseUrl = baseUrl.trim().trimEnd('/')
        this.token = token.trim()
    }

    private fun url(path: String): String {
        val p = if (path.startsWith("/")) path else "/$path"
        return baseUrl + p
    }

    private fun authed(builder: Request.Builder): Request.Builder {
        if (token.isNotBlank()) {
            builder.header("Authorization", "Bearer $token")
        }
        return builder
    }

    suspend fun health(): HealthResponse = withContext(Dispatchers.IO) {
        val req = Request.Builder().url(url("/health")).get().build()
        client.newCall(req).execute().use { res ->
            val body = res.body?.string().orEmpty()
            if (!res.isSuccessful) error("health HTTP ${res.code}: $body")
            gson.fromJson(body, HealthResponse::class.java)
        }
    }

    suspend fun projects(): ProjectsResponse = withContext(Dispatchers.IO) {
        val req = authed(Request.Builder().url(url("/v1/projects")).get()).build()
        client.newCall(req).execute().use { res ->
            val body = res.body?.string().orEmpty()
            if (!res.isSuccessful) error("projects HTTP ${res.code}: $body")
            gson.fromJson(body, ProjectsResponse::class.java)
        }
    }

    suspend fun config(): ConfigResponse = withContext(Dispatchers.IO) {
        val req = authed(Request.Builder().url(url("/v1/config")).get()).build()
        client.newCall(req).execute().use { res ->
            val body = res.body?.string().orEmpty()
            if (!res.isSuccessful) error("config HTTP ${res.code}: $body")
            gson.fromJson(body, ConfigResponse::class.java)
        }
    }

    suspend fun listRuns(): RunsResponse = withContext(Dispatchers.IO) {
        val req = authed(Request.Builder().url(url("/v1/runs")).get()).build()
        client.newCall(req).execute().use { res ->
            val body = res.body?.string().orEmpty()
            if (!res.isSuccessful) error("runs HTTP ${res.code}: $body")
            gson.fromJson(body, RunsResponse::class.java)
        }
    }

    suspend fun startRun(body: StartRunRequest): StartRunResponse = withContext(Dispatchers.IO) {
        val json = gson.toJson(body)
        val req = authed(
            Request.Builder()
                .url(url("/v1/runs"))
                .post(json.toRequestBody(jsonMedia)),
        ).build()
        client.newCall(req).execute().use { res ->
            val text = res.body?.string().orEmpty()
            val parsed = gson.fromJson(text, StartRunResponse::class.java)
                ?: StartRunResponse(ok = false, error = text)
            if (!res.isSuccessful && parsed.error == null) {
                return@use StartRunResponse(ok = false, error = "HTTP ${res.code}: $text")
            }
            parsed
        }
    }

    suspend fun cancel(runId: String): Boolean = withContext(Dispatchers.IO) {
        val req = authed(
            Request.Builder()
                .url(url("/v1/runs/$runId/cancel"))
                .post("{}".toRequestBody(jsonMedia)),
        ).build()
        client.newCall(req).execute().use { it.isSuccessful }
    }

    /** t63: steer the active run (harness client mode hosts only). */
    suspend fun steer(runId: String, text: String): Boolean = withContext(Dispatchers.IO) {
        val json = gson.toJson(mapOf("text" to text))
        val req = authed(
            Request.Builder()
                .url(url("/v1/runs/$runId/steer"))
                .post(json.toRequestBody(jsonMedia)),
        ).build()
        client.newCall(req).execute().use { it.isSuccessful }
    }

    /** t63: sandboxed folder listing — path null lists the allowlist roots. */
    suspend fun fs(path: String?): FsResponse = withContext(Dispatchers.IO) {
        val q = if (path.isNullOrBlank()) {
            ""
        } else {
            "?path=" + java.net.URLEncoder.encode(path, "UTF-8")
        }
        val req = authed(Request.Builder().url(url("/v1/fs$q")).get()).build()
        client.newCall(req).execute().use { res ->
            val body = res.body?.string().orEmpty()
            if (!res.isSuccessful) error("fs HTTP ${res.code}: $body")
            gson.fromJson(body, FsResponse::class.java)
        }
    }

    /** t63: settle a permission.request (allow/deny/always-tool/always-category). */
    suspend fun permissionRespond(runId: String, requestId: String, decision: String): Boolean =
        withContext(Dispatchers.IO) {
            val json = gson.toJson(mapOf("requestId" to requestId, "decision" to decision))
            val req = authed(
                Request.Builder()
                    .url(url("/v1/runs/$runId/permission"))
                    .post(json.toRequestBody(jsonMedia)),
            ).build()
            client.newCall(req).execute().use { it.isSuccessful }
        }

    /** t63: settle an ask_user.request (null = dismiss). */
    suspend fun askRespond(runId: String, requestId: String, answer: String?): Boolean =
        withContext(Dispatchers.IO) {
            val json = gson.toJson(mapOf("requestId" to requestId, "answer" to answer))
            val req = authed(
                Request.Builder()
                    .url(url("/v1/runs/$runId/ask"))
                    .post(json.toRequestBody(jsonMedia)),
            ).build()
            client.newCall(req).execute().use { it.isSuccessful }
        }

    /**
     * Stream SSE events from /v1/runs/:id/events.
     * Emits raw JsonObject per data line.
     */
    fun streamEvents(runId: String): Flow<JsonObject> = callbackFlow {
        val req = authed(
            Request.Builder()
                .url(url("/v1/runs/$runId/events"))
                .header("Accept", "text/event-stream")
                .get(),
        ).build()

        val factory = EventSources.createFactory(client)
        val listener = object : EventSourceListener() {
            override fun onEvent(
                eventSource: EventSource,
                id: String?,
                type: String?,
                data: String,
            ) {
                if (data.isBlank()) return
                try {
                    val el = JsonParser.parseString(data)
                    if (el.isJsonObject()) {
                        trySend(el.getAsJsonObject())
                    }
                } catch (_: Exception) {
                    // ignore malformed
                }
            }

            override fun onFailure(
                eventSource: EventSource,
                t: Throwable?,
                response: Response?,
            ) {
                close(t ?: Exception("SSE failed HTTP ${response?.code}"))
            }

            override fun onClosed(eventSource: EventSource) {
                close()
            }
        }

        val source = factory.newEventSource(req, listener)
        awaitClose { source.cancel() }
    }
}
