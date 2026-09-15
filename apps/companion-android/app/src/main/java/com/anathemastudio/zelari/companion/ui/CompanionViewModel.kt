package com.anathemastudio.zelari.companion.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.anathemastudio.zelari.companion.data.ChatMessage
import com.anathemastudio.zelari.companion.data.ConfigPaths
import com.anathemastudio.zelari.companion.data.ConnState
import com.anathemastudio.zelari.companion.data.FsEntry
import com.anathemastudio.zelari.companion.data.PendingAsk
import com.anathemastudio.zelari.companion.data.PendingPermission
import com.anathemastudio.zelari.companion.data.HistoryMessage
import com.anathemastudio.zelari.companion.data.Prefs
import com.anathemastudio.zelari.companion.data.ProjectDto
import com.anathemastudio.zelari.companion.data.ProviderInfo
import com.anathemastudio.zelari.companion.data.RunSummary
import com.anathemastudio.zelari.companion.data.StartRunRequest
import com.anathemastudio.zelari.companion.data.ZelariApi
import com.anathemastudio.zelari.companion.data.describeConnectFailure
import com.anathemastudio.zelari.companion.data.isLoopbackHost
import com.anathemastudio.zelari.companion.data.normalizeHostUrl
import com.anathemastudio.zelari.companion.data.parsePairingPayload
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
    val mode: String = "kraken",
    val phase: String = "build",
    val messages: List<ChatMessage> = emptyList(),
    val draft: String = "",
    val running: Boolean = false,
    val activeRunId: String? = null,
    val liveTool: String? = null,
    val drawerOpen: Boolean = false,
    val providers: List<ProviderInfo> = emptyList(),
    val selectedProvider: String = "",
    val selectedModel: String = "",
    val customModel: String = "",
    val sessions: List<RunSummary> = emptyList(),
    val showSettings: Boolean = false,
    val cliVersion: String = "",
    val configPaths: ConfigPaths? = null,
    // t63: agent controls (Desktop parity).
    val permissionPreset: String = "standard",
    val strictDone: Boolean = false,
    val folderPath: String = "",
    val showFolders: Boolean = false,
    val fsPath: String = "",
    val fsParent: String? = null,
    val fsRoots: List<ProjectDto> = emptyList(),
    val fsEntries: List<FsEntry> = emptyList(),
    val permissionAsk: PendingPermission? = null,
    val agentAsk: PendingAsk? = null,
    // t66: full-fs run parked until the desktop trust modal answers.
    val awaitingTrust: Boolean = false,
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
            val provider = prefs.provider.first()
            val model = prefs.model.first()
            val preset = prefs.permissionPreset.first()
            val strict = prefs.strictDone.first()
            val folder = prefs.folderPath.first()
            _ui.update {
                it.copy(
                    baseUrl = base,
                    token = token,
                    projectId = project,
                    mode = mode,
                    phase = phase,
                    selectedProvider = provider,
                    selectedModel = model,
                    permissionPreset = preset,
                    strictDone = strict,
                    folderPath = folder,
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

    // ── t63: agent controls (Desktop parity) ──

    fun setPermissionPreset(v: String) {
        _ui.update { it.copy(permissionPreset = v) }
        viewModelScope.launch { prefs.saveAgent(v, _ui.value.strictDone) }
    }

    fun setStrictDone(v: Boolean) {
        _ui.update { it.copy(strictDone = v) }
        viewModelScope.launch { prefs.saveAgent(_ui.value.permissionPreset, v) }
    }

    fun toggleFolders() {
        val opening = !_ui.value.showFolders
        _ui.update { it.copy(showFolders = opening) }
        if (opening) loadFs(null)
    }

    fun closeFolders() = _ui.update { it.copy(showFolders = false) }

    fun loadFs(path: String?) {
        viewModelScope.launch {
            try {
                val res = api.fs(path)
                _ui.update {
                    it.copy(
                        fsPath = res.path ?: "",
                        fsParent = res.parent,
                        fsRoots = res.roots,
                        fsEntries = res.entries,
                    )
                }
            } catch (e: Exception) {
                _ui.update {
                    it.copy(statusLine = "fs: ${e.message?.take(80) ?: e.javaClass.simpleName}")
                }
            }
        }
    }

    fun selectFolder(path: String) {
        _ui.update { it.copy(folderPath = path, showFolders = false, projectId = "") }
        viewModelScope.launch { prefs.saveFolder(path) }
    }

    fun clearFolder() {
        _ui.update { it.copy(folderPath = "") }
        viewModelScope.launch { prefs.saveFolder("") }
    }

    fun steer() {
        val state = _ui.value
        val text = state.draft.trim()
        val runId = state.activeRunId ?: return
        if (text.isEmpty()) return
        viewModelScope.launch {
            try {
                api.steer(runId, text)
                _ui.update { it.copy(draft = "", statusLine = "Steer sent…") }
            } catch (e: Exception) {
                _ui.update { it.copy(statusLine = "Steer failed: ${e.message?.take(80)}") }
            }
        }
    }

    fun respondPermission(requestId: String, decision: String) {
        val runId = _ui.value.activeRunId ?: return
        _ui.update { it.copy(permissionAsk = null) }
        viewModelScope.launch {
            try {
                api.permissionRespond(runId, requestId, decision)
            } catch (e: Exception) {
                appendSystem("Permission respond failed: ${e.message?.take(80)}")
            }
        }
    }

    fun respondAsk(requestId: String, answer: String?) {
        val runId = _ui.value.activeRunId ?: return
        _ui.update { it.copy(agentAsk = null) }
        viewModelScope.launch {
            try {
                api.askRespond(runId, requestId, answer)
            } catch (e: Exception) {
                appendSystem("Ask respond failed: ${e.message?.take(80)}")
            }
        }
    }

    fun toggleDrawer() = _ui.update { it.copy(drawerOpen = !it.drawerOpen) }
    fun closeDrawer() = _ui.update { it.copy(drawerOpen = false) }

    fun setProvider(id: String) {
        val provider = _ui.value.providers.find { it.id == id }
        val model = provider?.let { p ->
            p.defaultModel.ifBlank { p.models.firstOrNull().orEmpty() }
        }.orEmpty()
        _ui.update { it.copy(selectedProvider = id, selectedModel = model) }
        viewModelScope.launch { prefs.saveProviderModel(id, model) }
    }

    fun setModel(m: String) {
        _ui.update { it.copy(selectedModel = m) }
        viewModelScope.launch { prefs.saveProviderModel(_ui.value.selectedProvider, m) }
    }

    fun rerun(prompt: String) {
        _ui.update { it.copy(draft = prompt, drawerOpen = false) }
    }

    fun setCustomModel(v: String) {
        _ui.update { it.copy(customModel = v) }
        viewModelScope.launch {
            val effective = v.ifBlank { _ui.value.selectedModel }
            prefs.saveProviderModel(_ui.value.selectedProvider, effective)
        }
    }

    fun toggleSettings() = _ui.update { it.copy(showSettings = !it.showSettings) }
    fun closeSettings() = _ui.update { it.copy(showSettings = false) }

    private fun loadConfig() {
        viewModelScope.launch {
            try {
                val cfg = api.config()
                if (!cfg.ok) return@launch
                val savedProvider = _ui.value.selectedProvider
                val savedModel = _ui.value.selectedModel
                val provider = savedProvider.ifBlank { cfg.activeProviderId }
                val model = savedModel.ifBlank {
                    cfg.modelByProvider[provider]
                        ?: cfg.providers.find { it.id == provider }?.defaultModel.orEmpty()
                }
                _ui.update {
                    it.copy(
                        providers = cfg.providers,
                        selectedProvider = provider,
                        selectedModel = model,
                        cliVersion = cfg.cliVersion,
                        configPaths = cfg.configPaths,
                    )
                }
            } catch (_: Exception) {
                // config not critical — drawer will show empty pickers
            }
        }
    }

    fun loadSessions() {
        viewModelScope.launch {
            try {
                val res = api.listRuns()
                if (!res.ok) return@launch
                val all = buildList {
                    res.active?.let { add(it) }
                    addAll(res.recent)
                }
                _ui.update { it.copy(sessions = all) }
            } catch (_: Exception) {
                // sessions not critical
            }
        }
    }

    fun applyPairingPayload(raw: String) {
        val parsed = parsePairingPayload(raw)
        if (parsed == null) {
            appendSystem("QR not recognized. Scan the QR from Zelari Desktop → Connections → Mobile connection.")
            return
        }
        val token = parsed.token.ifBlank { _ui.value.token }
        _ui.update { it.copy(baseUrl = parsed.url, token = token) }
        connect(parsed.url, token)
    }

    fun connect(
        baseUrl: String = _ui.value.baseUrl,
        token: String = _ui.value.token,
        silent: Boolean = false,
    ) {
        viewModelScope.launch {
            val url = normalizeHostUrl(baseUrl)
            _ui.update {
                it.copy(
                    conn = ConnState.Connecting,
                    statusLine = "Connecting…",
                    baseUrl = url,
                    token = token,
                )
            }
            try {
                if (isLoopbackHost(url)) {
                    throw IllegalArgumentException(
                        "127.0.0.1 / localhost is this phone, not your PC. " +
                            "Scan the Desktop QR or paste the Tailscale IP (100.x) shown there.",
                    )
                }
                api.update(url, token)
                val health = api.health()
                val projects = api.projects()
                prefs.saveConnection(url, token)
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
                loadConfig()
                loadSessions()
            } catch (e: Exception) {
                val detail = describeConnectFailure(url, e)
                _ui.update {
                    it.copy(
                        conn = ConnState.Error,
                        statusLine = detail,
                    )
                }
                if (!silent) {
                    appendSystem("Connect failed: $detail")
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
                        projectId = if (state.folderPath.isBlank()) state.projectId.ifBlank { null } else null,
                        cwd = state.folderPath.ifBlank { null },
                        history = history,
                        permissionPreset = state.permissionPreset.ifBlank { null },
                        strictDone = state.strictDone,
                        provider = state.selectedProvider.ifBlank { null },
                        model = state.customModel.ifBlank { state.selectedModel }.ifBlank { null },
                    ),
                )
                if (!res.ok || res.run == null) {
                    failAssistant(assistantId, res.error ?: "Failed to start run")
                    return@launch
                }
                val runId = res.run.id
                val awaiting = res.awaitingTrust == true
                _ui.update {
                    it.copy(
                        activeRunId = runId,
                        awaitingTrust = awaiting,
                        statusLine = if (awaiting) "Waiting for desktop trust…" else "Running $runId…",
                    )
                }
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
        val type = ev.get("type")?.getAsString() ?: return
        when (type) {
            "message_delta", "text_delta" -> {
                val delta = ev.get("delta")?.getAsString()
                    ?: ev.get("text")?.getAsString()
                    ?: ev.get("content")?.getAsString()
                    ?: return
                appendAssistantDelta(assistantId, delta)
            }
            "message_end", "agent_end" -> {
                // keep streaming until run_finished
            }
            "tool_execution_start" -> {
                val name = ev.get("toolName")?.getAsString()
                    ?: ev.get("name")?.getAsString()
                    ?: ev.get("tool")?.getAsString()
                    ?: "tool"
                _ui.update { it.copy(liveTool = name) }
            }
            "tool_execution_end" -> {
                _ui.update { it.copy(liveTool = null) }
            }
            "error" -> {
                val msg = ev.get("message")?.getAsString()
                    ?: ev.get("error")?.getAsString()
                    ?: "error"
                appendAssistantDelta(assistantId, "\n\n⚠ $msg")
            }
            "log" -> {
                val msg = ev.get("message")?.getAsString() ?: return
                if (msg.contains("[headless]") || msg.contains("[companion]")) {
                    _ui.update { it.copy(statusLine = msg.take(120)) }
                }
            }
            "permission.request" -> {
                val reqId = ev.get("requestId")?.getAsString() ?: return
                _ui.update {
                    it.copy(
                        permissionAsk = PendingPermission(
                            requestId = reqId,
                            tool = ev.get("tool")?.getAsString() ?: "tool",
                            category = ev.get("category")?.takeIf { c -> c.isJsonPrimitive() }?.getAsString(),
                            categories = ev.get("categories")?.takeIf { c -> c.isJsonArray() }?.getAsJsonArray()
                                ?.mapNotNull { el -> if (el.isJsonPrimitive()) el.getAsString() else null }
                                ?: emptyList(),
                            reason = ev.get("reason")?.takeIf { c -> c.isJsonPrimitive() }?.getAsString(),
                        ),
                    )
                }
            }
            "permission.settled" -> {
                val decision = ev.get("decision")?.getAsString() ?: "settled"
                val timedOut = ev.get("timedOut")?.takeIf { c -> c.isJsonPrimitive() }?.getAsBoolean() ?: false
                _ui.update {
                    it.copy(
                        permissionAsk = null,
                        statusLine = if (timedOut) "Permission timed out — denied" else "Permission $decision",
                    )
                }
            }
            "ask_user.request" -> {
                val reqId = ev.get("requestId")?.getAsString() ?: return
                _ui.update {
                    it.copy(
                        agentAsk = PendingAsk(
                            requestId = reqId,
                            question = ev.get("question")?.takeIf { c -> c.isJsonPrimitive() }?.getAsString()
                                ?: "Agent question",
                            choices = ev.get("choices")?.takeIf { c -> c.isJsonArray() }?.getAsJsonArray()
                                ?.mapNotNull { el -> if (el.isJsonPrimitive()) el.getAsString() else null }
                                ?: emptyList(),
                        ),
                    )
                }
            }
            "ask_user.settled" -> _ui.update { it.copy(agentAsk = null) }
            "control_accepted", "control_applied" -> {
                _ui.update { it.copy(statusLine = type.removePrefix("control_")) }
            }
            // t66: full-fs run parked awaiting the desktop trust modal — keep
            // the user informed instead of a silent spin.
            "trust.pending" -> {
                val path = ev.get("path")?.takeIf { c -> c.isJsonPrimitive() }?.getAsString()
                _ui.update {
                    it.copy(
                        awaitingTrust = true,
                        statusLine = if (path.isNullOrBlank()) {
                            "Waiting for desktop to trust this folder…"
                        } else {
                            "Waiting for desktop to trust $path…"
                        },
                    )
                }
            }
            "trust.settled" -> {
                val approved = ev.get("approved")?.takeIf { c -> c.isJsonPrimitive() }?.getAsBoolean() ?: false
                _ui.update {
                    it.copy(
                        awaitingTrust = false,
                        statusLine = if (approved) "Trust approved — starting…" else "Trust denied — run cancelled",
                    )
                }
            }
            "run_finished" -> {
                val status = ev.get("status")?.getAsString() ?: "completed"
                _ui.update {
                    it.copy(
                        running = false,
                        activeRunId = null,
                        liveTool = null,
                        awaitingTrust = false,
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
