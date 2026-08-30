//! harness_sidecar — ONE long-lived `zelari-code --serve-harness` child
//! (Pilastro B, desktop slice). Replaces spawn-per-run `--headless`: the
//! 4 parallel runs become 4 `session.create` sessions on a single NDJSON
//! stdio server.
//!
//! Wire contract (src/cli/serve/harnessServer.ts — headless protocol v2):
//!   → {"id":N,"method":"…","params":{…}}            one JSON object per line
//!   ← {"id":N,"ok":true,"result":{…}} | {"id":N,"ok":false,"error":{code,message}}
//!   ← {"type":"…"}                                   unsolicited events
//! Boot line: `protocol_info` (version 2, same envelope as `--headless`).
//! Methods used here: session.create {workspaceRoot} → {sessionId},
//! run.turn {sessionId, …HeadlessOptions} → {exitCode} (BrainEvents ride the
//! same stdout, written directly by runOneTurn), session.dispose, and — when
//! the CLI build has them (t32) — session.steer / session.cancel. Unknown
//! methods return the typed error `unknown_method`: steer/cancel degrade to
//! a VISIBLE typed error — never a crash and NEVER a silent fallback to a
//! bare `--headless` spawn.
//!
//! Event routing (multi-session over one stdout): every BrainEvent emitted
//! after the spine opens carries the SPINE `sessionId`; this module keeps a
//! spine→run map. Resumed runs pre-bind (resumeSessionId is known up front).
//! Fresh runs bind on their `session_started`: a startup slot serializes the
//! tiny pre-spine window so at most ONE fresh run is "awaiting" at a time,
//! making the bind deterministic. sessionId-less lines (early MCP setup
//! logs, control acks) go to the single active run when unambiguous,
//! otherwise they are broadcast to all active runs: duplicated setup logs
//! are cosmetic, a dropped error would not be. This is the documented
//! residue of the 1:1 mapping — the harness protocol stamps events with the
//! spine id, not with the harness session id.
//!
//! Lifecycle: lazy start on the first run; if the child dies unexpectedly it
//! is restarted with exponential backoff (0.5s→8s, MAX_RESTART_ATTEMPTS) and
//! every in-flight request fails with the typed error `sidecar_died`;
//! exhaustion emits `harness-sidecar-status` {status:"down"} and the next
//! run_task surfaces a typed Err. No `--headless` fallback anywhere.
//!
//! Shutdown (the proof survives the UI): closing the child's stdin IS the
//! protocol's graceful shutdown — runHarnessServer treats stdin 'end' as
//! close(), which awaits server.dispose(), which awaits ALL pending
//! completion-proof writes (never cancels them) before tearing services
//! down. We therefore drop stdin first and wait up to DRAIN_TIMEOUT (8s);
//! only past that deadline does the supervisor kill the tree (Windows:
//! taskkill /T /F via kill_child_tree).

use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

/// The CLI harness speaks headless protocol v2 (HEADLESS_PROTOCOL_VERSION in
/// src/cli/headless/protocol.ts). Verified on the boot line.
pub(crate) const HEADLESS_PROTOCOL_VERSION: u32 = 2;

/// Args after the JS entry. Without `--serve-harness` the child boots the
/// Ink TUI and stdout starts with PluginGate ("Checking for optional tool
/// plugins…") instead of `protocol_info` — the 2.16.0 Desktop regression.
pub(crate) const SIDECAR_CLI_ARGS: &[&str] = &["--serve-harness"];

/// One stdout line during the boot handshake.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum BootLine {
    ProtocolInfo(u32),
    /// Blank / whitespace-only — keep reading.
    Skip,
    /// Non-empty line that is not a `protocol_info` JSON object.
    Wrong(String),
}

/// Classify one stdout line as the harness boot handshake.
pub(crate) fn interpret_boot_line(raw: &str) -> BootLine {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return BootLine::Skip;
    }
    match serde_json::from_str::<Value>(trimmed) {
        Ok(v) if v.get("type").and_then(|t| t.as_str()) == Some("protocol_info") => {
            BootLine::ProtocolInfo(v.get("version").and_then(|x| x.as_u64()).unwrap_or(2) as u32)
        }
        _ => BootLine::Wrong(trimmed.chars().take(200).collect()),
    }
}

