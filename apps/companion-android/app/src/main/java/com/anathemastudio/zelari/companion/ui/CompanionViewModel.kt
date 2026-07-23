package com.anathemastudio.zelari.companion.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.anathemastudio.zelari.companion.data.ChatMessage
import com.anathemastudio.zelari.companion.data.ConnState
import com.anathemastudio.zelari.companion.data.HistoryMessage
import com.anathemastudio.zelari.companion.data.Prefs
import com.anathemastudio.zelari.companion.data.ProjectDto
import com.anathemastudio.zelari.companion.data.StartRunRequest
import com.anathemastudio.zelari.companion.data.ZelariApi
import com.google.gson.JsonObject
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.util.UUID

data class UiState(
    val baseUrl: String = "",
    val token: String = "",
    val conn: ConnState = ConnState.Disconnected,
    val statusLine: String = "Not connected",
    val hostVersion: String? = null,
    val projects: List<ProjectDto> = emptyList(),
    val projectId: String = "",
    val mode: String = "agent",
    val phase: String = "build",
    val messages: List<ChatMessage> = emptyList(),
    val draft: String = "",
    val running: Boolean = false,
    val activeRunId: String? = null,
    val liveTool: String? = null,
)

class CompanionViewModel(app: Application) : AndroidViewModel(app) {
    private val prefs = Prefs(app)
    private val api = ZelariApi("", "")

    private val _ui = MutableStateFlow(UiState())
    val ui: StateFlow<UiState> = _ui.asStateFlow()

    private var streamJob: Job? = null

    init {
        viewModelScope.launch {
            val base = prefs.baseUrl.first()
            val token = prefs.token.first()
            val project = prefs.projectId.first()
            val mode = prefs.mode.first()
            val phase = prefs.phase.first()
            _ui.update {
                it.copy(
                    baseUrl = base,
                    token = token,
                    projectId = project,
                    mode = mode,
                    phase = phase,
                )
            }
            if (base.isNotBlank() && token.isNotBlank()) {
                connect(base, token, silent = true)
            }
        }
    }

    fun setBaseUrl(v: String) = _ui.update { it.copy(baseUrl = v) }
    fun setToken(v: String) = _ui.update { it.copy(token = v) }
    fun setDraft(v: String) = _ui.update { it.copy(draft = v) }
    fun setMode(v: String) {
        _ui.update { it.copy(mode = v) }
        viewModelScope.launch { prefs.saveModePhase(v, _ui.value.phase) }
    }
    fun setPhase(v: String) {
        _ui.update { it.copy(phase = v) }
        viewModelScope.launch { prefs.saveModePhase(_ui.value.mode, v) }
    }
    fun setProject(id: String) {
        _ui.update { it.copy(projectId = id) }
        viewModelScope.launch { prefs.saveProject(id) }
    }

    fun connect(
        baseUrl: String = _ui.value.baseUrl,
        token: String = _ui.value.token,
        silent: Boolean = false,
    ) {
        viewModelScope.launch {
            _ui.update {
                it.copy(
                    conn = ConnState.Connecting,
                    statusLine = "Connecting…",
                    baseUrl = baseUrl,
                    token = token,
                )
            }
            try {
                api.update(baseUrl, token)
                val health = api.health()
                val projects = api.projects()
                prefs.saveConnection(baseUrl, token)
                val pid = _ui.value.projectId.ifBlank {
                    projects.projects.firstOrNull()?.id.orEmpty()
                }
                if (pid.isNotBlank()) prefs.saveProject(pid)
                _ui.update {
                    it.copy(
                        conn = ConnState.Connected,
                        statusLine = "Connected · v${health.version ?: "?"} · ${projects.projects.size} projects",
                        hostVersion = health.version,
                        projects = projects.projects,
                        projectId = pid.ifBlank { it.projectId },
                    )
                }
            } catch (e: Exception) {
                _ui.update {
                    it.copy(
                        conn = ConnState.Error,
                        statusLine = e.message ?: "Connection failed",
                    )
                }
                if (!silent) {
                    appendSystem("Connect failed: ${e.message}")
                }
            }
        }
    }

