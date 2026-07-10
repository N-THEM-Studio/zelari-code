//! Zelari Desktop — thin Tauri shell over `zelari-code --headless`.
//!
//! The coding brain stays in Node (`@zelari/core` + CLI). This host only
//! resolves the CLI, spawns headless runs, and streams NDJSON BrainEvents
//! to the web UI via Tauri events.

use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// Hide console window for short-lived CLI helpers on Windows.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Shared cancel flag for the active headless run (single-flight for v0.1).
struct RunState {
    cancel: AtomicBool,
    running: AtomicBool,
}

impl Default for RunState {
    fn default() -> Self {
        Self {
            cancel: AtomicBool::new(false),
            running: AtomicBool::new(false),
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CliStatus {
    ok: bool,
    node: Option<String>,
    cli_path: Option<String>,
    cli_version: Option<String>,
    cwd: String,
    message: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RunStarted {
    run_id: String,
    prompt: String,
    mode: String,
    phase: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RunFinished {
    run_id: String,
    exit_code: i32,
    cancelled: bool,
}

fn find_node() -> Option<PathBuf> {
    which::which("node").ok()
}

fn resolve_cli_entry() -> Result<PathBuf, String> {
    if let Ok(raw) = std::env::var("ZELARI_CLI_PATH") {
        let p = PathBuf::from(raw.trim());
        if p.is_file() {
            return Ok(p);
        }
        let candidate = p.join("bin").join("zelari-code.js");
        if candidate.is_file() {
            return Ok(candidate);
        }
        return Err(format!(
            "ZELARI_CLI_PATH set but not a valid CLI entry: {}",
            p.display()
        ));
    }

    let candidates = [
        PathBuf::from("../../bin/zelari-code.js"),
        PathBuf::from("../bin/zelari-code.js"),
        PathBuf::from("bin/zelari-code.js"),
        PathBuf::from("./bin/zelari-code.js"),
    ];
    for c in candidates {
        if let Ok(abs) = std::fs::canonicalize(&c) {
            if abs.is_file() {
                return Ok(abs);
            }
        }
        if c.is_file() {
            return Ok(c);
        }
    }

    if let Ok(cwd) = std::env::current_dir() {
        if let Some(found) = walk_up_for_cli(&cwd) {
            return Ok(found);
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            if let Some(found) = walk_up_for_cli(parent) {
                return Ok(found);
            }
        }
    }

    if let Ok(global) = which::which("zelari-code") {
        return Ok(global);
    }

    Err(
        "Could not find zelari-code CLI. Install with `npm i -g zelari-code` \
         or set ZELARI_CLI_PATH to the monorepo root / bin/zelari-code.js."
            .into(),
    )
}

fn walk_up_for_cli(start: &Path) -> Option<PathBuf> {
    let mut dir = start.to_path_buf();
    for _ in 0..8 {
        let candidate = dir.join("bin").join("zelari-code.js");
        if candidate.is_file() {
            return Some(candidate);
        }
        if !dir.pop() {
            break;
        }
    }
    None
}

fn read_cli_version(node: &Path, cli: &Path) -> Option<String> {
    let output = if is_js_entry(cli) {
        Command::new(node)
            .arg(cli)
            .arg("--version")
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .output()
            .ok()?
    } else {
        Command::new(cli)
            .arg("--version")
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .output()
            .ok()?
    };
    if !output.status.success() {
        return None;
    }
    String::from_utf8(output.stdout)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Normalize "zelari-code v1.8.3" / "v1.8.3" / "1.8.3" → "1.8.3"
fn normalize_semver(raw: &str) -> String {
    let s = raw.trim();
    // Take last whitespace-separated token (drops "zelari-code")
    let token = s.split_whitespace().last().unwrap_or(s);
    token.trim().trim_start_matches('v').to_string()
}

fn parse_semver(raw: &str) -> Option<(u64, u64, u64)> {
    let s = normalize_semver(raw);
    let core = s.split('-').next().unwrap_or(&s);
    let mut parts = core.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    let patch = parts.next()?.parse().ok()?;
    Some((major, minor, patch))
}

/// -1 if a < b, 0 equal, 1 if a > b
fn cmp_semver(a: &str, b: &str) -> i32 {
    match (parse_semver(a), parse_semver(b)) {
        (Some(x), Some(y)) => {
            if x < y {
                -1
            } else if x > y {
                1
            } else {
                0
            }
        }
        _ => 0,
    }
}

/// Fetch latest zelari-code version from npm (via Node fetch — no extra Rust dep).
fn fetch_npm_latest_cli(node: &Path) -> Result<String, String> {
    let script = r#"
fetch('https://registry.npmjs.org/zelari-code/latest')
  .then(r => { if (!r.ok) throw new Error('HTTP '+r.status); return r.json(); })
  .then(j => { if (!j.version) throw new Error('no version'); process.stdout.write(String(j.version)); })
  .catch(e => { process.stderr.write(String(e && e.message || e)); process.exit(1); });
"#;
    let mut cmd = Command::new(node);
    cmd.arg("-e").arg(script);
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let output = cmd
        .output()
        .map_err(|e| format!("Failed to query npm registry: {e}"))?;
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(if err.trim().is_empty() {
            "Failed to query npm registry".into()
        } else {
            err.trim().to_string()
        });
    }
    let v = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if v.is_empty() {
        return Err("Empty version from npm".into());
    }
    Ok(normalize_semver(&v))
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CliUpdateCheck {
    installed: Option<String>,
    npm_latest: Option<String>,
    update_available: bool,
    message: String,
}

#[tauri::command]
fn check_cli_update() -> Result<CliUpdateCheck, String> {
    let node = find_node().ok_or_else(|| "Node.js not found on PATH".to_string())?;
    let installed = resolve_cli_entry()
        .ok()
        .and_then(|cli| read_cli_version(&node, &cli))
        .map(|v| normalize_semver(&v));

    let npm_latest = fetch_npm_latest_cli(&node)?;

    let update_available = match &installed {
        Some(cur) => cmp_semver(cur, &npm_latest) < 0,
        None => true,
    };

    let message = match &installed {
        Some(cur) if update_available => {
            format!("CLI is v{cur}; npm latest is v{npm_latest}. Use Update CLI to upgrade.")
        }
        Some(cur) => format!("CLI is up to date (v{cur})."),
        None => format!("CLI not found. Install with: npm i -g zelari-code@{npm_latest}"),
    };

    Ok(CliUpdateCheck {
        installed,
        npm_latest: Some(npm_latest),
        update_available,
        message,
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateCliArgs {
    /// Optional pin e.g. "1.9.2"; default "latest"
    #[serde(default)]
    version: Option<String>,
}

#[tauri::command]
fn update_cli(args: UpdateCliArgs) -> Result<serde_json::Value, String> {
    let node = find_node().ok_or_else(|| "Node.js not found on PATH".to_string())?;
    let ver = args
        .version
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("latest");
    let pkg = format!("zelari-code@{ver}");

    // Prefer: node <npm-cli.js> install -g … (avoids broken .cmd shims on Windows)
    let npm_cli = {
        let dir = node.parent().map(|p| p.to_path_buf());
        let mut candidates = Vec::new();
        if let Some(d) = dir {
            candidates.push(d.join("node_modules").join("npm").join("bin").join("npm-cli.js"));
            candidates.push(
                d.join("..")
                    .join("lib")
                    .join("node_modules")
                    .join("npm")
                    .join("bin")
                    .join("npm-cli.js"),
            );
        }
        candidates.into_iter().find(|p| p.is_file())
    };

    let mut cmd = if let Some(ref cli_js) = npm_cli {
        let mut c = Command::new(&node);
        c.arg(cli_js).arg("install").arg("-g").arg(&pkg);
        c
    } else {
        // Fallback: PATH npm (shell on Windows for .cmd shim)
        #[cfg(windows)]
        {
            let mut c = Command::new("cmd");
            c.args(["/C", "npm", "install", "-g", &pkg]);
            c
        }
        #[cfg(not(windows))]
        {
            let mut c = Command::new("npm");
            c.args(["install", "-g", &pkg]);
            c
        }
    };

    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let output = cmd
        .output()
        .map_err(|e| format!("Failed to run npm install: {e}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let combined = format!("{stdout}{stderr}");

    if !output.status.success() {
        return Err(if combined.trim().is_empty() {
            format!("npm install failed ({})", output.status)
        } else {
            combined.trim().to_string()
        });
    }

    // Re-read installed version
    let installed = resolve_cli_entry()
        .ok()
        .and_then(|cli| read_cli_version(&node, &cli))
        .map(|v| normalize_semver(&v));

    Ok(serde_json::json!({
        "ok": true,
        "package": pkg,
        "installed": installed,
        "output": combined.trim(),
    }))
}

fn is_js_entry(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| {
            e.eq_ignore_ascii_case("js")
                || e.eq_ignore_ascii_case("mjs")
                || e.eq_ignore_ascii_case("cjs")
        })
        .unwrap_or(false)
}

fn spawn_cli_base(node: &Path, cli: &Path, cwd: Option<&Path>) -> Command {
    let mut c = if is_js_entry(cli) {
        let mut c = Command::new(node);
        c.arg(cli);
        c
    } else {
        Command::new(cli)
    };
    // Avoid inheriting a console / stdin that can leave dangling uv handles
    // when the parent (Tauri) already owns the UI process.
    c.stdin(Stdio::null());
    c.env("FORCE_COLOR", "0");
    // Desktop already verified Node exists; skip preflight probes that spawn
    // extra shells (a common UV_HANDLE_CLOSING trigger on Windows).
    c.env("ZELARI_SKIP_PREFLIGHT", "1");
    c.env("ANATHEMA_DEV", "1"); // no background update check mid-stream
    // When the user picks a working folder (Open Folder), the spawned CLI
    // must run inside it so process.cwd() reflects the chosen project. All
    // CLI subsystems (workspace, council, mission, lsp, safety) read cwd
    // directly, so a single current_dir() here aligns everything.
    if let Some(dir) = cwd {
        c.current_dir(dir);
    }
    #[cfg(windows)]
    {
        c.creation_flags(CREATE_NO_WINDOW);
    }
    c
}

/// Kill a child process tree. On Windows, plain `Child::kill` often leaves
/// grandchild node processes (and their libuv handles) half-closed, which
/// surfaces as `UV_HANDLE_CLOSING` assertions in `async.c`.
/// Does **not** wait — caller must `wait()` once to reap.
fn kill_child_tree(child: &mut Child) {
    let pid = child.id();
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .status();
        // Also signal via Win32 kill in case taskkill is unavailable.
        let _ = child.kill();
    }
    #[cfg(not(windows))]
    {
        let _ = child.kill();
    }
}

fn run_cli_capture(node: &Path, cli: &Path, args: &[&str]) -> Result<String, String> {
    let mut cmd = spawn_cli_base(node, cli, None);
    for a in args {
        cmd.arg(a);
    }
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    let output = cmd
        .output()
        .map_err(|e| format!("Failed to spawn zelari-code: {e}"))?;
    let out = String::from_utf8_lossy(&output.stdout).to_string();
    let err = String::from_utf8_lossy(&output.stderr).to_string();

    // On Windows, Node may print valid JSON then abort with UV_HANDLE_CLOSING.
    // Treat non-empty stdout as success when exit status is non-zero.
    if !output.status.success() {
        if !out.trim().is_empty()
            && (out.trim_start().starts_with('{') || out.trim_start().starts_with('['))
        {
            return Ok(out);
        }
        let msg = if !err.trim().is_empty()
            && !err.contains("UV_HANDLE_CLOSING")
            && !err.contains("Assertion failed")
        {
            err.trim().to_string()
        } else if !out.trim().is_empty() {
            out.trim().to_string()
        } else {
            format!("CLI exited with {}", output.status)
        };
        return Err(msg);
    }
    String::from_utf8(output.stdout).map_err(|e| format!("Invalid UTF-8 from CLI: {e}"))
}

#[tauri::command]
fn get_cli_status() -> CliStatus {
    let cwd = std::env::current_dir()
        .map(|p| p.display().to_string())
        .unwrap_or_else(|_| ".".into());

    let node = find_node();
    let cli = resolve_cli_entry();

    match (node.as_ref(), cli.as_ref()) {
        (Some(node_path), Ok(cli_path)) => {
            let version = read_cli_version(node_path, cli_path);
            CliStatus {
                ok: true,
                node: Some(node_path.display().to_string()),
                cli_path: Some(cli_path.display().to_string()),
                cli_version: version,
                cwd,
                message: "CLI ready".into(),
            }
        }
        (None, _) => CliStatus {
            ok: false,
            node: None,
            cli_path: cli.ok().map(|p| p.display().to_string()),
            cli_version: None,
            cwd,
            message: "Node.js not found on PATH (need Node ≥ 20).".into(),
        },
        (Some(node_path), Err(e)) => CliStatus {
            ok: false,
            node: Some(node_path.display().to_string()),
            cli_path: None,
            cli_version: None,
            cwd,
            message: e.clone(),
        },
    }
}

/// Returns the JSON string from `zelari-code --print-config`.
#[tauri::command]
fn get_app_config() -> Result<serde_json::Value, String> {
    let node = find_node().ok_or_else(|| "Node.js not found on PATH".to_string())?;
    let cli = resolve_cli_entry()?;
    let raw = run_cli_capture(&node, &cli, &["--print-config"])?;
    serde_json::from_str(raw.trim()).map_err(|e| format!("Invalid --print-config JSON: {e}\n{raw}"))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetConfigArgs {
    provider: Option<String>,
    model: Option<String>,
    endpoint: Option<String>,
    #[serde(default)]
    endpoint_clear: bool,
}

#[tauri::command]
fn set_app_config(args: SetConfigArgs) -> Result<serde_json::Value, String> {
    let node = find_node().ok_or_else(|| "Node.js not found on PATH".to_string())?;
    let cli = resolve_cli_entry()?;
    let mut argv: Vec<String> = vec!["--set-config".into()];
    if let Some(p) = args
        .provider
        .as_ref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
    {
        argv.push("--provider".into());
        argv.push(p.to_string());
    }
    if let Some(m) = args
        .model
        .as_ref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
    {
        argv.push("--model".into());
        argv.push(m.to_string());
    }
    if let Some(ep) = args
        .endpoint
        .as_ref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
    {
        argv.push("--endpoint".into());
        argv.push(ep.to_string());
    }
    if args.endpoint_clear {
        argv.push("--endpoint-clear".into());
    }
    if argv.len() == 1 {
        return Err(
            "set_app_config requires provider, model, endpoint, and/or endpointClear".into(),
        );
    }
    let refs: Vec<&str> = argv.iter().map(|s| s.as_str()).collect();
    let raw = run_cli_capture(&node, &cli, &refs)?;
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(raw.trim()) {
        return Ok(v);
    }
    Ok(serde_json::json!({ "ok": true, "message": raw.trim() }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetKeyArgs {
    provider: String,
    key: String,
}

#[tauri::command]
fn set_api_key(args: SetKeyArgs) -> Result<serde_json::Value, String> {
    let node = find_node().ok_or_else(|| "Node.js not found on PATH".to_string())?;
    let cli = resolve_cli_entry()?;
    let provider = args.provider.trim();
    let key = args.key.trim();
    if provider.is_empty() || key.is_empty() {
        return Err("provider and key are required".into());
    }
    let raw = run_cli_capture(
        &node,
        &cli,
        &["--set-key", "--provider", provider, "--key", key],
    )?;
    serde_json::from_str(raw.trim())
        .or_else(|_| Ok(serde_json::json!({ "ok": true, "message": raw.trim() })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DiscoverArgs {
    provider: Option<String>,
}

/// Parse a JSON object from CLI stdout. Tolerates trailing noise and prefers
/// the last `{…}` line (Node on Windows can abort after printing valid JSON
/// with UV_HANDLE_CLOSING, still leaving a good payload on stdout).
fn parse_cli_json_stdout(stdout: &str) -> Option<serde_json::Value> {
    let trimmed = stdout.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(trimmed) {
        return Some(v);
    }
    for line in trimmed.lines().rev() {
        let l = line.trim();
        if !l.starts_with('{') {
            continue;
        }
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(l) {
            return Some(v);
        }
    }
    None
}

fn is_discover_success(v: &serde_json::Value) -> bool {
    if v.get("ok").and_then(|x| x.as_bool()) == Some(true) {
        return true;
    }
    v.get("models")
        .and_then(|m| m.as_array())
        .map(|a| !a.is_empty())
        .unwrap_or(false)
}

#[tauri::command]
fn discover_models(args: DiscoverArgs) -> Result<serde_json::Value, String> {
    let node = find_node().ok_or_else(|| "Node.js not found on PATH".to_string())?;
    let cli = resolve_cli_entry()?;
    let mut argv: Vec<String> = vec!["--discover-models".into()];
    if let Some(p) = args
        .provider
        .as_ref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
    {
        argv.push("--provider".into());
        argv.push(p.to_string());
    }
    let refs: Vec<&str> = argv.iter().map(|s| s.as_str()).collect();
    // Discovery can take a while (network)
    let mut cmd = spawn_cli_base(&node, &cli, None);
    for a in &refs {
        cmd.arg(a);
    }
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    let output = cmd
        .output()
        .map_err(|e| format!("Failed to spawn discover-models: {e}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);

    // Prefer stdout JSON even when process exit code is non-zero (Windows UV abort
    // after successful discovery is common and must not discard the model list).
    if let Some(v) = parse_cli_json_stdout(&stdout) {
        if is_discover_success(&v) {
            return Ok(v);
        }
        if let Some(err) = v.get("error").and_then(|e| e.as_str()) {
            return Err(err.to_string());
        }
    }

    if !output.status.success() {
        for blob in [stderr.trim(), stdout.trim()] {
            if let Some(v) = parse_cli_json_stdout(blob) {
                if let Some(err) = v.get("error").and_then(|e| e.as_str()) {
                    return Err(err.to_string());
                }
            }
            if !blob.is_empty()
                && !blob.contains("UV_HANDLE_CLOSING")
                && !blob.contains("Assertion failed")
            {
                return Err(blob.to_string());
            }
        }
        return Err("discover-models failed (no model list in output)".into());
    }

    parse_cli_json_stdout(&stdout).ok_or_else(|| format!("Invalid discover-models JSON:\n{stdout}"))
}

#[tauri::command]
fn cancel_run(state: State<'_, Arc<RunState>>) -> Result<(), String> {
    if state.running.load(Ordering::SeqCst) {
        state.cancel.store(true, Ordering::SeqCst);
        Ok(())
    } else {
        Err("No active run".into())
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RunTaskArgs {
    prompt: String,
    #[serde(default = "default_mode")]
    mode: String,
    #[serde(default = "default_phase")]
    phase: String,
    #[serde(default)]
    council: bool,
    #[serde(default)]
    provider: Option<String>,
    #[serde(default)]
    model: Option<String>,
    /// Optional working directory chosen via "Open Folder". When set, the
    /// headless CLI is spawned inside it (current_dir) so the agent operates
    /// on the user-selected project. None = inherit the Tauri process cwd.
    #[serde(default)]
    cwd: Option<String>,
}

fn default_mode() -> String {
    "agent".into()
}
fn default_phase() -> String {
    "build".into()
}

fn normalize_mode(mode: &str, council: bool) -> String {
    let m = mode.trim().to_lowercase();
    if council && (m.is_empty() || m == "agent") {
        return "council".into();
    }
    match m.as_str() {
        "agent" | "council" | "zelari" => m,
        _ => "agent".into(),
    }
}

fn normalize_phase(phase: &str) -> String {
    match phase.trim().to_lowercase().as_str() {
        "plan" => "plan".into(),
        _ => "build".into(),
    }
}

#[tauri::command]
fn run_task(
    app: AppHandle,
    state: State<'_, Arc<RunState>>,
    args: RunTaskArgs,
) -> Result<String, String> {
    if state.running.swap(true, Ordering::SeqCst) {
        return Err("A task is already running. Cancel it first.".into());
    }
    state.cancel.store(false, Ordering::SeqCst);

    let prompt = args.prompt.trim().to_string();
    if prompt.is_empty() {
        state.running.store(false, Ordering::SeqCst);
        return Err("Prompt is empty".into());
    }

    let mode = normalize_mode(&args.mode, args.council);
    let phase = normalize_phase(&args.phase);

    let node = find_node().ok_or_else(|| {
        state.running.store(false, Ordering::SeqCst);
        "Node.js not found on PATH".to_string()
    })?;
    let cli = match resolve_cli_entry() {
        Ok(p) => p,
        Err(e) => {
            state.running.store(false, Ordering::SeqCst);
            return Err(e);
        }
    };

    let run_id = format!(
        "run-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    );

    let _ = app.emit(
        "run-started",
        RunStarted {
            run_id: run_id.clone(),
            prompt: prompt.clone(),
            mode: mode.clone(),
            phase: phase.clone(),
        },
    );

    let run_state = Arc::clone(&state);
    let app_handle = app.clone();
    let run_id_thread = run_id.clone();
    let provider = args.provider;
    let model = args.model;
    let cwd = args.cwd;

    thread::spawn(move || {
        let result = spawn_headless(
            &app_handle,
            &run_state,
            &node,
            &cli,
            &prompt,
            &mode,
            &phase,
            provider.as_deref(),
            model.as_deref(),
            cwd.as_deref(),
        );

        let (exit_code, cancelled) = match result {
            Ok(code) => (code, run_state.cancel.load(Ordering::SeqCst)),
            Err(err) => {
                let _ = app_handle.emit(
                    "agent-event",
                    serde_json::json!({
                        "type": "error",
                        "message": err,
                        "runId": run_id_thread,
                    }),
                );
                (2, run_state.cancel.load(Ordering::SeqCst))
            }
        };

        let _ = app_handle.emit(
            "run-finished",
            RunFinished {
                run_id: run_id_thread,
                exit_code,
                cancelled,
            },
        );
        run_state.running.store(false, Ordering::SeqCst);
        run_state.cancel.store(false, Ordering::SeqCst);
    });

    Ok(run_id)
}

fn spawn_headless(
    app: &AppHandle,
    state: &RunState,
    node: &Path,
    cli: &Path,
    prompt: &str,
    mode: &str,
    phase: &str,
    provider: Option<&str>,
    model: Option<&str>,
    cwd: Option<&str>,
) -> Result<i32, String> {
    let mut cmd = spawn_cli_base(node, cli, cwd.map(Path::new));

    cmd.arg("--headless")
        .arg("--task")
        .arg(prompt)
        .arg("--output")
        .arg("json")
        .arg("--mode")
        .arg(mode)
        .arg("--phase")
        .arg(phase);

    if let Some(p) = provider {
        if !p.is_empty() {
            cmd.arg("--provider").arg(p);
        }
    }
    if let Some(m) = model {
        if !m.is_empty() {
            cmd.arg("--model").arg(m);
        }
    }

    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn zelari-code: {e}"))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Failed to capture CLI stdout".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Failed to capture CLI stderr".to_string())?;

    // Drain stderr on a side thread (never block the NDJSON reader).
    let app_err = app.clone();
    let err_thread = thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines().flatten() {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let _ = app_err.emit("agent-stderr", serde_json::json!({ "line": trimmed }));
        }
    });

    // Read stdout on a side thread so we can poll cancel without waiting for
    // the next line (thinking phases can be silent for minutes).
    let (tx, rx) = mpsc::channel::<Result<String, String>>();
    let out_thread = thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            match line {
                Ok(l) => {
                    if tx.send(Ok(l)).is_err() {
                        break;
                    }
                }
                Err(e) => {
                    let _ = tx.send(Err(e.to_string()));
                    break;
                }
            }
        }
    });

    let mut cancelled = false;
    loop {
        if state.cancel.load(Ordering::SeqCst) {
            cancelled = true;
            kill_child_tree(&mut child);
            break;
        }

        match rx.recv_timeout(Duration::from_millis(200)) {
            Ok(Ok(line)) => {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                match serde_json::from_str::<serde_json::Value>(trimmed) {
                    Ok(value) => {
                        let _ = app.emit("agent-event", value);
                    }
                    Err(_) => {
                        let _ = app.emit(
                            "agent-event",
                            serde_json::json!({
                                "type": "log",
                                "message": trimmed,
                            }),
                        );
                    }
                }
            }
            Ok(Err(e)) => {
                let _ = app.emit(
                    "agent-event",
                    serde_json::json!({
                        "type": "error",
                        "message": format!("stdout read error: {e}"),
                    }),
                );
                break;
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                // Still running — loop to re-check cancel.
                if let Ok(Some(status)) = child.try_wait() {
                    // Process exited; drain remaining lines briefly.
                    while let Ok(msg) = rx.try_recv() {
                        if let Ok(line) = msg {
                            let trimmed = line.trim();
                            if trimmed.is_empty() {
                                continue;
                            }
                            if let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed) {
                                let _ = app.emit("agent-event", value);
                            }
                        }
                    }
                    let _ = err_thread.join();
                    let _ = out_thread.join();
                    return Ok(status
                        .code()
                        .unwrap_or(if status.success() { 0 } else { 2 }));
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }

    // Reader finished or cancel: reap exactly once.
    if !cancelled {
        if let Ok(None) = child.try_wait() {
            // stdout closed but process still alive — give it a moment, then kill tree
            thread::sleep(Duration::from_millis(150));
            if let Ok(None) = child.try_wait() {
                kill_child_tree(&mut child);
            }
        }
    }

    let _ = err_thread.join();
    let _ = out_thread.join();
    match child.try_wait() {
        Ok(Some(s)) => Ok(s.code().unwrap_or(if s.success() { 0 } else { 2 })),
        Ok(None) => match child.wait() {
            Ok(s) => Ok(s.code().unwrap_or(if s.success() { 0 } else { 2 })),
            Err(_) => Ok(if cancelled { 130 } else { 2 }),
        },
        Err(_) => Ok(if cancelled { 130 } else { 2 }),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(Arc::new(RunState::default()))
        .invoke_handler(tauri::generate_handler![
            get_cli_status,
            get_app_config,
            set_app_config,
            set_api_key,
            discover_models,
            check_cli_update,
            update_cli,
            run_task,
            cancel_run
        ])
        .run(tauri::generate_context!())
        .expect("error while running Zelari Desktop");
}