/// Bounded wait for the `protocol_info` boot line after spawn.
const BOOT_TIMEOUT: Duration = Duration::from_secs(20);
/// Bounded graceful-drain wait at app close (proof writes flush server-side)
/// before the forced tree kill. Deliberately generous (5-10s per spec).
const DRAIN_TIMEOUT: Duration = Duration::from_secs(8);
/// Poll quantum for cancel-aware waits (mirrors the old spawn_headless loop).
const POLL: Duration = Duration::from_millis(200);
/// Quick roundtrips (session.create / steer / cancel) ceiling.
const ROUNDTRIP_TIMEOUT: Duration = Duration::from_secs(30);
/// Restart backoff: 0.5s doubling capped at 8s, MAX_RESTART_ATTEMPTS tries.
const RESTART_BASE: Duration = Duration::from_millis(500);
const RESTART_CAP: Duration = Duration::from_secs(8);
const MAX_RESTART_ATTEMPTS: u32 = 5;
/// How long a fresh run may hold the startup slot waiting for its spine
/// `session_started` before falling back to unbound (broadcast) routing.
const SPINE_BIND_WAIT: Duration = Duration::from_secs(30);
/// After a cooperative cancel is delivered, how long we keep waiting for the
/// run.turn settlement before giving up on it (visible typed error).
const CANCEL_GRACE: Duration = Duration::from_secs(30);

/// Typed protocol/transport error. `code` mirrors the server error codes
/// (bad_json · bad_request · unknown_method · unknown_session ·
/// method_failed) plus client-side codes (sidecar_died · sidecar_down ·
/// transport_closed · cancel_timeout · timeout).
#[derive(Debug, Clone)]
pub(crate) struct HarnessError {
    pub code: String,
    pub message: String,
}

impl HarnessError {
    fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
        }
    }

    /// True when the running CLI build predates session.steer/session.cancel.
    pub(crate) fn is_unknown_method(&self) -> bool {
        self.code == "unknown_method"
    }
}

impl std::fmt::Display for HarnessError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

/// One sidecar process generation. The supervisor thread owns the `Child`
/// (it is the only reaper); everything else is shared through this handle.
struct ProcState {
    /// Kept for the boot-timeout killer (taskkill by PID).
    pid: u32,
    /// `Some` while the pipe is open. Taking/Dropping it sends EOF to the
    /// server — the protocol's graceful-shutdown trigger (drains pending
    /// completion-proof writes via server.dispose()).
    stdin: Mutex<Option<ChildStdin>>,
    /// In-flight requests by envelope id.
    pending: Mutex<HashMap<u64, Sender<Result<Value, HarnessError>>>>,
    /// Signalled exactly once after this generation's stdout EOF is reaped.
    done: Mutex<Receiver<()>>,
}

/// An in-flight request: registration handle for timeout/cancel cleanup.
struct InFlight {
    proc: Arc<ProcState>,
    id: u64,
    rx: Receiver<Result<Value, HarnessError>>,
}

impl InFlight {
    fn detach(self) {
        self.proc
            .pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.id);
    }

    fn wait_timeout(self, timeout: Duration) -> Result<Value, HarnessError> {
        match self.rx.recv_timeout(timeout) {
            Ok(res) => res,
            Err(RecvTimeoutError::Timeout) => {
                let err = HarnessError::new("timeout", "harness request timed out");
                self.detach();
                Err(err)
            }
            Err(RecvTimeoutError::Disconnected) => Err(HarnessError::new(
                "sidecar_died",
                "harness sidecar exited while the request was in flight",
            )),
        }
    }

    /// Poll-style wait used by the turn loop: never blocks longer than POLL.
    fn poll(&self) -> Option<Result<Value, HarnessError>> {
        match self.rx.try_recv() {
            Ok(res) => Some(res),
            Err(mpsc::TryRecvError::Empty) => None,
            Err(mpsc::TryRecvError::Disconnected) => Some(Err(HarnessError::new(
                "sidecar_died",
                "harness sidecar exited while the turn was running",
            ))),
        }
    }
}

/// Manager for the single sidecar + run routing tables. Managed as Tauri
/// state (`Arc<HarnessSidecar>`).
pub(crate) struct HarnessSidecar {
    proc: Mutex<Option<Arc<ProcState>>>,
    /// Serializes process spawn/restart across threads (ensure_started and
    /// the supervisor-restart path both take it).
    spawn_lock: Mutex<()>,
    next_id: AtomicU64,
    shutting_down: AtomicBool,
    app: Mutex<Option<AppHandle>>,
    /// spine sessionId → run_id (learned from session_started / pre-bound
    /// for --resume runs). Kept after turn end so late events still route.
    spine_routes: Mutex<HashMap<String, String>>,
    /// run_id → harness sessionId (steer/cancel targeting).
    run_sessions: Mutex<HashMap<String, String>>,
    /// run_id → live BrainEvent sink (the run thread forwards to the UI).
    sinks: Mutex<HashMap<String, Sender<Value>>>,
    /// Fresh (non-resumed) runs awaiting their spine binding, FIFO.
    awaiting_spine: Mutex<Vec<String>>,
    /// One-shot bind notification per awaiting fresh run.
    bind_notify: Mutex<HashMap<String, Sender<()>>>,
    /// Startup slot: at most one fresh run between "run.turn sent" and
    /// "spine bound", so session_started binding stays deterministic.
    fresh_slot: Mutex<()>,
}

