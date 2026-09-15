package com.anathemastudio.zelari.companion.data

data class HealthResponse(
    val ok: Boolean = false,
    val service: String? = null,
    val version: String? = null,
    val projects: Int? = null,
    val activeRun: String? = null,
)

data class ProjectsResponse(
    val ok: Boolean = false,
    val projects: List<ProjectDto> = emptyList(),
)

data class ProjectDto(
    val id: String = "",
    val name: String = "",
    val path: String = "",
)

data class StartRunRequest(
    val prompt: String,
    val mode: String = "agent",
    val phase: String = "build",
    val projectId: String? = null,
    val cwd: String? = null,
    val history: List<HistoryMessage>? = null,
    val provider: String? = null,
    val model: String? = null,
    // t63: per-turn knobs (Desktop parity) — server drops unknown values.
    val permissionPreset: String? = null,
    val strictDone: Boolean? = null,
    val verifyPack: Boolean? = null,
)

data class HistoryMessage(
    val role: String,
    val content: String,
)

data class StartRunResponse(
    val ok: Boolean = false,
    val error: String? = null,
    val run: RunDto? = null,
    val eventsUrl: String? = null,
    val cancelUrl: String? = null,
    val steerUrl: String? = null,
    val permissionUrl: String? = null,
    val askUrl: String? = null,
    // t66: full-fs cwd outside the allowlist — run parked until the desktop
    // trust modal approves (POST /v1/trust).
    val awaitingTrust: Boolean? = null,
)

data class RunDto(
    val id: String = "",
    val status: String = "",
    val mode: String = "",
    val phase: String = "",
    val cwd: String = "",
    val createdAt: Long = 0,
)

data class ChatMessage(
    val id: String,
    val role: String, // user | assistant | system | tool
    val content: String,
    val streaming: Boolean = false,
)

data class ConfigResponse(
    val ok: Boolean = false,
    val activeProviderId: String = "",
    val modelByProvider: Map<String, String> = emptyMap(),
    val providers: List<ProviderInfo> = emptyList(),
    val cliVersion: String = "",
    val configPaths: ConfigPaths? = null,
)

data class ConfigPaths(
    val provider: String = "",
    val keys: String = "",
)

data class ProviderInfo(
    val id: String = "",
    val displayName: String = "",
    val hasKey: Boolean = false,
    val envVar: String = "",
    val models: List<String> = emptyList(),
    val defaultModel: String = "",
    val endpoint: String? = null,
    val baseUrl: String? = null,
)

data class RunsResponse(
    val ok: Boolean = false,
    val active: RunSummary? = null,
    val recent: List<RunSummary> = emptyList(),
)

data class RunSummary(
    val id: String = "",
    val status: String = "",
    val mode: String = "",
    val phase: String = "",
    val cwd: String = "",
    val createdAt: Long = 0,
    val finishedAt: Long? = null,
    val exitCode: Int? = null,
    val promptPreview: String = "",
)

enum class ConnState {
    Disconnected,
    Connecting,
    Connected,
    Error,
}

// t63: sandboxed folder browsing (GET /v1/fs).
data class FsEntry(
    val name: String = "",
    val path: String = "",
    val dir: Boolean = true,
)

data class FsResponse(
    val ok: Boolean = false,
    val path: String? = null,
    val parent: String? = null,
    val roots: List<ProjectDto> = emptyList(),
    val entries: List<FsEntry> = emptyList(),
)

// t63: pending mobile approvals raised on the run SSE.
data class PendingPermission(
    val requestId: String,
    val tool: String,
    val category: String? = null,
    val categories: List<String> = emptyList(),
    val reason: String? = null,
)

data class PendingAsk(
    val requestId: String,
    val question: String,
    val choices: List<String> = emptyList(),
)
