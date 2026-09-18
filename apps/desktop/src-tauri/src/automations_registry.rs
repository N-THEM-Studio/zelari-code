//! automations_registry — Desktop IPC over the `zelari-code automation` CLI.
//!
//! The registry itself lives in the CLI (`src/cli/automations`, ADR-0037). The
//! Desktop is deliberately a THIN, honest view: every command shells out to
//! `zelari-code automation <sub> --json` from the workspace dir the caller
//! passes, parses stdout as JSON, and surfaces stderr + exit code on failure.
//! No registry logic is duplicated here — the CLI stays the single source of
//! truth (the same reason `cli_doctor_check` shells out to `--doctor --json`).
//!
//! Contract (all return `Result<Value, String>`; a failure is a JSON string
//! `{"message":…,"exitCode":N}` so the UI can show the exact exit code):
//!   list_automations(repo_path)                    → `automation list --json`
//!   delete_automation(id, repo_path)               → `automation delete --id`
//!   manage_automation_schedule(id, action, repo)   → register|remove|status
//!   list_pending_approvals(repo_path)              → `automation pending --json`
//!   resolve_automation_approval(run_id, decision, edited_text, repo_path)
//!   run_automation_once(id, repo_path)             → `automation run --id --once`
//!   upsert_automation(spec_json, repo_path)        → `automation upsert --file <tmp> --json`
//!   automation_channel_login(channel, repo_path)   → `automation login <channel>`
//!   automation_channel_health(channel, repo_path)  → `automation health <channel> --json`
//!   list_automation_runs(automation_id, repo_path) → `automation runs --id <id> --json`
//!   manage_channel_credential(action, endpoint, secret, repo_path)
//!                                                  → `automation credential website … --json`
//!   automation_channel_probe(channel, repo_path)   → `automation probe <channel> --json`

use std::path::Path;
use std::process::Stdio;

use serde_json::{json, Value};

/// Resolve the CLI entry exactly the way every other command does.
fn cli_and_node() -> Result<(std::path::PathBuf, std::path::PathBuf), String> {
    let node = crate::find_node().ok_or_else(|| "Node.js not found on PATH".to_string())?;
    let cli = crate::resolve_cli_entry()?;
    Ok((node, cli))
}

/// Run `zelari-code automation <args>` in `repo_path`. Returns
/// `(exitCode, stdout, stderr)`; only a spawn failure is an Err here.
fn run_automation(repo_path: &str, args: &[&str]) -> Result<(i32, String, String), String> {
    let (node, cli) = cli_and_node()?;
    let cwd = repo_path.trim();
    let cwd = if cwd.is_empty() {
        None
    } else {
        Some(Path::new(cwd))
    };
    let mut cmd = crate::spawn_cli_base(&node, &cli, cwd);
    cmd.arg("automation");
    for a in args {
        cmd.arg(a);
    }
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    let output = cmd.output().map_err(crate::format_cli_spawn_err)?;
    Ok((
        output.status.code().unwrap_or(-1),
        String::from_utf8_lossy(&output.stdout).to_string(),
        String::from_utf8_lossy(&output.stderr).to_string(),
    ))
}

/// Structured failure: a JSON object so the UI can surface message + exit code.
fn cli_error(stderr: &str, stdout: &str, exit_code: i32) -> String {
    let message = if !stderr.trim().is_empty() {
        stderr.trim()
    } else if !stdout.trim().is_empty() {
        stdout.trim()
    } else {
        "zelari-code automation failed"
    };
    json!({ "message": message, "exitCode": exit_code }).to_string()
}

/// Last non-empty stdout line, trimmed — the CLI's human summary line.
fn last_line(stdout: &str) -> Option<String> {
    stdout
        .lines()
        .rev()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .map(str::to_string)
}

