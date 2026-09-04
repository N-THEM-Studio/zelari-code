//! Zelari Desktop — thin Tauri shell over the `zelari-code` CLI.
//!
//! The coding brain stays in Node (`@zelari/core` + CLI). This host only
//! resolves the CLI, drives ONE long-lived `--serve-harness` sidecar
//! (see harness_sidecar.rs) over NDJSON stdio, and streams NDJSON BrainEvents
//! to the web UI via Tauri events.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};

mod harness_sidecar;
use harness_sidecar::HarnessSidecar;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// Hide console window for short-lived CLI helpers on Windows.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Max concurrent runs across all workspaces.
const MAX_PARALLEL_RUNS: usize = 4;

/// One active (or just-finished) headless run.
#[derive(Clone)]
struct RunEntry {
    run_id: String,
    /// Kept for diagnostics / future per-conversation queries.
    #[allow(dead_code)]
    conversation_id: String,
    /// Normalized workspace key (canonical, lowercased, forward slashes). */
    cwd: String,
    cancel: Arc<AtomicBool>,
}

/// Multi-run registry (replaces the v0.1 single-flight RunState).
/// Policy: max ONE active run per cwd - two CLI processes writing the
/// same tree would race on plan.json and source files - plus a global
/// MAX_PARALLEL_RUNS cap.
struct RunRegistry {
    runs: Mutex<Vec<RunEntry>>,
}

impl Default for RunRegistry {
    fn default() -> Self {
        Self {
            runs: Mutex::new(Vec::new()),
        }
    }
}

impl RunRegistry {
    fn register(
        &self,
        run_id: &str,
        conversation_id: &str,
        cwd: &str,
    ) -> Result<Arc<AtomicBool>, String> {
        let mut runs = self.runs.lock().unwrap_or_else(|e| e.into_inner());
        if runs.iter().any(|r| r.cwd == cwd) {
            return Err(
                "Another build run is already modifying this workspace. Wait for it to finish or cancel it first."
                    .into(),
            );
        }
        if runs.len() >= MAX_PARALLEL_RUNS {
            return Err(format!(
                "Too many concurrent runs (max {MAX_PARALLEL_RUNS}). Wait for a background run to finish."
            ));
        }
        let cancel = Arc::new(AtomicBool::new(false));
        runs.push(RunEntry {
            run_id: run_id.to_string(),
            conversation_id: conversation_id.to_string(),
            cwd: cwd.to_string(),
            cancel: Arc::clone(&cancel),
        });
        Ok(cancel)
    }

    fn remove(&self, run_id: &str) {
        let mut runs = self.runs.lock().unwrap_or_else(|e| e.into_inner());
        runs.retain(|r| r.run_id != run_id);
    }

    /// Cancel one run (by id) or every active run (legacy no-arg call).
    fn cancel(&self, run_id: Option<&str>) -> usize {
        let runs = self.runs.lock().unwrap_or_else(|e| e.into_inner());
        let targets: Vec<&RunEntry> = match run_id {
            Some(id) if !id.is_empty() && !id.starts_with("pending:") => {
                runs.iter().filter(|r| r.run_id == id).collect()
            }
            _ => runs.iter().collect(),
        };
        for t in &targets {
            t.cancel.store(true, Ordering::SeqCst);
        }
        targets.len()
    }
}

/// Normalize a workspace path into a comparison key: canonicalize when
/// possible (symlinks, Windows 8.3), forward slashes, lowercase (case-
/// insensitive filesystems: Windows/macOS).
fn normalize_cwd(cwd: Option<&str>) -> String {
    let raw = cwd.unwrap_or("").trim();
    if raw.is_empty() {
        return String::new();
    }
    match Path::new(raw).canonicalize() {
        Ok(c) => c.to_string_lossy().replace('\\', "/").to_lowercase(),
        Err(_) => raw.replace('\\', "/").to_lowercase(),
    }
}

/// Per-run identity stamped on EVERY emitted event so the frontend can
/// route without guessing which chat is visible (multi-chat M2).
#[derive(Clone)]
struct RunEnvelopeCtx {
    run_id: String,
    /// Kept for diagnostics / future per-conversation queries.
    #[allow(dead_code)]
    conversation_id: String,
    cwd: String,
}

fn enveloped(mut value: serde_json::Value, ctx: &RunEnvelopeCtx) -> serde_json::Value {
    if let Some(obj) = value.as_object_mut() {
        obj.insert("runId".into(), serde_json::json!(ctx.run_id));
        obj.insert(
            "conversationId".into(),
            serde_json::json!(ctx.conversation_id),
        );
        obj.insert("cwd".into(), serde_json::json!(ctx.cwd));
    }
    value
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
            bind: Mutex::new("0.0.0.0".into()),
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
    /// Best URL for the phone (Tailscale IPv4 when detected).
    phone_url: String,
    /// Tailscale CGNAT IPv4 (`tailscale ip -4`), if any.
    tailscale_ip: Option<String>,
    /// Full token for QR/pairing (local only). Empty if missing.
    token: String,
    token_path: String,
    pid: Option<u32>,
    message: String,
}

fn is_cgnat_ipv4(ip: &str) -> bool {
    let parts: Vec<u32> = ip.split('.').filter_map(|s| s.parse().ok()).collect();
    parts.len() == 4 && parts[0] == 100 && (64..=127).contains(&parts[1])
}