impl HarnessSidecar {
    pub(crate) fn new() -> Self {
        Self {
            proc: Mutex::new(None),
            spawn_lock: Mutex::new(()),
            next_id: AtomicU64::new(1),
            shutting_down: AtomicBool::new(false),
            app: Mutex::new(None),
            spine_routes: Mutex::new(HashMap::new()),
            run_sessions: Mutex::new(HashMap::new()),
            sinks: Mutex::new(HashMap::new()),
            awaiting_spine: Mutex::new(Vec::new()),
            bind_notify: Mutex::new(HashMap::new()),
            fresh_slot: Mutex::new(()),
        }
    }

    /// The status event needs an AppHandle; commands stash theirs here
    /// (idempotent — every run_task passes the same handle).
    pub(crate) fn set_app_handle(&self, app: AppHandle) {
        let mut guard = self.app.lock().unwrap_or_else(|e| e.into_inner());
        if guard.is_none() {
            *guard = Some(app);
        }
    }

    fn emit_status(&self, status: &str, message: &str) {
        let guard = self.app.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(app) = guard.as_ref() {
            // Forward-compatible informational channel: the frontend has no
            // listener yet unless one is added later (non-breaking).
            let _ = app.emit(
                "harness-sidecar-status",
                json!({ "status": status, "message": message }),
            );
        }
    }

    /// Visible failure surface: the sidecar must be up before any turn.
    /// Errors bubble to run_task as typed Errs — NO --headless fallback.
    pub(crate) fn ensure_started(self: &Arc<Self>) -> Result<(), String> {
        if self.shutting_down.load(Ordering::SeqCst) {
            return Err("harness sidecar is shutting down".into());
        }
        {
            let proc = self.proc.lock().unwrap_or_else(|e| e.into_inner());
            if proc.is_some() {
                return Ok(());
            }
        }
        let _guard = self.spawn_lock.lock().unwrap_or_else(|e| e.into_inner());
        // Double-check under the lock (a supervisor restart may have won).
        {
            let proc = self.proc.lock().unwrap_or_else(|e| e.into_inner());
            if proc.is_some() {
                return Ok(());
            }
        }
        self.spawn_generation()
    }

    /// Spawn one child generation + supervisor thread. Caller holds
    /// spawn_lock. Returns once the boot line arrived (or visibly Err).
    fn spawn_generation(self: &Arc<Self>) -> Result<(), String> {
        let node = crate::find_node().ok_or_else(|| "Node.js not found on PATH".to_string())?;
        let cli = crate::resolve_cli_entry()?;
        let mut cmd = crate::spawn_cli_base(&node, &cli, None);
        cmd.args(SIDECAR_CLI_ARGS);
        // The transport owns stdin: NDJSON requests flow in here (the base
        // helper nulls stdin for one-shot captures — override for streaming).
        cmd.stdin(Stdio::piped());
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());
        // Sidecar-granular environment (set ONCE at spawn — these knobs
        // cannot vary per turn on a shared process; per-turn variance is
        // expressed through run.turn input fields wherever the protocol
        // exposes one: provider, model, profile, gauntlet, graph, resume…):
        // - memory panel on (same as the old per-run default);
        // - strict_done is NO LONGER pinned: the sidecar inherits the CLI
        //   default (ON, ADR-0025 — W6/t46 flip after QA t21) and the
        //   per-turn `strictDone` field wins via the per-invocation env
        //   overlay (H10). Missions strict / verify pack off still mirror
        //   the CLI defaults (belt-and-suspenders; no protocol field).
        cmd.env("ZELARI_MEMORY_V2", "1");
        // Belt-and-suspenders with `--serve-harness`: the CLI also keys off
        // this env so a stale Desktop binary that omits the flag still
        // starts the NDJSON server instead of the TUI.
        cmd.env("ZELARI_SERVE_HARNESS", "1");
        cmd.env("ZELARI_MISSION_STRICT", "1");
        cmd.env("ZELARI_VERIFY_PACK", "0");
        cmd.env("ZELARI_GAUNTLET", "0");
        // Experimental flags: same computation the per-run path did with
        // bon_alpha=false (strip bon). A per-run bon_alpha=true has no
        // protocol field — pinned off for the sidecar's lifetime (documented).
        cmd.env(
            "ZELARI_EXPERIMENTAL",
            crate::desktop_experimental_flags(
                &std::env::var("ZELARI_EXPERIMENTAL").unwrap_or_default(),
                false,
            ),
        );
        // Kraken model-routing envs are per-run today; the harness protocol
        // has no turn field for them, so pin them to CLI defaults for the
        // sidecar's lifetime (same removal the per-run path did when no
        // override was set). Documented limitation.
        crate::set_optional_model_env(&mut cmd, "ZELARI_KRAKEN_EXPLORE_MODEL", None);
        crate::set_optional_model_env(&mut cmd, "ZELARI_KRAKEN_GENERAL_MODEL", None);
        crate::set_optional_model_env(&mut cmd, "ZELARI_KRAKEN_VERIFY_MODEL", None);
        crate::set_optional_model_env(&mut cmd, "ZELARI_KRAKEN_PLANNER_MODEL", None);
        crate::set_optional_model_env(&mut cmd, "ZELARI_KRAKEN_DELEGATION", None);

