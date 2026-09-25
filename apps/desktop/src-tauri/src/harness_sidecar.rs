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
//! making the bind deterministic. Routing is ISOLATED per chat (Fix B, t60):
//! a line carrying a mapped spine `sessionId` goes to that run's sink ONLY;
//! a spine id we cannot map, or a SEMANTIC agent-event with no spine id, is
//! DROPPED with a diagnostic while ≥2 sinks are live — never broadcast (that
//! is the cross-chat leak: every copy would be relabelled with the receiving
//! run's conversationId). Only cosmetic lines (early MCP setup `log`, control
//! acks) are still broadcast: duplication there is harmless. The single-sink
//! window stays direct as before — with one run there is no cross-chat hazard.
//!
//! Deterministic routing (`session-routing` capability, 2026-09-24): a CLI
//! that advertises it in its boot `protocol_info` stamps EVERY line of a
//! served turn with `harnessSessionId` — the id session.create returned for
//! the run. Such lines route by run_sessions (run_id → harness session) and
//! nothing else: no spine-bind heuristic, no startup slot, so N fresh chats
//! start in parallel and a line can never be bound to the wrong chat. The
//! spine-bind path below stays as the fallback for older CLI builds, now
//! binding a sole awaiting run ONLY on its `session_started` (binding on any
//! unmapped spine id attached a sub-agent's or another chat's permission
//! request — whose `sessionId` is the HARNESS id — to the new chat).
//!
//! Conversation identity (M2, cross-talk fix): the routing tables above only
//! say WHICH RUN gets a line. The desktop also needs to know which CHAT that
//! run belongs to, and the sidecar must never guess it from "the active
//! chat". run_turn_full therefore records run_id → conversationId, and every
//! line fanned out to a sink is stamped with the identity of the run that
//! RECEIVES it (routed 1:1 and broadcast alike). The `harness-state`
//! advisory event resolves the same mapping (spine sessionId → run →
//! conversation) and omits the field when the spine id is unmapped.
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
use std::fs::OpenOptions;
use tauri::{AppHandle, Emitter, Manager};

// W2.3 — streaming delta coalescer. Declared with an explicit `#[path]` so the
// new module lives beside this file WITHOUT touching the crate root (lib.rs):
// a bare `mod` declared inside harness_sidecar.rs would look for a sibling
// `harness_sidecar/` directory instead.
#[path = "delta_coalescer.rs"]
mod delta_coalescer;

use self::delta_coalescer::{is_delta_type, DeltaCoalescer, FLUSH_WINDOW};

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

/// Does a boot `protocol_info` line advertise the `session-routing`
/// capability (every served-turn line stamped with `harnessSessionId`)?
pub(crate) fn boot_advertises_session_routing(raw: &str) -> bool {
    serde_json::from_str::<Value>(raw.trim())
        .ok()
        .and_then(|v| v.get("capabilities").and_then(|c| c.as_array()).cloned())
        .map(|caps| caps.iter().any(|c| c.as_str() == Some("session-routing")))
        .unwrap_or(false)
}

/// The final `harness_state` NDJSON event (ADR-0023 / H1 inc.3): the typed
/// read-model the CLI emits as the LAST stdout line of a turn when
/// output=json (runOneTurn / council / mission / kraken-graph hosts — see
/// src/cli/headless/harnessStateEmit.ts). On the sidecar wire it rides the
/// same stdout as every BrainEvent; it carries NO top-level sessionId (the
/// spine id lives at `session.sessionId`), so routing hoists it (dispatch_line).
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct HarnessStateEvent {
    /// `session.sessionId` when the payload carries it (routing key).
    pub session_id: Option<String>,
    /// The raw read-model (type + session + turns + execution + support).
    pub state: Value,
}

/// Pure classifier — `Some` for every `type:"harness_state"` JSON object,
/// `None` for everything else. Advisory by contract: a MALFORMED payload
/// still classifies (a missing session id only degrades routing to the
/// broadcast path and leaves the UI panel empty) — never a parse error,
/// never a crash.
pub(crate) fn interpret_harness_state(event: &Value) -> Option<HarnessStateEvent> {
    if event.get("type").and_then(|t| t.as_str()) != Some("harness_state") {
        return None;
    }
    Some(HarnessStateEvent {
        session_id: event
            .pointer("/session/sessionId")
            .and_then(|s| s.as_str())
            .map(str::to_string),
        state: event.clone(),
    })
}

/// The `harness-state` Tauri event payload — byte-for-byte the SAME shape the
/// frontend already listens for (`{sessionId, conversationId, state}`). W4.2:
/// it BORROWS the shared read-model via `Arc` and serializes it in place, so
/// emitting no longer deep-clones the (potentially large) `state`; `Clone`
/// — which Tauri's emitter requires — is just an `Arc` bump.
#[derive(Clone)]
struct HarnessStatePayload {
    session_id: Option<String>,
    conversation_id: Option<String>,
    state: Arc<Value>,
}

impl serde::Serialize for HarnessStatePayload {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut obj = serializer.serialize_struct("HarnessStatePayload", 3)?;
        obj.serialize_field("sessionId", &self.session_id)?;
        obj.serialize_field("conversationId", &self.conversation_id)?;
        // Serialize the Value by reference — no per-event deep clone.
        obj.serialize_field("state", self.state.as_ref())?;
        obj.end()
    }
}

