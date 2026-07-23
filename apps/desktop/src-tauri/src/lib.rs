//! Zelari Desktop — thin Tauri shell over `zelari-code --headless`.
//!
//! The coding brain stays in Node (`@zelari/core` + CLI). This host only
//! resolves the CLI, spawns headless runs, and streams NDJSON BrainEvents
//! to the web UI via Tauri events.

use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
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

/// Background `zelari-code serve` process for Android companion.
struct CompanionServeState {
    child: Mutex<Option<Child>>,
    bind: Mutex<String>,
    port: Mutex<u16>,
}

impl Default for CompanionServeState {
    fn default() -> Self {
        Self {
            child: Mutex::new(None),
            bind: Mutex::new("127.0.0.1".into()),
            port: Mutex::new(7421),
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CompanionServeStatus {
    running: bool,
    healthy: bool,
    bind: String,
    port: u16,
    url: String,
    /// Full token for QR/pairing (local only). Empty if missing.
    token: String,
    token_path: String,
    pid: Option<u32>,
    message: String,
}

fn zelari_home_dir() -> PathBuf {
    if let Ok(h) = std::env::var("USERPROFILE") {
        return PathBuf::from(h).join(".zelari-code");
    }
    if let Ok(h) = std::env::var("HOME") {
        return PathBuf::from(h).join(".zelari-code");
    }
    PathBuf::from(".zelari-code")
}

fn companion_token_path() -> PathBuf {
    zelari_home_dir().join("companion.token")
}

fn read_companion_token() -> String {
    let p = companion_token_path();
    fs::read_to_string(&p)
        .map(|s| s.trim().to_string())
        .unwrap_or_default()
}

/// HTTP GET body (tiny helper — no extra deps).
fn http_get_text(url: &str, timeout: Duration) -> Result<String, String> {
    // Prefer curl on PATH (present on modern Windows + Unix); fallback to raw TCP is overkill.
    let mut cmd = Command::new("curl");
    cmd.args([
        "-sS",
        "--max-time",
        &timeout.as_secs().max(1).to_string(),
        url,
    ]);
    #[cfg(windows)]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let out = cmd
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| format!("curl failed: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(if err.trim().is_empty() {
            format!("curl exit {}", out.status)
        } else {
            err.trim().to_string()
        });
    }
    String::from_utf8(out.stdout).map_err(|e| e.to_string())
}

fn companion_health_ok(bind: &str, port: u16) -> bool {
    // Always probe loopback — serve bound to 0.0.0.0 still answers on 127.0.0.1.
    let host = if bind == "0.0.0.0" || bind == "::" {
        "127.0.0.1"
    } else {
        bind
    };
    let url = format!("http://{host}:{port}/health");
    match http_get_text(&url, Duration::from_secs(2)) {
        Ok(body) => body.contains("\"ok\"") && body.contains("true"),
        Err(_) => false,
    }
}

fn reap_dead_companion(state: &CompanionServeState) {
    let mut guard = state.child.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(child) = guard.as_mut() {
        match child.try_wait() {
            Ok(Some(_)) => {
                *guard = None;
            }
            Ok(None) => {}
            Err(_) => {
                *guard = None;
            }
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
    let resolved = resolve_cli_entry_raw()?;
    Ok(unwrap_cli_js_entry(&resolved))
}

/// Locate a CLI path without unwrapping Windows `.cmd` shims to JS.
fn resolve_cli_entry_raw() -> Result<PathBuf, String> {
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
    let mut cmd = spawn_cli_base(node, cli, None);
    cmd.arg("--version")
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let output = cmd.output().ok()?;
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

fn is_batch_shim(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("cmd") || e.eq_ignore_ascii_case("bat"))
        .unwrap_or(false)
}

/// Resolve an npm Windows bin shim (`.cmd`/`.bat`) to the real JS entry.
///
/// Rust's `Command` cannot safely spawn batch files with args (CVE-2024-24576
/// hardening → "batch file arguments are invalid"). Prefer
/// `node <prefix>/node_modules/zelari-code/bin/zelari-code.js` instead.
fn unwrap_cli_js_entry(path: &Path) -> PathBuf {
    if is_js_entry(path) {
        return path.to_path_buf();
    }

    // Bare name or extensionless shim next to zelari-code.cmd (PATHEXT order).
    let batch_candidate = if is_batch_shim(path) {
        path.to_path_buf()
    } else if path.extension().is_none() {
        let with_cmd = path.with_extension("cmd");
        if with_cmd.is_file() {
            with_cmd
        } else {
            return path.to_path_buf();
        }
    } else {
        return path.to_path_buf();
    };

    if let Some(parent) = batch_candidate.parent() {
        let candidate = parent
            .join("node_modules")
            .join("zelari-code")
            .join("bin")
            .join("zelari-code.js");
        if candidate.is_file() {
            return candidate;
        }
    }

    // Fallback: parse the shim for a path ending in zelari-code.js.
    if let Ok(text) = fs::read_to_string(&batch_candidate) {
        if let Some(js) = extract_js_path_from_cmd_shim(&text, batch_candidate.parent()) {
            if js.is_file() {
                return js;
            }
        }
    }

    path.to_path_buf()
}

/// Best-effort extract of `…zelari-code.js` from an npm-style `.cmd` shim body.
fn extract_js_path_from_cmd_shim(text: &str, shim_dir: Option<&Path>) -> Option<PathBuf> {
    // Match quoted paths first (npm cmd-shim: "%dp0%\node_modules\…\zelari-code.js").
    for token in text.split(|c: char| c == '"' || c.is_whitespace()) {
        let t = token.trim().trim_matches('"').trim_matches('\'');
        if t.is_empty() {
            continue;
        }
        // Normalize %dp0%\rel or %~dp0\rel → relative to shim dir.
        let cleaned = t
            .replace("%~dp0%", "")
            .replace("%~dp0", "")
            .replace("%dp0%\\", "")
            .replace("%dp0%/", "")
            .replace("%dp0%", "")
            .replace("%dp0\\", "")
            .replace("%dp0/", "")
            .replace("%dp0", "");
        let lower = cleaned.to_ascii_lowercase();
        if !lower.ends_with("zelari-code.js") {
            continue;
        }
        let p = PathBuf::from(&cleaned);
        if p.is_file() {
            return Some(p);
        }
        if let Some(dir) = shim_dir {
            let joined = dir.join(&cleaned);
            if joined.is_file() {
                return Some(joined);
            }
            // Strip leading separators left after %dp0% removal.
            let trimmed = cleaned.trim_start_matches(['\\', '/']);
            let joined = dir.join(trimmed);
            if joined.is_file() {
                return Some(joined);
            }
        }
    }
    None
}

/// Human-readable spawn failure (Windows batch-shim hint).
fn format_cli_spawn_err(err: impl std::fmt::Display) -> String {
    let msg = err.to_string();
    if msg.contains("batch file arguments are invalid") {
        format!(
            "Failed to spawn zelari-code: {msg}. \
             On Windows, Desktop must run the JS entry (node …/bin/zelari-code.js), \
             not the npm .cmd shim. Reinstall with `npm i -g zelari-code` or set \
             ZELARI_CLI_PATH to the monorepo root / bin/zelari-code.js."
        )
    } else {
        format!("Failed to spawn zelari-code: {msg}")
    }
}

fn spawn_cli_base(node: &Path, cli: &Path, cwd: Option<&Path>) -> Command {
    // Always prefer the unwrapped JS entry so Windows never CreateProcess'es a .cmd.
    let cli = unwrap_cli_js_entry(cli);
    let mut c = if is_js_entry(&cli) {
        let mut c = Command::new(node);
        c.arg(&cli);
        c
    } else {
        // Non-JS (native binary, or unresolvable .cmd). Spawning a .cmd with
        // args fails on Windows; callers map that via format_cli_spawn_err.
        Command::new(&cli)
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
        .map_err(format_cli_spawn_err)?;
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
    // Prefer tolerant JSON extraction (CLI may print warnings on stderr/stdout
    // mix on Windows); full-string parse first, then line scan.
    parse_cli_json_stdout(&raw).ok_or_else(|| {
        format!(
            "Failed to load provider config (invalid --print-config JSON).\n{raw}"
        )
    })
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
        .map_err(|e| {
            let msg = format_cli_spawn_err(e);
            msg.replacen("Failed to spawn zelari-code", "Failed to spawn discover-models", 1)
        })?;
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
struct GitStatusArgs {
    #[serde(default)]
    cwd: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GitFileChangeDto {
    path: String,
    added: Option<i64>,
    removed: Option<i64>,
    untracked: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GitStatusDto {
    is_repo: bool,
    branch: Option<String>,
    files: Vec<GitFileChangeDto>,
    cwd: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

fn git_output(cwd: &Path, args: &[&str]) -> Option<String> {
    let mut c = Command::new("git");
    c.arg("-C").arg(cwd).args(args);
    #[cfg(windows)]
    {
        c.creation_flags(CREATE_NO_WINDOW);
    }
    let out = c.output().ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Lightweight git snapshot for the desktop right rail (branch + changed files).
#[tauri::command]
fn get_git_status(args: GitStatusArgs) -> Result<GitStatusDto, String> {
    let cwd = args
        .cwd
        .as_ref()
        .map(PathBuf::from)
        .filter(|p| p.is_dir())
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));

    let inside = git_output(&cwd, &["rev-parse", "--is-inside-work-tree"]);
    if inside.as_deref().map(|s| s.trim()) != Some("true") {
        return Ok(GitStatusDto {
            is_repo: false,
            branch: None,
            files: vec![],
            cwd: cwd.display().to_string(),
            error: None,
        });
    }

    let branch = git_output(&cwd, &["rev-parse", "--abbrev-ref", "HEAD"])
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    let mut by_path: std::collections::BTreeMap<String, GitFileChangeDto> =
        std::collections::BTreeMap::new();

    let parse_numstat = |out: &str, map: &mut std::collections::BTreeMap<String, GitFileChangeDto>| {
        for line in out.lines() {
            if line.trim().is_empty() {
                continue;
            }
            let parts: Vec<&str> = line.split('\t').collect();
            if parts.len() < 3 {
                continue;
            }
            let added = if parts[0] == "-" {
                None
            } else {
                parts[0].parse::<i64>().ok()
            };
            let removed = if parts[1] == "-" {
                None
            } else {
                parts[1].parse::<i64>().ok()
            };
            let mut path = parts[2..].join("\t");
            // Collapse rename "old => new"
            if let Some(idx) = path.rfind(" => ") {
                path = path[idx + 4..].to_string();
            }
            let entry = map.entry(path.clone()).or_insert(GitFileChangeDto {
                path: path.clone(),
                added: Some(0),
                removed: Some(0),
                untracked: false,
            });
            entry.untracked = false;
            entry.added = match (entry.added, added) {
                (Some(a), Some(b)) => Some(a + b),
                (None, _) | (_, None) => None,
            };
            entry.removed = match (entry.removed, removed) {
                (Some(a), Some(b)) => Some(a + b),
                (None, _) | (_, None) => None,
            };
        }
    };

    if let Some(u) = git_output(&cwd, &["diff", "--numstat"]) {
        parse_numstat(&u, &mut by_path);
    }
    if let Some(s) = git_output(&cwd, &["diff", "--cached", "--numstat"]) {
        parse_numstat(&s, &mut by_path);
    }
    if let Some(status) = git_output(&cwd, &["status", "--porcelain=v1"]) {
        for line in status.lines() {
            if let Some(rest) = line.strip_prefix("?? ") {
                let path = rest.trim().trim_matches('"').to_string();
                if path.is_empty() {
                    continue;
                }
                by_path.entry(path.clone()).or_insert(GitFileChangeDto {
                    path,
                    added: None,
                    removed: None,
                    untracked: true,
                });
            }
        }
    }

    let mut files: Vec<GitFileChangeDto> = by_path.into_values().collect();
    files.sort_by(|a, b| {
        let churn = |f: &GitFileChangeDto| {
            if f.untracked {
                return -1i64;
            }
            f.added.unwrap_or(0) + f.removed.unwrap_or(0)
        };
        churn(b).cmp(&churn(a)).then_with(|| a.path.cmp(&b.path))
    });
    // Cap list for UI
    files.truncate(40);

    Ok(GitStatusDto {
        is_repo: true,
        branch,
        files,
        cwd: cwd.display().to_string(),
        error: None,
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListDirArgs {
    /// Absolute directory to list. When None, uses `cwd` (or process cwd).
    #[serde(default)]
    path: Option<String>,
    /// Project root / workdir for sandbox. Listing is confined under this root.
    #[serde(default)]
    cwd: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DirEntryDto {
    name: String,
    path: String,
    is_dir: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ListDirDto {
    path: String,
    entries: Vec<DirEntryDto>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

fn is_hidden_noise_name(name: &str) -> bool {
    matches!(
        name,
        "node_modules"
            | ".git"
            | "target"
            | "dist"
            | ".next"
            | ".turbo"
            | "coverage"
            | "__pycache__"
            | ".venv"
            | "venv"
    )
}

/// Search project files/dirs for @-mention autocomplete (bounded walk).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SearchWorkspaceArgs {
    #[serde(default)]
    cwd: Option<String>,
    /// Case-insensitive substring filter on relative path (optional).
    #[serde(default)]
    query: Option<String>,
    /// Max results (default 40, cap 100).
    #[serde(default)]
    limit: Option<u32>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceHitDto {
    /// Path relative to project root (forward slashes).
    path: String,
    /// Absolute path.
    absolute: String,
    is_dir: bool,
    name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SearchWorkspaceDto {
    cwd: String,
    hits: Vec<WorkspaceHitDto>,
}

fn path_under_root(path: &std::path::Path, root: &std::path::Path) -> bool {
    path == root || path.starts_with(root)
}

fn rel_display(abs: &std::path::Path, root: &std::path::Path) -> String {
    abs.strip_prefix(root)
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| abs.to_string_lossy().replace('\\', "/"))
}

#[tauri::command]
fn search_workspace(args: SearchWorkspaceArgs) -> Result<SearchWorkspaceDto, String> {
    let root = args
        .cwd
        .as_ref()
        .map(PathBuf::from)
        .filter(|p| p.is_dir())
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
    let root_canon = fs::canonicalize(&root).unwrap_or(root.clone());
    let q = args
        .query
        .as_ref()
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty());
    let limit = args.limit.unwrap_or(40).clamp(1, 100) as usize;

    let mut hits: Vec<WorkspaceHitDto> = Vec::new();
    let mut stack: Vec<PathBuf> = vec![root_canon.clone()];
    let mut visited = 0usize;
    const MAX_VISIT: usize = 4_000;

    while let Some(dir) = stack.pop() {
        if hits.len() >= limit || visited >= MAX_VISIT {
            break;
        }
        let rd = match fs::read_dir(&dir) {
            Ok(r) => r,
            Err(_) => continue,
        };
        for ent in rd.flatten() {
            if hits.len() >= limit || visited >= MAX_VISIT {
                break;
            }
            visited += 1;
            let name = ent.file_name().to_string_lossy().to_string();
            if name == "." || name == ".." || is_hidden_noise_name(&name) {
                continue;
            }
            // Skip other hidden dirs at top-level of each walk step
            if name.starts_with('.') && name != ".zelari" && name != ".claude" && name != ".opencode"
            {
                continue;
            }
            let path = ent.path();
            let is_dir = ent.file_type().map(|t| t.is_dir()).unwrap_or(false);
            if is_dir {
                stack.push(path.clone());
            }
            let rel = rel_display(&path, &root_canon);
            if rel.is_empty() {
                continue;
            }
            if let Some(ref qq) = q {
                let hay = rel.to_lowercase();
                let name_l = name.to_lowercase();
                if !hay.contains(qq.as_str()) && !name_l.contains(qq.as_str()) {
                    continue;
                }
            }
            hits.push(WorkspaceHitDto {
                path: rel,
                absolute: path.display().to_string(),
                is_dir,
                name,
            });
        }
    }

    // Prefer shorter paths / files that match name first
    hits.sort_by(|a, b| {
        let score = |h: &WorkspaceHitDto| {
            let mut s = h.path.len() as i32;
            if h.is_dir {
                s += 2;
            }
            s
        };
        score(a).cmp(&score(b)).then_with(|| a.path.cmp(&b.path))
    });
    if hits.len() > limit {
        hits.truncate(limit);
    }

    Ok(SearchWorkspaceDto {
        cwd: root_canon.display().to_string(),
        hits,
    })
}

/// Read a text file under the project workdir (for @-mention attach).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReadProjectTextArgs {
    path: String,
    #[serde(default)]
    cwd: Option<String>,
    /// Max bytes to read (default 512_000, cap 1_000_000).
    #[serde(default)]
    max_bytes: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ReadProjectTextDto {
    path: String,
    absolute: String,
    is_dir: bool,
    text: Option<String>,
    note: Option<String>,
    size: u64,
}

#[tauri::command]
fn read_project_text(args: ReadProjectTextArgs) -> Result<ReadProjectTextDto, String> {
    let root = args
        .cwd
        .as_ref()
        .map(PathBuf::from)
        .filter(|p| p.is_dir())
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
    let root_canon = fs::canonicalize(&root).unwrap_or(root.clone());

    let raw = args.path.trim();
    if raw.is_empty() {
        return Err("Path is empty".into());
    }
    let candidate = {
        let p = PathBuf::from(raw);
        if p.is_absolute() {
            p
        } else {
            root_canon.join(p)
        }
    };
    let abs = fs::canonicalize(&candidate).map_err(|e| format!("Cannot open: {e}"))?;
    if !path_under_root(&abs, &root_canon) {
        return Err("Path is outside the open project folder".into());
    }
    let rel = rel_display(&abs, &root_canon);
    let meta = fs::metadata(&abs).map_err(|e| format!("stat failed: {e}"))?;
    if meta.is_dir() {
        return Ok(ReadProjectTextDto {
            path: rel,
            absolute: abs.display().to_string(),
            is_dir: true,
            text: None,
            note: Some("directory — list/read with tools as needed".into()),
            size: 0,
        });
    }
    let max_b = args.max_bytes.unwrap_or(512_000).min(1_000_000);
    let size = meta.len();
    if size > max_b {
        return Ok(ReadProjectTextDto {
            path: rel,
            absolute: abs.display().to_string(),
            is_dir: false,
            text: None,
            note: Some(format!(
                "too large ({} KB) — path only",
                (size / 1024).max(1)
            )),
            size,
        });
    }
    let bytes = fs::read(&abs).map_err(|e| format!("read failed: {e}"))?;
    // Binary heuristic: NUL in first 800 bytes
    let head_n = bytes.len().min(800);
    if bytes[..head_n].contains(&0) {
        return Ok(ReadProjectTextDto {
            path: rel,
            absolute: abs.display().to_string(),
            is_dir: false,
            text: None,
            note: Some("binary — path only".into()),
            size,
        });
    }
    let mut text = String::from_utf8_lossy(&bytes).into_owned();
    if text.starts_with('\u{feff}') {
        text = text.trim_start_matches('\u{feff}').to_string();
    }
    const TEXT_MAX: usize = 48_000;
    if text.len() > TEXT_MAX {
        let more = text.len() - TEXT_MAX;
        text.truncate(TEXT_MAX);
        text.push_str(&format!("\n\n… [truncated, {more} more chars]"));
    }
    Ok(ReadProjectTextDto {
        path: rel,
        absolute: abs.display().to_string(),
        is_dir: false,
        text: Some(text),
        note: None,
        size,
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PrintMcpArgs {
    #[serde(default)]
    cwd: Option<String>,
}

#[tauri::command]
fn print_mcp(args: PrintMcpArgs) -> Result<serde_json::Value, String> {
    let node = find_node().ok_or_else(|| "Node.js not found on PATH".to_string())?;
    let cli = resolve_cli_entry()?;
    let mut argv = vec!["--print-mcp".to_string()];
    if let Some(cwd) = args.cwd.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
        argv.push("--cwd".into());
        argv.push(cwd.to_string());
    }
    let refs: Vec<&str> = argv.iter().map(|s| s.as_str()).collect();
    let raw = run_cli_capture(&node, &cli, &refs)?;
    parse_cli_json_stdout(&raw).ok_or_else(|| format!("Invalid --print-mcp JSON:\n{raw}"))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetMcpArgs {
    name: String,
    command: String,
    #[serde(default)]
    args: Option<Vec<String>>,
    #[serde(default)]
    scope: Option<String>,
    #[serde(default)]
    enabled: Option<bool>,
    #[serde(default)]
    cwd: Option<String>,
}

#[tauri::command]
fn set_mcp(args: SetMcpArgs) -> Result<serde_json::Value, String> {
    let node = find_node().ok_or_else(|| "Node.js not found on PATH".to_string())?;
    let cli = resolve_cli_entry()?;
    let mut argv = vec![
        "--set-mcp".to_string(),
        "--name".into(),
        args.name,
        "--command".into(),
        args.command,
        "--scope".into(),
        args.scope.unwrap_or_else(|| "user".into()),
    ];
    if let Some(en) = args.enabled {
        argv.push("--enabled".into());
        argv.push(if en { "true".into() } else { "false".into() });
    }
    if let Some(a) = args.args {
        argv.push("--args".into());
        argv.push(serde_json::to_string(&a).map_err(|e| e.to_string())?);
    }
    if let Some(cwd) = args.cwd.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
        argv.push("--cwd".into());
        argv.push(cwd.to_string());
    }
    let refs: Vec<&str> = argv.iter().map(|s| s.as_str()).collect();
    let raw = run_cli_capture(&node, &cli, &refs)?;
    parse_cli_json_stdout(&raw).ok_or_else(|| format!("Invalid --set-mcp JSON:\n{raw}"))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoveMcpArgs {
    name: String,
    #[serde(default)]
    scope: Option<String>,
    #[serde(default)]
    cwd: Option<String>,
}

#[tauri::command]
fn remove_mcp(args: RemoveMcpArgs) -> Result<serde_json::Value, String> {
    let node = find_node().ok_or_else(|| "Node.js not found on PATH".to_string())?;
    let cli = resolve_cli_entry()?;
    let mut argv = vec![
        "--remove-mcp".to_string(),
        "--name".into(),
        args.name,
        "--scope".into(),
        args.scope.unwrap_or_else(|| "user".into()),
    ];
    if let Some(cwd) = args.cwd.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
        argv.push("--cwd".into());
        argv.push(cwd.to_string());
    }
    let refs: Vec<&str> = argv.iter().map(|s| s.as_str()).collect();
    let raw = run_cli_capture(&node, &cli, &refs)?;
    parse_cli_json_stdout(&raw).ok_or_else(|| format!("Invalid --remove-mcp JSON:\n{raw}"))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PrintSkillsArgs {
    #[serde(default)]
    cwd: Option<String>,
}

#[tauri::command]
fn print_skills(args: PrintSkillsArgs) -> Result<serde_json::Value, String> {
    let node = find_node().ok_or_else(|| "Node.js not found on PATH".to_string())?;
    let cli = resolve_cli_entry()?;
    let mut argv = vec!["--print-skills".to_string()];
    if let Some(cwd) = args.cwd.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
        argv.push("--cwd".into());
        argv.push(cwd.to_string());
    }
    let refs: Vec<&str> = argv.iter().map(|s| s.as_str()).collect();
    let raw = run_cli_capture(&node, &cli, &refs)?;
    parse_cli_json_stdout(&raw).ok_or_else(|| format!("Invalid --print-skills JSON:\n{raw}"))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetSkillArgs {
    name: String,
    description: String,
    body: String,
    #[serde(default)]
    category: Option<String>,
    #[serde(default)]
    tools: Option<Vec<String>>,
    #[serde(default)]
    cost: Option<String>,
    #[serde(default)]
    scope: Option<String>,
    #[serde(default)]
    cwd: Option<String>,
}

#[tauri::command]
fn set_skill(args: SetSkillArgs) -> Result<serde_json::Value, String> {
    let node = find_node().ok_or_else(|| "Node.js not found on PATH".to_string())?;
    let cli = resolve_cli_entry()?;
    let mut argv = vec![
        "--set-skill".to_string(),
        "--name".into(),
        args.name,
        "--description".into(),
        args.description,
        "--body".into(),
        args.body,
        "--scope".into(),
        args.scope.unwrap_or_else(|| "user".into()),
    ];
    if let Some(c) = args.category {
        argv.push("--category".into());
        argv.push(c);
    }
    if let Some(tools) = args.tools {
        if !tools.is_empty() {
            argv.push("--tools".into());
            argv.push(tools.join(","));
        }
    }
    if let Some(cost) = args.cost {
        argv.push("--cost".into());
        argv.push(cost);
    }
    if let Some(cwd) = args.cwd.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
        argv.push("--cwd".into());
        argv.push(cwd.to_string());
    }
    let refs: Vec<&str> = argv.iter().map(|s| s.as_str()).collect();
    let raw = run_cli_capture(&node, &cli, &refs)?;
    parse_cli_json_stdout(&raw).ok_or_else(|| format!("Invalid --set-skill JSON:\n{raw}"))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoveSkillArgs {
    name: String,
    #[serde(default)]
    scope: Option<String>,
    #[serde(default)]
    cwd: Option<String>,
}

#[tauri::command]
fn remove_skill(args: RemoveSkillArgs) -> Result<serde_json::Value, String> {
    let node = find_node().ok_or_else(|| "Node.js not found on PATH".to_string())?;
    let cli = resolve_cli_entry()?;
    let mut argv = vec![
        "--remove-skill".to_string(),
        "--name".into(),
        args.name,
        "--scope".into(),
        args.scope.unwrap_or_else(|| "user".into()),
    ];
    if let Some(cwd) = args.cwd.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
        argv.push("--cwd".into());
        argv.push(cwd.to_string());
    }
    let refs: Vec<&str> = argv.iter().map(|s| s.as_str()).collect();
    let raw = run_cli_capture(&node, &cli, &refs)?;
    parse_cli_json_stdout(&raw).ok_or_else(|| format!("Invalid --remove-skill JSON:\n{raw}"))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GenerateSkillFromUrlArgs {
    url: String,
    #[serde(default)]
    provider: Option<String>,
    #[serde(default)]
    model: Option<String>,
}

/// Fetch a URL and draft a skill with the selected model (long-running).
#[tauri::command]
fn generate_skill_from_url(args: GenerateSkillFromUrlArgs) -> Result<serde_json::Value, String> {
    let node = find_node().ok_or_else(|| "Node.js not found on PATH".to_string())?;
    let cli = resolve_cli_entry()?;
    let mut argv = vec![
        "--generate-skill-from-url".to_string(),
        "--url".into(),
        args.url,
    ];
    if let Some(p) = args.provider.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
        argv.push("--provider".into());
        argv.push(p.to_string());
    }
    if let Some(m) = args.model.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
        argv.push("--model".into());
        argv.push(m.to_string());
    }
    let refs: Vec<&str> = argv.iter().map(|s| s.as_str()).collect();
    let raw = run_cli_capture(&node, &cli, &refs)?;
    parse_cli_json_stdout(&raw)
        .ok_or_else(|| format!("Invalid --generate-skill-from-url JSON:\n{raw}"))
}

#[tauri::command]
fn print_ssh_targets() -> Result<serde_json::Value, String> {
    let node = find_node().ok_or_else(|| "Node.js not found on PATH".to_string())?;
    let cli = resolve_cli_entry()?;
    let raw = run_cli_capture(&node, &cli, &["--print-ssh-targets"])?;
    parse_cli_json_stdout(&raw).ok_or_else(|| format!("Invalid --print-ssh-targets JSON:\n{raw}"))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetSshTargetArgs {
    /// Full target object as JSON string or structured fields via `json`
    json: String,
}

#[tauri::command]
fn set_ssh_target(args: SetSshTargetArgs) -> Result<serde_json::Value, String> {
    let node = find_node().ok_or_else(|| "Node.js not found on PATH".to_string())?;
    let cli = resolve_cli_entry()?;
    let raw = run_cli_capture(
        &node,
        &cli,
        &["--set-ssh-target", "--json", &args.json],
    )?;
    parse_cli_json_stdout(&raw).ok_or_else(|| format!("Invalid --set-ssh-target JSON:\n{raw}"))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SshIdArgs {
    id: String,
}

#[tauri::command]
fn remove_ssh_target(args: SshIdArgs) -> Result<serde_json::Value, String> {
    let node = find_node().ok_or_else(|| "Node.js not found on PATH".to_string())?;
    let cli = resolve_cli_entry()?;
    let raw = run_cli_capture(&node, &cli, &["--remove-ssh-target", "--id", &args.id])?;
    parse_cli_json_stdout(&raw).ok_or_else(|| format!("Invalid --remove-ssh-target JSON:\n{raw}"))
}

#[tauri::command]
fn test_ssh_target(args: SshIdArgs) -> Result<serde_json::Value, String> {
    let node = find_node().ok_or_else(|| "Node.js not found on PATH".to_string())?;
    let cli = resolve_cli_entry()?;
    // test may exit non-zero on failure but still print JSON
    let mut cmd = spawn_cli_base(&node, &cli, None);
    cmd.arg("--test-ssh-target").arg("--id").arg(&args.id);
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    let output = cmd
        .output()
        .map_err(format_cli_spawn_err)?;
    let out = String::from_utf8_lossy(&output.stdout).to_string();
    if let Some(v) = parse_cli_json_stdout(&out) {
        return Ok(v);
    }
    let err = String::from_utf8_lossy(&output.stderr).to_string();
    Err(if !err.trim().is_empty() {
        err
    } else {
        out
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PrintSshPubkeyArgs {
    path: String,
}

#[tauri::command]
fn print_ssh_pubkey(args: PrintSshPubkeyArgs) -> Result<serde_json::Value, String> {
    let node = find_node().ok_or_else(|| "Node.js not found on PATH".to_string())?;
    let cli = resolve_cli_entry()?;
    let mut cmd = spawn_cli_base(&node, &cli, None);
    cmd.arg("--print-ssh-pubkey").arg("--path").arg(&args.path);
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    let output = cmd
        .output()
        .map_err(format_cli_spawn_err)?;
    let out = String::from_utf8_lossy(&output.stdout).to_string();
    if let Some(v) = parse_cli_json_stdout(&out) {
        return Ok(v);
    }
    let err = String::from_utf8_lossy(&output.stderr).to_string();
    Err(if !err.trim().is_empty() {
        err
    } else {
        out
    })
}

/// Write UTF-8 text to an absolute path chosen by the user (e.g. chat export).
/// Not sandboxed to the project workdir — destination comes from the native dialog.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WriteTextFileArgs {
    path: String,
    content: String,
}

#[tauri::command]
fn write_text_file(args: WriteTextFileArgs) -> Result<String, String> {
    let path = args.path.trim();
    if path.is_empty() {
        return Err("Path is empty".into());
    }
    let p = PathBuf::from(path);
    if p.is_dir() {
        return Err("Path is a directory; expected a file path".into());
    }
    if let Some(parent) = p.parent() {
        if !parent.as_os_str().is_empty() && !parent.is_dir() {
            return Err(format!(
                "Parent folder does not exist: {}",
                parent.display()
            ));
        }
    }
    fs::write(&p, args.content.as_bytes()).map_err(|e| format!("Write failed: {e}"))?;
    Ok(p.display().to_string())
}

/// List one directory level under the project workdir (lazy file tree).
#[tauri::command]
fn list_dir(args: ListDirArgs) -> Result<ListDirDto, String> {
    let root = args
        .cwd
        .as_ref()
        .map(PathBuf::from)
        .filter(|p| p.is_dir())
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));

    let root_canon = fs::canonicalize(&root).unwrap_or(root.clone());

    let target = match args.path.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
        Some(p) => PathBuf::from(p),
        None => root.clone(),
    };

    let target_canon = match fs::canonicalize(&target) {
        Ok(p) => p,
        Err(e) => {
            return Ok(ListDirDto {
                path: target.display().to_string(),
                entries: vec![],
                error: Some(format!("Cannot open: {e}")),
            });
        }
    };

    // Sandbox: listing must stay under project root
    if !target_canon.starts_with(&root_canon) {
        return Err("Path is outside the open project folder".into());
    }

    if !target_canon.is_dir() {
        return Ok(ListDirDto {
            path: target_canon.display().to_string(),
            entries: vec![],
            error: Some("Not a directory".into()),
        });
    }

    let mut entries: Vec<DirEntryDto> = Vec::new();
    let rd = match fs::read_dir(&target_canon) {
        Ok(r) => r,
        Err(e) => {
            return Ok(ListDirDto {
                path: target_canon.display().to_string(),
                entries: vec![],
                error: Some(e.to_string()),
            });
        }
    };

    for ent in rd.flatten() {
        let name = ent.file_name().to_string_lossy().to_string();
        if name == "." || name == ".." {
            continue;
        }
        if is_hidden_noise_name(&name) {
            continue;
        }
        let meta = match ent.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let path = ent.path().display().to_string();
        entries.push(DirEntryDto {
            name,
            path,
            is_dir: meta.is_dir(),
        });
        if entries.len() >= 200 {
            break;
        }
    }

    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });

    Ok(ListDirDto {
        path: target_canon.display().to_string(),
        entries,
        error: None,
    })
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
    /// JSON-encoded AgentMessage[] of prior conversation turns, forwarded to
    /// the CLI as `--history <json>` so the agent keeps multi-turn context
    /// across the per-message process boundary. None/empty = stateless.
    #[serde(default)]
    history: Option<String>,
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginsCwdArgs {
    #[serde(default)]
    cwd: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginsInstallArgs {
    id: String,
    #[serde(default)]
    cwd: Option<String>,
}

/// `zelari-code --plugins-status [--cwd <path>]` → JSON plugin list.
#[tauri::command]
fn plugins_status(args: PluginsCwdArgs) -> Result<serde_json::Value, String> {
    let node = find_node().ok_or_else(|| "Node.js not found on PATH".to_string())?;
    let cli = resolve_cli_entry()?;
    let mut argv: Vec<String> = vec!["--plugins-status".into()];
    if let Some(ref cwd) = args.cwd {
        if !cwd.trim().is_empty() {
            argv.push("--cwd".into());
            argv.push(cwd.clone());
        }
    }
    let refs: Vec<&str> = argv.iter().map(|s| s.as_str()).collect();
    let raw = run_cli_capture(&node, &cli, &refs)?;
    serde_json::from_str(raw.trim())
        .map_err(|e| format!("Invalid --plugins-status JSON: {e}\n{raw}"))
}

/// `zelari-code --plugins-install <id> [--cwd <path>]` → JSON install result.
/// Installs Playwright package + Chromium when id=playwright.
#[tauri::command]
fn plugins_install(args: PluginsInstallArgs) -> Result<serde_json::Value, String> {
    let node = find_node().ok_or_else(|| "Node.js not found on PATH".to_string())?;
    let cli = resolve_cli_entry()?;
    let id = args.id.trim();
    if id.is_empty() {
        return Err("plugin id is required".into());
    }
    let mut argv: Vec<String> = vec!["--plugins-install".into(), id.into()];
    if let Some(ref cwd) = args.cwd {
        if !cwd.trim().is_empty() {
            argv.push("--cwd".into());
            argv.push(cwd.clone());
        }
    }
    let refs: Vec<&str> = argv.iter().map(|s| s.as_str()).collect();
    let raw = run_cli_capture(&node, &cli, &refs)?;
    // Install may take minutes (Chromium). run_cli_capture waits for process end.
    // Prefer JSON on stdout even when exit code non-zero.
    serde_json::from_str(raw.trim()).or_else(|_| {
        Ok(serde_json::json!({
            "ok": false,
            "id": id,
            "message": raw.trim(),
            "output": raw,
        }))
    })
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
    let history = args.history;

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
            history.as_deref(),
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
    history: Option<&str>,
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
    // Forward conversation history so the desktop (fresh process per message)
    // preserves multi-turn context. We write the JSON to a TEMP FILE rather
    // than passing it as `--history <json>` because Windows' CreateProcess has
    // a ~32KB command-line ceiling (os error 206) and a multi-turn chat's
    // serialized history can easily exceed it. The CLI reads it via
    // `--history-file <path>`; we clean up the file below after the run ends.
    let history_file: Option<PathBuf> = if let Some(h) = history {
        if !h.is_empty() {
            let file_name = format!(
                "zelari-history-{}.json",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_nanos())
                    .unwrap_or(0)
            );
            let path = std::env::temp_dir().join(file_name);
            match fs::write(&path, h) {
                Ok(()) => {
                    cmd.arg("--history-file").arg(&path);
                    Some(path)
                }
                Err(_) => None, // Non-fatal: degrade to stateless.
            }
        } else {
            None
        }
    } else {
        None
    };

    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(format_cli_spawn_err)?;

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
    // Clean up the history tempfile (best-effort; never fail the run on cleanup).
    if let Some(ref p) = history_file {
        let _ = fs::remove_file(p);
    }
    match child.try_wait() {
        Ok(Some(s)) => Ok(s.code().unwrap_or(if s.success() { 0 } else { 2 })),
        Ok(None) => match child.wait() {
            Ok(s) => Ok(s.code().unwrap_or(if s.success() { 0 } else { 2 })),
            Err(_) => Ok(if cancelled { 130 } else { 2 }),
        },
        Err(_) => Ok(if cancelled { 130 } else { 2 }),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CompanionServeStartArgs {
    #[serde(default)]
    bind: Option<String>,
    #[serde(default)]
    port: Option<u16>,
    /// Project folder (Open Folder). Added as --project allowlist entry.
    #[serde(default)]
    project: Option<String>,
}

#[tauri::command]
fn companion_serve_status(state: State<'_, Arc<CompanionServeState>>) -> CompanionServeStatus {
    reap_dead_companion(&state);
    let bind = state
        .bind
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    let port = *state.port.lock().unwrap_or_else(|e| e.into_inner());
    let pid = state
        .child
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        .map(|c| c.id());
    let healthy = companion_health_ok(&bind, port);
    let tracked = pid.is_some();
    let running = tracked || healthy;
    let host = if bind == "0.0.0.0" || bind == "::" {
        "127.0.0.1"
    } else {
        bind.as_str()
    };
    let url = format!("http://{host}:{port}");
    let token = read_companion_token();
    let message = if healthy {
        "Companion serve is reachable".into()
    } else if tracked {
        "Process started; waiting for /health…".into()
    } else {
        "Companion serve is stopped".into()
    };
    CompanionServeStatus {
        running,
        healthy,
        bind,
        port,
        url,
        token,
        token_path: companion_token_path().display().to_string(),
        pid,
        message,
    }
}

#[tauri::command]
fn companion_serve_start(
    state: State<'_, Arc<CompanionServeState>>,
    args: CompanionServeStartArgs,
) -> Result<CompanionServeStatus, String> {
    reap_dead_companion(&state);
    // Already healthy → no-op success.
    {
        let bind = state.bind.lock().unwrap_or_else(|e| e.into_inner()).clone();
        let port = *state.port.lock().unwrap_or_else(|e| e.into_inner());
        let has_child = state
            .child
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_some();
        if companion_health_ok(&bind, port) {
            return Ok(companion_serve_status(state));
        }
        // Stale child that never became healthy — kill before restart.
        if has_child {
            let mut guard = state.child.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(mut child) = guard.take() {
                kill_child_tree(&mut child);
                let _ = child.wait();
            }
        }
    }

    let bind = args
        .bind
        .as_ref()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "127.0.0.1".into());
    let port = args.port.unwrap_or(7421);
    if port == 0 {
        return Err("Invalid port".into());
    }

    let node = find_node().ok_or_else(|| "Node.js not found on PATH".to_string())?;
    let cli = resolve_cli_entry()?;

    // Detached long-running process — not capture mode.
    let mut cmd = spawn_cli_base(&node, &cli, None);
    cmd.arg("serve")
        .arg("--bind")
        .arg(&bind)
        .arg("--port")
        .arg(port.to_string());
    if let Some(proj) = args
        .project
        .as_ref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
    {
        cmd.arg("--project").arg(proj);
    }
    cmd.stdout(Stdio::null()).stderr(Stdio::null());

    let child = cmd.spawn().map_err(format_cli_spawn_err)?;
    let pid = child.id();

    *state.bind.lock().unwrap_or_else(|e| e.into_inner()) = bind.clone();
    *state.port.lock().unwrap_or_else(|e| e.into_inner()) = port;
    *state.child.lock().unwrap_or_else(|e| e.into_inner()) = Some(child);

    // Wait briefly for /health (CLI boot + token write).
    let mut healthy = false;
    for _ in 0..20 {
        thread::sleep(Duration::from_millis(250));
        if companion_health_ok(&bind, port) {
            healthy = true;
            break;
        }
        // Child died?
        let mut g = state.child.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(c) = g.as_mut() {
            if let Ok(Some(status)) = c.try_wait() {
                *g = None;
                return Err(format!(
                    "Companion serve exited immediately (code {:?}). \
                     Ensure the monorepo CLI is built (npm run build:cli) — \
                     global npm may lack `serve`.",
                    status.code()
                ));
            }
        }
    }

    let token = read_companion_token();
    let host = if bind == "0.0.0.0" || bind == "::" {
        "127.0.0.1"
    } else {
        bind.as_str()
    };
    Ok(CompanionServeStatus {
        running: true,
        healthy,
        bind: bind.clone(),
        port,
        url: format!("http://{host}:{port}"),
        token,
        token_path: companion_token_path().display().to_string(),
        pid: Some(pid),
        message: if healthy {
            "Companion serve started".into()
        } else {
            "Process launched; /health not ready yet — retry Status".into()
        },
    })
}

#[tauri::command]
fn companion_serve_stop(
    state: State<'_, Arc<CompanionServeState>>,
) -> Result<CompanionServeStatus, String> {
    {
        let mut guard = state.child.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(mut child) = guard.take() {
            kill_child_tree(&mut child);
            let _ = child.wait();
        }
    }
    // Brief pause so the port frees.
    thread::sleep(Duration::from_millis(300));
    Ok(companion_serve_status(state))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(Arc::new(RunState::default()))
        .manage(Arc::new(CompanionServeState::default()))
        .invoke_handler(tauri::generate_handler![
            get_cli_status,
            get_app_config,
            set_app_config,
            set_api_key,
            discover_models,
            check_cli_update,
            update_cli,
            plugins_status,
            plugins_install,
            run_task,
            cancel_run,
            get_git_status,
            write_text_file,
            list_dir,
            search_workspace,
            read_project_text,
            print_mcp,
            set_mcp,
            remove_mcp,
            print_skills,
            set_skill,
            remove_skill,
            companion_serve_status,
            companion_serve_start,
            companion_serve_stop,
            generate_skill_from_url,
            print_ssh_targets,
            set_ssh_target,
            remove_ssh_target,
            test_ssh_target,
            print_ssh_pubkey
        ])
        .run(tauri::generate_context!())
        .expect("error while running Zelari Desktop");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn unwrap_leaves_js_entry_alone() {
        let p = PathBuf::from("bin/zelari-code.js");
        assert_eq!(unwrap_cli_js_entry(&p), p);
    }

    #[test]
    fn unwrap_resolves_npm_cmd_shim_layout() {
        let dir = std::env::temp_dir().join(format!(
            "zelari-unwrap-test-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        let js_dir = dir.join("node_modules").join("zelari-code").join("bin");
        fs::create_dir_all(&js_dir).unwrap();
        let js = js_dir.join("zelari-code.js");
        fs::write(&js, b"// stub\n").unwrap();
        let cmd = dir.join("zelari-code.cmd");
        fs::write(
            &cmd,
            r#"@ECHO off
"node" "%dp0%\node_modules\zelari-code\bin\zelari-code.js" %*
"#,
        )
        .unwrap();

        let resolved = unwrap_cli_js_entry(&cmd);
        assert_eq!(resolved, js);

        let bare = dir.join("zelari-code");
        // Extensionless next to .cmd should also unwrap via with_extension("cmd").
        let resolved_bare = unwrap_cli_js_entry(&bare);
        assert_eq!(resolved_bare, js);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn unwrap_parses_cmd_shim_when_layout_differs() {
        let dir = std::env::temp_dir().join(format!(
            "zelari-unwrap-parse-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        // JS not under node_modules/… — only reachable via parse.
        let js = dir.join("custom").join("zelari-code.js");
        fs::create_dir_all(js.parent().unwrap()).unwrap();
        fs::write(&js, b"// stub\n").unwrap();
        let cmd = dir.join("zelari-code.cmd");
        let mut f = fs::File::create(&cmd).unwrap();
        writeln!(
            f,
            r#"@ECHO off
node "{}" %*"#,
            js.display()
        )
        .unwrap();

        let resolved = unwrap_cli_js_entry(&cmd);
        assert_eq!(resolved, js);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn format_cli_spawn_err_hints_on_batch_invalid() {
        let msg = format_cli_spawn_err("batch file arguments are invalid");
        assert!(msg.contains("JS entry"));
        assert!(msg.contains("ZELARI_CLI_PATH"));
    }
}