    fun send() {
        val state = _ui.value
        val text = state.draft.trim()
        if (text.isEmpty() || state.running) return
        if (state.conn != ConnState.Connected) {
            appendSystem("Connect to host first.")
            return
        }

        val userMsg = ChatMessage(
            id = UUID.randomUUID().toString(),
            role = "user",
            content = text,
        )
        val assistantId = UUID.randomUUID().toString()
        _ui.update {
            it.copy(
                draft = "",
                running = true,
                liveTool = null,
                messages = it.messages + userMsg + ChatMessage(
                    id = assistantId,
                    role = "assistant",
                    content = "",
                    streaming = true,
                ),
            )
        }

        viewModelScope.launch {
            try {
                val history = buildHistory(state.messages + userMsg)
                val res = api.startRun(
                    StartRunRequest(
                        prompt = text,
                        mode = state.mode,
                        phase = state.phase,
                        projectId = state.projectId.ifBlank { null },
                        history = history,
                    ),
                )
                if (!res.ok || res.run == null) {
                    failAssistant(assistantId, res.error ?: "Failed to start run")
                    return@launch
                }
                val runId = res.run.id
                _ui.update { it.copy(activeRunId = runId, statusLine = "Running $runId…") }
                streamJob?.cancel()
                streamJob = launch {
                    try {
                        api.streamEvents(runId).collect { ev ->
                            handleEvent(assistantId, ev)
                        }
                    } catch (e: Exception) {
                        // Stream closed after finish is normal
                        if (_ui.value.running) {
                            _ui.update {
                                it.copy(
                                    running = false,
                                    statusLine = e.message ?: "Stream ended",
                                    liveTool = null,
                                )
                            }
                            finalizeAssistant(assistantId)
                        }
                    }
                }
            } catch (e: Exception) {
                failAssistant(assistantId, e.message ?: "send failed")
            }
        }
    }

    fun cancel() {
        val id = _ui.value.activeRunId ?: return
        viewModelScope.launch {
            try {
                api.cancel(id)
                _ui.update { it.copy(statusLine = "Cancel requested…") }
            } catch (e: Exception) {
                appendSystem("Cancel failed: ${e.message}")
            }
        }
    }

    fun clearChat() {
        _ui.update { it.copy(messages = emptyList()) }
    }

    private fun buildHistory(messages: List<ChatMessage>): List<HistoryMessage> {
        return messages
            .filter { it.role == "user" || it.role == "assistant" }
            .filter { it.content.isNotBlank() }
            .takeLast(16)
            .map { HistoryMessage(role = it.role, content = it.content) }
    }

    private fun handleEvent(assistantId: String, ev: JsonObject) {
        val type = ev.get("type")?.asString ?: return
        when (type) {
            "message_delta", "text_delta" -> {
                val delta = ev.get("delta")?.asString
                    ?: ev.get("text")?.asString
                    ?: ev.get("content")?.asString
                    ?: return
                appendAssistantDelta(assistantId, delta)
            }
            "message_end", "agent_end" -> {
                // keep streaming until run_finished
            }
            "tool_execution_start" -> {
                val name = ev.get("toolName")?.asString
                    ?: ev.get("name")?.asString
                    ?: ev.get("tool")?.asString
                    ?: "tool"
                _ui.update { it.copy(liveTool = name) }
            }
            "tool_execution_end" -> {
                _ui.update { it.copy(liveTool = null) }
            }
            "error" -> {
                val msg = ev.get("message")?.asString
                    ?: ev.get("error")?.asString
                    ?: "error"
                appendAssistantDelta(assistantId, "\n\n⚠ $msg")
            }
            "log" -> {
                val msg = ev.get("message")?.asString ?: return
                if (msg.contains("[headless]") || msg.contains("[companion]")) {
                    _ui.update { it.copy(statusLine = msg.take(120)) }
                }
            }
            "run_finished" -> {
                val status = ev.get("status")?.asString ?: "completed"
                _ui.update {
                    it.copy(
                        running = false,
                        activeRunId = null,
                        liveTool = null,
                        statusLine = "Run $status",
                    )
                }
                finalizeAssistant(assistantId)
            }
        }
    }

    private fun appendAssistantDelta(id: String, delta: String) {
        _ui.update { state ->
            state.copy(
                messages = state.messages.map { m ->
                    if (m.id == id) m.copy(content = m.content + delta, streaming = true)
                    else m
                },
            )
        }
    }

    private fun finalizeAssistant(id: String) {
        _ui.update { state ->
            state.copy(
                messages = state.messages.map { m ->
                    if (m.id == id) {
                        val c = m.content.ifBlank { "(no text)" }
                        m.copy(content = c, streaming = false)
                    } else m
                },
            )
        }
    }

    private fun failAssistant(id: String, err: String) {
        _ui.update { state ->
            state.copy(
                running = false,
                activeRunId = null,
                liveTool = null,
                statusLine = err,
                messages = state.messages.map { m ->
                    if (m.id == id) m.copy(content = "⚠ $err", streaming = false)
                    else m
                },
            )
        }
    }

    private fun appendSystem(text: String) {
        _ui.update {
            it.copy(
                messages = it.messages + ChatMessage(
                    id = UUID.randomUUID().toString(),
                    role = "system",
                    content = text,
                ),
            )
        }
    }
}
