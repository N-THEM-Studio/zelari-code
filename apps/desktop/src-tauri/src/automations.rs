//! automations — the OS scheduled job behind Settings → Automations.
//!
//! One command, three actions, three platforms:
//!   `invoke("manage_automation", { action: "register" | "remove" | "status",
//!     intervalMin, maxCostUsd, repoPath })`
//!   → `{ registered: bool, detail: string, nextRun: string | null }`
//!
//! Every backend drives the SAME job: the gardener — a propose-only
//! `--headless --once --mode zelari --phase plan` mission that fires only when
//! `scripts/zelari-gardener.sh` detects real work (failing tests, red CI, HEAD
//! drift, open plan tasks). A quiet repo exits 0 without spending anything.
//! Register is per-user and needs no elevation:
//!   - Windows: a MINUTE Trigger `schtasks` task `ZelariGardener` pointing at
//!     `<repo>\.zelari\gardener-task.cmd`;
//!   - macOS: a per-user LaunchAgent `com.zelari.gardener` at
//!     `~/Library/LaunchAgents/`, `StartInterval` in SECONDS, loaded with
//!     `launchctl`;
//!   - Linux: a tagged user-crontab line (`*/N * * * * … # ZelariGardener`)
//!     pointing at `<repo>/.zelari/gardener-task.sh`;
//!   - anything else: a typed Err, never a panic.
//!
//! Registration never puts the bash invocation on the scheduler command line.
//! Windows' `/TR` has a documented ~261 char limit and would need triple-nested
//! quoting (`cmd /C "set X=1&& "C:\Program Files\…\bash.exe" -c "…"`) which a
//! repo path containing a space does not survive; the unix backends have no
//! such constraint but reuse the same launcher so the budget/interpreter always
//! match the current Settings and the SCHEDULER ENTRY points at the launcher,
//! never at `scripts/` directly. The launcher resolves the script branch at RUN
//! time: a tree that later loses `scripts/zelari-gardener.sh` no-ops (logs and
//! exits 0) instead of falling back to a blind `--phase plan` that would spend
//! money every interval.
//!
//! Deliberate limits (documented, not accidental):
//!   - the job runs as the logged-on user only (no `/RU` password dance, no
//!     elevation, no `sudo`), so it is dormant while nobody is signed in — right
//!     for a desktop companion app;
//!   - removing the job leaves the launcher file on disk (regenerated on the next
//!     register; deleting files from the repo is not remove's job);
//!   - Linux Remove strips only lines carrying the `# ZelariGardener` tag, so the
//!     rest of the user's crontab is never touched.

#[cfg(any(windows, target_os = "macos", target_os = "linux", test))]
use std::path::Path;
// `Value` is the `manage_automation` return type on EVERY OS (the IPC entry is
// unconditionally compiled), so the parent module always needs it. `json!` is
// used only by the Windows backend here — the mac/linux submodules import their
// own copy — so it stays Windows-gated to avoid an unused-import warning.
use serde_json::Value;
#[cfg(windows)]
use serde_json::json;

// Shared by the Windows backend AND the shared unix plumbing (`prepare_repo` /
// `write_unix_launcher` below), so these must be in scope on mac/linux too — not
// Windows-only, or a unix build fails to compile (facts happened).
#[cfg(any(windows, target_os = "macos", target_os = "linux"))]
use std::fs;
#[cfg(any(windows, target_os = "macos", target_os = "linux"))]
use std::path::PathBuf;

#[cfg(windows)]
use std::process::{Command, Stdio};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// Name of the Windows scheduled task (what `schtasks /Query /TN` looks for).
#[cfg(windows)]
pub(crate) const TASK_NAME: &str = "ZelariGardener";

/// Tag appended to every crontab line we own. Remove strips only lines carrying
/// it — the rest of the user's crontab is never touched. Linux-only (plus tests):
/// launchd has no crontab, so gating it macos would only warn as dead code.
#[cfg(any(target_os = "linux", test))]
const CRON_TAG: &str = "# ZelariGardener";

/// launchd Label — also the LaunchAgent plist file stem. Used only by the macOS
/// backend (and its unit tests), so it is macOS-gated to keep a Linux build free
/// of dead-code warnings.
#[cfg(any(target_os = "macos", test))]
const LAUNCHD_LABEL: &str = "com.zelari.gardener";

/// Mirror of desktopPrefs.gardenerIntervalMin (the UI clamps too).
const MIN_INTERVAL_MIN: u32 = 5;
const MAX_INTERVAL_MIN: u32 = 1440;
/// Mirror of desktopPrefs.gardenerMaxCostUsd.
const MIN_MAX_COST_USD: f64 = 0.5;
const MAX_MAX_COST_USD: f64 = 20.0;
const DEFAULT_MAX_COST_USD: f64 = 2.0;

