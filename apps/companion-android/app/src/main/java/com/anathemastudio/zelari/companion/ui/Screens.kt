package com.anathemastudio.zelari.companion.ui

import android.text.format.DateUtils
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.ClearAll
import androidx.compose.material.icons.filled.Link
import androidx.compose.material.icons.filled.Menu
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.DrawerValue
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalDrawerSheet
import androidx.compose.material3.ModalNavigationDrawer
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.rememberDrawerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.anathemastudio.zelari.companion.data.ChatMessage
import com.anathemastudio.zelari.companion.data.ConnState
import com.anathemastudio.zelari.companion.data.ProviderInfo
import com.anathemastudio.zelari.companion.data.RunSummary

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CompanionApp(vm: CompanionViewModel) {
    val state by vm.ui.collectAsState()
    var showConnect by remember { mutableStateOf(false) }

    val drawerState = rememberDrawerState(initialValue = DrawerValue.Closed)

    // VM state -> drawer
    LaunchedEffect(state.drawerOpen) {
        if (state.drawerOpen) drawerState.open() else drawerState.close()
    }
    // Swipe-to-close -> VM state
    LaunchedEffect(drawerState) {
        snapshotFlow { drawerState.isClosed }
            .collect { if (it) vm.closeDrawer() }
    }

    ModalNavigationDrawer(
        drawerState = drawerState,
        drawerContent = {
            DrawerContent(state = state, vm = vm)
        },
    ) {
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
                    navigationIcon = {
                        IconButton(onClick = { vm.toggleDrawer() }) {
                            Icon(Icons.Default.Menu, contentDescription = "Menu")
                        }
                    },
                    actions = {
                        IconButton(onClick = { vm.clearChat() }) {
                            Icon(Icons.Default.ClearAll, contentDescription = "Clear chat")
                        }
                        IconButton(onClick = { vm.toggleSettings() }) {
                            Icon(Icons.Default.Settings, contentDescription = "Settings")
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
            if (state.showSettings) {
                SettingsScreen(state, vm, Modifier.padding(padding))
            } else {
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

// ── Drawer ──────────────────────────────────────────────────────────────────

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun DrawerContent(state: UiState, vm: CompanionViewModel) {
    ModalDrawerSheet {
        Column(
            Modifier
                .verticalScroll(rememberScrollState())
                .padding(16.dp),
        ) {
            // Header
            Text("Zelari Companion", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
            Text(
                state.statusLine,
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.height(16.dp))
            HorizontalDivider()
            Spacer(Modifier.height(12.dp))

            // ── Provider / Model ──
            Text(
                "PROVIDER / MODEL",
                style = MaterialTheme.typography.labelLarge,
                color = MaterialTheme.colorScheme.primary,
                fontWeight = FontWeight.Bold,
            )
            Spacer(Modifier.height(8.dp))
            ProviderPicker(state, vm)
            Spacer(Modifier.height(8.dp))
            ModelPicker(state, vm)
            Spacer(Modifier.height(16.dp))
            HorizontalDivider()
            Spacer(Modifier.height(12.dp))

            // ── Directory ──
            Text(
                "DIRECTORY",
                style = MaterialTheme.typography.labelLarge,
                color = MaterialTheme.colorScheme.primary,
                fontWeight = FontWeight.Bold,
            )
            Spacer(Modifier.height(8.dp))
            ProjectPicker(state, vm)
            Spacer(Modifier.height(16.dp))
            HorizontalDivider()
            Spacer(Modifier.height(12.dp))

            // ── Sessioni ──
            Row(
                Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    "SESSIONI",
                    style = MaterialTheme.typography.labelLarge,
                    color = MaterialTheme.colorScheme.primary,
                    fontWeight = FontWeight.Bold,
                )
                Spacer(Modifier.weight(1f))
                IconButton(
                    onClick = { vm.loadSessions() },
                    modifier = Modifier.size(32.dp),
                ) {
                    Icon(
                        Icons.Default.Refresh,
                        contentDescription = "Refresh sessions",
                        modifier = Modifier.size(18.dp),
                    )
                }
            }
            Spacer(Modifier.height(4.dp))
            if (state.sessions.isEmpty()) {
                Text(
                    "No runs yet.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            } else {
                state.sessions.forEach { run ->
                    SessionRow(run) { vm.rerun(run.promptPreview) }
                    Spacer(Modifier.height(6.dp))
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ProviderPicker(state: UiState, vm: CompanionViewModel) {
    var expanded by remember { mutableStateOf(false) }
    val selected = state.providers.find { it.id == state.selectedProvider }
    ExposedDropdownMenuBox(expanded = expanded, onExpandedChange = { expanded = it }) {
        OutlinedTextField(
            value = selected?.let {
                if (it.hasKey) it.displayName else "${it.displayName} (no key)"
            } ?: state.selectedProvider.ifBlank { "Provider…" },
            onValueChange = {},
            readOnly = true,
            label = { Text("Provider") },
            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded) },
            modifier = Modifier
                .menuAnchor()
                .fillMaxWidth(),
            singleLine = true,
        )
        ExposedDropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            state.providers.forEach { p ->
                DropdownMenuItem(
                    text = {
                        Text(
                            if (p.hasKey) p.displayName else "${p.displayName}  (no key)",
                            color = if (p.hasKey) {
                                MaterialTheme.colorScheme.onSurface
                            } else {
                                MaterialTheme.colorScheme.onSurfaceVariant
                            },
                        )
                    },
                    onClick = {
                        vm.setProvider(p.id)
                        expanded = false
                    },
                )
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ModelPicker(state: UiState, vm: CompanionViewModel) {
    var expanded by remember { mutableStateOf(false) }
    val provider = state.providers.find { it.id == state.selectedProvider }
    val models = provider?.models.orEmpty()
    // Ensure current selection is always visible in the list
    val options = if (state.selectedModel.isNotBlank() && state.selectedModel !in models) {
        listOf(state.selectedModel) + models
    } else {
        models
    }
    ExposedDropdownMenuBox(expanded = expanded, onExpandedChange = { expanded = it }) {
        OutlinedTextField(
            value = state.selectedModel.ifBlank { "Model…" },
            onValueChange = {},
            readOnly = true,
            label = { Text("Model") },
            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded) },
            modifier = Modifier
                .menuAnchor()
                .fillMaxWidth(),
            singleLine = true,
        )
        ExposedDropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            if (options.isEmpty()) {
                DropdownMenuItem(
                    text = { Text("No models discovered", color = MaterialTheme.colorScheme.onSurfaceVariant) },
                    onClick = { expanded = false },
                    enabled = false,
                )
            } else {
                options.forEach { m ->
                    DropdownMenuItem(
                        text = { Text(m, fontFamily = FontFamily.Monospace, fontSize = 13.sp) },
                        onClick = {
                            vm.setModel(m)
                            expanded = false
                        },
                    )
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ProjectPicker(state: UiState, vm: CompanionViewModel) {
    var expanded by remember { mutableStateOf(false) }
    val selected = state.projects.find { it.id == state.projectId }
    ExposedDropdownMenuBox(expanded = expanded, onExpandedChange = { expanded = it }) {
        OutlinedTextField(
            value = selected?.let { "${it.name} (${it.id})" } ?: state.projectId.ifBlank { "Project…" },
            onValueChange = {},
            readOnly = true,
            label = { Text("Project") },
            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded) },
            modifier = Modifier
                .menuAnchor()
                .fillMaxWidth(),
            singleLine = true,
        )
        ExposedDropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
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
                        expanded = false
                    },
                )
            }
        }
    }
}

@Composable
private fun SessionRow(run: RunSummary, onClick: () -> Unit) {
    val statusColor = when (run.status) {
        "running" -> MaterialTheme.colorScheme.primary
        "completed" -> Color(0xFF4CAF50)
        "error" -> MaterialTheme.colorScheme.error
        else -> MaterialTheme.colorScheme.onSurfaceVariant
    }
    val timeAgo = DateUtils.getRelativeTimeSpanString(
        run.createdAt,
        System.currentTimeMillis(),
        DateUtils.MINUTE_IN_MILLIS,
    ).toString()

    Row(
        Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(vertical = 4.dp),
        verticalAlignment = Alignment.Top,
    ) {
        Box(
            Modifier
                .padding(top = 5.dp)
                .size(8.dp)
                .background(statusColor, CircleShape),
        )
        Spacer(Modifier.width(10.dp))
        Column(Modifier.weight(1f)) {
            Text(
                run.promptPreview.ifBlank { "(no prompt)" },
                style = MaterialTheme.typography.bodySmall,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                "${run.status} · $timeAgo · ${run.mode}/${run.phase}",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

// ── Controls bar (mode / phase only) ────────────────────────────────────────

@Composable
private fun ControlsBar(state: UiState, vm: CompanionViewModel) {
    Row(
        Modifier
            .fillMaxWidth()
            .background(MaterialTheme.colorScheme.surface)
            .padding(horizontal = 12.dp, vertical = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        listOf("kraken", "council", "zelari").forEach { m ->
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

// ── Chat ────────────────────────────────────────────────────────────────────

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

// ── Composer ────────────────────────────────────────────────────────────────

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

// ── Settings ────────────────────────────────────────────────────────────────

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SettingsScreen(state: UiState, vm: CompanionViewModel, modifier: Modifier = Modifier) {
    Column(
        modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background),
    ) {
        TopAppBar(
            title = { Text("Settings", fontWeight = FontWeight.Bold) },
            navigationIcon = {
                IconButton(onClick = { vm.closeSettings() }) {
                    Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                }
            },
            colors = TopAppBarDefaults.topAppBarColors(
                containerColor = MaterialTheme.colorScheme.surface,
            ),
        )

        Column(
            Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(18.dp),
        ) {
            SettingsSection("Provider / Model") {
                ProviderPicker(state, vm)
                Spacer(Modifier.height(8.dp))
                ModelPicker(state, vm)
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(
                    value = state.customModel,
                    onValueChange = vm::setCustomModel,
                    label = { Text("Custom model id (optional)") },
                    placeholder = { Text("e.g. MiniMax-M2.5") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                val provider = state.providers.find { it.id == state.selectedProvider }
                if (provider != null) {
                    Spacer(Modifier.height(8.dp))
                    SettingsInfoRow("API key env", provider.envVar.ifBlank { "—" })
                    SettingsInfoRow("Key status", if (provider.hasKey) "present" else "missing")
                    SettingsInfoRow("Endpoint", provider.endpoint ?: provider.baseUrl ?: "default")
                }
            }

            SettingsSection("Defaults") {
                SettingsLabel("Mode")
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    listOf("kraken", "council", "zelari").forEach { m ->
                        FilterChip(
                            selected = state.mode == m,
                            onClick = { vm.setMode(m) },
                            label = { Text(m) },
                        )
                    }
                }
                Spacer(Modifier.height(8.dp))
                SettingsLabel("Phase")
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    listOf("plan", "build").forEach { p ->
                        FilterChip(
                            selected = state.phase == p,
                            onClick = { vm.setPhase(p) },
                            label = { Text(p) },
                        )
                    }
                }
            }

            SettingsSection("Directory") {
                ProjectPicker(state, vm)
                Text(
                    "Working directory is limited to the allowlist configured on the PC.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(top = 6.dp),
                )
            }

            SettingsSection("Connection") {
                SettingsInfoRow("Host", state.baseUrl.ifBlank { "—" })
                SettingsInfoRow("Token", if (state.token.isBlank()) "—" else "••••••••")
                SettingsInfoRow("Status", state.conn.name)
            }

            SettingsSection("System") {
                SettingsInfoRow("CLI version", state.cliVersion.ifBlank { "—" })
                SettingsInfoRow("Host version", state.hostVersion ?: "—")
                SettingsInfoRow("Provider config", state.configPaths?.provider ?: "—")
                SettingsInfoRow("Keys config", state.configPaths?.keys ?: "—")
            }
        }
    }
}

@Composable
private fun SettingsSection(title: String, content: @Composable () -> Unit) {
    Card(
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        shape = RoundedCornerShape(14.dp),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(Modifier.padding(14.dp)) {
            Text(
                title,
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.Bold,
                color = MaterialTheme.colorScheme.primary,
            )
            Spacer(Modifier.height(10.dp))
            content()
        }
    }
}

@Composable
private fun SettingsLabel(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.labelLarge,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(bottom = 4.dp),
    )
}

@Composable
private fun SettingsInfoRow(label: String, value: String) {
    Row(
        Modifier
            .fillMaxWidth()
            .padding(vertical = 2.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(
            label,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.width(110.dp),
        )
        Text(
            value,
            style = MaterialTheme.typography.bodySmall,
            fontFamily = FontFamily.Monospace,
        )
    }
}

// ── Connect sheet ───────────────────────────────────────────────────────────

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