/// `automation <sub> --json`: Ok(parsed) when the exit code is one of `ok_codes`
/// AND stdout carries JSON; structured Err otherwise (tolerant parser: a leading
/// warning line still yields the payload). Exit 4 is the P1 "unproven" state, so
/// callers that tolerate it pass `&[0, 4]` (or `&[0, 1]` for a diagnostic probe).
fn run_json_allow(repo_path: &str, args: &[&str], ok_codes: &[i32]) -> Result<Value, String> {
    let mut with_flag: Vec<&str> = args.to_vec();
    with_flag.push("--json");
    let (code, out, err) = run_automation(repo_path, &with_flag)?;
    if !ok_codes.contains(&code) {
        return Err(cli_error(&err, &out, code));
    }
    crate::parse_cli_json_stdout(&out).ok_or_else(|| {
        json!({
            "message": format!("expected JSON from `automation {}` but got: {}", args.join(" "), out.trim()),
            "exitCode": code,
        })
        .to_string()
    })
}

/// The common case: only exit 0 is a success.
fn run_json(repo_path: &str, args: &[&str]) -> Result<Value, String> {
    run_json_allow(repo_path, args, &[0])
}

/// Plain (non-JSON) sub: Ok({exitCode, stdout}) on 0; structured Err otherwise.
fn run_plain(repo_path: &str, args: &[&str]) -> Result<Value, String> {
    let (code, out, err) = run_automation(repo_path, args)?;
    if code == 0 {
        Ok(json!({ "exitCode": code, "stdout": out.trim() }))
    } else {
        Err(cli_error(&err, &out, code))
    }
}

/// Exit 4 is the CLI's "unproven / needs attention" contract (P1), a NORMAL
/// outcome for run/approve — never a hard error. Only 1 (or spawn) is an Err.
fn run_tolerant(repo_path: &str, args: &[&str]) -> Result<Value, String> {
    let (code, out, err) = run_automation(repo_path, args)?;
    if code == 0 || code == 4 {
        Ok(json!({ "exitCode": code, "stdout": out.trim() }))
    } else {
        Err(cli_error(&err, &out, code))
    }
}

/// The `approve` decision flag. Pure so it is unit-tested.
fn approval_flag(decision: &str, edited_text: Option<&str>) -> Result<String, String> {
    match decision {
        "allow" => Ok("--allow".to_string()),
        "deny" => Ok("--deny".to_string()),
        "edit" => Ok(format!("--edit={}", edited_text.unwrap_or_default())),
        other => Err(format!("unknown approval decision: {other}")),
    }
}

#[tauri::command]
pub async fn list_automations(repo_path: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || run_json(&repo_path, &["list"]))
        .await
        .map_err(|e| format!("list_automations task failed: {e}"))?
}

#[tauri::command]
pub async fn delete_automation(id: String, repo_path: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || run_plain(&repo_path, &["delete", "--id", &id]))
        .await
        .map_err(|e| format!("delete_automation task failed: {e}"))?
}

#[tauri::command]
pub async fn manage_automation_schedule(
    id: String,
    action: String,
    repo_path: String,
) -> Result<Value, String> {
    let action = action.trim().to_ascii_lowercase();
    tauri::async_runtime::spawn_blocking(move || match action.as_str() {
        "register" | "remove" => run_plain(&repo_path, &[action.as_str(), "--id", &id]),
        "status" => run_json(&repo_path, &["status", "--id", &id]),
        other => Err(format!("unknown schedule action: {other}")),
    })
    .await
    .map_err(|e| format!("manage_automation_schedule task failed: {e}"))?
}

#[tauri::command]
pub async fn list_pending_approvals(repo_path: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || run_json(&repo_path, &["pending"]))
        .await
        .map_err(|e| format!("list_pending_approvals task failed: {e}"))?
}

#[tauri::command]
pub async fn resolve_automation_approval(
    run_id: String,
    decision: String,
    edited_text: Option<String>,
    repo_path: String,
) -> Result<Value, String> {
    let decision = decision.trim().to_ascii_lowercase();
    tauri::async_runtime::spawn_blocking(move || {
        let flag = approval_flag(&decision, edited_text.as_deref())?;
        run_tolerant(&repo_path, &["approve", &run_id, &flag])
    })
    .await
    .map_err(|e| format!("resolve_automation_approval task failed: {e}"))?
}