/// Semantic agent-event classifier (Fix B, t60). These types describe a
/// SPECIFIC chat's agent activity — assistant text/deltas, tool calls, asks,
/// session lifecycle, run errors — so they must NEVER fan out to more than
/// one sink (a duplicated semantic event is the cross-chat leak this guard
/// closes). Everything else (early MCP setup `log`, control acks,
/// `protocol_info`) is cosmetic: duplication is harmless and stays
/// broadcastable in the multi-run window.
pub(crate) fn is_semantic_agent_event(kind: &str) -> bool {
    matches!(
        kind,
        "permission.request"
            | "permission.settled"
            | "ask_user.request"
            | "ask_user.settled"
            | "session_started"
            | "harness_state"
            | "error"
    ) || kind.starts_with("assistant")
        || kind.starts_with("message_")
        || kind.starts_with("tool")
        || kind.starts_with("turn")
        || kind.starts_with("agent")
        || kind.starts_with("task_")
        || kind.starts_with("session_")
        || kind.starts_with("error")
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
/// After the watchdog (idle/wall) fires and the cooperative cancel is sent,
/// how long the run.turn channel stays open for a late settlement: a run
/// that actually finishes inside the window returns its REAL result — the
/// work is not discarded. Only a silent expiry surfaces the typed timeout.
const TURN_TIMEOUT_GRACE: Duration = Duration::from_secs(60);

/// Per-turn watchdog (field report: "the model never answers on clean PCs").
/// A run.turn that never settles — provider fetch hanging, CLI stuck
/// mid-turn — used to poll FOREVER with no error and no event: an infinite
/// silent spinner. The watchdog is IDLE-based: a turn only fails when NO
/// NDJSON event has been received for it for TURN_IDLE_TIMEOUT — a
/// legitimately working turn (silent model thinking, a 45-min tentacle)
/// keeps refreshing the idle clock with every event and is never killed
/// mid-flight. Tentacles emit `agent_status` heartbeats while blocked on the
/// model so a GLM/Grok thinking phase does not look like a hung CLI.
/// Default idle is 15 min so it sits ABOVE provider first-token idle (10 min):
/// a silent lead should get a provider idle error, not a sidecar cancel that
/// closes the session as `completed` with no explanation.
/// The wall cap is the structural backstop for a chatty runaway (a 15s
/// heartbeat never trips idle). It is not "one tentacle": a parent turn
/// hosts several sequential 45-min tentacles plus lead/verify overhead, and
/// the old 50-min ceiling killed active Kraken turns while events were
/// still arriving. Default 4h. Idle (15 min of silence) remains the
/// stuck-turn detector. Past either limit the run fails with a distinct
/// reason (`turn_idle_timeout` vs `turn_wall_timeout`) so chat does not
/// blame the idle watchdog for a wall kill.
/// Env overrides: ZELARI_SIDECAR_TURN_IDLE_TIMEOUT_SECS (clamped >= 30s)
/// and ZELARI_SIDECAR_TURN_TIMEOUT_SECS (clamped >= 60s) — a typo cannot
/// insta-kill legitimate turns.
const TURN_IDLE_TIMEOUT_DEFAULT_SECS: u64 = 900;
const TURN_IDLE_TIMEOUT_MIN_SECS: u64 = 30;
const TURN_TIMEOUT_DEFAULT_SECS: u64 = 14400;
const TURN_TIMEOUT_MIN_SECS: u64 = 60;

fn turn_idle_timeout() -> Duration {
    let secs = std::env::var("ZELARI_SIDECAR_TURN_IDLE_TIMEOUT_SECS")
        .ok()
        .and_then(|v| v.trim().parse::<u64>().ok())
        .unwrap_or(TURN_IDLE_TIMEOUT_DEFAULT_SECS)
        .max(TURN_IDLE_TIMEOUT_MIN_SECS);
    Duration::from_secs(secs)
}

fn turn_timeout() -> Duration {
    let secs = std::env::var("ZELARI_SIDECAR_TURN_TIMEOUT_SECS")
        .ok()
        .and_then(|v| v.trim().parse::<u64>().ok())
        .unwrap_or(TURN_TIMEOUT_DEFAULT_SECS)
        .max(TURN_TIMEOUT_MIN_SECS);
    Duration::from_secs(secs)
}

/// Wall-clock milliseconds since UNIX_EPOCH — the idle-watchdog time base
/// (the reader thread stamps it; the run thread reads it; an Instant cannot
/// be shared across that boundary).
fn unix_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

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
    /// run_id → desktop conversationId (M2 conversation isolation). The
    /// sidecar is ONE process for every chat, so identity must travel WITH
    /// the run: every event fanned out to a run sink is stamped with this
    /// conversationId, making the fan-out (broadcast residue included)
    /// attributable per target instead of per active chat. Empty/unknown
    /// entries are never stamped (an unstamped line is dropped by the TS
    /// layer — cosmetic duplication may be dropped, cross-talk may not).
    run_conversations: Mutex<HashMap<String, String>>,
    /// run_id → live BrainEvent sink (the run thread forwards to the UI).
    sinks: Mutex<HashMap<String, Sender<Value>>>,
    /// requestId → spine sessionId of a LIVE ask (Fix B, t60). Learned from
    /// the `permission.request` / `ask_user.request` events that carry the
    /// emitter spine id (Fix A) and removed on the matching `*.settled`.
    /// Consulted by the respond path so an answer is scoped to the ONE
    /// session that raised the ask (`permission.respond`/`ask_user.respond`
    /// echo it back in params; a mismatch is rejected CLI-side as
    /// `session_mismatch`).
    ask_sessions: Mutex<HashMap<String, String>>,
    /// run_id → last NDJSON event received for that run (ms since
    /// UNIX_EPOCH). The reader stamps it on every routed/broadcast event
    /// line (any type); long_turn's idle watchdog reads it.
    run_activity: Mutex<HashMap<String, Arc<AtomicU64>>>,
    /// Fresh (non-resumed) runs awaiting their spine binding, FIFO.
    awaiting_spine: Mutex<Vec<String>>,
    /// One-shot bind notification per awaiting fresh run.
    bind_notify: Mutex<HashMap<String, Sender<()>>>,
    /// Last `harness_state` read-model per spine sessionId (advisory UI
    /// state). W4.2: held behind a shared `Arc` so a new event is deep-copied
    /// at most once and every slot (this map, the global slot, the emitted
    /// payload) references the SAME allocation.
    harness_states: Mutex<HashMap<String, Arc<Value>>>,
    /// Global last harness_state regardless of session (single-run UX) AND the
    /// dedup anchor: an event whose value equals this is neither stored nor
    /// emitted (W4.2).
    last_harness_state: Mutex<Option<Arc<Value>>>,
    /// Startup slot: at most one fresh run between "run.turn sent" and
    /// "spine bound", so session_started binding stays deterministic.
    /// Legacy CLIs only — unused when `session_routing` is set.
    fresh_slot: Mutex<()>,
    /// The running CLI advertised `session-routing` on its boot line: every
    /// turn line carries `harnessSessionId` (see the module doc).
    session_routing: AtomicBool,
    /// W2.3 — streaming delta coalescer: batches consecutive `message_delta` /
    /// `thinking_delta` events for a (run id, delta type) into ONE event so the
    /// frontend re-renders ~1 per flush window instead of per token. See the
    /// `delta_coalescer` module for the ordering contract.
    delta_coalescer: Mutex<DeltaCoalescer>,
    /// One-shot guard: the delta flusher thread starts at most once.
    flusher_started: AtomicBool,
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
            run_conversations: Mutex::new(HashMap::new()),
            sinks: Mutex::new(HashMap::new()),
            ask_sessions: Mutex::new(HashMap::new()),
            run_activity: Mutex::new(HashMap::new()),
            awaiting_spine: Mutex::new(Vec::new()),
            bind_notify: Mutex::new(HashMap::new()),
            harness_states: Mutex::new(HashMap::new()),
            last_harness_state: Mutex::new(None),
            fresh_slot: Mutex::new(()),
            session_routing: AtomicBool::new(false),
            delta_coalescer: Mutex::new(DeltaCoalescer::new()),
            flusher_started: AtomicBool::new(false),
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

    /// Store the latest harness_state (per spine session + global last) and
    /// surface it to the UI the same way emit_status does — a global Tauri
    /// event the frontend may or may not listen to (advisory, non-breaking).
    /// Without an AppHandle (no run started yet) it only stores, never emits.
    ///
    /// Identity (M2): the payload is resolved through the sidecar's OWN
    /// binding tables — spine sessionId → run_id (spine_routes) → desktop
    /// conversationId (run_conversations). When the spine id is unmapped the
    /// event carries NO conversationId: the frontend then drops it instead
    /// of attributing the read-model to whichever chat is on screen.
    ///
    /// W4.2: takes ownership of the read-model and returns whether a NEW value
    /// was stored (and therefore emitted). The payload is compared BY VALUE,
    /// once, against the previous one: a repeat of the last read-model neither
    /// clones nor emits. On a genuine change exactly ONE deep copy is taken —
    /// the value is moved into a shared `Arc` referenced by the session map,
    /// the global slot AND the emitted payload — down from three deep clones
    /// per event in the old code.
    fn store_and_emit_harness_state(&self, hs: HarnessStateEvent) -> bool {
        let HarnessStateEvent { session_id, state } = hs;
        // Dedup anchor: identical read-model → nothing to store (it would be a
        // no-op) and nothing for the UI to see. Cheap value compare, no clone.
        {
            let last = self
                .last_harness_state
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            if let Some(prev) = last.as_ref() {
                if prev.as_ref() == &state {
                    return false;
                }
            }
        }
        // Changed: own the read-model ONCE and share it everywhere (Arc bumps).
        let shared = Arc::new(state);
        *self
            .last_harness_state
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = Some(Arc::clone(&shared));
        if let Some(sid) = &session_id {
            self.harness_states
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(sid.clone(), Arc::clone(&shared));
        }
        let conversation_id = session_id
            .as_ref()
            .and_then(|sid| self.conversation_for_spine(sid));
        let guard = self.app.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(app) = guard.as_ref() {
            let _ = app.emit(
                "harness-state",
                HarnessStatePayload {
                    session_id,
                    conversation_id,
                    state: shared,
                },
            );
        }
        true
    }

    /// spine sessionId → desktop conversationId, via the two routing tables
    /// the sidecar already keeps (spine_routes then run_conversations). None
    /// when either hop is unknown — never a guessed identity.
    fn conversation_for_spine(&self, spine_id: &str) -> Option<String> {
        let run_id = {
            let guard = self.spine_routes.lock().unwrap_or_else(|e| e.into_inner());
            guard.get(spine_id).cloned()
        }?;
        let guard = self
            .run_conversations
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        guard.get(&run_id).cloned().filter(|c| !c.is_empty())
    }

    /// Read-model seam for future consumers (a Tauri command would call
    /// this): the last harness_state, optionally scoped to a spine session.
    /// lib.rs is not extended in this slice, so outside tests nothing calls
    /// it yet — the unit test below pins the store/getter roundtrip.
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn last_harness_state(&self, session_id: Option<&str>) -> Option<Value> {
        match session_id {
            Some(sid) => self
                .harness_states
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .get(sid)
                .map(|v| v.as_ref().clone()),
            None => self
                .last_harness_state
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .as_ref()
                .map(|v| v.as_ref().clone()),
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
        // W2.3: the delta flusher lives for the whole sidecar lifetime
        // (idempotent — safe across supervisor restarts).
        self.ensure_delta_flusher();
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
        // as harness-sidecar-log events AND append to <app_data_dir>/logs/
        // zelari-sidecar.log. The durable file matters: events are lossy
        // across restarts and nothing else keeps the child's stderr, so this
        // log is the field-debugging record for "the model never answers".
        //
        // The AppHandle is resolved LAZILY, per line, until it is known: the
        // W4.3 prewarm spawned the child before any command had stashed a
        // handle, and a handle read once at spawn left that whole generation
        // with no log file and no log events (2026-09-16 → 2026-09-24).
        {
            let me = Arc::clone(self);
            thread::spawn(move || {
                let mut app: Option<AppHandle> = None;
                let mut log_file: Option<std::fs::File> = None;
                // NOT reader.lines().map_while(Result::ok): one non-UTF8
                // byte would end the iteration, kill the drain thread, fill
                // the pipe and deadlock the child. Decode raw bytes lossily;
                // stop only on IO error or EOF.
                let mut reader = BufReader::new(stderr);
                let mut buf: Vec<u8> = Vec::with_capacity(512);
                loop {
                    buf.clear();
                    match reader.read_until(b'\n', &mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(_) => {}
                    }
                    let line = String::from_utf8_lossy(&buf);
                    let trimmed = line.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    if app.is_none() {
                        app = me.app.lock().unwrap_or_else(|e| e.into_inner()).clone();
                        log_file = app.as_ref().and_then(open_sidecar_log);
                    }
                    if let Some(app) = app.as_ref() {
                        let _ = app.emit("harness-sidecar-log", json!({ "line": trimmed }));
                    }
                    if let Some(file) = log_file.as_mut() {
                        let ts = std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .map(|d| d.as_secs())
                            .unwrap_or(0);
                        let _ = writeln!(file, "[{ts}] {trimmed}");
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

    /// Ask-bridge (permission.respond / ask_user.respond): fire-and-forget
    /// write that mirrors write_request's locking (proc → stdin) WITHOUT
    /// registering pending — the CLI side treats the ack as advisory, and a
    /// dead sidecar simply drops it (deny-on-timeout is enforced CLI-side).
    fn send_host_respond(&self, method: &str, params: Value) {
        let proc = match self
            .proc
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .map(Arc::clone)
        {
            Some(p) => p,
            None => return,
        };
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let line = json!({ "id": id, "method": method, "params": params }).to_string();
        let mut stdin_guard = proc.stdin.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(stdin) = stdin_guard.as_mut() {
            let _ = writeln!(stdin, "{line}").and_then(|_| stdin.flush());
        }
    }

    /// respond path so an answer is scoped to the ONE session that raised the
    /// ask (`permission.respond`/`ask_user.respond` echo it back in params; a
    /// mismatch is rejected CLI-side as `session_mismatch`).
    fn ask_session_of(&self, request_id: &str) -> Option<String> {
        self.ask_sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(request_id)
            .cloned()
    }

    pub(crate) fn send_permission_respond(&self, request_id: &str, decision: &str) {
        let mut params = json!({ "requestId": request_id, "decision": decision });
        // Fix B (t60): scope the answer to the session that raised the ask so
        // a respond from ANOTHER chat cannot settle this requestId (the CLI
        // rejects a mismatched sessionId as `session_mismatch`).
        if let Some(sid) = self.ask_session_of(request_id) {
            params["sessionId"] = json!(sid);
        }
        self.send_host_respond("permission.respond", params);
    }

    pub(crate) fn send_ask_user_respond(&self, request_id: &str, answer: Option<&str>) {
        let mut params = json!({ "requestId": request_id, "answer": answer });
        if let Some(sid) = self.ask_session_of(request_id) {
            params["sessionId"] = json!(sid);
        }
        self.send_host_respond("ask_user.respond", params);
    }

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
    /// same reason the old spawn_headless polled with recv_timeout). The
    /// watchdog is IDLE-based (`last_event_ms` is stamped by the reader on
    /// every NDJSON event for this run) with the wall cap as backstop, plus
    /// a grace window that returns a late post-cancel settlement.
    fn long_turn(
        &self,
        session_id: &str,
        turn_input: Value,
        cancel: &AtomicBool,
        last_event_ms: &AtomicU64,
        on_tick: &mut dyn FnMut(),
    ) -> Result<Value, HarnessError> {
        let started = Instant::now();
        let in_flight = self.write_request("run.turn", turn_input)?;
        let mut cancel_delivered = false;
        let mut cancel_deadline: Option<Instant> = None;
        let idle_timeout = turn_idle_timeout();
        let wall_timeout = turn_timeout();
        let wall_deadline = started + wall_timeout;
        loop {
            if let Some(result) = in_flight.poll() {
                return result;
            }
            on_tick();
            // Per-turn watchdog: IDLE first (no event for this run within
            // idle_timeout = the agent stopped producing output) or the
            // wall cap (absolute ceiling even for a chatty turn) = typed
            // error, never an infinite silent spinner.
            let idle_secs = unix_millis()
                .saturating_sub(last_event_ms.load(Ordering::SeqCst))
                / 1000;
            let idle_fired = idle_secs >= idle_timeout.as_secs();
            let wall_fired = Instant::now() >= wall_deadline;
            if idle_fired || wall_fired {
                // Both limits crossed inside one poll quantum: report the
                // structural backstop.
                let kind = if wall_fired { "wall" } else { "idle" };
                // Best-effort cleanup: the request is abandoned but the CLI
                // may still be running it (holding the session's spine
                // lock). If session.cancel at least answers, the session
                // unwinds cooperatively and the child stays alive. The
                // run.turn pending channel stays OPEN through the grace
                // window below (detaching here would DROP the settlement).
                let cancel_outcome = self.roundtrip(
                    "session.cancel",
                    json!({ "sessionId": session_id, "reason": if wall_fired { "turn_wall_timeout" } else { "turn_idle_timeout" } }),
                );
                if cancel_outcome.is_err() {
                    // No answer within ROUNDTRIP_TIMEOUT: the CLI event loop
                    // is hung, not merely slow — every later roundtrip would
                    // cascade into a 30s timeout. Kill the tree; the
                    // supervisor reaps, fails in-flight requests with
                    // `sidecar_died` and restarts with backoff, restoring
                    // service without user intervention.
                    let pid = self
                        .proc
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .as_ref()
                        .map(|p| p.pid);
                    if let Some(pid) = pid {
                        kill_pid_tree(pid);
                    }
                }
                // Grace window: if the run actually settles after the
                // cooperative cancel, return its REAL result — the work is
                // not discarded. A hung CLI (tree killed above) answers via
                // the supervisor's `sidecar_died` failure of this channel.
                let grace_deadline = Instant::now() + TURN_TIMEOUT_GRACE;
                while Instant::now() < grace_deadline {
                    if let Some(result) = in_flight.poll() {
                        return result;
                    }
                    on_tick();
                    thread::sleep(POLL);
                }
                in_flight.detach();
                let detail = if wall_fired {
                    format!(
                        "run.turn wall cap reached after {}s while the turn was still active (silence {idle_secs}s, limit {kind}) — not the idle watchdog; see sidecar diagnostics",
                        started.elapsed().as_secs()
                    )
                } else {
                    format!(
                        "run.turn idle for {idle_secs}s (wall {}s, limit {kind}) — no events from the agent; see sidecar diagnostics",
                        started.elapsed().as_secs()
                    )
                };
                return Err(HarnessError::new(
                    if wall_fired {
                        "turn_wall_timeout"
                    } else {
                        "turn_idle_timeout"
                    },
                    detail,
                ));
            }
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
    /// Identity note (M2): `conversation_id` is the desktop chat this run
    /// belongs to. It is stored per run_id so every event this sidecar fans
    /// out — routed 1:1 or broadcast to the documented residue targets — can
    /// be stamped with the identity of the run that RECEIVES it. The sidecar
    /// never guesses an active conversation: an unknown run_id stamps nothing.
    pub(crate) fn run_turn_full(
        self: &Arc<Self>,
        app: &AppHandle,
        run_id: &str,
        conversation_id: &str,
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
        // Conversation identity for this run (see run_turn_full doc note):
        // stamped on every event the reader fans out to this run's sink.
        if !conversation_id.is_empty() {
            self.run_conversations
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(run_id.to_string(), conversation_id.to_string());
        }

        // Routing setup. Resumed runs know their spine id up front (pre-bound
        // for the harness-state identity lookup). Fresh runs: with
        // `session-routing` the harness session id mapped above IS the route
        // (every line carries it) — no slot, no awaiting, so fresh chats start
        // in parallel; legacy CLIs take the startup slot so their
        // session_started binds 1:1.
        let mut slot: Option<MutexGuard<'_, ()>> = None;
        let (bind_tx, bind_rx) = mpsc::channel::<()>();
        let session_routed = self.session_routing.load(Ordering::SeqCst);
        match resume_spine.map(str::trim).filter(|s| !s.is_empty()) {
            Some(sid) => {
                self.spine_routes
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .insert(sid.to_string(), run_id.to_string());
            }
            None if session_routed => {}
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
        // The companion activity clock starts now: with no event at all the
        // idle watchdog counts silence from turn start.
        let (evt_tx, evt_rx) = mpsc::channel::<Value>();
        self.sinks
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(run_id.to_string(), evt_tx);
        let activity = Arc::new(AtomicU64::new(unix_millis()));
        self.run_activity
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(run_id.to_string(), Arc::clone(&activity));
        let mut pump = || {
            while let Ok(event) = evt_rx.try_recv() {
                on_event(event);
            }
        };

        if !turn_input.is_object() {
            turn_input = json!({});
        }
        turn_input["sessionId"] = json!(session_id);
        let result = self.long_turn(&session_id, turn_input, cancel, &activity, &mut pump);

        // Wait (bounded) for the spine binding so the slot is released as
        // soon as routing is deterministic — fresh runs only.
        if slot.is_some() {
            let _ = bind_rx.recv_timeout(SPINE_BIND_WAIT);
        }

        // W2.3: flush any delta batch this run still has buffered BEFORE its
        // sink is dropped, so the trailing tokens reach the UI (the later
        // `pump()` drains the channel they land in). A buffer owned by another
        // live run is left alone.
        self.flush_pending_deltas_for(run_id);

        // Cleanup routing state (spine_routes is kept: late events still
        // route to the finished run's dropped sink and clean up lazily).
        self.sinks
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(run_id);
        self.run_activity
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

        // Release the kernel session (the desktop creates one per run; without
        // this they accumulate in the server until process death — the
        // companion runManager disposes after every settled run, the desktop
        // must too). Best-effort: a dead sidecar or an already-unknown session
        // must not fail the settled turn; bounded by ROUNDTRIP_TIMEOUT.
        if let Err(err) = self.roundtrip("session.dispose", json!({ "sessionId": session_id.as_str() })) {
            eprintln!("[harness-sidecar] session.dispose({session_id}) after run failed: {err}");
        }

        // Flush whatever the reader routed while the turn was settling.
        pump();

        match result {
            Ok(value) => Ok(value.get("exitCode").and_then(|c| c.as_i64()).unwrap_or(0) as i32),
            Err(err) => Err(err.to_string()),
        }
    }

    /// send_control target: route a desktop ControlEvent to the run's
    /// harness session. Returns the harness result payload (the value under
    /// "result" in the response envelope — the CLI answers a steer with
    /// {accepted, outcome, controlId, controlType}; outcome
    /// "already_finished" when no live turn exists). Unknown method
    /// (t32-less CLI) = typed visible error, never a crash and never a
    /// silent fallback.
    pub(crate) fn steer_run(&self, run_id: &str, event: &Value) -> Result<Value, String> {
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
            Ok(result) => Ok(result),
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
        // W2.3: never swallow a trailing delta batch at close.
        self.flush_pending_deltas();
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
            // harness_state (ADR-0023 final read-model): store + surface via
            // the advisory `harness-state` event, then route like any other
            // BrainEvent — with the spine id HOISTED to the top level so the
            // sink bind stays deterministic (the payload nests it at
            // session.sessionId; without the hoist a harness_state landing
            // in a multi-run window would broadcast instead of binding 1:1).
            if let Some(hs) = interpret_harness_state(&value) {
                // Move the read-model into the store (W4.2 — no per-event deep
                // clone); keep the spine id for the routing hoist below.
                let spine_id = hs.session_id.clone();
                self.store_and_emit_harness_state(hs);
                let mut routed = value;
                if let Some(sid) = &spine_id {
                    routed["sessionId"] = json!(sid);
                }
                self.route_event(routed);
                return;
            }
            self.route_event(value);
        }
    }

    /// Track requestId → spine sessionId for LIVE asks (Fix B, t60). Fix A
    /// stamps `permission.request` / `ask_user.request` with the emitter spine
    /// id; recording it here is what lets the respond path scope an answer to
    /// the single session that raised the ask. The matching `*.settled`
    /// removes the entry.
    fn track_ask_session(&self, event: &Value) {
        let request_id = match event.get("requestId").and_then(|r| r.as_str()) {
            Some(r) if !r.is_empty() => r.to_string(),
            _ => return,
        };
        match event.get("type").and_then(|t| t.as_str()) {
            Some("permission.request") | Some("ask_user.request") => {
                if let Some(sid) = event
                    .get("sessionId")
                    .and_then(|s| s.as_str())
                    .filter(|s| !s.is_empty())
                {
                    self.ask_sessions
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .insert(request_id, sid.to_string());
                }
            }
            Some("permission.settled") | Some("ask_user.settled") => {
                self.ask_sessions
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .remove(&request_id);
            }
            _ => {}
        }
    }

    /// The single live sink's run_id, or `None` when 0 or ≥2 sinks are live.
    fn sole_sink(&self) -> Option<String> {
        let sinks = self.sinks.lock().unwrap_or_else(|e| e.into_inner());
        if sinks.len() == 1 {
            sinks.keys().next().cloned()
        } else {
            None
        }
    }

    /// The run whose harness session (session.create id) is `harness_id`.
    fn run_for_harness_session(&self, harness_id: &str) -> Option<String> {
        self.run_sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .find(|(_, sid)| sid.as_str() == harness_id)
            .map(|(run_id, _)| run_id.clone())
    }

    fn route_event(&self, event: Value) {
        self.track_ask_session(&event);
        // `session-routing`: the stamped harness session id is authoritative.
        // A known id routes 1:1; an unknown one (its run already settled and
        // was cleaned up) is dropped — never re-guessed, never broadcast.
        if let Some(harness_id) = event
            .get("harnessSessionId")
            .and_then(|s| s.as_str())
            .filter(|s| !s.is_empty())
            .map(str::to_string)
        {
            match self.run_for_harness_session(&harness_id) {
                Some(run_id) => {
                    // Keep the spine table warm for legacy consumers (late
                    // unstamped lines, harness-state identity) — learned
                    // from the run's own session_started only.
                    if event.get("type").and_then(|t| t.as_str()) == Some("session_started") {
                        if let Some(spine) = event
                            .get("sessionId")
                            .and_then(|s| s.as_str())
                            .filter(|s| !s.is_empty())
                        {
                            self.spine_routes
                                .lock()
                                .unwrap_or_else(|e| e.into_inner())
                                .insert(spine.to_string(), run_id.clone());
                        }
                    }
                    self.send_to_run(&run_id, event);
                }
                None => eprintln!(
                    "[harness-sidecar] dropping event of settled harness session {harness_id}: no live run"
                ),
            }
            return;
        }
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
            // Only the run's OWN session_started may bind it: any other line
            // with an unmapped id (a sub-agent's session, or another chat's
            // permission.request carrying its HARNESS id) would otherwise be
            // attached to the new chat, and that chat's real spine events
            // dropped afterwards.
            let is_session_started =
                event.get("type").and_then(|t| t.as_str()) == Some("session_started");
            let sole_awaiting = if is_session_started {
                let mut awaiting = self
                    .awaiting_spine
                    .lock()
                    .unwrap_or_else(|e| e.into_inner());
                if awaiting.len() == 1 {
                    Some(awaiting.remove(0))
                } else {
                    None
                }
            } else {
                None
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
            } else if let Some(run_id) = self.sole_sink() {
                // Single live run whose spine id is not (yet) mapped: no
                // isolation hazard — the sole run is the only plausible owner
                // — so keep the historical direct delivery.
                self.send_to_run(&run_id, event);
            } else {
                // Fix B (t60): a spine id we cannot map, with ≥2 live sinks,
                // must NOT broadcast. Broadcasting would relabel this event
                // with EACH receiving run's conversationId — the cross-chat
                // leak. Drop it with a diagnostic instead.
                eprintln!(
                    "[harness-sidecar] dropping unmapped-sessionId event (sessionId={sid}): no run to route to"
                );
            }
        } else {
            // No spine id. Cosmetic lines (early MCP `log`, control acks)
            // still go to the single run when unambiguous, else broadcast
            // (duplicated setup logs are harmless). Fix B (t60): SEMANTIC
            // agent events must NEVER fan out across chats — with ≥2 sinks
            // they are dropped, never relabelled into an unrelated chat.
            match self.sole_sink() {
                Some(run_id) => self.send_to_run(&run_id, event),
                None => {
                    let kind = event
                        .get("type")
                        .and_then(|t| t.as_str())
                        .unwrap_or("")
                        .to_string();
                    if is_semantic_agent_event(&kind) {
                        eprintln!(
                            "[desktop] dropping semantic agent-event: no session routing (type={kind})"
                        );
                    } else {
                        self.broadcast(event);
                    }
                }
            }
        }
    }

    /// Reader-side activity stamp: EVERY NDJSON event line routed to a run
    /// (any type) refreshes its idle-watchdog clock. Broadcast lines count
    /// for every live run — duplicated setup logs are cosmetic, a false
    /// idle kill would not be.
    fn touch_run_activity(&self, run_id: &str) {
        let clock = self
            .run_activity
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(run_id)
            .cloned();
        if let Some(clock) = clock {
            clock.store(unix_millis(), Ordering::SeqCst);
        }
    }

    /// Stamp the receiving run's conversationId on an outgoing event (M2).
    /// Deterministic per the sidecar's own binding rules: the identity comes
    /// from the run REGISTERING the sink, never from a global "active chat".
    /// A run with no conversation (legacy/automation caller) leaves the line
    /// unstamped — the TS layer drops what it cannot attribute instead of
    /// guessing, so an unstamped line can never land in the wrong chat.
    fn stamp_conversation_id(&self, run_id: &str, event: &mut Value) {
        let cid = {
            let guard = self
                .run_conversations
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            guard.get(run_id).cloned()
        };
        if let Some(cid) = cid.filter(|c| !c.is_empty()) {
            if let Some(obj) = event.as_object_mut() {
                obj.insert("conversationId".into(), json!(cid));
            }
        }
    }

    /// Coalescing entry point for per-run delivery (W2.3). Delta events
    /// (`message_delta`/`thinking_delta`) are BUFFERED so consecutive chunks of
    /// the same (run id, delta type) leave as ONE event; every other event
    /// flushes any pending buffer for this run FIRST (strict ordering) and then
    /// passes straight through. Raw delivery is `emit_to_run`.
    fn send_to_run(&self, run_id: &str, event: Value) {
        let kind = event.get("type").and_then(|t| t.as_str()).unwrap_or("");
        if is_delta_type(kind) {
            // Keep the idle watchdog alive: the reader IS receiving events even
            // though this one is only buffered, not emitted yet.
            self.touch_run_activity(run_id);
            let displaced = {
                let mut coalescer = self
                    .delta_coalescer
                    .lock()
                    .unwrap_or_else(|e| e.into_inner());
                coalescer.push_delta(run_id, event)
            };
            // A different key displaced the previous buffer: emit it FIRST so
            // the coalesced event always precedes the delta that displaced it.
            if let Some((prev_run, prev_event)) = displaced {
                self.emit_to_run(&prev_run, prev_event);
            }
            return;
        }
        // Non-delta: flush the same-run buffer BEFORE emitting, so a
        // message_start / message_end / tool / agent_end / error can never
        // overtake the coalesced deltas that preceded it.
        let flushed = {
            let mut coalescer = self
                .delta_coalescer
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            coalescer.flush_for(run_id)
        };
        if let Some((prev_run, prev_event)) = flushed {
            self.emit_to_run(&prev_run, prev_event);
        }
        self.emit_to_run(run_id, event);
    }

    /// Raw per-run delivery: activity stamp + conversation identity + sink send
    /// (the pre-W2.3 body of `send_to_run`; coalesced buffers re-enter here).
    fn emit_to_run(&self, run_id: &str, mut event: Value) {
        self.touch_run_activity(run_id);
        let tx = {
            let sinks = self.sinks.lock().unwrap_or_else(|e| e.into_inner());
            sinks.get(run_id).cloned()
        };
        if let Some(tx) = tx {
            self.stamp_conversation_id(run_id, &mut event);
            if tx.send(event).is_err() {
                // Run finished; lazy cleanup.
                self.sinks
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .remove(run_id);
            }
        }
    }

    /// Start the single delta-flusher thread (idempotent). It holds a `Weak`
    /// and exits when the sidecar is dropped (app exit), so it never leaks
    /// across supervisor restarts. The thread is the timer trigger (c): it
    /// flushes a buffer once its FLUSH_WINDOW elapsed even if no further event
    /// arrives, bounding batching latency at ~FLUSH_WINDOW.
    fn ensure_delta_flusher(self: &Arc<Self>) {
        if self.flusher_started.swap(true, Ordering::SeqCst) {
            return;
        }
        let weak = Arc::downgrade(self);
        thread::spawn(move || loop {
            // Tick well below the window so the deadline is met within ~1 tick.
            thread::sleep(FLUSH_WINDOW / 4);
            match weak.upgrade() {
                Some(sidecar) => sidecar.flush_due_deltas(),
                None => break,
            }
        });
    }

    /// Timer tick: flush the pending delta buffer once its window elapsed.
    fn flush_due_deltas(&self) {
        let due = {
            let mut coalescer = self
                .delta_coalescer
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            coalescer.flush_if_due(FLUSH_WINDOW)
        };
        if let Some((run_id, event)) = due {
            self.emit_to_run(&run_id, event);
        }
    }

    /// Flush the pending buffer unconditionally (stream end / disconnect /
    /// shutdown) so a trailing batch is never lost.
    fn flush_pending_deltas(&self) {
        let pending = {
            let mut coalescer = self
                .delta_coalescer
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            coalescer.flush()
        };
        if let Some((run_id, event)) = pending {
            self.emit_to_run(&run_id, event);
        }
    }

    /// Flush the pending buffer IFF it belongs to `run_id` (run end). The run
    /// thread calls this BEFORE dropping the run's sink so a trailing batch is
    /// not sent to a dead channel.
    fn flush_pending_deltas_for(&self, run_id: &str) {
        let pending = {
            let mut coalescer = self
                .delta_coalescer
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            coalescer.flush_for(run_id)
        };
        if let Some((pending_run, event)) = pending {
            self.emit_to_run(&pending_run, event);
        }
    }

    fn broadcast(&self, event: Value) {
        let targets: Vec<(String, Sender<Value>)> = {
            let sinks = self.sinks.lock().unwrap_or_else(|e| e.into_inner());
            sinks.iter().map(|(k, v)| (k.clone(), v.clone())).collect()
        };
        for (run_id, tx) in targets {
            self.touch_run_activity(&run_id);
            // Per-target identity: every recipient's copy carries ITS OWN
            // conversation, so the documented broadcast residue (setup logs,
            // control acks) surfaces in each chat instead of only whichever
            // chat happens to be on screen.
            let mut copy = event.clone();
            self.stamp_conversation_id(&run_id, &mut copy);
            let _ = tx.send(copy);
        }
    }
}

/// Open `<app_data_dir>/logs/zelari-sidecar.log` for append, rotating it
/// first. One-generation rotation: a hung CLI can emit stderr for the whole
/// boot-timeout window on every restart; without a cap the log grows
/// forever. 5 MiB is days of healthy stderr. Windows rename fails on an
/// existing target, so the previous .old is dropped first.
fn open_sidecar_log(app: &AppHandle) -> Option<std::fs::File> {
    let dir = app.path().app_data_dir().ok()?.join("logs");
    std::fs::create_dir_all(&dir).ok()?;
    let path = dir.join("zelari-sidecar.log");
    const MAX_LOG_BYTES: u64 = 5 * 1024 * 1024;
    if std::fs::metadata(&path)
        .map(|m| m.len() > MAX_LOG_BYTES)
        .unwrap_or(false)
    {
        let _ = std::fs::remove_file(dir.join("zelari-sidecar.log.old"));
        let _ = std::fs::rename(&path, dir.join("zelari-sidecar.log.old"));
    }
    OpenOptions::new().create(true).append(true).open(path).ok()
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
        me.session_routing
            .store(boot_advertises_session_routing(&boot_line), Ordering::SeqCst);
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
    // W2.3: the stream ended (EOF / read error = disconnect). Flush whatever
    // delta batch is still buffered so the last tokens are not lost.
    me.flush_pending_deltas();

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

    #[test]
    fn harness_state_classifies_real_payload() {
        let line = r#"{"type":"harness_state","session":{"sessionId":"sess-1","status":"completed","lastSeq":7},"turns":[{"index":1,"toolCalls":0,"outcome":"completed","verification":{"strict":true,"verdict":"PASS"}}],"execution":{"turnsTotal":1,"contracts":[{"turn":1,"complete":true,"signals":{},"blockers":[]}]},"support":{"contextProjections":[],"memoryEvents":0,"compactions":0}}"#;
        let event = serde_json::from_str::<Value>(line).unwrap();
        let hs = interpret_harness_state(&event).expect("harness_state classifies");
        assert_eq!(hs.session_id.as_deref(), Some("sess-1"));
        assert_eq!(
            hs.state.get("type").and_then(|t| t.as_str()),
            Some("harness_state")
        );
    }

    #[test]
    fn harness_state_rejects_other_events() {
        let boot = serde_json::json!({ "type": "protocol_info", "version": 2 });
        assert_eq!(interpret_harness_state(&boot), None);
        let response = serde_json::json!({ "id": 1, "ok": true, "result": {} });
        assert_eq!(interpret_harness_state(&response), None);
        assert_eq!(interpret_harness_state(&serde_json::json!("nonsense")), None);
    }

    #[test]
    fn harness_state_survives_malformed_payload() {
        // Advisory contract: a missing session id still classifies (routing
        // degrades to broadcast; the UI panel stays empty) — never a crash.
        let bare = serde_json::json!({ "type": "harness_state" });
        let hs = interpret_harness_state(&bare).expect("still classifies");
        assert_eq!(hs.session_id, None);
    }

    #[test]
    fn harness_state_store_roundtrip() {
        let sidecar = HarnessSidecar::new();
        assert_eq!(sidecar.last_harness_state(None), None);
        let event = serde_json::json!({
            "type": "harness_state",
            "session": { "sessionId": "sess-2", "status": "completed" }
        });
        let hs = interpret_harness_state(&event).unwrap();
        // No AppHandle in tests → the emit is skipped, the store is not.
        assert!(sidecar.store_and_emit_harness_state(hs));
        assert_eq!(sidecar.last_harness_state(None), Some(event.clone()));
        assert_eq!(sidecar.last_harness_state(Some("sess-2")), Some(event));
        assert_eq!(sidecar.last_harness_state(Some("other")), None);
    }

    /// W4.2: an unchanged read-model is neither stored again nor emitted; a
    /// changed one is, exactly once, with the NEW value.
    #[test]
    fn harness_state_emits_only_on_change() {
        let sidecar = HarnessSidecar::new();
        let mk = |status: &str| {
            let event = serde_json::json!({
                "type": "harness_state",
                "session": { "sessionId": "sess-3", "status": status }
            });
            interpret_harness_state(&event).unwrap()
        };
        let status = |sidecar: &HarnessSidecar| {
            sidecar
                .last_harness_state(Some("sess-3"))
                .and_then(|v| {
                    v.pointer("/session/status")
                        .and_then(|s| s.as_str())
                        .map(str::to_string)
                })
        };

        // First sighting → stored + (would) emit.
        assert!(sidecar.store_and_emit_harness_state(mk("running")));
        assert_eq!(status(&sidecar), Some("running".to_string()));

        // Byte-identical read-model → no store, no emit.
        assert!(!sidecar.store_and_emit_harness_state(mk("running")));

        // A real change → one emit with the NEW value.
        assert!(sidecar.store_and_emit_harness_state(mk("completed")));
        assert_eq!(status(&sidecar), Some("completed".to_string()));
    }

    /// W4.2: the emitted payload keeps the exact same JSON shape/keys as the
    /// pre-refactor `json!({sessionId, conversationId, state})`.
    #[test]
    fn harness_state_payload_shape_is_unchanged() {
        let payload = HarnessStatePayload {
            session_id: Some("sess-9".to_string()),
            conversation_id: Some("conv-1".to_string()),
            state: Arc::new(serde_json::json!({ "type": "harness_state" })),
        };
        let value = serde_json::to_value(&payload).unwrap();
        assert_eq!(value["sessionId"], serde_json::json!("sess-9"));
        assert_eq!(value["conversationId"], serde_json::json!("conv-1"));
        assert_eq!(value["state"], serde_json::json!({ "type": "harness_state" }));

        // Unmapped identity serializes to null, never a missing key.
        let bare = HarnessStatePayload {
            session_id: None,
            conversation_id: None,
            state: Arc::new(serde_json::json!({ "type": "harness_state" })),
        };
        let value = serde_json::to_value(&bare).unwrap();
        assert!(value["sessionId"].is_null());
        assert!(value["conversationId"].is_null());
    }

    // --- Fix B (t60): chat-isolated routing --------------------------------

    /// Build a sidecar with one live sink per run id, returning the receivers
    /// (the per-run forward channels route_event pushes into).
    fn sidecar_with_sinks(
        runs: &[&str],
    ) -> (HarnessSidecar, Vec<std::sync::mpsc::Receiver<serde_json::Value>>) {
        let sidecar = HarnessSidecar::new();
        let mut rxs = Vec::new();
        {
            let mut sinks = sidecar.sinks.lock().unwrap_or_else(|e| e.into_inner());
            for run in runs {
                let (tx, rx) = std::sync::mpsc::channel::<serde_json::Value>();
                sinks.insert((*run).to_string(), tx);
                rxs.push(rx);
            }
        }
        (sidecar, rxs)
    }

    /// Pre-bind a spine session id to a run (what `session_started` does).
    fn bind(sidecar: &HarnessSidecar, spine: &str, run: &str) {
        sidecar
            .spine_routes
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(spine.to_string(), run.to_string());
    }

    #[test]
    fn semantic_classifier_covers_agent_events_and_spares_cosmetics() {
        for kind in [
            "permission.request",
            "permission.settled",
            "ask_user.request",
            "ask_user.settled",
            "assistant",
            "message_delta",
            "tool_use",
            "tool_execution_start",
            "session_started",
            "harness_state",
            "agent_status",
            "error",
        ] {
            assert!(is_semantic_agent_event(kind), "{kind} must be semantic");
        }
        for kind in ["log", "control_accepted", "protocol_info"] {
            assert!(
                !is_semantic_agent_event(kind),
                "{kind} must stay broadcastable"
            );
        }
    }

    #[test]
    fn route_event_session_id_targets_only_the_owning_sink() {
        let (sidecar, rxs) = sidecar_with_sinks(&["run-a", "run-b"]);
        bind(&sidecar, "sess-a", "run-a");
        let event = serde_json::json!({
            "type": "permission.request",
            "requestId": "perm-1",
            "sessionId": "sess-a",
        });
        sidecar.route_event(event.clone());
        assert_eq!(
            rxs[0].try_recv().unwrap(),
            event,
            "the owning run receives the event"
        );
        assert!(
            rxs[1].try_recv().is_err(),
            "the other chat must NOT receive it (no cross-chat broadcast)"
        );
    }

    #[test]
    fn route_event_drops_semantic_event_without_session_id_across_two_sinks() {
        let (sidecar, rxs) = sidecar_with_sinks(&["run-a", "run-b"]);
        sidecar.route_event(serde_json::json!({ "type": "assistant", "text": "hi" }));
        assert!(rxs[0].try_recv().is_err(), "dropped, not broadcast");
        assert!(rxs[1].try_recv().is_err(), "dropped, not broadcast");
    }

    #[test]
    fn route_event_broadcasts_cosmetic_event_across_two_sinks() {
        let (sidecar, rxs) = sidecar_with_sinks(&["run-a", "run-b"]);
        let event = serde_json::json!({ "type": "log", "message": "mcp ready" });
        sidecar.route_event(event.clone());
        assert_eq!(rxs[0].try_recv().unwrap(), event);
        assert_eq!(rxs[1].try_recv().unwrap(), event);
    }

    #[test]
    fn route_event_drops_unmapped_session_id_across_two_sinks() {
        let (sidecar, rxs) = sidecar_with_sinks(&["run-a", "run-b"]);
        sidecar.route_event(serde_json::json!({
            "type": "assistant",
            "sessionId": "ghost",
            "text": "x",
        }));
        assert!(rxs[0].try_recv().is_err());
        assert!(rxs[1].try_recv().is_err());
    }

    #[test]
    fn route_event_single_sink_stays_direct_without_session_id() {
        let (sidecar, rxs) = sidecar_with_sinks(&["run-only"]);
        let event = serde_json::json!({ "type": "assistant", "text": "hi" });
        sidecar.route_event(event.clone());
        assert_eq!(rxs[0].try_recv().unwrap(), event);
    }

    #[test]
    fn route_event_single_sink_delivers_unmapped_session_id() {
        let (sidecar, rxs) = sidecar_with_sinks(&["run-only"]);
        let event = serde_json::json!({
            "type": "assistant",
            "sessionId": "ghost",
            "text": "x",
        });
        sidecar.route_event(event.clone());
        assert_eq!(rxs[0].try_recv().unwrap(), event);
    }

    // --- session-routing (2026-09-24): deterministic harness-id routing -----

    /// Map run → harness session (what run_turn_full does after session.create).
    fn map_session(sidecar: &HarnessSidecar, run: &str, harness: &str) {
        sidecar
            .run_sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(run.to_string(), harness.to_string());
    }

    #[test]
    fn boot_line_session_routing_capability() {
        assert!(boot_advertises_session_routing(
            r#"{"type":"protocol_info","version":2,"capabilities":["steer","session-routing"]}"#
        ));
        assert!(!boot_advertises_session_routing(
            r#"{"type":"protocol_info","version":2,"capabilities":["steer","cancel"]}"#
        ));
        assert!(!boot_advertises_session_routing(r#"{"type":"protocol_info","version":2}"#));
        assert!(!boot_advertises_session_routing("not json"));
    }

    #[test]
    fn route_event_harness_session_id_targets_only_its_run() {
        let (sidecar, rxs) = sidecar_with_sinks(&["run-a", "run-b"]);
        map_session(&sidecar, "run-a", "hs-a");
        map_session(&sidecar, "run-b", "hs-b");
        // A sub-agent line: its spine-looking sessionId is unmapped, but the
        // harness stamp is authoritative.
        let event = serde_json::json!({
            "type": "tool_execution_start",
            "sessionId": "sub-agent-xyz",
            "harnessSessionId": "hs-b",
        });
        sidecar.route_event(event.clone());
        assert_eq!(rxs[1].try_recv().unwrap(), event);
        assert!(rxs[0].try_recv().is_err(), "the other chat must not receive it");
    }

    #[test]
    fn route_event_permission_request_routes_by_harness_id() {
        // The CLI stamps permission.request `sessionId` with the HARNESS id:
        // it must reach its chat, never be dropped or bound to another one.
        let (sidecar, rxs) = sidecar_with_sinks(&["run-a", "run-b"]);
        map_session(&sidecar, "run-a", "hs-a");
        map_session(&sidecar, "run-b", "hs-b");
        let event = serde_json::json!({
            "type": "permission.request",
            "requestId": "perm-7",
            "sessionId": "hs-a",
            "harnessSessionId": "hs-a",
        });
        sidecar.route_event(event.clone());
        assert_eq!(rxs[0].try_recv().unwrap(), event);
        assert!(rxs[1].try_recv().is_err());
    }

    #[test]
    fn route_event_unknown_harness_session_is_dropped_not_broadcast() {
        let (sidecar, rxs) = sidecar_with_sinks(&["run-a", "run-b"]);
        map_session(&sidecar, "run-a", "hs-a");
        sidecar.route_event(serde_json::json!({
            "type": "log",
            "message": "late line of a settled run",
            "harnessSessionId": "hs-gone",
        }));
        assert!(rxs[0].try_recv().is_err());
        assert!(rxs[1].try_recv().is_err());
    }

    #[test]
    fn route_event_harness_session_started_learns_the_spine_route() {
        let (sidecar, rxs) = sidecar_with_sinks(&["run-a", "run-b"]);
        map_session(&sidecar, "run-a", "hs-a");
        sidecar.route_event(serde_json::json!({
            "type": "session_started",
            "sessionId": "spine-a",
            "harnessSessionId": "hs-a",
        }));
        assert!(rxs[0].try_recv().is_ok());
        let routes = sidecar.spine_routes.lock().unwrap_or_else(|e| e.into_inner());
        assert_eq!(routes.get("spine-a").map(String::as_str), Some("run-a"));
    }

    #[test]
    fn legacy_sole_awaiting_run_binds_only_on_its_session_started() {
        let (sidecar, rxs) = sidecar_with_sinks(&["run-a", "run-b"]);
        bind(&sidecar, "spine-a", "run-a");
        sidecar
            .awaiting_spine
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push("run-b".to_string());
        // Chat A's permission ask (harness id, unstamped legacy CLI) must NOT
        // be attached to the fresh chat B.
        sidecar.route_event(serde_json::json!({
            "type": "permission.request",
            "requestId": "perm-1",
            "sessionId": "hs-a",
        }));
        assert!(rxs[1].try_recv().is_err(), "never bound to the awaiting chat");
        assert_eq!(
            sidecar.awaiting_spine.lock().unwrap_or_else(|e| e.into_inner()).len(),
            1,
            "chat B is still awaiting its own session_started"
        );
        let started = serde_json::json!({ "type": "session_started", "sessionId": "spine-b" });
        sidecar.route_event(started.clone());
        assert_eq!(rxs[1].try_recv().unwrap(), started);
        assert!(rxs[0].try_recv().is_err());
    }

    #[test]
    fn respond_session_is_tracked_from_request_and_cleared_on_settled() {
        let (sidecar, _rxs) = sidecar_with_sinks(&["run-a", "run-b"]);
        bind(&sidecar, "sess-a", "run-a");
        sidecar.route_event(serde_json::json!({
            "type": "permission.request",
            "requestId": "perm-9",
            "sessionId": "sess-a",
            "tool": "bash",
        }));
        assert_eq!(sidecar.ask_session_of("perm-9").as_deref(), Some("sess-a"));
        sidecar.route_event(serde_json::json!({
            "type": "permission.settled",
            "requestId": "perm-9",
            "sessionId": "sess-a",
        }));
        assert_eq!(sidecar.ask_session_of("perm-9"), None);
    }

    // --- W2.3: streaming delta coalescing ----------------------------------

    #[test]
    fn consecutive_deltas_coalesce_and_a_non_delta_flushes_them_first() {
        let (sidecar, rxs) = sidecar_with_sinks(&["run-a"]);
        bind(&sidecar, "sess-a", "run-a");
        for chunk in ["Hel", "lo ", "world"] {
            sidecar.route_event(serde_json::json!({
                "type": "message_delta",
                "sessionId": "sess-a",
                "delta": chunk,
            }));
        }
        // Still buffered: no per-token emission.
        assert!(
            rxs[0].try_recv().is_err(),
            "deltas must be buffered, not emitted per token"
        );
        // The boundary flushes the batch BEFORE itself.
        sidecar.route_event(serde_json::json!({ "type": "message_end", "sessionId": "sess-a" }));
        let first = rxs[0].try_recv().unwrap();
        assert_eq!(first["type"], "message_delta");
        assert_eq!(first["delta"], "Hello world", "payloads concatenate in order");
        let second = rxs[0].try_recv().unwrap();
        assert_eq!(second["type"], "message_end", "coalesced deltas precede the boundary");
    }

    #[test]
    fn a_delta_for_a_different_request_flushes_the_previous_buffer_first() {
        let (sidecar, rxs) = sidecar_with_sinks(&["run-a", "run-b"]);
        bind(&sidecar, "sess-a", "run-a");
        bind(&sidecar, "sess-b", "run-b");
        sidecar.route_event(serde_json::json!({
            "type": "message_delta", "sessionId": "sess-a", "delta": "A1",
        }));
        sidecar.route_event(serde_json::json!({
            "type": "message_delta", "sessionId": "sess-a", "delta": "A2",
        }));
        // A delta for run-b must flush run-a's pending buffer first.
        sidecar.route_event(serde_json::json!({
            "type": "message_delta", "sessionId": "sess-b", "delta": "B1",
        }));
        let a = rxs[0].try_recv().unwrap();
        assert_eq!(a["delta"], "A1A2", "run-a's batch flushed on the run change");
        assert!(rxs[1].try_recv().is_err(), "run-b is still buffered");
    }

    #[test]
    fn a_delta_of_a_different_type_flushes_the_previous_buffer_first() {
        let (sidecar, rxs) = sidecar_with_sinks(&["run-a"]);
        bind(&sidecar, "sess-a", "run-a");
        sidecar.route_event(serde_json::json!({
            "type": "message_delta", "sessionId": "sess-a", "delta": "hi",
        }));
        sidecar.route_event(serde_json::json!({
            "type": "thinking_delta", "sessionId": "sess-a", "delta": "hmm",
        }));
        let first = rxs[0].try_recv().unwrap();
        assert_eq!(first["type"], "message_delta");
        assert_eq!(first["delta"], "hi");
    }

    #[test]
    fn the_flusher_drains_a_buffered_batch_without_a_trailing_event() {
        let (sidecar, rxs) = sidecar_with_sinks(&["run-a"]);
        bind(&sidecar, "sess-a", "run-a");
        sidecar.route_event(serde_json::json!({
            "type": "message_delta", "sessionId": "sess-a", "delta": "trailing",
        }));
        assert!(rxs[0].try_recv().is_err());
        // The timer tick / shutdown / EOF path flushes unconditionally.
        sidecar.flush_pending_deltas();
        assert_eq!(rxs[0].try_recv().unwrap()["delta"], "trailing");
    }
}