        let mut child = cmd.spawn().map_err(crate::format_cli_spawn_err)?;
        let pid = child.id();
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "harness sidecar: no stdin".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "harness sidecar: no stdout".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "harness sidecar: no stderr".to_string())?;

        let (done_tx, done_rx) = mpsc::channel::<()>();
        let proc = Arc::new(ProcState {
            pid,
            stdin: Mutex::new(Some(stdin)),
            pending: Mutex::new(HashMap::new()),
            done: Mutex::new(done_rx),
        });
        {
            let mut guard = self.proc.lock().unwrap_or_else(|e| e.into_inner());
            *guard = Some(Arc::clone(&proc));
        }

        // stderr drain: a full pipe would deadlock the child; lines surface
        // as harness-sidecar-log events (visible, not attached to any run).
        {
            let app = self.app.lock().unwrap_or_else(|e| e.into_inner()).clone();
            thread::spawn(move || {
                let reader = BufReader::new(stderr);
                for line in reader.lines().map_while(Result::ok) {
                    let trimmed = line.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    if let Some(app) = app.as_ref() {
                        let _ = app.emit("harness-sidecar-log", json!({ "line": trimmed }));
                    }
                }
            });
        }

        // Supervisor: owns the Child; handshake → stream pump → reap →
        // (on unexpected death only) restart with backoff.
        let (boot_tx, boot_rx) = mpsc::channel::<Result<u32, String>>();
        {
            let me = Arc::clone(self);
            let proc = Arc::clone(&proc);
            thread::spawn(move || {
                supervise_child(me, child, stdout, proc, boot_tx, done_tx);
            });
        }
        match boot_rx.recv_timeout(BOOT_TIMEOUT) {
            Ok(Ok(version)) => {
                if version < HEADLESS_PROTOCOL_VERSION {
                    self.emit_status(
                        "ready",
                        &format!(
                            "harness sidecar speaks protocol v{version} (expected \
                             v{HEADLESS_PROTOCOL_VERSION}); session controls may be unavailable"
                        ),
                    );
                } else {
                    self.emit_status("ready", "harness sidecar ready");
                }
                Ok(())
            }
            Ok(Err(msg)) => {
                self.fail_and_clear_proc(&proc, &msg);
                Err(msg)
            }
            Err(_) => {
                // Boot watchdog inline: kill by PID so the supervisor's
                // read_line sees EOF and reaps; failure stays visible.
                let msg = "harness sidecar did not send the protocol_info boot line in time";
                self.fail_and_clear_proc(&proc, msg);
                kill_pid_tree(proc.pid);
                Err(msg.to_string())
            }
        }
    }

    fn fail_and_clear_proc(&self, proc: &Arc<ProcState>, msg: &str) {
        fail_pending(&proc.pending, "sidecar_died", msg);
        {
            let mut guard = self.proc.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(current) = guard.as_ref() {
                if Arc::ptr_eq(current, proc) {
                    *guard = None;
                }
            }
        }
        self.emit_status("down", msg);
    }

    // ------------------------------------------------------------------
    // Request plumbing
    // ------------------------------------------------------------------

    fn write_request(&self, method: &str, params: Value) -> Result<InFlight, HarnessError> {
        let proc = self
            .proc
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .map(Arc::clone)
            .ok_or_else(|| HarnessError::new("sidecar_down", "harness sidecar is not running"))?;
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = mpsc::channel::<Result<Value, HarnessError>>();
        proc.pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(id, tx);
        let line = json!({ "id": id, "method": method, "params": params }).to_string();
        let mut stdin_guard = proc.stdin.lock().unwrap_or_else(|e| e.into_inner());
        let write_res = match stdin_guard.as_mut() {
            Some(stdin) => stdin
                .write_all(line.as_bytes())
                .and_then(|_| stdin.write_all(b"\n"))
                .and_then(|_| stdin.flush()),
            None => Err(std::io::Error::other("stdin closed (draining)")),
        };
        drop(stdin_guard);
        match write_res {
            Ok(()) => Ok(InFlight { proc, id, rx }),
            Err(e) => {
                proc.pending
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .remove(&id);
                Err(HarnessError::new(
                    "transport_closed",
                    format!("harness sidecar stdin write failed: {e}"),
                ))
            }
        }
    }

    fn roundtrip(&self, method: &str, params: Value) -> Result<Value, HarnessError> {
        self.write_request(method, params)?
            .wait_timeout(ROUNDTRIP_TIMEOUT)
    }

    // ------------------------------------------------------------------
    // Turn orchestration (runs on the run_task worker thread)
    // ------------------------------------------------------------------

    /// Long-running turn request: polls the response so the cancel flag and
    /// the event pump stay live (thinking phases can be silent for minutes —
    /// same reason the old spawn_headless polled with recv_timeout).
    fn long_turn(
        &self,
        session_id: &str,
        turn_input: Value,
        cancel: &AtomicBool,
        on_tick: &mut dyn FnMut(),
    ) -> Result<Value, HarnessError> {
        let in_flight = self.write_request("run.turn", turn_input)?;
        let mut cancel_delivered = false;
        let mut cancel_deadline: Option<Instant> = None;
        loop {
            if let Some(result) = in_flight.poll() {
                return result;
            }
            on_tick();
            if cancel.load(Ordering::SeqCst) {
                if !cancel_delivered {
                    cancel_delivered = true;
                    // Cooperative cancel via the session-scoped control plane.
                    // A t32-less CLI answers unknown_method: surface it, keep
                    // streaming, bound the wait — never fake success.
                    match self.roundtrip(
                        "session.cancel",
                        json!({ "sessionId": session_id, "reason": "user" }),
                    ) {
                        Ok(_) => {
                            cancel_deadline = Some(Instant::now() + CANCEL_GRACE);
                        }
                        Err(err) => {
                            cancel_deadline = Some(Instant::now() + CANCEL_GRACE);
                            on_tick();
                            // The error is reported by the caller from the
                            // final Result; keep waiting for natural end.
                            let _ = err;
                        }
                    }
                }
                if let Some(deadline) = cancel_deadline {
                    if Instant::now() >= deadline {
                        in_flight.detach();
                        return Err(HarnessError::new(
                            "cancel_timeout",
                            "turn did not settle after session.cancel",
                        ));
                    }
                }
            }
            thread::sleep(POLL);
        }
    }

    /// Full session flow for one desktop run: session.create → routing
    /// setup → run.turn (streaming events) → cleanup. Returns the turn
    /// exit code. `resume_spine` pre-binds routing for --resume runs.
    ///
    /// Mapping note (requirement 2): the desktop RunTaskArgs map onto
    /// HeadlessOptions turn fields 1:1 for task/mode/phase/provider/model/
    /// profile/gauntlet/krakenGraph/planOnly/runPlan/resumeSessionId/history/
    /// todos; env-only per-run knobs (bon_alpha, kraken_* model overrides,
    /// verify_pack, verifier_review) have NO protocol field and are pinned
    /// at sidecar spawn (documented limitation).
    pub(crate) fn run_turn_full(
        self: &Arc<Self>,
        app: &AppHandle,
        run_id: &str,
        workspace_root: &str,
        resume_spine: Option<&str>,
        mut turn_input: Value,
        cancel: &AtomicBool,
        on_event: &mut dyn FnMut(Value),
    ) -> Result<i32, String> {
        self.set_app_handle(app.clone());
        self.ensure_started()
            .map_err(|e| format!("harness sidecar unavailable: {e}"))?;

        // 4 parallel runs = 4 sessions on the ONE sidecar; the cwd travels
        // as the session's workspaceRoot (verified: session.create takes
        // {workspaceRoot} and the kernel keys per-workspace services by it).
        let created = self
            .roundtrip("session.create", json!({ "workspaceRoot": workspace_root }))
            .map_err(|e| e.to_string())?;
        let session_id = created
            .get("sessionId")
            .and_then(|s| s.as_str())
            .ok_or_else(|| "harness sidecar returned no sessionId from session.create".to_string())?
            .to_string();
        self.run_sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(run_id.to_string(), session_id.clone());

        // Routing setup. Resumed runs know their spine id up front; fresh
        // runs take the startup slot so their session_started binds 1:1.
        let mut slot: Option<MutexGuard<'_, ()>> = None;
        let (bind_tx, bind_rx) = mpsc::channel::<()>();
        match resume_spine.map(str::trim).filter(|s| !s.is_empty()) {
            Some(sid) => {
                self.spine_routes
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .insert(sid.to_string(), run_id.to_string());
            }
            None => {
                // Cancellable slot acquisition: serializes only the pre-spine
                // window (MCP setup logs), never the turn itself.
                let deadline = Instant::now() + SPINE_BIND_WAIT;
                loop {
                    match self.fresh_slot.try_lock() {
                        Ok(guard) => {
                            slot = Some(guard);
                            break;
                        }
                        Err(_) => {
                            if cancel.load(Ordering::SeqCst) || Instant::now() >= deadline {
                                // Fallback: proceed unslotted (ambiguous bind
                                // window; events broadcast, documented).
                                break;
                            }
                            thread::sleep(POLL);
                        }
                    }
                }
                self.awaiting_spine
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .push(run_id.to_string());
                self.bind_notify
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .insert(run_id.to_string(), bind_tx);
            }
        }

        // Per-run event sink: the reader thread routes routed/broadcast
        // events here; the tick closure below forwards them to the UI.
        let (evt_tx, evt_rx) = mpsc::channel::<Value>();
        self.sinks
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(run_id.to_string(), evt_tx);
        let mut pump = || {
            while let Ok(event) = evt_rx.try_recv() {
                on_event(event);
            }
        };

        if !turn_input.is_object() {
            turn_input = json!({});
        }
        turn_input["sessionId"] = json!(session_id);
        let result = self.long_turn(&session_id, turn_input, cancel, &mut pump);

        // Wait (bounded) for the spine binding so the slot is released as
        // soon as routing is deterministic — fresh runs only.
        if slot.is_some() {
            let _ = bind_rx.recv_timeout(SPINE_BIND_WAIT);
        }

        // Cleanup routing state (spine_routes is kept: late events still
        // route to the finished run's dropped sink and clean up lazily).
        self.sinks
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(run_id);
        self.awaiting_spine
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .retain(|r| r != run_id);
        self.bind_notify
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(run_id);
        self.run_sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(run_id);
        drop(slot);

        // Flush whatever the reader routed while the turn was settling.
        pump();

        match result {
            Ok(value) => Ok(value.get("exitCode").and_then(|c| c.as_i64()).unwrap_or(0) as i32),
            Err(err) => Err(err.to_string()),
        }
    }

    /// send_control target: route a desktop ControlEvent to the run's
    /// harness session. Unknown method (t32-less CLI) = typed visible error,
    /// never a crash and never a silent fallback.
    pub(crate) fn steer_run(&self, run_id: &str, event: &Value) -> Result<(), String> {
        let session = {
            let guard = self.run_sessions.lock().unwrap_or_else(|e| e.into_inner());
            guard.get(run_id).cloned()
        }
        .ok_or_else(|| format!("no active run: {run_id}"))?;
        let kind = event.get("type").and_then(|t| t.as_str()).unwrap_or("");
        let res = if kind == "cancel" {
            let reason = event
                .get("reason")
                .and_then(|r| r.as_str())
                .unwrap_or("user");
            self.roundtrip(
                "session.cancel",
                json!({ "sessionId": session, "reason": reason }),
            )
        } else {
            // steer and follow_up both ride the §24 boundary-turn-end queue
            // in the session-scoped protocol (controlType 'steer').
            let text = event.get("text").and_then(|t| t.as_str()).unwrap_or("");
            let mut params = json!({ "sessionId": session, "text": text });
            if let Some(control_id) = event.get("id").and_then(|i| i.as_str()) {
                if !control_id.is_empty() {
                    params["controlId"] = json!(control_id);
                }
            }
            self.roundtrip("session.steer", params)
        };
        match res {
            Ok(_) => Ok(()),
            Err(err) if err.is_unknown_method() => Err(format!(
                "this CLI build has no session-scoped controls (no {kind} support): {err}"
            )),
            Err(err) => Err(err.to_string()),
        }
    }

    /// Graceful app-close teardown (requirement 4). Closing stdin is the
    /// protocol shutdown: the server's stdin-'end' handler runs close() →
    /// server.dispose(), which awaits ALL pending completion-proof writes
    /// (never cancels them) before services die. We wait bounded; the
    /// supervisor force-kills the tree only past DRAIN_TIMEOUT.
    pub(crate) fn shutdown(&self) {
        self.shutting_down.store(true, Ordering::SeqCst);
        let proc = self.proc.lock().unwrap_or_else(|e| e.into_inner()).take();
        if let Some(proc) = proc {
            // Drop stdin → EOF on the server side → graceful close+drain.
            drop(proc.stdin.lock().unwrap_or_else(|e| e.into_inner()).take());
            // Bounded wait for the supervisor's reap; past the deadline we
            // return and the supervisor finishes the forced kill itself.
            let _ = proc
                .done
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .recv_timeout(DRAIN_TIMEOUT + Duration::from_secs(2));
        }
    }

    // ------------------------------------------------------------------
    // Event routing (supervisor/reader thread side)
    // ------------------------------------------------------------------

    fn dispatch_line(&self, proc: &ProcState, line: &str) {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            return;
        }
        let value = match serde_json::from_str::<Value>(trimmed) {
            Ok(v) => v,
            Err(_) => {
                // A malformed server line is never a client crash; surface it.
                self.emit_status("log", &format!("non-JSON sidecar line: {trimmed}"));
                return;
            }
        };
        // Response envelope? (id + ok/error — demultiplexed by id)
        if let Some(id) = value.get("id").and_then(|x| x.as_u64()) {
            if value.get("ok").is_some() {
                let tx = proc
                    .pending
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .remove(&id);
                if let Some(tx) = tx {
                    if value.get("ok").and_then(|o| o.as_bool()) == Some(true) {
                        let _ = tx.send(Ok(value.get("result").cloned().unwrap_or(Value::Null)));
                    } else {
                        let code = value
                            .pointer("/error/code")
                            .and_then(|c| c.as_str())
                            .unwrap_or("method_failed");
                        let message = value
                            .pointer("/error/message")
                            .and_then(|m| m.as_str())
                            .unwrap_or("harness request failed");
                        let _ = tx.send(Err(HarnessError::new(code, message)));
                    }
                }
                return;
            }
        }
        // Unsolicited event (type field): route to run sinks.
        if value.get("type").and_then(|t| t.as_str()).is_some() {
            self.route_event(value);
        }
    }

    fn route_event(&self, event: Value) {
        let spine_id = event
            .get("sessionId")
            .and_then(|s| s.as_str())
            .map(str::to_string);
        if let Some(sid) = spine_id {
            let bound = {
                let guard = self.spine_routes.lock().unwrap_or_else(|e| e.into_inner());
                guard.get(&sid).cloned()
            };
            if let Some(run_id) = bound {
                self.send_to_run(&run_id, event);
                return;
            }
            let sole_awaiting = {
                let mut awaiting = self
                    .awaiting_spine
                    .lock()
                    .unwrap_or_else(|e| e.into_inner());
                if awaiting.len() == 1 {
                    Some(awaiting.remove(0))
                } else {
                    None
                }
            };
            if let Some(run_id) = sole_awaiting {
                // Deterministic bind: exactly one fresh run is in its
                // pre-spine window (the startup slot guarantees this).
                self.spine_routes
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .insert(sid, run_id.clone());
                let notify = self
                    .bind_notify
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .remove(&run_id);
                if let Some(tx) = notify {
                    let _ = tx.send(());
                }
                self.send_to_run(&run_id, event);
            } else {
                // Ambiguous window (slot timed out / cancel skip) or no
                // awaiting run: broadcast WITHOUT binding. A mis-bound spine
                // id would corrupt the desktop's resume chain (wrong session
                // log); a duplicated session_started line is only cosmetic.
                self.broadcast(event);
            }
        } else {
            // No sessionId (setup logs, control acks): single active run →
            // it; multiple → broadcast. Visible duplication beats dropped
            // errors (documented 1:1-mapping residue).
            let single = {
                let sinks = self.sinks.lock().unwrap_or_else(|e| e.into_inner());
                if sinks.len() == 1 {
                    sinks.keys().next().cloned()
                } else {
                    None
                }
            };
            match single {
                Some(run_id) => self.send_to_run(&run_id, event),
                None => self.broadcast(event),
            }
        }
    }

    fn send_to_run(&self, run_id: &str, event: Value) {
        let tx = {
            let sinks = self.sinks.lock().unwrap_or_else(|e| e.into_inner());
            sinks.get(run_id).cloned()
        };
        if let Some(tx) = tx {
            if tx.send(event).is_err() {
                // Run finished; lazy cleanup.
                self.sinks
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .remove(run_id);
            }
        }
    }

    fn broadcast(&self, event: Value) {
        let targets: Vec<(String, Sender<Value>)> = {
            let sinks = self.sinks.lock().unwrap_or_else(|e| e.into_inner());
            sinks.iter().map(|(k, v)| (k.clone(), v.clone())).collect()
        };
        for (_, tx) in targets {
            let _ = tx.send(event.clone());
        }
    }
}