/// Hide the console window for the short-lived schtasks / where helpers.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// `scripts/zelari-gardener.sh` relative to the repo root (the work-detector).
const GARDENER_REL: &str = "scripts/zelari-gardener.sh";
/// Windows launcher written next to the gardener's own state (`.zelari/`).
#[cfg(windows)]
const LAUNCHER_REL: &str = ".zelari/gardener-task.cmd";
/// POSIX launcher, same `.zelari/` home (used only by the unix register paths).
#[cfg(any(target_os = "macos", target_os = "linux"))]
const UNIX_LAUNCHER_REL: &str = ".zelari/gardener-task.sh";

/// Clamp the per-run budget to the window both sides agree on, 2 decimals.
/// Non-finite input falls back to the default (2 USD) instead of poisoning the
/// launcher with `NaN`.
fn clamp_cost(value: f64) -> f64 {
    let v = if value.is_finite() { value } else { DEFAULT_MAX_COST_USD };
    let clamped = v.clamp(MIN_MAX_COST_USD, MAX_MAX_COST_USD);
    (clamped * 100.0).round() / 100.0
}

/// Interval must be inside the window; a sick caller gets a typed error rather
/// than a job that hammers the repo every minute.
fn validate_interval(value: u32) -> Result<u32, String> {
    if (MIN_INTERVAL_MIN..=MAX_INTERVAL_MIN).contains(&value) {
        Ok(value)
    } else {
        Err(format!(
            "intervalMin must be between {MIN_INTERVAL_MIN} and {MAX_INTERVAL_MIN} minutes (got {value})."
        ))
    }
}

/// Body of the Windows launcher `.cmd`. Pure so it can be unit-tested off-Windows:
/// quotes and the budget export live HERE, which is what keeps `/TR` short.
#[cfg(any(windows, test))]
fn launcher_script(bash: &Path, script: &Path, repo: &Path, max_cost_usd: f64) -> String {
    format!(
        "@echo off\r\n\
         rem Zelari gardener launcher — regenerated by Settings → Automations.\r\n\
         set ZELARI_MISSION_MAX_COST={:.2}\r\n\
         \"{}\" \"{}\" \"{}\"\r\n",
        clamp_cost(max_cost_usd),
        bash.display(),
        script.display(),
        repo.display()
    )
}

/// Body of the POSIX launcher `.zelari/gardener-task.sh`. Pure so it can be
/// unit-tested off-unix.
///
/// The launcher is deliberately dumb: it never falls back to a blind
/// `--phase plan` (that would spend money every interval on a quiet or
/// script-less tree). It execs the repo's own work-detecting gardener when it is
/// present, and otherwise logs one line (stderr + `.zelari/gardener.log`) and
/// exits 0. The branch is resolved at RUN time, so Register keeps working on a
/// tree that later loses `scripts/`.
#[cfg(any(target_os = "macos", target_os = "linux", test))]
fn unix_launcher_script(repo: &Path, max_cost_usd: f64) -> String {
    format!(
        "#!/usr/bin/env bash\n\
         # Zelari gardener launcher — regenerated by Settings → Automations.\n\
         # Runs the repo's work-detecting gardener when present; otherwise logs and exits 0.\n\
         set -u\n\
         export ZELARI_MISSION_MAX_COST=\"{:.2}\"\n\
         REPO=\"{}\"\n\
         SCRIPT=\"$REPO/{}\"\n\
         LOG=\"$REPO/.zelari/gardener.log\"\n\
         if [ -f \"$SCRIPT\" ]; then\n\
         exec bash \"$SCRIPT\" \"$REPO\"\n\
         fi\n\
         mkdir -p \"$(dirname \"$LOG\")\" 2>/dev/null || true\n\
         MSG=\"[gardener] launcher: $SCRIPT not found — nothing scheduled.\"\n\
         printf '%s %s\\n' \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\" \"$MSG\" >> \"$LOG\" 2>/dev/null || true\n\
         printf '%s %s\\n' \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\" \"$MSG\" >&2\n\
         exit 0\n",
        clamp_cost(max_cost_usd),
        repo.display(),
        GARDENER_REL,
    )
}

/// One crontab line: `*/N` minutes, running the generated launcher, tagged so
/// Remove strips exactly this line and nothing else. Linux-only (plus tests).
#[cfg(any(target_os = "linux", test))]
fn crontab_line(interval_min: u32, launcher: &Path) -> String {
    format!(
        "*/{} * * * * /bin/bash \"{}\" {}",
        interval_min,
        launcher.display(),
        CRON_TAG
    )
}

