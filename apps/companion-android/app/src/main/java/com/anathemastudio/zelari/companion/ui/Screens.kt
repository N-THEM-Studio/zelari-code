package com.anathemastudio.zelari.companion.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.ClearAll
import androidx.compose.material.icons.filled.Link
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.anathemastudio.zelari.companion.data.ChatMessage
import com.anathemastudio.zelari.companion.data.ConnState

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CompanionApp(vm: CompanionViewModel) {
    val state by vm.ui.collectAsState()
    var showConnect by remember { mutableStateOf(false) }

    LaunchedEffect(state.conn) {
        if (state.conn == ConnState.Disconnected || state.conn == ConnState.Error) {
            // keep connect sheet available
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text("Zelari", fontWeight = FontWeight.Bold)
                        Text(
                            state.statusLine,
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = 1,
                        )
                    }
                },
                actions = {
                    IconButton(onClick = { vm.clearChat() }) {
                        Icon(Icons.Default.ClearAll, contentDescription = "Clear chat")
                    }
                    IconButton(onClick = { showConnect = true }) {
                        Icon(Icons.Default.Link, contentDescription = "Connection")
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.surface,
                ),
            )
        },
        containerColor = MaterialTheme.colorScheme.background,
    ) { padding ->
        Column(
            Modifier
                .fillMaxSize()
                .padding(padding),
        ) {
            ControlsBar(state, vm)
            ChatList(
                messages = state.messages,
                liveTool = state.liveTool,
                running = state.running,
                modifier = Modifier.weight(1f),
            )
            Composer(
                draft = state.draft,
                running = state.running,
                connected = state.conn == ConnState.Connected,
                onDraft = vm::setDraft,
                onSend = vm::send,
                onCancel = vm::cancel,
            )
        }
    }

    if (showConnect || state.conn != ConnState.Connected) {
        ConnectSheet(
            state = state,
            onDismiss = {
                if (state.conn == ConnState.Connected) showConnect = false
            },
            onBaseUrl = vm::setBaseUrl,
            onToken = vm::setToken,
            onConnect = {
                vm.connect()
                showConnect = false
            },
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ControlsBar(state: UiState, vm: CompanionViewModel) {
    Column(
        Modifier
            .fillMaxWidth()
            .background(MaterialTheme.colorScheme.surface)
            .padding(horizontal = 12.dp, vertical = 8.dp),
    ) {
        // Project dropdown
        var projOpen by remember { mutableStateOf(false) }
        val selected = state.projects.find { it.id == state.projectId }
        ExposedDropdownMenuBox(expanded = projOpen, onExpandedChange = { projOpen = it }) {
            OutlinedTextField(
                value = selected?.let { "${it.name} (${it.id})" } ?: state.projectId.ifBlank { "Project…" },
                onValueChange = {},
                readOnly = true,
                label = { Text("Project") },
                trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(projOpen) },
                modifier = Modifier
                    .menuAnchor()
                    .fillMaxWidth(),
                singleLine = true,
            )
            ExposedDropdownMenu(expanded = projOpen, onDismissRequest = { projOpen = false }) {
                state.projects.forEach { p ->
                    DropdownMenuItem(
                        text = {
                            Column {
                                Text(p.name, fontWeight = FontWeight.SemiBold)
                                Text(p.path, fontSize = 11.sp, fontFamily = FontFamily.Monospace)
                            }
                        },
                        onClick = {
                            vm.setProject(p.id)
                            projOpen = false
                        },
                    )
                }
            }
        }
        Spacer(Modifier.height(8.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            listOf("agent", "council", "zelari").forEach { m ->
                FilterChip(
                    selected = state.mode == m,
                    onClick = { vm.setMode(m) },
                    label = { Text(m) },
                )
            }
            Spacer(Modifier.width(4.dp))
            listOf("plan", "build").forEach { p ->
                FilterChip(
                    selected = state.phase == p,
                    onClick = { vm.setPhase(p) },
                    label = { Text(p) },
                )
            }
        }
    }
}

@Composable
private fun ChatList(
    messages: List<ChatMessage>,
    liveTool: String?,
    running: Boolean,
    modifier: Modifier = Modifier,
) {
    val listState = rememberLazyListState()
    LaunchedEffect(messages.size, messages.lastOrNull()?.content?.length, liveTool) {
        if (messages.isNotEmpty()) {
            listState.animateScrollToItem(messages.lastIndex + if (liveTool != null) 1 else 0)
        }
    }
    LazyColumn(
        state = listState,
        modifier = modifier.fillMaxWidth(),
        contentPadding = PaddingValues(12.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        if (messages.isEmpty()) {
            item {
                Box(
                    Modifier
                        .fillMaxWidth()
                        .padding(32.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        "Connect to your PC via Tailscale,\nthen send a prompt like Desktop.",
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                    )
                }
            }
        }
        items(messages, key = { it.id }) { msg ->
            MessageBubble(msg)
        }
        if (running && liveTool != null) {
            item {
                Text(
                    "⚙ $liveTool",
                    color = MaterialTheme.colorScheme.primary,
                    style = MaterialTheme.typography.labelMedium,
                    modifier = Modifier.padding(start = 8.dp),
                )
            }
        }
    }
}

@Composable
private fun MessageBubble(msg: ChatMessage) {
    val isUser = msg.role == "user"
    val isSystem = msg.role == "system"
    val bg = when {
        isUser -> MaterialTheme.colorScheme.primary.copy(alpha = 0.18f)
        isSystem -> MaterialTheme.colorScheme.surfaceVariant
        else -> MaterialTheme.colorScheme.surface
    }
    val align = if (isUser) Alignment.CenterEnd else Alignment.CenterStart
    Box(Modifier.fillMaxWidth(), contentAlignment = align) {
        Card(
            colors = CardDefaults.cardColors(containerColor = bg),
            shape = RoundedCornerShape(14.dp),
            modifier = Modifier.fillMaxWidth(if (isUser) 0.92f else 1f),
        ) {
            Column(Modifier.padding(12.dp)) {
                Text(
                    msg.role.uppercase(),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.primary,
                    fontWeight = FontWeight.Bold,
                )
                Spacer(Modifier.height(4.dp))
                Text(
                    msg.content.ifBlank { if (msg.streaming) "…" else "" },
                    style = MaterialTheme.typography.bodyMedium,
                    fontFamily = if (isSystem) FontFamily.Monospace else FontFamily.Default,
                    lineHeight = 20.sp,
                )
            }
        }
    }
}

@Composable
private fun Composer(
    draft: String,
    running: Boolean,
    connected: Boolean,
    onDraft: (String) -> Unit,
    onSend: () -> Unit,
    onCancel: () -> Unit,
) {
    Row(
        Modifier
            .fillMaxWidth()
            .background(MaterialTheme.colorScheme.surface)
            .padding(10.dp),
        verticalAlignment = Alignment.Bottom,
    ) {
        OutlinedTextField(
            value = draft,
            onValueChange = onDraft,
            modifier = Modifier.weight(1f),
            placeholder = {
                Text(if (connected) "Message the agent…" else "Connect first…")
            },
            minLines = 1,
            maxLines = 5,
            enabled = !running,
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
            keyboardActions = KeyboardActions(onSend = { if (!running) onSend() }),
        )
        Spacer(Modifier.width(8.dp))
        if (running) {
            IconButton(onClick = onCancel) {
                Icon(
                    Icons.Default.Stop,
                    contentDescription = "Stop",
                    tint = MaterialTheme.colorScheme.error,
                    modifier = Modifier.size(28.dp),
                )
            }
        } else {
            IconButton(
                onClick = onSend,
                enabled = connected && draft.isNotBlank(),
            ) {
                Icon(
                    Icons.AutoMirrored.Filled.Send,
                    contentDescription = "Send",
                    tint = MaterialTheme.colorScheme.primary,
                    modifier = Modifier.size(28.dp),
                )
            }
        }
    }
}

@Composable
private fun ConnectSheet(
    state: UiState,
    onDismiss: () -> Unit,
    onBaseUrl: (String) -> Unit,
    onToken: (String) -> Unit,
    onConnect: () -> Unit,
) {
    Box(
        Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background.copy(alpha = 0.96f))
            .padding(20.dp),
        contentAlignment = Alignment.Center,
    ) {
        Card(
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
            shape = RoundedCornerShape(18.dp),
            modifier = Modifier.fillMaxWidth(),
        ) {
            Column(Modifier.padding(20.dp)) {
                Text("Connect to host", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
                Spacer(Modifier.height(6.dp))
                Text(
                    "Run on PC:\nzelari-code serve --bind <tailscale-ip> --project <repo>\nThen paste URL + token.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Spacer(Modifier.height(16.dp))
                OutlinedTextField(
                    value = state.baseUrl,
                    onValueChange = onBaseUrl,
                    label = { Text("Host URL") },
                    placeholder = { Text("http://100.x.y.z:7421") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                Spacer(Modifier.height(10.dp))
                OutlinedTextField(
                    value = state.token,
                    onValueChange = onToken,
                    label = { Text("Bearer token") },
                    placeholder = { Text("~/.zelari-code/companion.token") },
                    singleLine = true,
                    visualTransformation = PasswordVisualTransformation(),
                    modifier = Modifier.fillMaxWidth(),
                )
                if (state.conn == ConnState.Error) {
                    Spacer(Modifier.height(8.dp))
                    Text(state.statusLine, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                }
                Spacer(Modifier.height(16.dp))
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                    if (state.conn == ConnState.Connected) {
                        TextButton(onClick = onDismiss) { Text("Close") }
                        Spacer(Modifier.width(8.dp))
                    }
                    Button(
                        onClick = onConnect,
                        enabled = state.baseUrl.isNotBlank() && state.token.isNotBlank() &&
                            state.conn != ConnState.Connecting,
                    ) {
                        Text(if (state.conn == ConnState.Connecting) "Connecting…" else "Connect")
                    }
                }
            }
        }
    }
}