/// Supervisor for one child generation: handshake on the first line, then
/// pump the stream; on EOF reap the child (bounded drain on the shutdown
/// path, forced tree-kill past the deadline) and — ONLY on unexpected death
/// — restart with exponential backoff. A shutdown never restarts.
fn supervise_child(
    me: Arc<HarnessSidecar>,
    mut child: Child,
    stdout: ChildStdout,
    proc: Arc<ProcState>,
    boot_tx: Sender<Result<u32, String>>,
    done_tx: Sender<()>,
) {
    let mut reader = BufReader::new(stdout);

    // Phase 1 — boot handshake: skip blank lines, then require protocol_info.
    let mut boot_line = String::new();
    let boot = loop {
        let mut line = String::new();
        match reader.read_line(&mut line) {
            Ok(0) => break Err("harness sidecar exited before handshake".to_string()),
            Ok(_) => match interpret_boot_line(&line) {
                BootLine::Skip => continue,
                BootLine::ProtocolInfo(version) => {
                    boot_line = line;
                    break Ok(version);
                }
                BootLine::Wrong(preview) => {
                    break Err(format!(
                        "harness sidecar boot line is not protocol_info: {preview}"
                    ));
                }
            },
            Err(e) => break Err(format!("harness sidecar stdout read error: {e}")),
        }
    };
    if boot.is_ok() {
        me.dispatch_line(&proc, &boot_line);
    }
    let _ = boot_tx.send(boot);

    // Phase 2 — stream pump (the server survives bad input; so do we).
    loop {
        let mut line = String::new();
        match reader.read_line(&mut line) {
            Ok(0) => break, // EOF: child stdout closed
            Ok(_) => me.dispatch_line(&proc, &line),
            Err(_) => break,
        }
    }

    // Phase 3 — reap. Graceful shutdown drains up to DRAIN_TIMEOUT (the
    // server is inside dispose(): awaiting pending proof writes — never
    // cancel them); anything past the deadline is force-killed as a tree.
    let deadline = Instant::now() + DRAIN_TIMEOUT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => {
                if Instant::now() >= deadline {
                    crate::kill_child_tree(&mut child);
                    break child.wait().ok();
                }
                thread::sleep(POLL);
            }
            Err(_) => break None,
        }
    };
    let graceful = me.shutting_down.load(Ordering::SeqCst);
    let msg = if graceful {
        "harness sidecar closed (graceful drain)".to_string()
    } else {
        format!(
            "harness sidecar exited unexpectedly (status: {})",
            status
                .map(|s| s
                    .code()
                    .map(|c| c.to_string())
                    .unwrap_or_else(|| "signal".to_string()))
                .unwrap_or_else(|| "unknown".to_string())
        )
    };
    me.fail_and_clear_proc(&proc, &msg);
    let _ = done_tx.send(());
    if graceful {
        me.emit_status("stopped", &msg);
        return; // app is closing: never restart
    }

    // Unexpected death → VISIBLE status + restart with backoff. If all
    // attempts fail, status "down" persists until the next run_task retries.
    me.emit_status("restarting", &msg);
    let mut backoff = RESTART_BASE;
    for attempt in 1..=MAX_RESTART_ATTEMPTS {
        thread::sleep(backoff);
        backoff = (backoff * 2).min(RESTART_CAP);
        if me.shutting_down.load(Ordering::SeqCst) {
            return;
        }
        let _guard = me.spawn_lock.lock().unwrap_or_else(|e| e.into_inner());
        if me.shutting_down.load(Ordering::SeqCst) {
            return;
        }
        {
            let guard = me.proc.lock().unwrap_or_else(|e| e.into_inner());
            if guard.is_some() {
                return; // someone else restarted it already
            }
        }
        if me.spawn_generation().is_ok() {
            me.emit_status("ready", "harness sidecar restarted");
            return;
        }
        if attempt == MAX_RESTART_ATTEMPTS {
            me.emit_status(
                "down",
                &format!(
                    "harness sidecar failed {MAX_RESTART_ATTEMPTS} restart attempts; \
                     new runs will report the error (no fallback)"
                ),
            );
        }
    }
}