/// Remove every ZelariGardener-tagged line (and only those) from a crontab dump.
/// Linux-only (plus tests).
#[cfg(any(target_os = "linux", test))]
fn strip_tagged(existing: &str) -> String {
    let mut kept: Vec<&str> = existing.lines().filter(|l| !l.contains(CRON_TAG)).collect();
    while kept.last().map(|l| l.trim().is_empty()).unwrap_or(false) {
        kept.pop();
    }
    let mut out = kept.join("\n");
    if !out.is_empty() {
        out.push('\n');
    }
    out
}

/// Crontab body after a register: the user's other lines preserved, exactly one
/// ZelariGardener line (the new one). Linux-only (plus tests).
#[cfg(any(target_os = "linux", test))]
fn merge_crontab(existing: &str, new_line: &str) -> String {
    let mut out = strip_tagged(existing);
    out.push_str(new_line);
    out.push('\n');
    out
}

/// Linux-only (plus tests).
#[cfg(any(target_os = "linux", test))]
fn crontab_has_tag(existing: &str) -> bool {
    existing.lines().any(|l| l.contains(CRON_TAG))
}

/// Minimal XML escaping so a repo path containing `&`, `<` or `>` cannot corrupt
/// the plist. macOS-only (plus tests), like the plist it serves.
#[cfg(any(target_os = "macos", test))]
fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// Per-user LaunchAgent plist. `StartInterval` is the UI interval in SECONDS
/// (the UI is minutes: 30 → 1800). `ProgramArguments` runs the generated
/// launcher — never `scripts/` directly. macOS-only (plus tests).
#[cfg(any(target_os = "macos", test))]
fn launchd_plist(interval_min: u32, launcher: &Path, repo: &Path) -> String {
    let seconds = interval_min.saturating_mul(60);
    let repo_dir = xml_escape(&repo.display().to_string());
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
         <!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n\
         <plist version=\"1.0\">\n\
         <dict>\n\
         <key>Label</key>\n\
         <string>{label}</string>\n\
         <key>ProgramArguments</key>\n\
         <array>\n\
         <string>/bin/bash</string>\n\
         <string>{launcher}</string>\n\
         </array>\n\
         <key>StartInterval</key>\n\
         <integer>{seconds}</integer>\n\
         <key>RunAtLoad</key>\n\
         <false/>\n\
         <key>WorkingDirectory</key>\n\
         <string>{repo_dir}</string>\n\
         <key>StandardOutPath</key>\n\
         <string>{repo_dir}/.zelari/gardener.out.log</string>\n\
         <key>StandardErrorPath</key>\n\
         <string>{repo_dir}/.zelari/gardener.err.log</string>\n\
         </dict>\n\
         </plist>\n",
        label = LAUNCHD_LABEL,
        launcher = xml_escape(&launcher.display().to_string()),
        seconds = seconds,
        repo_dir = repo_dir,
    )
}

#[cfg(any(windows, target_os = "macos", target_os = "linux"))]
fn unknown_action(other: &str) -> String {
    format!("Unknown automation action '{other}' (expected register, remove or status).")
}

// ---------------------------------------------------------------------------
// Windows — schtasks (kept verbatim; TR-length and quoting tests pinned).
// ---------------------------------------------------------------------------

/// `Next Run Time` column of `schtasks /Query /FO CSV /V`.
///
/// Position-based on purpose: the header and the date format are localized, the
/// column order is not. Pure so it can be unit-tested off-Windows.
#[cfg(any(windows, test))]
fn parse_next_run(csv: &str) -> Option<String> {
    let mut lines = csv.lines().map(str::trim).filter(|l| !l.is_empty());
    lines.next()?; // header row
    let row = lines.next()?;
    let field = row.trim_matches('"').split("\",\"").nth(1)?;
    let cleaned = field.trim().trim_matches('"').to_string();
    if cleaned.is_empty() || cleaned.eq_ignore_ascii_case("N/A") {
        None
    } else {
        Some(cleaned)
    }
}

#[cfg(windows)]
fn hidden(cmd: &mut Command) -> &mut Command {
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

#[cfg(windows)]
fn run_schtasks(args: &[&str]) -> Result<std::process::Output, String> {
    hidden(Command::new("schtasks").args(args))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| format!("Failed to run schtasks: {e}"))
}

/// Exit code only — "not registered" is by far the usual non-zero here, and the
/// message text is localized.
#[cfg(windows)]
fn is_registered() -> bool {
    matches!(run_schtasks(&["/Query", "/TN", TASK_NAME]), Ok(out) if out.status.success())
}