#[tauri::command]
pub async fn run_automation_once(id: String, repo_path: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        run_tolerant(&repo_path, &["run", "--id", &id, "--once"])
    })
    .await
    .map_err(|e| format!("run_automation_once task failed: {e}"))?
}

/// Flip one automation's `enabled` flag. Thin bridge over
/// `automation set-enabled --id <id> --value <bool> --json`; the reserved
/// `gardener` id is refused by the CLI (a structured Err carrying its code).
#[tauri::command]
pub async fn set_automation_enabled(
    id: String,
    enabled: bool,
    repo_path: String,
) -> Result<Value, String> {
    let value = if enabled { "true" } else { "false" };
    tauri::async_runtime::spawn_blocking(move || {
        run_json(&repo_path, &["set-enabled", "--id", &id, "--value", value])
    })
    .await
    .map_err(|e| format!("set_automation_enabled task failed: {e}"))?
}

/// Run one automation DETACHED from the Desktop: spawn
/// `automation run --id <id> --once` with stdin/stdout/stderr = null and return
/// `{"started": true}` immediately, WITHOUT waiting on the child (no
/// `.wait()`/`.status()`), so the run survives the Desktop closing. Real
/// progress is read back from the run history (`automation runs`), never here.
#[tauri::command]
pub async fn run_automation_headless(id: String, repo_path: String) -> Result<Value, String> {
    let (node, cli) = cli_and_node()?;
    let cwd = repo_path.trim();
    let cwd = if cwd.is_empty() {
        None
    } else {
        Some(Path::new(cwd))
    };
    let mut cmd = crate::spawn_cli_base(&node, &cli, cwd);
    cmd.arg("automation")
        .arg("run")
        .arg("--id")
        .arg(&id)
        .arg("--once");
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    // Spawn, then drop the handle: intentionally fire-and-forget.
    cmd.spawn().map_err(crate::format_cli_spawn_err)?;
    Ok(json!({ "started": true }))
}

/// Create/update an automation from a raw JSON spec. The spec is written to a
/// temp file (never interpolated into a shell) and passed as an ARG to the CLI,
/// then removed in EVERY case — success, CLI error, or bad JSON. Returns the
/// saved spec echoed by `automation upsert --json`.
#[tauri::command]
pub async fn upsert_automation(spec_json: String, repo_path: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let tmp = std::env::temp_dir().join(format!(
            "zelari-upsert-{}-{}.json",
            std::process::id(),
            ts
        ));
        std::fs::write(&tmp, spec_json.as_bytes())
            .map_err(|e| format!("cannot write temp spec: {e}"))?;
        let path = tmp.to_string_lossy().to_string();
        // Always clean up the temp file, whatever the CLI returns.
        let result = run_json(&repo_path, &["upsert", "--file", &path]);
        let _ = std::fs::remove_file(&tmp);
        result
    })
    .await
    .map_err(|e| format!("upsert_automation task failed: {e}"))?
}

/// Manual headed login on the channel's persistent browser profile. Exit 0 = ok,
/// 4 = window closed without a logged-in state (a VALID "unproven" outcome),
/// 1 = env error. Always returns `{ ok, message }`.
#[tauri::command]
pub async fn automation_channel_login(channel: String, repo_path: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (code, out, err) =
            run_automation(&repo_path, &["login", &channel, "--timeout-sec", "300"])?;
        match code {
            0 => Ok(json!({
                "ok": true,
                "message": last_line(&out).unwrap_or_else(|| format!("{channel}: logged in")),
            })),
            4 => Ok(json!({
                "ok": false,
                "message": last_line(&out)
                    .unwrap_or_else(|| format!("{channel}: login not confirmed")),
            })),
            other => Err(cli_error(&err, &out, other)),
        }
    })
    .await
    .map_err(|e| format!("automation_channel_login task failed: {e}"))?
}