/// Boot-timeout killer by PID (the Child lives on the supervisor thread).
/// Windows keeps the /T tree semantics; unix falls back to a plain kill.
fn kill_pid_tree(pid: u32) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(crate::CREATE_NO_WINDOW)
            .status();
    }
    #[cfg(not(windows))]
    {
        let _ = Command::new("kill").args(["-9", &pid.to_string()]).status();
    }
}

/// Fail every in-flight request of a dying generation with a typed error.
fn fail_pending(
    pending: &Mutex<HashMap<u64, Sender<Result<Value, HarnessError>>>>,
    code: &str,
    message: &str,
) {
    let mut guard = pending.lock().unwrap_or_else(|e| e.into_inner());
    for (_, tx) in guard.drain() {
        let _ = tx.send(Err(HarnessError::new(code, message)));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sidecar_argv_is_serve_harness() {
        assert_eq!(SIDECAR_CLI_ARGS, &["--serve-harness"]);
    }

    #[test]
    fn boot_line_accepts_protocol_info() {
        assert_eq!(
            interpret_boot_line(r#"{"type":"protocol_info","version":2}"#),
            BootLine::ProtocolInfo(2)
        );
    }

    #[test]
    fn boot_line_defaults_missing_version_to_2() {
        assert_eq!(
            interpret_boot_line(r#"{"type":"protocol_info"}"#),
            BootLine::ProtocolInfo(2)
        );
    }

    #[test]
    fn boot_line_skips_blank() {
        assert_eq!(interpret_boot_line("  \n"), BootLine::Skip);
        assert_eq!(interpret_boot_line(""), BootLine::Skip);
    }

    #[test]
    fn boot_line_rejects_plugin_gate_tui_frame() {
        match interpret_boot_line("Checking for optional tool plugins…") {
            BootLine::Wrong(preview) => {
                assert!(preview.contains("Checking for optional tool plugins"));
            }
            other => panic!("expected Wrong, got {other:?}"),
        }
    }

    #[test]
    fn boot_line_rejects_other_json() {
        match interpret_boot_line(r#"{"type":"log","message":"hi"}"#) {
            BootLine::Wrong(preview) => assert!(preview.contains("log")),
            other => panic!("expected Wrong, got {other:?}"),
        }
    }
}