/// Find a bash interpreter that can run the gardener script.
#[cfg(windows)]
fn find_bash() -> Result<PathBuf, String> {
    let fixed = [
        r"C:\Program Files\Git\bin\bash.exe",
        r"C:\Program Files (x86)\Git\bin\bash.exe",
    ];
    for candidate in fixed {
        let path = PathBuf::from(candidate);
        if path.is_file() {
            return Ok(path);
        }
    }
    if let Ok(out) = hidden(Command::new("where").arg("bash"))
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
    {
        if out.status.success() {
            if let Some(line) = String::from_utf8_lossy(&out.stdout)
                .lines()
                .map(str::trim)
                .find(|l| !l.is_empty())
            {
                let path = PathBuf::from(line);
                if path.is_file() {
                    return Ok(path);
                }
            }
        }
    }
    Err(
        "Git Bash not found — install Git for Windows, or put bash.exe on PATH. \
         (Checked C:\\Program Files\\Git\\bin\\bash.exe, C:\\Program Files (x86)\\Git\\bin\\bash.exe and `where bash`.)"
            .to_string(),
    )
}

#[cfg(windows)]
fn status() -> Result<Value, String> {
    let out = run_schtasks(&["/Query", "/TN", TASK_NAME, "/FO", "CSV", "/V"])?;
    if !out.status.success() {
        let code = out.status.code().unwrap_or(-1);
        return Ok(json!({
            "registered": false,
            "detail": format!("Not registered (schtasks /Query exit code {code})."),
            "nextRun": Value::Null,
        }));
    }
    let next = parse_next_run(&String::from_utf8_lossy(&out.stdout));
    let detail = match &next {
        Some(t) => format!("Registered — next run {t}."),
        None => "Registered (Task Scheduler reported no next run time).".to_string(),
    };
    Ok(json!({ "registered": true, "detail": detail, "nextRun": next }))
}

#[cfg(windows)]
fn register(interval_min: u32, max_cost_usd: f64, repo_path: &str) -> Result<Value, String> {
    let interval = validate_interval(interval_min)?;
    let cost = clamp_cost(max_cost_usd);

    let repo = repo_path.trim();
    if repo.is_empty() {
        return Err("No workspace folder — open the zelari-code repo before registering.".to_string());
    }
    let repo = PathBuf::from(repo);
    if !repo.is_dir() {
        return Err(format!("Workspace folder not found: {}", repo.display()));
    }

    let script = repo.join(GARDENER_REL);
    if !script.is_file() {
        return Err(format!(
            "Gardener script not found at {} — open the zelari-code repository as the workspace, then register.",
            script.display()
        ));
    }

    let bash = find_bash()?;
    let launcher = repo.join(LAUNCHER_REL);
    if let Some(parent) = launcher.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Could not create {}: {e}", parent.display()))?;
    }
    fs::write(&launcher, launcher_script(&bash, &script, &repo, cost))
        .map_err(|e| format!("Could not write {}: {e}", launcher.display()))?;

    let tr = format!("\"{}\"", launcher.display());
    let minutes = interval.to_string();
    let out = run_schtasks(&[
        "/Create", "/TN", TASK_NAME, "/SC", "MINUTE", "/MO", &minutes, "/F", "/TR", &tr,
    ])?;
    if !out.status.success() {
        return Err(format!("schtasks /Create failed: {}", combined(&out)));
    }

    let mut value = status()?;
    value["detail"] = json!(format!(
        "Registered — every {interval} min, budget cap ${cost:.2} per run (launcher: {}).",
        launcher.display()
    ));
    Ok(value)
}

#[cfg(windows)]
fn remove() -> Result<Value, String> {
    if !is_registered() {
        return Ok(json!({
            "registered": false,
            "detail": "Not registered — nothing to remove.",
            "nextRun": Value::Null,
        }));
    }
    let out = run_schtasks(&["/Delete", "/TN", TASK_NAME, "/F"])?;
    if !out.status.success() {
        let message = combined(&out);
        // Raced with something else deleting it: gone is gone.
        if message.to_ascii_lowercase().contains("cannot find") {
            return Ok(json!({
                "registered": false,
                "detail": "Removed (already gone).",
                "nextRun": Value::Null,
            }));
        }
        return Err(format!("schtasks /Delete failed: {message}"));
    }
    Ok(json!({
        "registered": false,
        "detail": "Removed — the task no longer runs.",
        "nextRun": Value::Null,
    }))
}

// ---------------------------------------------------------------------------
// Shared POSIX plumbing (macOS + Linux).
// ---------------------------------------------------------------------------