/// Login-state probe for a channel (`automation health <ch> --json`). Exit 4
/// (relogin_required) is a VALID answer, not a failure. Prefer the CLI JSON
/// object; fall back to synthesizing `{ loggedIn: code == 0 }` if stdout is text.
#[tauri::command]
pub async fn automation_channel_health(channel: String, repo_path: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (code, out, err) = run_automation(&repo_path, &["health", &channel, "--json"])?;
        if code != 0 && code != 4 {
            return Err(cli_error(&err, &out, code));
        }
        if let Some(v) = crate::parse_cli_json_stdout(&out) {
            return Ok(v);
        }
        Ok(json!({
            "channel": channel,
            "loggedIn": code == 0,
            "exitCode": code,
            "message": last_line(&out).unwrap_or_default(),
        }))
    })
    .await
    .map_err(|e| format!("automation_channel_health task failed: {e}"))?
}

/// Recent runs of one automation (newest first) with the full evidence record —
/// timestamps, draft + provenance, approvals and per-channel posts. Thin bridge
/// over `automation runs --id <id> --json`.
#[tauri::command]
pub async fn list_automation_runs(automation_id: String, repo_path: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        run_json(&repo_path, &["runs", "--id", &automation_id])
    })
    .await
    .map_err(|e| format!("list_automation_runs task failed: {e}"))?
}

/// Store / show / remove the website webhook credential. Returns the CLI's
/// machine-readable `credential website --json` object (secret ALWAYS masked).
/// `secret` is optional for `store` — a blank one lets the CLI fall back to the
/// `ZELARI_WEBSITE_WEBHOOK_SECRET` env var.
#[tauri::command]
pub async fn manage_channel_credential(
    action: String,
    endpoint: Option<String>,
    secret: Option<String>,
    repo_path: String,
) -> Result<Value, String> {
    let action = action.trim().to_ascii_lowercase();
    tauri::async_runtime::spawn_blocking(move || {
        let mut args: Vec<&str> = vec!["credential", "website"];
        match action.as_str() {
            "store" => {
                let ep = endpoint.as_deref().map(str::trim).unwrap_or("");
                if ep.is_empty() {
                    return Err(cli_error(
                        "[automation credential] --endpoint <https-url> is required",
                        "",
                        1,
                    ));
                }
                args.push("--endpoint");
                args.push(ep);
                let sec = secret.as_deref().map(str::trim).unwrap_or("");
                if !sec.is_empty() {
                    args.push("--secret");
                    args.push(sec);
                }
            }
            "show" => args.push("--show"),
            "remove" => args.push("--remove"),
            other => return Err(format!("unknown credential action: {other}")),
        }
        run_json(&repo_path, &args)
    })
    .await
    .map_err(|e| format!("manage_channel_credential task failed: {e}"))?
}

/// Selector/session diagnostic for a social channel. Exit 1 is NOT an error here:
/// the probe returns a VALID report whose steps describe what failed, so we parse
/// the JSON for both 0 and 1 and only fail on a real spawn/env error.
#[tauri::command]
pub async fn automation_channel_probe(channel: String, repo_path: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        run_json_allow(&repo_path, &["probe", &channel], &[0, 1])
    })
    .await
    .map_err(|e| format!("automation_channel_probe task failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn approval_flag_maps_each_decision() {
        assert_eq!(approval_flag("allow", None).unwrap(), "--allow");
        assert_eq!(approval_flag("deny", None).unwrap(), "--deny");
        assert_eq!(approval_flag("edit", Some("hi")).unwrap(), "--edit=hi");
        assert_eq!(approval_flag("edit", None).unwrap(), "--edit=");
        assert!(approval_flag("nope", None).is_err());
    }

    #[test]
    fn cli_error_is_structured_json_with_exit_code() {
        let raw = cli_error("boom", "", 1);
        let v: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(v["message"], "boom");
        assert_eq!(v["exitCode"], 1);
    }

    #[test]
    fn cli_error_falls_back_to_stdout_then_generic() {
        let v: Value = serde_json::from_str(&cli_error("", "some stdout", 4)).unwrap();
        assert_eq!(v["message"], "some stdout");
        assert_eq!(v["exitCode"], 4);
        let v2: Value = serde_json::from_str(&cli_error("  ", "  ", 1)).unwrap();
        assert_eq!(v2["message"], "zelari-code automation failed");
    }
}