fn tailscale_cli_ipv4() -> Option<String> {
    let bins: Vec<String> = {
        #[cfg(windows)]
        {
            vec![
                "tailscale".into(),
                r"C:\Program Files\Tailscale\tailscale.exe".into(),
                r"C:\Program Files (x86)\Tailscale\tailscale.exe".into(),
            ]
        }
        #[cfg(not(windows))]
        {
            vec!["tailscale".into(), "/usr/bin/tailscale".into()]
        }
    };
    for bin in bins {
        let mut cmd = Command::new(&bin);
        cmd.args(["ip", "-4"]);
        #[cfg(windows)]
        {
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        if let Ok(out) = cmd.stdout(Stdio::piped()).stderr(Stdio::null()).output() {
            if !out.status.success() {
                continue;
            }
            if let Some(ip) = String::from_utf8_lossy(&out.stdout)
                .lines()
                .map(str::trim)
                .find(|l| is_cgnat_ipv4(l))
            {
                return Some(ip.to_string());
            }
        }
    }
    None
}

fn cgnat_ipv4_from_system() -> Option<String> {
    #[cfg(windows)]
    {
        let mut cmd = Command::new("ipconfig");
        cmd.creation_flags(CREATE_NO_WINDOW);
        let out = cmd.output().ok()?;
        for token in String::from_utf8_lossy(&out.stdout).split_whitespace() {
            let t = token.trim_end_matches([',', ':']);
            if is_cgnat_ipv4(t) {
                return Some(t.to_string());
            }
        }
        None
    }
    #[cfg(not(windows))]
    {
        for (bin, args) in [
            ("ip", &["-4", "-o", "addr", "show"][..]),
            ("hostname", &["-I"][..]),
        ] {
            let Ok(out) = Command::new(bin).args(args).output() else {
                continue;
            };
            if !out.status.success() {
                continue;
            }
            for token in String::from_utf8_lossy(&out.stdout)
                .split(|c: char| c.is_whitespace() || c == '/' || c == ',')
            {
                if is_cgnat_ipv4(token) {
                    return Some(token.to_string());
                }
            }
        }
        None
    }
}

fn detect_tailscale_ipv4() -> Option<String> {
    tailscale_cli_ipv4().or_else(cgnat_ipv4_from_system)
}

fn companion_status_from(
    bind: String,
    port: u16,
    pid: Option<u32>,
    running: bool,
    healthy: bool,
    message: String,
) -> CompanionServeStatus {
    let tailscale_ip = detect_tailscale_ipv4();
    let loopback_host = if bind == "0.0.0.0" || bind == "::" {
        "127.0.0.1"
    } else {
        bind.as_str()
    };
    let url = format!("http://{loopback_host}:{port}");
    let phone_url = tailscale_ip
        .as_ref()
        .map(|ip| format!("http://{ip}:{port}"))
        .unwrap_or_else(|| url.clone());
    CompanionServeStatus {
        running,
        healthy,
        bind,
        port,
        url,
        phone_url,
        tailscale_ip,
        token: read_companion_token(),
        token_path: companion_token_path().display().to_string(),
        pid,
        message,
    }
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
    /// Kept for diagnostics / future per-conversation queries.
    #[allow(dead_code)]
    conversation_id: String,
    cwd: String,
    prompt: String,
    mode: String,
    phase: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RunFinished {
    run_id: String,
    /// Kept for diagnostics / future per-conversation queries.
    #[allow(dead_code)]
    conversation_id: String,
    cwd: String,
    exit_code: i32,
    cancelled: bool,
}

pub(crate) fn find_node() -> Option<PathBuf> {
    which::which("node").ok()
}

pub(crate) fn resolve_cli_entry() -> Result<PathBuf, String> {
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

fn parse_semver(raw: &str) -> Option<((u64, u64, u64), Option<String>)> {
    let s = normalize_semver(raw);
    let (core, pre) = match s.split_once('-') {
        Some((c, p)) => (c, Some(p.to_string())),
        None => (s.as_str(), None),
    };
    let mut parts = core.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    let patch = parts.next()?.parse().ok()?;
    Some(((major, minor, patch), pre))
}

/// SemVer 2.0.0 precedence: 1.0.0-alpha < 1.0.0. Same core + both
/// prerelease → identifier compare (numeric vs ASCII, longer wins).
fn cmp_prerelease(a: &str, b: &str) -> i32 {
    let pa: Vec<&str> = a.split('.').collect();
    let pb: Vec<&str> = b.split('.').collect();
    let n = pa.len().max(pb.len());
    for i in 0..n {
        match (pa.get(i), pb.get(i)) {
            (None, Some(_)) => return -1,
            (Some(_), None) => return 1,
            (Some(x), Some(y)) => {
                let xn = x.parse::<u64>().ok();
                let yn = y.parse::<u64>().ok();
                match (xn, yn) {
                    (Some(xi), Some(yi)) if xi != yi => {
                        return if xi < yi { -1 } else { 1 };
                    }
                    (Some(_), None) => return -1,
                    (None, Some(_)) => return 1,
                    _ if *x != *y => return if *x < *y { -1 } else { 1 },
                    _ => {}
                }
            }
            _ => {}
        }
    }
    0
}

/// -1 if a < b, 0 equal, 1 if a > b. Release > matching prerelease.
fn cmp_semver(a: &str, b: &str) -> i32 {
    match (parse_semver(a), parse_semver(b)) {
        (Some(x), Some(y)) => {
            if x.0 < y.0 {
                -1
            } else if x.0 > y.0 {
                1
            } else {
                match (&x.1, &y.1) {
                    (None, None) => 0,
                    (Some(_), None) => -1,
                    (None, Some(_)) => 1,
                    (Some(pa), Some(pb)) => cmp_prerelease(pa, pb),
                }
            }
        }
        _ => 0,
    }
}

/// Map an app version to the npm dist-tag channel it should track.
/// Pre-release builds (e.g. `2.0.0-alpha.3`) follow their matching dist-tag
/// (`alpha`), stable builds follow `latest`. This keeps the Desktop's CLI
/// update on the same channel as the Desktop itself.
fn dist_tag_for(version: &str) -> &'static str {
    if version.contains("-alpha.") {
        "alpha"
    } else if version.contains("-beta.") {
        "beta"
    } else if version.contains("-next.") {
        "next"
    } else {
        "latest"
    }
}

/// Fetch the current zelari-code version for a dist-tag from npm
/// (via Node fetch — no extra Rust dep).
fn fetch_npm_latest_cli(node: &Path, tag: &str) -> Result<String, String> {
    let script = r#"
fetch('https://registry.npmjs.org/zelari-code/' + process.env.ZELARI_NPM_TAG)
  .then(r => { if (!r.ok) throw new Error('HTTP '+r.status); return r.json(); })
  .then(j => { if (!j.version) throw new Error('no version'); process.stdout.write(String(j.version)); })
  .catch(e => { process.stderr.write(String(e && e.message || e)); process.exit(1); });
"#;
    let mut cmd = Command::new(node);
    cmd.arg("-e").arg(script);
    cmd.env("ZELARI_NPM_TAG", tag);
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
    channel: String,
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

    let channel = dist_tag_for(env!("CARGO_PKG_VERSION"));
    let npm_latest = fetch_npm_latest_cli(&node, channel)?;

    let update_available = match &installed {
        Some(cur) => cmp_semver(cur, &npm_latest) < 0,
        None => true,
    };

    let message = match &installed {
        Some(cur) if update_available => {
            format!("CLI is v{cur}; npm {channel} is v{npm_latest}. Use Update CLI to upgrade.")
        }
        Some(cur) => format!("CLI is up to date (v{cur}) on npm {channel}."),
        None => format!("CLI not found. Install with: npm i -g zelari-code@{npm_latest}"),
    };

    Ok(CliUpdateCheck {
        installed,
        npm_latest: Some(npm_latest),
        channel: channel.to_string(),
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
        .unwrap_or_else(|| dist_tag_for(env!("CARGO_PKG_VERSION")));
    let pkg = format!("zelari-code@{ver}");

    // Prefer: node <npm-cli.js> install -g … (avoids broken .cmd shims on Windows)
    let npm_cli = {
        let dir = node.parent().map(|p| p.to_path_buf());
        let mut candidates = Vec::new();
        if let Some(d) = dir {
            candidates.push(
                d.join("node_modules")
                    .join("npm")
                    .join("bin")
                    .join("npm-cli.js"),
            );
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
pub(crate) fn format_cli_spawn_err(err: impl std::fmt::Display) -> String {
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

pub(crate) fn spawn_cli_base(node: &Path, cli: &Path, cwd: Option<&Path>) -> Command {
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
pub(crate) fn kill_child_tree(child: &mut Child) {
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
    let output = cmd.output().map_err(format_cli_spawn_err)?;
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
            message: "Node.js not found on PATH (need Node ≥ 24, see engines.node).".into(),
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

/// 2.32 B5 — Desktop doctor gate. Runs `zelari-code --doctor --json` and
/// returns the structured DoctorReport (`healthy`, `firstRed`). The CLI
/// exits 1 when the doctor is red; the JSON on stdout is still the contract
/// (same precedent as test_ssh_target), so stdout is parsed before any
/// error path. Mirrors the TUI first-run gate (main.ts runFirstRunDoctorGate).
#[tauri::command]
fn cli_doctor_check() -> Result<serde_json::Value, String> {
    let node = find_node().ok_or_else(|| "Node.js not found on PATH".to_string())?;
    let cli = resolve_cli_entry()?;
    let mut cmd = spawn_cli_base(&node, &cli, None);
    cmd.args(["--doctor", "--json"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let output = cmd.output().map_err(format_cli_spawn_err)?;
    let out = String::from_utf8_lossy(&output.stdout).to_string();
    if let Some(v) = parse_cli_json_stdout(&out) {
        return Ok(v);
    }
    let err = String::from_utf8_lossy(&output.stderr).to_string();
    Err(if !err.trim().is_empty() { err } else { out })
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
        format!("Failed to load provider config (invalid --print-config JSON).\n{raw}")
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MemoryQueryArgs {
    cwd: String,
    request: serde_json::Value,
}

/// Read-only Desktop bridge. Domain behavior remains in the Node MemoryService.
#[tauri::command]
fn query_memory(args: MemoryQueryArgs) -> Result<serde_json::Value, String> {
    let cwd = args.cwd.trim();
    if cwd.is_empty() {
        return Err("A project folder is required for memory exploration.".into());
    }
    let node = find_node().ok_or_else(|| "Node.js not found on PATH".to_string())?;
    let cli = resolve_cli_entry()?;
    let request = serde_json::to_string(&args.request)
        .map_err(|e| format!("Failed to encode memory request: {e}"))?;
    let raw = run_cli_capture(
        &node,
        &cli,
        &["--memory-json", request.as_str(), "--cwd", cwd],
    )?;
    parse_cli_json_stdout(&raw).ok_or_else(|| format!("Invalid JSON from memory service.\n{raw}"))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetConfigArgs {
    provider: Option<String>,
    model: Option<String>,
    endpoint: Option<String>,
    thinking: Option<String>,
    #[serde(default)]
    endpoint_clear: bool,
    verifier_provider: Option<String>,
    verifier_model: Option<String>,
    #[serde(default)]
    verifier_clear: bool,
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
    if let Some(t) = args
        .thinking
        .as_ref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
    {
        argv.push("--thinking".into());
        argv.push(t.to_string());
    }
    if args.endpoint_clear {
        argv.push("--endpoint-clear".into());
    }
    if let Some(vp) = args
        .verifier_provider
        .as_ref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
    {
        argv.push("--verifier-provider".into());
        argv.push(vp.to_string());
    }
    if let Some(vm) = args
        .verifier_model
        .as_ref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
    {
        argv.push("--verifier-model".into());
        argv.push(vm.to_string());
    }
    if args.verifier_clear {
        argv.push("--verifier-clear".into());
    }
    if argv.len() == 1 {
        return Err(
            "set_app_config: nothing to update — provide at least one of provider, model, endpoint, thinking, verifier provider+model, verifierClear, or endpointClear".into(),
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
struct LoginOAuthArgs {
    provider: String,
    code: Option<String>,
    #[serde(default)]
    no_browser: bool,
}

#[tauri::command]
fn login_oauth(args: LoginOAuthArgs) -> Result<serde_json::Value, String> {
    let node = find_node().ok_or_else(|| "Node.js not found on PATH".to_string())?;
    let cli = resolve_cli_entry()?;
    let provider = args.provider.trim();
    if provider.is_empty() {
        return Err("provider is required".into());
    }
    let mut argv: Vec<String> = vec![
        "--login-oauth".into(),
        "--provider".into(),
        provider.to_string(),
    ];
    if let Some(code) = args
        .code
        .as_ref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
    {
        argv.push("--code".into());
        argv.push(code.to_string());
    }
    if args.no_browser {
        argv.push("--no-browser".into());
    }
    let refs: Vec<&str> = argv.iter().map(|s| s.as_str()).collect();
    let raw = run_cli_capture(&node, &cli, &refs)?;
    parse_cli_json_stdout(&raw).ok_or_else(|| format!("Invalid login-oauth JSON:\n{raw}"))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProviderOnlyArgs {
    provider: String,
}

#[tauri::command]
fn refresh_oauth(args: ProviderOnlyArgs) -> Result<serde_json::Value, String> {
    let node = find_node().ok_or_else(|| "Node.js not found on PATH".to_string())?;
    let cli = resolve_cli_entry()?;
    let provider = args.provider.trim();
    if provider.is_empty() {
        return Err("provider is required".into());
    }
    let raw = run_cli_capture(&node, &cli, &["--refresh-oauth", "--provider", provider])?;
    parse_cli_json_stdout(&raw).ok_or_else(|| format!("Invalid refresh-oauth JSON:\n{raw}"))
}

#[tauri::command]
fn logout_oauth(args: ProviderOnlyArgs) -> Result<serde_json::Value, String> {
    let node = find_node().ok_or_else(|| "Node.js not found on PATH".to_string())?;
    let cli = resolve_cli_entry()?;
    let provider = args.provider.trim();
    if provider.is_empty() {
        return Err("provider is required".into());
    }
    let raw = run_cli_capture(&node, &cli, &["--logout-oauth", "--provider", provider])?;
    parse_cli_json_stdout(&raw).ok_or_else(|| format!("Invalid logout-oauth JSON:\n{raw}"))
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
    let output = cmd.output().map_err(|e| {
        let msg = format_cli_spawn_err(e);
        msg.replacen(
            "Failed to spawn zelari-code",
            "Failed to spawn discover-models",
            1,
        )
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
fn cancel_run(
    state: State<'_, Arc<RunRegistry>>,
    args: Option<CancelRunArgs>,
) -> Result<usize, String> {
    let n = state.cancel(args.and_then(|a| a.run_id).as_deref());
    if n == 0 {
        Err("No active run".into())
    } else {
        Ok(n)
    }
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CancelRunArgs {
    /// Cancel exactly this run; omit to cancel every active run (legacy).
    #[serde(default)]
    run_id: Option<String>,
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

    let parse_numstat =
        |out: &str, map: &mut std::collections::BTreeMap<String, GitFileChangeDto>| {
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
            if name.starts_with('.')
                && name != ".zelari"
                && name != ".claude"
                && name != ".opencode"
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
    /// Milliseconds since Unix epoch of the last modification (0 if unknown).
    /// Paired with `size` it lets TS pollers skip parse+setState when the
    /// file signature is unchanged.
    mtime_ms: u64,
}

/// t63: dedup registry for plan.json watchers (one thread per workspace).
struct PlanWatchRegistry {
    watched: std::sync::Mutex<std::collections::HashSet<String>>,
}

impl PlanWatchRegistry {
    fn new() -> Self {
        PlanWatchRegistry {
            watched: std::sync::Mutex::new(std::collections::HashSet::new()),
        }
    }
}

/// t63: arm a backend watcher over `<cwd>/.zelari/plan.json`.
///
/// Emits `plan-changed` `{cwd}` when the file signature (mtime+size)
/// changes, so the Project panel refreshes even while the window is
/// unfocused (out-of-band CLI/council writes — the focus reload cannot
/// see those until the user returns). Std-only poller (no new crates,
/// per repo conventions): one detached thread per distinct workspace,
/// deduped by canonical path via PlanWatchRegistry. The first read is a
/// baseline (no emit); deletions never emit (nothing to reload). The
/// payload carries the ORIGINAL cwd string so the frontend reloads the
/// exact key it knows (fs::canonicalize would return a \\?\ verbatim
/// prefix on Windows).
#[tauri::command]
fn watch_plan_changes(
    cwd: String,
    app: tauri::AppHandle,
    state: tauri::State<'_, std::sync::Arc<PlanWatchRegistry>>,
) -> Result<(), String> {
    use tauri::Emitter;
    let root = fs::canonicalize(&cwd).map_err(|e| format!("Cannot resolve cwd: {e}"))?;
    let key = root.display().to_string();
    {
        let mut guard = state.watched.lock().unwrap_or_else(|e| e.into_inner());
        if !guard.insert(key.clone()) {
            return Ok(()); // already watching this workspace
        }
    }
    let plan_path = root.join(".zelari").join("plan.json");
    std::thread::spawn(move || {
        let mut last: Option<(u64, u64)> = None;
        let mut primed = false;
        loop {
            let sig = fs::metadata(&plan_path).ok().and_then(|m| {
                let mt = m
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0);
                Some((mt, m.len()))
            });
            if !primed {
                last = sig;
                primed = true;
            } else if sig != last {
                if sig.is_some() {
                    let _ = app.emit(
                        "plan-changed",
                        serde_json::json!({ "cwd": cwd }),
                    );
                }
                last = sig;
            }
            std::thread::sleep(std::time::Duration::from_millis(1200));
        }
    });
    Ok(())
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
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    if meta.is_dir() {
        return Ok(ReadProjectTextDto {
            path: rel,
            absolute: abs.display().to_string(),
            is_dir: true,
            text: None,
            note: Some("directory — list/read with tools as needed".into()),
            size: 0,
            mtime_ms,
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
            mtime_ms,
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
            mtime_ms,
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
        mtime_ms,
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
    if let Some(cwd) = args
        .cwd
        .as_ref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
    {
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
    if let Some(cwd) = args
        .cwd
        .as_ref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
    {
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
    if let Some(cwd) = args
        .cwd
        .as_ref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
    {
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
    if let Some(cwd) = args
        .cwd
        .as_ref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
    {
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
    if let Some(cwd) = args
        .cwd
        .as_ref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
    {
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
    if let Some(cwd) = args
        .cwd
        .as_ref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
    {
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
    let raw = run_cli_capture(&node, &cli, &["--set-ssh-target", "--json", &args.json])?;
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
    let output = cmd.output().map_err(format_cli_spawn_err)?;
    let out = String::from_utf8_lossy(&output.stdout).to_string();
    if let Some(v) = parse_cli_json_stdout(&out) {
        return Ok(v);
    }
    let err = String::from_utf8_lossy(&output.stderr).to_string();
    Err(if !err.trim().is_empty() { err } else { out })
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
    let output = cmd.output().map_err(format_cli_spawn_err)?;
    let out = String::from_utf8_lossy(&output.stdout).to_string();
    if let Some(v) = parse_cli_json_stdout(&out) {
        return Ok(v);
    }
    let err = String::from_utf8_lossy(&output.stderr).to_string();
    Err(if !err.trim().is_empty() { err } else { out })
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

    let target = match args
        .path
        .as_ref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
    {
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

// Fields never read in Rust (mission_strict, verify_pack, verifier_review,
// bon_alpha, kraken_* overrides) stay part of the frontend command contract:
// they are consumed by serde and referenced in tests. Since the sidecar
// migration they are pinned at sidecar spawn (no per-run protocol field) —
// see harness_sidecar::spawn_generation and run_sidecar_turn.
#[allow(dead_code)]
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
    /// Conversation the run belongs to (multi-chat desktop). Stamped on
    /// every emitted event so the frontend can route without guessing.
    #[serde(default)]
    conversation_id: Option<String>,
    /// Optional working directory chosen via "Open Folder". Travels as
    /// `session.create { workspaceRoot }` on the shared `--serve-harness`
    /// sidecar (the child is spawned once without current_dir; the turn
    /// honors this via HeadlessOptions.cwd). None = inherit the Tauri
    /// process cwd.
    #[serde(default)]
    cwd: Option<String>,
    /// JSON-encoded AgentMessage[] of prior conversation turns, forwarded to
    /// the CLI as `--history <json>` so the agent keeps multi-turn context
    /// across the per-message process boundary. None/empty = stateless.
    #[serde(default)]
    history: Option<String>,
    /// JSON-encoded session todo list replayed across the per-message
    /// process boundary so `todo_read` returns the prior state (not empty).
    #[serde(default)]
    todos: Option<String>,
    /// 2.0 spine session id to resume (`--resume <id>`): the CLI continues
    /// the same event log and derives model context from it (ADR-0016/0021).
    /// The desktop captures it from the `session_started` NDJSON event on
    /// turn 1 and replays it on every following turn of the conversation.
    #[serde(default)]
    session_id: Option<String>,
    /// When true, dispatch via `--kraken-graph <prompt>` (plan + execute a
    /// parallel task DAG) instead of `--task <prompt>` — bypasses `mode`.
    #[serde(default)]
    kraken_graph: bool,
    /// When true, only plan the Kraken graph and write it to disk
    /// (`.zelari/radio/plan-<id>.json`) without executing — the desktop
    /// "plan" phase. Mutually exclusive with `run_plan`.
    #[serde(default)]
    plan_only: bool,
    /// Execute a previously saved plan by id (`--run-plan <id>`). The desktop
    /// "build" phase passes the id captured from the preceding plan-only run.
    #[serde(default)]
    run_plan: Option<String>,
    /// Capability profile forwarded as `--profile <id>` (ADR-0022).
    #[serde(default)]
    profile: Option<String>,
    /// Evidence gate: `--strict-done`.
    #[serde(default)]
    strict_done: bool,
    /// Mission/Zelari evidence gate. Missions are strict by default.
    #[serde(default = "default_true")]
    mission_strict: bool,
    /// Native criteria pack (typecheck/test/build when available).
    #[serde(default)]
    verify_pack: bool,
    /// Advisory verifier override. None preserves CLI automatic selection.
    #[serde(default)]
    verifier_review: Option<bool>,
    /// Experimental Best-of-N: sets ZELARI_EXPERIMENTAL=bon on the child.
    #[serde(default)]
    bon_alpha: bool,
    /// Host-driven Gauntlet loop (`--gauntlet` / ZELARI_GAUNTLET).
    #[serde(default)]
    gauntlet_loop: bool,
    /// Kraken explore tentacle model override. Empty / None = inherit.
    #[serde(default)]
    kraken_explore_model: Option<String>,
    /// Kraken general tentacle model override. Empty / None = inherit.
    #[serde(default)]
    kraken_general_model: Option<String>,
    /// Kraken verify tentacle model override. Empty / None = inherit.
    #[serde(default)]
    kraken_verify_model: Option<String>,
    /// Kraken Graph planner model override. Empty / None = inherit.
    #[serde(default)]
    kraken_planner_model: Option<String>,
    /// Kraken delegation policy (automatic|prefer|aggressive|lead-only). None / "automatic" = CLI default.
    #[serde(default)]
    kraken_delegation: Option<String>,
}

fn default_mode() -> String {
    "agent".into()
}
fn default_phase() -> String {
    "build".into()
}
fn default_true() -> bool {
    true
}

fn normalize_mode(mode: &str, council: bool) -> String {
    let m = mode.trim().to_lowercase();
    if council && (m.is_empty() || m == "agent" || m == "kraken") {
        return "council".into();
    }
    match m.as_str() {
        // Canonical single-agent surface is kraken; `agent` is a legacy alias.
        // Mapping kraken→agent made sidecar JSON skip Kraken playbooks
        // (gated on mode==="kraken") so Desktop ran lead-only.
        "kraken" | "agent" => "kraken".into(),
        "council" | "zelari" => m,
        _ => "kraken".into(),
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

/// Registry of live runs is kept in RunRegistry; control routing lives in
/// harness_sidecar (the sidecar transport owns the process stdin).
/// Write one NDJSON ControlEvent to a running run's harness session.
/// Accepts steer / follow_up / cancel — routed over the sidecar's
/// session-scoped protocol (session.steer / session.cancel). Resolves with
/// the harness result payload on success (the CLI answers a steer with
/// {accepted, outcome, controlId, controlType}; outcome "already_finished"
/// when no live turn exists). On CLI builds without those methods the typed
/// `unknown_method` error surfaces to the caller: visible, no crash, and
/// NEVER a fallback to a bare --headless spawn's stdin bridge.
#[tauri::command]
fn send_control(
    sidecar: State<'_, Arc<HarnessSidecar>>,
    run_id: String,
    event: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let obj = event.as_object().ok_or("control event must be a JSON object")?;
    let kind = obj.get("type").and_then(|v| v.as_str()).unwrap_or("");
    if kind.is_empty() {
        return Err("control event requires a \"type\" field".into());
    }
    if !matches!(kind, "steer" | "follow_up" | "cancel") {
        return Err(format!("unsupported control event type: {kind}"));
    }
    let id = obj.get("id").and_then(|v| v.as_str()).unwrap_or("");
    if id.is_empty() {
        return Err("control event requires an \"id\" field".into());
    }
    sidecar.steer_run(&run_id, &event)
}

#[tauri::command]
fn run_task(
    app: AppHandle,
    state: State<'_, Arc<RunRegistry>>,
    sidecar: State<'_, Arc<HarnessSidecar>>,
    args: RunTaskArgs,
) -> Result<String, String> {
    let prompt = args.prompt.trim().to_string();
    if prompt.is_empty() {
        return Err("Prompt is empty".into());
    }

    let mode = normalize_mode(&args.mode, args.council);
    let phase = normalize_phase(&args.phase);

    // Fail FAST with the same visible errors as before (the sidecar would
    // surface these too, but only after run-started — keep the early Err).
    find_node().ok_or_else(|| "Node.js not found on PATH".to_string())?;
    resolve_cli_entry()?;

    let run_id = format!(
        "run-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    );
    let conversation_id = args.conversation_id.clone().unwrap_or_default();
    let cwd_norm = normalize_cwd(args.cwd.as_deref());
    // Policy: max ONE active run per workspace (cwd) + global cap.
    let cancel_flag = state.register(&run_id, &conversation_id, &cwd_norm)?;

    let _ = app.emit(
        "run-started",
        RunStarted {
            run_id: run_id.clone(),
            conversation_id: conversation_id.clone(),
            cwd: cwd_norm.clone(),
            prompt: prompt.clone(),
            mode: mode.clone(),
            phase: phase.clone(),
        },
    );

    let registry = Arc::clone(&state);
    let sidecar = Arc::clone(&sidecar);
    let app_handle = app.clone();
    let run_id_thread = run_id.clone();
    let provider = args.provider;
    let model = args.model;
    let cwd = args.cwd;
    let history = args.history;
    let todos = args.todos;
    let session_id = args.session_id;
    let kraken_graph = args.kraken_graph;
    let plan_only = args.plan_only;
    let run_plan = args.run_plan;
    let profile = args.profile;
    let strict_done = args.strict_done;
    let gauntlet_loop = args.gauntlet_loop;
    let kraken_explore_model = args.kraken_explore_model;
    let kraken_general_model = args.kraken_general_model;
    let kraken_verify_model = args.kraken_verify_model;
    let kraken_planner_model = args.kraken_planner_model;
    let kraken_delegation = args.kraken_delegation;
    // mission_strict / verify_pack / verifier_review / bon_alpha remain
    // sidecar-spawn knobs (no run.turn field yet). Kraken tentacle routing
    // and delegation ARE per-turn — otherwise Desktop Settings are ignored.

    let env_ctx = RunEnvelopeCtx {
        run_id: run_id.clone(),
        conversation_id: conversation_id.clone(),
        cwd: cwd_norm.clone(),
    };

    thread::spawn(move || {
        let result = run_sidecar_turn(
            &app_handle,
            &sidecar,
            &cancel_flag,
            &env_ctx,
            &prompt,
            &mode,
            &phase,
            provider.as_deref(),
            model.as_deref(),
            cwd.as_deref(),
            history.as_deref(),
            todos.as_deref(),
            session_id.as_deref(),
            kraken_graph,
            plan_only,
            run_plan.as_deref(),
            profile.as_deref(),
            strict_done,
            gauntlet_loop,
            kraken_explore_model.as_deref(),
            kraken_general_model.as_deref(),
            kraken_verify_model.as_deref(),
            kraken_planner_model.as_deref(),
            kraken_delegation.as_deref(),
        );

        let (exit_code, cancelled) = match result {
            Ok(code) => (code, cancel_flag.load(Ordering::SeqCst)),
            Err(err) => {
                let _ = app_handle.emit(
                    "agent-event",
                    enveloped(
                        serde_json::json!({
                            "type": "error",
                            "message": err,
                        }),
                        &env_ctx,
                    ),
                );
                (2, cancel_flag.load(Ordering::SeqCst))
            }
        };

        let _ = app_handle.emit(
            "run-finished",
            RunFinished {
                run_id: run_id_thread.clone(),
                conversation_id: env_ctx.conversation_id.clone(),
                cwd: env_ctx.cwd.clone(),
                exit_code,
                cancelled,
            },
        );
        registry.remove(&run_id_thread);
    });

    Ok(run_id)
}

fn run_sidecar_turn(
    app: &AppHandle,
    sidecar: &Arc<HarnessSidecar>,
    cancel: &AtomicBool,
    envelope: &RunEnvelopeCtx,
    prompt: &str,
    mode: &str,
    phase: &str,
    provider: Option<&str>,
    model: Option<&str>,
    cwd: Option<&str>,
    history: Option<&str>,
    todos: Option<&str>,
    session_id: Option<&str>,
    kraken_graph: bool,
    plan_only: bool,
    run_plan: Option<&str>,
    profile: Option<&str>,
    strict_done: bool,
    gauntlet: bool,
    kraken_explore_model: Option<&str>,
    kraken_general_model: Option<&str>,
    kraken_verify_model: Option<&str>,
    kraken_planner_model: Option<&str>,
    kraken_delegation: Option<&str>,
) -> Result<i32, String> {
    // Sessions carry the workspace: today's spawn used current_dir(cwd); on
    // the shared sidecar the cwd travels as session.create's workspaceRoot
    // (the kernel keys per-workspace services — LSP, policy cache — by it).
    let workspace_root = match cwd.map(str::trim).filter(|c| !c.is_empty()) {
        Some(c) => c.to_string(),
        None => std::env::current_dir()
            .map(|p| p.display().to_string())
            .unwrap_or_else(|_| ".".into()),
    };

    // Turn input mirrors the CLI flags the old --headless spawn built
    // (HeadlessOptions shape — verified against src/cli/headless.ts):
    //   --task/--task-file      → task        (NDJSON stdin has NO Windows
    //                             ~32KB command-line ceiling, so the
    //                             tempfile spill is no longer needed)
    //   --mode/--phase          → mode/phase
    //   --provider/--model      → provider/model
    //   --profile               → profile
    //   --strict-done           → strictDone  (per-invocation env overlay,
    //                             H10: the sidecar inherits the CLI default
    //                             ON and the turn field wins when set)
    //   --gauntlet              → gauntlet
    //   --kraken-graph          → krakenGraph (+ planOnly / runPlan)
    //   --resume <id>           → resumeSessionId
    //   --history-file <json>   → history     (parsed array; invalid JSON is
    //                             ignored → stateless, same as the CLI)
    //   --todos <json>          → todos       (parsed array, same fallback)
    // Env-only knobs still pinned at sidecar spawn: bon_alpha, verify_pack,
    // verifier_review. Kraken tentacle models + delegation ARE per-turn.
    let mut input = serde_json::json!({
        "task": prompt,
        "mode": mode,
        "phase": phase,
        "strictDone": strict_done,
        "gauntlet": gauntlet,
    });
    if let Some(p) = provider.map(str::trim).filter(|p| !p.is_empty()) {
        input["provider"] = serde_json::json!(p);
    }
    if let Some(m) = model.map(str::trim).filter(|m| !m.is_empty()) {
        input["model"] = serde_json::json!(m);
    }
    if let Some(p) = profile.map(str::trim).filter(|p| !p.is_empty()) {
        input["profile"] = serde_json::json!(p);
    }
    if let Some(m) = kraken_explore_model.map(str::trim).filter(|m| !m.is_empty()) {
        input["krakenExploreModel"] = serde_json::json!(m);
    }
    if let Some(m) = kraken_general_model.map(str::trim).filter(|m| !m.is_empty()) {
        input["krakenGeneralModel"] = serde_json::json!(m);
    }
    if let Some(m) = kraken_verify_model.map(str::trim).filter(|m| !m.is_empty()) {
        input["krakenVerifyModel"] = serde_json::json!(m);
    }
    if let Some(m) = kraken_planner_model.map(str::trim).filter(|m| !m.is_empty()) {
        input["krakenPlannerModel"] = serde_json::json!(m);
    }
    if let Some(d) = kraken_delegation.map(str::trim).filter(|d| !d.is_empty()) {
        input["krakenDelegation"] = serde_json::json!(d);
    }
    if kraken_graph {
        // Plan + execute a Kraken task graph instead of a normal dispatch.
        input["krakenGraph"] = serde_json::json!(prompt);
        if plan_only {
            input["planOnly"] = serde_json::json!(true);
        }
        if let Some(id) = run_plan.map(str::trim).filter(|id| !id.is_empty()) {
            input["runPlan"] = serde_json::json!(id);
        }
    }
    if let Some(sid) = session_id.map(str::trim).filter(|s| !s.is_empty()) {
        // E1.4: resume the 2.0 spine session so model context comes from the
        // event log; also pre-binds sidecar event routing for this run.
        input["resumeSessionId"] = serde_json::json!(sid);
    }
    if let Some(h) = history.filter(|h| !h.is_empty()) {
        match serde_json::from_str::<serde_json::Value>(h) {
            Ok(v) if v.is_array() => {
                input["history"] = v;
            }
            _ => {} // Non-fatal: degrade to stateless (CLI parity).
        }
    }
    if let Some(t) = todos.filter(|t| !t.is_empty()) {
        match serde_json::from_str::<serde_json::Value>(t) {
            Ok(v) if v.is_array() => {
                input["todos"] = v;
            }
            _ => {} // Non-fatal: todos replay degrades to empty (CLI parity).
        }
    }

    sidecar.run_turn_full(
        app,
        &envelope.run_id,
        &workspace_root,
        session_id,
        input,
        cancel,
        &mut |value| {
            let _ = app.emit("agent-event", enveloped(value, envelope));
        },
    )
}


/// Desktop is authoritative: a value sets the env, inherit removes it
/// so a parent-shell override cannot leak into the child CLI.
pub(crate) fn set_optional_model_env(cmd: &mut Command, key: &str, value: Option<&str>) {
    match value.map(str::trim).filter(|v| !v.is_empty()) {
        Some(v) => {
            cmd.env(key, v);
        }
        None => {
            cmd.env_remove(key);
        }
    }
}

pub(crate) fn desktop_experimental_flags(existing: &str, bon_alpha: bool) -> String {
    let mut flags: Vec<String> = existing
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty() && !s.eq_ignore_ascii_case("bon"))
        .collect();
    if bon_alpha {
        flags.push("bon".into());
    }
    flags.join(",")
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
    let bind = state.bind.lock().unwrap_or_else(|e| e.into_inner()).clone();
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
    let message = if healthy {
        "Companion serve is reachable".into()
    } else if tracked {
        "Process started; waiting for /health…".into()
    } else {
        "Companion serve is stopped".into()
    };
    companion_status_from(bind, port, pid, running, healthy, message)
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
        .unwrap_or_else(|| "0.0.0.0".into());
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

    Ok(companion_status_from(
        bind,
        port,
        Some(pid),
        true,
        healthy,
        if healthy {
            "Companion serve started".into()
        } else {
            "Process launched; /health not ready yet — retry Status".into()
        },
    ))
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
        .manage(Arc::new(RunRegistry::default()))
        .manage(Arc::new(CompanionServeState::default()))
        .manage(Arc::new(HarnessSidecar::new()))
        .manage(Arc::new(PlanWatchRegistry::new()))
        .invoke_handler(tauri::generate_handler![
            get_cli_status,
            cli_doctor_check,
            get_app_config,
            query_memory,
            set_app_config,
            set_api_key,
            login_oauth,
            refresh_oauth,
            logout_oauth,
            discover_models,
            check_cli_update,
            update_cli,
            plugins_status,
            plugins_install,
            run_task,
            cancel_run,
            send_control,
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
            print_ssh_pubkey,
            watch_plan_changes
        ])
        .build(tauri::generate_context!())
        .expect("error while building Zelari Desktop")
        .run(|app_handle, event| {
            // Requirement 4 — the proof survives the UI. On app exit we do
            // NOT hard-kill the sidecar mid-write: shutdown() closes the
            // child's stdin, which is the protocol's graceful-shutdown
            // trigger — the server runs close() → kernel dispose(), which
            // awaits ALL pending completion-proof writes (never cancels
            // them) before services die. The wait is bounded (8s drain +
            // reap margin); only past that deadline does the supervisor
            // force-kill the tree (taskkill /T /F on Windows).
            if let tauri::RunEvent::Exit = event {
                app_handle.state::<Arc<HarnessSidecar>>().shutdown();
            }
        });
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
        let dir = std::env::temp_dir().join(format!("zelari-unwrap-test-{}", std::process::id()));
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
        let dir = std::env::temp_dir().join(format!("zelari-unwrap-parse-{}", std::process::id()));
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

    #[test]
    fn cmp_semver_release_outranks_matching_prerelease() {
        assert_eq!(cmp_semver("2.0.0-alpha.6", "2.0.0"), -1);
        assert_eq!(cmp_semver("2.0.0", "2.0.0-alpha.6"), 1);
        assert_eq!(cmp_semver("2.0.0", "2.0.0"), 0);
        assert_eq!(cmp_semver("2.0.0-alpha.6", "2.0.0-alpha.6"), 0);
    }

    #[test]
    fn cmp_semver_prerelease_order() {
        assert_eq!(cmp_semver("2.0.0-alpha.6", "2.0.0-alpha.7"), -1);
        assert_eq!(cmp_semver("2.0.0-alpha.7", "2.0.0-beta.1"), -1);
        assert_eq!(cmp_semver("1.46.1", "2.0.0"), -1);
        assert_eq!(cmp_semver("v2.0.0-alpha.6", "zelari-code v2.0.0"), -1);
    }

    #[test]
    fn desktop_run_defaults_keep_missions_strict_and_verifier_automatic() {
        let args: RunTaskArgs = serde_json::from_value(serde_json::json!({
            "prompt": "test"
        }))
        .unwrap();
        assert!(args.mission_strict);
        assert!(!args.strict_done);
        assert!(!args.verify_pack);
        assert_eq!(args.verifier_review, None);
        assert!(!args.gauntlet_loop);
        assert_eq!(args.kraken_explore_model, None);
        assert_eq!(args.kraken_general_model, None);
        assert_eq!(args.kraken_verify_model, None);
        assert_eq!(args.kraken_planner_model, None);
        assert_eq!(args.kraken_delegation, None);
    }

    fn env_value(cmd: &Command, key: &str) -> Option<Option<String>> {
        cmd.get_envs().find_map(|(k, v)| {
            if k.to_string_lossy() == key {
                Some(v.map(|s| s.to_string_lossy().into_owned()))
            } else {
                None
            }
        })
    }

    #[test]
    fn set_optional_model_env_sets_non_empty_and_removes_inherit() {
        let mut cmd = Command::new("echo");
        set_optional_model_env(&mut cmd, "ZELARI_KRAKEN_EXPLORE_MODEL", Some("model-a"));
        set_optional_model_env(&mut cmd, "ZELARI_KRAKEN_GENERAL_MODEL", Some("model-b"));
        set_optional_model_env(&mut cmd, "ZELARI_KRAKEN_VERIFY_MODEL", Some("model-c"));
        set_optional_model_env(&mut cmd, "ZELARI_KRAKEN_PLANNER_MODEL", Some("model-d"));
        set_optional_model_env(&mut cmd, "ZELARI_KRAKEN_DELEGATION", Some("prefer"));
        assert_eq!(
            env_value(&cmd, "ZELARI_KRAKEN_EXPLORE_MODEL").flatten().as_deref(),
            Some("model-a")
        );
        assert_eq!(
            env_value(&cmd, "ZELARI_KRAKEN_GENERAL_MODEL").flatten().as_deref(),
            Some("model-b")
        );
        assert_eq!(
            env_value(&cmd, "ZELARI_KRAKEN_VERIFY_MODEL").flatten().as_deref(),
            Some("model-c")
        );
        assert_eq!(
            env_value(&cmd, "ZELARI_KRAKEN_PLANNER_MODEL").flatten().as_deref(),
            Some("model-d")
        );
        assert_eq!(
            env_value(&cmd, "ZELARI_KRAKEN_DELEGATION").flatten().as_deref(),
            Some("prefer")
        );

        set_optional_model_env(&mut cmd, "ZELARI_KRAKEN_GENERAL_MODEL", None);
        set_optional_model_env(&mut cmd, "ZELARI_KRAKEN_EXPLORE_MODEL", Some("  "));
        assert_eq!(env_value(&cmd, "ZELARI_KRAKEN_GENERAL_MODEL"), Some(None));
        assert_eq!(env_value(&cmd, "ZELARI_KRAKEN_EXPLORE_MODEL"), Some(None));
    }

    #[test]
    fn desktop_run_deserializes_kraken_model_overrides() {
        let args: RunTaskArgs = serde_json::from_value(serde_json::json!({
            "prompt": "test",
            "krakenExploreModel": "fast-model",
            "krakenGeneralModel": "coding-model",
            "krakenVerifyModel": "review-model",
            "krakenPlannerModel": "planner-model",
            "krakenDelegation": "prefer"
        }))
        .unwrap();
        assert_eq!(args.kraken_explore_model.as_deref(), Some("fast-model"));
        assert_eq!(args.kraken_general_model.as_deref(), Some("coding-model"));
        assert_eq!(args.kraken_verify_model.as_deref(), Some("review-model"));
        assert_eq!(args.kraken_planner_model.as_deref(), Some("planner-model"));
        assert_eq!(args.kraken_delegation.as_deref(), Some("prefer"));
    }

    #[test]
    fn desktop_bon_switch_adds_and_removes_only_bon() {
        assert_eq!(desktop_experimental_flags("foo, BON,bar", false), "foo,bar");
        assert_eq!(desktop_experimental_flags("foo,bar", true), "foo,bar,bon");
        assert_eq!(desktop_experimental_flags("bon", true), "bon");
        assert_eq!(desktop_experimental_flags("", false), "");
    }
}