/// Collapse a process' stdout/stderr into one diagnostic line.
#[cfg(any(windows, target_os = "macos", target_os = "linux"))]
fn combined(out: &std::process::Output) -> String {
    let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
    match (stdout.is_empty(), stderr.is_empty()) {
        (false, false) => format!("{stdout} {stderr}"),
        (true, false) => stderr,
        (false, true) => stdout,
        (true, true) => format!("exit code {}", out.status.code().unwrap_or(-1)),
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn prepare_repo(repo_path: &str) -> Result<PathBuf, String> {
    let repo = repo_path.trim();
    if repo.is_empty() {
        return Err("No workspace folder — open the zelari-code repo before registering.".to_string());
    }
    let repo = PathBuf::from(repo);
    if !repo.is_dir() {
        return Err(format!("Workspace folder not found: {}", repo.display()));
    }
    Ok(repo)
}

/// Write `.zelari/gardener-task.sh` (chmod +x) and return its path. The
/// script-present vs missing-script branch is resolved at RUN time inside the
/// launcher, so a tree that loses `scripts/` no-ops instead of spending.
#[cfg(any(target_os = "macos", target_os = "linux"))]
fn write_unix_launcher(repo: &Path, max_cost_usd: f64) -> Result<PathBuf, String> {
    use std::os::unix::fs::PermissionsExt;
    let launcher = repo.join(UNIX_LAUNCHER_REL);
    if let Some(parent) = launcher.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Could not create {}: {e}", parent.display()))?;
    }
    fs::write(&launcher, unix_launcher_script(repo, max_cost_usd))
        .map_err(|e| format!("Could not write {}: {e}", launcher.display()))?;
    let mut perms = fs::metadata(&launcher)
        .map_err(|e| format!("Could not stat {}: {e}", launcher.display()))?
        .permissions();
    perms.set_mode(0o755);
    fs::set_permissions(&launcher, perms)
        .map_err(|e| format!("Could not chmod {}: {e}", launcher.display()))?;
    Ok(launcher)
}

// ---------------------------------------------------------------------------
// macOS — per-user LaunchAgent (launchctl, no admin).
// ---------------------------------------------------------------------------

#[cfg(target_os = "macos")]
mod macos {
    use super::{
        clamp_cost, combined, launchd_plist, prepare_repo, validate_interval, write_unix_launcher,
        LAUNCHD_LABEL,
    };
    use serde_json::{json, Value};
    use std::fs;
    use std::path::PathBuf;
    use std::process::{Command, Stdio};

    fn plist_path() -> Result<PathBuf, String> {
        let home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .filter(|p| p.is_dir())
            .ok_or_else(|| "Could not resolve $HOME for the LaunchAgents folder.".to_string())?;
        Ok(home
            .join("Library/LaunchAgents")
            .join(format!("{LAUNCHD_LABEL}.plist")))
    }

    fn launchctl(args: &[&str]) -> Result<std::process::Output, String> {
        Command::new("launchctl")
            .args(args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
            .map_err(|e| format!("Failed to run launchctl: {e}"))
    }

    pub fn status() -> Result<Value, String> {
        let plist = plist_path()?;
        if plist.is_file() {
            Ok(json!({
                "registered": true,
                "detail": format!("Registered — LaunchAgent {} (loaded via launchctl).", plist.display()),
                "nextRun": Value::Null,
            }))
        } else {
            Ok(json!({
                "registered": false,
                "detail": format!("Not registered — no LaunchAgent at {}.", plist.display()),
                "nextRun": Value::Null,
            }))
        }
    }

    pub fn register(interval_min: u32, max_cost_usd: f64, repo_path: &str) -> Result<Value, String> {
        let interval = validate_interval(interval_min)?;
        let cost = clamp_cost(max_cost_usd);
        let repo = prepare_repo(repo_path)?;
        let launcher = write_unix_launcher(&repo, cost)?;

        let plist = plist_path()?;
        if let Some(parent) = plist.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Could not create {}: {e}", parent.display()))?;
        }
        fs::write(&plist, launchd_plist(interval, &launcher, &repo))
            .map_err(|e| format!("Could not write {}: {e}", plist.display()))?;

        let plist_str = plist.display().to_string();
        // Unload first (ignore "not loaded"), then (re)load with -w.
        let _ = launchctl(&["unload", "-w", &plist_str]);
        let out = launchctl(&["load", "-w", &plist_str])?;
        if !out.status.success() {
            return Err(format!("launchctl load failed: {}", combined(&out)));
        }

        Ok(json!({
            "registered": true,
            "detail": format!(
                "Registered — every {interval} min (launchd StartInterval {}s), budget cap ${cost:.2} per run ({}).",
                interval.saturating_mul(60),
                plist.display()
            ),
            "nextRun": Value::Null,
        }))
    }

    pub fn remove() -> Result<Value, String> {
        let plist = plist_path()?;
        if !plist.is_file() {
            return Ok(json!({
                "registered": false,
                "detail": "Not registered — nothing to remove.",
                "nextRun": Value::Null,
            }));
        }
        let _ = launchctl(&["unload", "-w", &plist.display().to_string()]);
        fs::remove_file(&plist)
            .map_err(|e| format!("Could not remove {}: {e}", plist.display()))?;
        Ok(json!({
            "registered": false,
            "detail": "Removed — the LaunchAgent no longer runs.",
            "nextRun": Value::Null,
        }))
    }
}

// ---------------------------------------------------------------------------
// Linux — tagged user crontab lines.
// ---------------------------------------------------------------------------

#[cfg(target_os = "linux")]
mod linux {
    use super::{
        clamp_cost, combined, crontab_has_tag, crontab_line, merge_crontab, prepare_repo,
        strip_tagged, validate_interval, write_unix_launcher,
    };
    use serde_json::{json, Value};
    use std::io::Write;
    use std::process::{Command, Stdio};

    fn cron_missing() -> String {
        "The `crontab` binary was not found on PATH — install cron (e.g. `sudo apt install cron` \
         or `sudo dnf install cronie`) and make sure the service is running to schedule the gardener on Linux."
            .to_string()
    }

    /// `crontab -l` output. An empty crontab (exit 1 + "no crontab for …") is a
    /// normal "nothing to preserve", not an error.
    fn read_crontab() -> Result<String, String> {
        let out = Command::new("crontab")
            .arg("-l")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
            .map_err(|_| cron_missing())?;
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    }

    /// Replace the user's crontab with `body` (via `crontab -`).
    fn write_crontab(body: &str) -> Result<(), String> {
        let mut child = Command::new("crontab")
            .arg("-")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|_| cron_missing())?;
        child
            .stdin
            .take()
            .ok_or_else(|| "Could not open crontab stdin.".to_string())?
            .write_all(body.as_bytes())
            .map_err(|e| format!("Could not write to crontab: {e}"))?;
        let out = child
            .wait_with_output()
            .map_err(|e| format!("crontab failed: {e}"))?;
        if !out.status.success() {
            return Err(format!("crontab - failed: {}", combined(&out)));
        }
        Ok(())
    }

    pub fn status() -> Result<Value, String> {
        let existing = read_crontab()?;
        if crontab_has_tag(&existing) {
            Ok(json!({
                "registered": true,
                "detail": "Registered — ZelariGardener line present in the user crontab.",
                "nextRun": Value::Null,
            }))
        } else {
            Ok(json!({
                "registered": false,
                "detail": "Not registered — no ZelariGardener line in the user crontab.",
                "nextRun": Value::Null,
            }))
        }
    }

    pub fn register(interval_min: u32, max_cost_usd: f64, repo_path: &str) -> Result<Value, String> {
        let interval = validate_interval(interval_min)?;
        let cost = clamp_cost(max_cost_usd);
        let repo = prepare_repo(repo_path)?;
        let launcher = write_unix_launcher(&repo, cost)?;

        let line = crontab_line(interval, &launcher);
        let existing = read_crontab()?;
        write_crontab(&merge_crontab(&existing, &line))?;

        Ok(json!({
            "registered": true,
            "detail": format!(
                "Registered — cron `*/{interval} * * * * … # ZelariGardener`, budget cap ${cost:.2} per run."
            ),
            "nextRun": Value::Null,
        }))
    }

    pub fn remove() -> Result<Value, String> {
        let existing = read_crontab()?;
        if !crontab_has_tag(&existing) {
            return Ok(json!({
                "registered": false,
                "detail": "Not registered — nothing to remove.",
                "nextRun": Value::Null,
            }));
        }
        write_crontab(&strip_tagged(&existing))?;
        Ok(json!({
            "registered": false,
            "detail": "Removed — the ZelariGardener crontab line no longer runs.",
            "nextRun": Value::Null,
        }))
    }
}

