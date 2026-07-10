//! Zelari Desktop — thin Tauri shell over `zelari-code --headless`.
//!
//! The coding brain stays in Node (`@zelari/core` + CLI). This host only
//! resolves the CLI, spawns headless runs, and streams NDJSON BrainEvents
//! to the web UI via Tauri events.

use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use tauri::{AppHandle, Emitter, State};

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

fn spawn_cli_base(node: &Path, cli: &Path) -> Command {
    if is_js_entry(cli) {
        let mut c = Command::new(node);
        c.arg(cli);
        c
    } else {
        Command::new(cli)
    }
}

fn run_cli_capture(node: &Path, cli: &Path, args: &[&str]) -> Result<String, String> {
    let mut cmd = spawn_cli_base(node, cli);
    for a in args {
        cmd.arg(a);
    }
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    let output = cmd
        .output()
        .map_err(|e| format!("Failed to spawn zelari-code: {e}"))?;
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        let out = String::from_utf8_lossy(&output.stdout);
        let msg = if !err.trim().is_empty() {
            err.trim().to_string()
        } else {
            out.trim().to_string()
        };
        return Err(if msg.is_empty() {
            format!("CLI exited with {}", output.status)
        } else {
            msg
        });
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
    if let Some(p) = args.provider.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
        argv.push("--provider".into());
        argv.push(p.to_string());
    }
    if let Some(m) = args.model.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
        argv.push("--model".into());
        argv.push(m.to_string());
    }
    if let Some(ep) = args.endpoint.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
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

#[tauri::command]
fn discover_models(args: DiscoverArgs) -> Result<serde_json::Value, String> {
    let node = find_node().ok_or_else(|| "Node.js not found on PATH".to_string())?;
    let cli = resolve_cli_entry()?;
    let mut argv: Vec<String> = vec!["--discover-models".into()];
    if let Some(p) = args.provider.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
        argv.push("--provider".into());
        argv.push(p.to_string());
    }
    let refs: Vec<&str> = argv.iter().map(|s| s.as_str()).collect();
    // Discovery can take a while (network)
    let mut cmd = spawn_cli_base(&node, &cli);
    for a in &refs {
        cmd.arg(a);
    }
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    let output = cmd
        .output()
        .map_err(|e| format!("Failed to spawn discover-models: {e}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    if !output.status.success() {
        // Prefer JSON error from stderr or stdout
        for blob in [stderr.trim(), stdout.trim()] {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(blob) {
                return Err(
                    v.get("error")
                        .and_then(|e| e.as_str())
                        .unwrap_or(blob)
                        .to_string(),
                );
            }
            if !blob.is_empty() {
                return Err(blob.to_string());
            }
        }
        return Err("discover-models failed".into());
    }
    serde_json::from_str(stdout.trim())
        .map_err(|e| format!("Invalid discover-models JSON: {e}\n{stdout}"))
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
) -> Result<i32, String> {
    let mut cmd = spawn_cli_base(node, cli);

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

    cmd.env("FORCE_COLOR", "0");
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

    let reader = BufReader::new(stdout);
    for line in reader.lines() {
        if state.cancel.load(Ordering::SeqCst) {
            let _ = child.kill();
            break;
        }
        let line = match line {
            Ok(l) => l,
            Err(e) => {
                let _ = app.emit(
                    "agent-event",
                    serde_json::json!({
                        "type": "error",
                        "message": format!("stdout read error: {e}"),
                    }),
                );
                break;
            }
        };
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

    let _ = err_thread.join();
    let status = child
        .wait()
        .map_err(|e| format!("Failed waiting for CLI: {e}"))?;
    Ok(status.code().unwrap_or(if status.success() { 0 } else { 2 }))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(Arc::new(RunState::default()))
        .invoke_handler(tauri::generate_handler![
            get_cli_status,
            get_app_config,
            set_app_config,
            set_api_key,
            discover_models,
            run_task,
            cancel_run
        ])
        .run(tauri::generate_context!())
        .expect("error while running Zelari Desktop");
}
