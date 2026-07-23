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

enum class ConnState {
    Disconnected,
    Connecting,
    Connected,
    Error,
}