// ---------------------------------------------------------------------------
// IPC entry point.
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn manage_automation(
    action: String,
    interval_min: u32,
    max_cost_usd: f64,
    repo_path: String,
) -> Result<Value, String> {
    let action = action.trim().to_ascii_lowercase();

    #[cfg(windows)]
    {
        match action.as_str() {
            "register" => register(interval_min, max_cost_usd, &repo_path),
            "remove" => remove(),
            "status" => status(),
            other => Err(unknown_action(other)),
        }
    }

    #[cfg(target_os = "macos")]
    {
        match action.as_str() {
            "register" => macos::register(interval_min, max_cost_usd, &repo_path),
            "remove" => macos::remove(),
            "status" => macos::status(),
            other => Err(unknown_action(other)),
        }
    }

    #[cfg(target_os = "linux")]
    {
        match action.as_str() {
            "register" => linux::register(interval_min, max_cost_usd, &repo_path),
            "remove" => linux::remove(),
            "status" => linux::status(),
            other => Err(unknown_action(other)),
        }
    }

    #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
    {
        let _ = (action, interval_min, max_cost_usd, repo_path);
        Err(format!(
            "Scheduled automations are supported on Windows (Task Scheduler), macOS (launchd) and Linux (cron); this build ({}) cannot register them.",
            std::env::consts::OS
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clamp_cost_holds_the_agreed_window() {
        assert_eq!(clamp_cost(2.0), 2.0);
        assert_eq!(clamp_cost(0.0), MIN_MAX_COST_USD);
        assert_eq!(clamp_cost(999.0), MAX_MAX_COST_USD);
        assert_eq!(clamp_cost(1.234), 1.23);
        assert_eq!(clamp_cost(f64::NAN), DEFAULT_MAX_COST_USD);
    }

    #[test]
    fn validate_interval_rejects_out_of_window() {
        assert_eq!(validate_interval(30).unwrap(), 30);
        assert_eq!(validate_interval(MIN_INTERVAL_MIN).unwrap(), MIN_INTERVAL_MIN);
        assert_eq!(validate_interval(MAX_INTERVAL_MIN).unwrap(), MAX_INTERVAL_MIN);
        assert!(validate_interval(0).is_err());
        assert!(validate_interval(MAX_INTERVAL_MIN + 1).is_err());
    }

    #[test]
    fn launcher_carries_budget_and_quoted_paths() {
        let body = launcher_script(
            Path::new(r"C:\Program Files\Git\bin\bash.exe"),
            Path::new(r"Z:\repo\scripts/zelari-gardener.sh"),
            Path::new(r"Z:\my repo"),
            2.5,
        );
        assert!(body.contains("@echo off"));
        assert!(body.contains("set ZELARI_MISSION_MAX_COST=2.50"));
        assert!(body.contains("\"C:\\Program Files\\Git\\bin\\bash.exe\""));
        assert!(body.contains("\"Z:\\repo\\scripts/zelari-gardener.sh\""));
        // The repo path is quoted, so a space cannot split it.
        assert!(body.contains("\"Z:\\my repo\""));
        // Clamped even when the caller asks for more than the cap.
        assert!(launcher_script(
            Path::new("bash"),
            Path::new("s.sh"),
            Path::new("r"),
            500.0
        )
        .contains("set ZELARI_MISSION_MAX_COST=20.00"));
    }

    #[test]
    fn launcher_stays_well_under_the_schtasks_tr_limit() {
        // Worst realistic case: long repo path inside Program Files.
        let launcher = Path::new(
            r"C:\Program Files\Zelari Code Examples\zelari-code\.zelari\gardener-task.cmd",
        );
        let tr = format!("\"{}\"", launcher.display());
        assert!(tr.len() < 261, "/TR would be {} chars", tr.len());
    }

    #[test]
    fn parse_next_run_reads_the_csv_column_and_tolerates_junk() {
        let csv = "\"TaskName\",\"Next Run Time\",\"Status\"\r\n\
                   \"\\ZelariGardener\",\"12/09/2026 10:30:00\",\"Ready\"\r\n";
        assert_eq!(
            parse_next_run(csv).as_deref(),
            Some("12/09/2026 10:30:00")
        );
        let none = "\"TaskName\",\"Next Run Time\"\r\n\"\\ZelariGardener\",\"N/A\"\r\n";
        assert_eq!(parse_next_run(none), None);
        assert_eq!(parse_next_run(""), None);
        assert_eq!(parse_next_run("\"only a header\"\r\n"), None);
    }

    // ---- unix launcher (macOS + Linux) ------------------------------------

    #[test]
    fn unix_launcher_runs_the_gardener_when_present() {
        let body = unix_launcher_script(Path::new("/home/u/proj"), 2.5);
        assert!(body.starts_with("#!/usr/bin/env bash"));
        assert!(body.contains("export ZELARI_MISSION_MAX_COST=\"2.50\""));
        // Script-present branch: exec the repo's OWN work-detector.
        assert!(body.contains("REPO=\"/home/u/proj\""));
        assert!(body.contains("SCRIPT=\"$REPO/scripts/zelari-gardener.sh\""));
        assert!(body.contains("if [ -f \"$SCRIPT\" ]; then"));
        assert!(body.contains("exec bash \"$SCRIPT\" \"$REPO\""));
    }

    #[test]
    fn unix_launcher_no_ops_without_the_script_and_never_spends() {
        let body = unix_launcher_script(Path::new("/home/u/proj"), 2.0);
        // Missing-script branch: log and exit 0.
        assert!(body.contains(".zelari/gardener.log"));
        assert!(body.contains("not found — nothing scheduled."));
        assert!(body.contains("exit 0"));
        // NEVER a blind plan-phase invoke — that would spend every interval.
        assert!(!body.contains("--phase plan"));
        assert!(!body.contains("zelari-code --headless"));
    }

    #[test]
    fn unix_launcher_quotes_a_repo_path_with_spaces() {
        let body = unix_launcher_script(Path::new("/home/u/my proj"), 2.0);
        assert!(body.contains("REPO=\"/home/u/my proj\""));
        assert!(body.contains("SCRIPT=\"$REPO/scripts/zelari-gardener.sh\""));
    }

    // ---- crontab (Linux) --------------------------------------------------

    #[test]
    fn crontab_line_is_minute_scheduled_and_tagged() {
        let line = crontab_line(30, Path::new("/repo/.zelari/gardener-task.sh"));
        assert_eq!(
            line,
            "*/30 * * * * /bin/bash \"/repo/.zelari/gardener-task.sh\" # ZelariGardener"
        );
        assert!(line.ends_with(CRON_TAG));
    }

    #[test]
    fn merge_crontab_preserves_foreign_lines_and_dedupes_ours() {
        let existing = "MAILTO=me@example.com\n\
                        0 8 * * * /home/u/bin/backup.sh\n\
                        */30 * * * * /bin/bash \"/old/gardener-task.sh\" # ZelariGardener\n";
        let line = crontab_line(60, Path::new("/repo/.zelari/gardener-task.sh"));
        let merged = merge_crontab(existing, &line);
        assert!(merged.contains("MAILTO=me@example.com"));
        assert!(merged.contains("/home/u/bin/backup.sh"));
        // The old tagged line is gone; exactly one (ours) remains.
        assert!(!merged.contains("/old/gardener-task.sh"));
        assert_eq!(merged.matches(CRON_TAG).count(), 1);
        assert!(merged.contains("*/60 * * * * /bin/bash \"/repo/.zelari/gardener-task.sh\" # ZelariGardener"));
        assert!(merged.ends_with('\n'));
    }

    #[test]
    fn merge_crontab_on_empty_crontab_yields_only_our_line() {
        let line = crontab_line(5, Path::new("/r/.zelari/gardener-task.sh"));
        assert_eq!(merge_crontab("", &line), format!("{line}\n"));
    }

    #[test]
    fn strip_tagged_removes_only_our_lines() {
        let existing = "0 8 * * * backup\n*/30 * * * * bash x # ZelariGardener\n17 3 * * 0 rotate\n";
        let stripped = strip_tagged(existing);
        assert!(stripped.contains("backup"));
        assert!(stripped.contains("rotate"));
        assert!(!stripped.contains(CRON_TAG));
        // Nothing foreign is dropped, and the file still ends in one newline.
        assert_eq!(stripped.matches('\n').count(), 2);
        assert!(stripped.ends_with('\n'));
    }

    #[test]
    fn crontab_has_tag_detects_registration() {
        assert!(crontab_has_tag("*/30 * * * * bash x # ZelariGardener\n"));
        assert!(!crontab_has_tag("*/30 * * * * bash x\n"));
        assert!(!crontab_has_tag(""));
    }

    // ---- launchd plist (macOS) -------------------------------------------

    #[test]
    fn launchd_plist_uses_seconds_and_points_at_the_launcher() {
        let plist = launchd_plist(
            30,
            Path::new("/Users/u/proj/.zelari/gardener-task.sh"),
            Path::new("/Users/u/proj"),
        );
        assert!(plist.contains("<key>Label</key>"));
        assert!(plist.contains(&format!("<string>{LAUNCHD_LABEL}</string>")));
        // ProgramArguments runs the generated launcher, never scripts/ directly.
        assert!(plist.contains("<key>ProgramArguments</key>"));
        assert!(plist.contains("<string>/Users/u/proj/.zelari/gardener-task.sh</string>"));
        assert!(!plist.contains("scripts/zelari-gardener.sh"));
        // StartInterval is SECONDS (30 min → 1800), never the raw minute count.
        assert!(plist.contains("<key>StartInterval</key>"));
        assert!(plist.contains("<integer>1800</integer>"));
        assert!(!plist.contains("<integer>30</integer>"));
        assert!(plist.contains("<key>RunAtLoad</key>"));
    }

    #[test]
    fn launchd_plist_escapes_xml_special_paths() {
        let plist = launchd_plist(
            5,
            Path::new("/home/a&b/.zelari/gardener-task.sh"),
            Path::new("/home/a&b"),
        );
        assert!(plist.contains("/home/a&amp;b/.zelari/gardener-task.sh"));
        assert!(!plist.contains("/home/a&b/"));
    }
}
