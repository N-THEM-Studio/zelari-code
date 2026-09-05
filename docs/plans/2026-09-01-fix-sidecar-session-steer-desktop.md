# Fix plan - Desktop sidecar, spine sessions, steering and diagnostics

**Date:** 2026-09-01
**Baseline:** zelari-code 2.20.0
**Origin:** diagnosis session on the repo + two clean PCs + Desktop in dev
**Status:** operational proposal, ready for execution

---

# 1. Context

The diagnosis isolated six confirmed defects (plus a minor one), all reproduced or
verified at code level, with file evidence. The user symptoms were:

- Desktop: "the model never responds" on clean machines (CLI ok, Desktop not).
- Desktop: `sidecar_died: harness sidecar exited unexpectedly (status: 1)`.
- Desktop: resuming an old session | "the agent starts but stalls without
  doing what was asked".
- Desktop: changing folder "carries over the session" of the previous
  project (cross-project contamination).
- `zelari-code --doctor` gives OK on Node 20.20.1 despite `engines.node >= 24`.

Root cause of the "never responds" family: **no network or installation bug** -
a combination of (a) an agent that can kill its own host process, (b) the session
spine lock without a liveness check, (c) sidecar errors invisible in the UI
because the frontend does not listen to the events the backend already emits.

---

# 2. The fixes

Ordered by execution priority (P0 | P2). Each fix = one atomic commit
(repo convention: single-task atomic commits, conventional commits).

---

## FIX-1 (P0) - Anti-self-kill guard in the bash/exec tool

**Problem.** An agent can run a taskkill against the node.exe image (or by
enumerated PIDs) and kill the process hosting it: the TUI, or the Desktop
`--serve-harness` sidecar. Reproduced on 2026-09-01: the agent, to stop a Vite
preview server on port 4173, killed *all* node.exe processes | `sidecar_died
(status: 1)`, log without a stacktrace (cold external kill), supervisors
exhausted the 5 restarts | total silence.

**Evidence.**
- Lethal command recorded in the spine:
  `E:/EasyPeasy/giocoandrea/.zelari/sessions/921987c9-./events.jsonl` seq 1261.
- The bash tool runs without any filter: `src/cli/tools/` + `src/cli/safety/`.

**Solution.**
1. New module `src/cli/safety/selfKillGuard.ts`: a matcher on spammable
   commands that:
   - target the `node.exe`/`node` image by name (taskkill, `Stop-Process`,
     `ps -W | grep node` + `kill`, pkill by node pattern, `wmic process . delete`);
   - target PIDs of its own tree: `process.pid`, parent PID chain
     (up to the sidecar/TUI PID), worker-thread PIDs and the active children
     of the tool registry.
2. The guard **refuses** with a tool-result error that teaches the safe
   alternative: kill **by port** (`netstat -ano | findstr :<port>` |
   `taskkill //PID <pid-listener>`), never by image name.
3. Cover both `bash` and `exec`-like (same spawn pipeline).

**Tests.** Unit tests on the matcher (taskkill/Stop-Process/pkill patterns,
negative cases with a specific non-self listener PID); integration test that
the denial tool-result contains the by-port instruction.

**Commit:** `fix(safety): block self-kill patterns targeting the agent host process tree`

---

## FIX-2 (P0) - Spine writer.lock: liveness takeover + heartbeat + sweep + visibility

**Problem.** The session spine lock is only temporal: an orphan lock with a
**dead** PID but more recent than 10 minutes blocks resume
(`SessionLogLockedError`) even if the owner no longer exists. The `locked`
case then degrades **silently** (no warning, no event): the turn resumes
without derived context, without epoch/budget - the user sees "the agent
starts but stalls / does not do what was asked". Reproduced with a dedicated
script (lock with dead PID | `SessionLogLockedError`; takeover only after 11
minutes).

**Evidence.**
- `packages/core/src/session/writer.ts:100-112` - `stale = now - ts > 10min`,
  `pid` written in the lock but never used.
- `src/cli/sessionSpine.ts:306-309` - the `locked` branch emits no warning
  (only `degraded` calls `warnOnce`).
- Real triggers: taskkill (FIX-1), the `turn_timeout` watchdog doing a
  kill-tree while the turn holds the lock (`harness_sidecar.rs:662-669`,
  explicit comment), Desktop crash/restart mid-turn.

**Solution.**
1. **Liveness takeover** in `SessionLogWriter.acquireLock` (writer.ts):
   lock not stale | read `pid` | probe `process.kill(pid, 0)`:
   - PID nonexistent | immediate takeover;
   - PID existing but heartbeat stopped (see point 2) past a threshold |
     takeover;
   - final fallback: the 10-minute temporal rule (unchanged).
2. **Heartbeat**: the writer updates `ts` in `writer.lock` on every `append()`
   (or at most every N seconds): distinguishes a living owner from a reused
   PID (PID reuse on Windows: mitigated by the heartbeat, not fully
   eliminable).
3. **Sweep at sidecar boot**: at `runHarnessServer()` startup, scan
   `.zelari/sessions/*/writer.lock` - orphans by liveness/heartbeat |
   takeover. Cures the crash|restart case before the user resumes the
   session.
4. **Visibility**: `locked` branch | `warnOnce` (parity with `degraded`) +
   a note event on the NDJSON channel so the Desktop can show "session
   resumed in degraded mode (orphan lock)".

**Tests.** Writer unit tests: takeover with dead PID, rejection with a living
PID and a fresh heartbeat, takeover with a living PID but stopped heartbeat,
staleness >10min. Sweep unit tests. Warning unit test on `locked`.

**Commits (split):**
- `fix(core): spine writer lock takeover by owner liveness + append heartbeat`
- `feat(cli): sweep orphan session spine locks at harness server boot`
- `fix(cli): surface locked-spine degradation with warning + NDJSON event`

**User remedy note (until the fix is out):** manually delete
`.zelari/sessions/<id>/writer.lock` or wait 10 minutes.

---

## FIX-3 (P0) - Desktop: folder change = new chat, never session reuse

**Problem.** `pickFolder` rebinds the active conversation's `cwd` but keeps
`sessionId` (spine) and `messages`. On the next message the turn does
`resumeSessionId=<project A spine>` against `<folder B>/.zelari/sessions/` |
the spine silently restarts from zero **and** the legacy fallback pours the
last 16 chats of project A as context of the agent working in B.
Cross-project contamination confirmed at full-flow level.

**Evidence.**
- `apps/desktop/src/App.tsx:2449-2462` - `pickFolder` changes only `cwd`.
- `apps/desktop/src/App.tsx:1199-1210` - `sessionId` captured from
  `session_started`, never reset.
- `apps/desktop/src/App.tsx:2289` - `send()` passes `sessionId: live?.sessionId`
  + `cwd: activeCwd`.
- `packages/core/src/session/store.ts:25-31` - sessions dir workspace-relative.

**Solution (chosen behavior).**
1. If the active conversation is **virgin** (no messages, no `sessionId`):
   rebind `cwd` in place (current behavior, correct).
2. If it has messages or a `sessionId`: `pickFolder` creates a **new
   conversation** tied to the new folder and selects it; the old one stays
   in the list with its project. The global `workdir` updated as today.
   - Updating the active chat is not an option: any hybrid (keeping
     messages and/or sessionId with another root) falls back into
     contamination.
3. Show the conversation's folder in the sidebar (sub-heading) to defuse
   the reported UI confusion.

**Tests.** Unit/it on `pickFolder` (virgin vs used); manual check:
folder change | new chat | first message produces a `session.started`
spine in the right folder and no ghost dir in the new project's
`.zelari/sessions/`.

**Commit:** `fix(desktop): switching folder starts a new chat instead of rebinding the session spine`

---

## FIX-4 (P1) - Steering: the `already_finished` noop must not lose the text

**Problem.** If the run ends in the window between the `running` check in the
composer and delivery, `session.steer` replies with the explicit noop
`already_finished` (paragraph 24): the text is **discarded** and the steered
bubble stays stuck at "sent" forever (no ack updates the state).

**Evidence.**
- `apps/desktop/src-tauri/src/harness_sidecar.rs:876-911` - `steer_run` does
  the `session.steer` roundtrip; `Ok(_) => Ok(())` **discards the noop
  payload**.
- `src/cli/serve/harnessServer.ts` (session.steer, no live turn branch) -
  typed noop, never fake success.
- `apps/desktop/src/App.tsx:2102-2160` - the bubble updates state only on
  ack-events; the noop produces no events.

**Solution.**
1. `steer_run` returns the roundtrip `result` (not just `Ok(())`); the
   `send_control` command propagates the payload to the frontend.
2. Frontend: on `already_finished` | bubble | `not_applied` state (visible),
   **composer prefill** with the text (same treatment as
   `follow_up_queued`) + explicit status line.
3. Optional (same commit): also close the inverse case - the
   `unknown_method` reply is already handled with a visible error, verify
   it in tests.

**Tests.** Unit on the payload plumbing; manual: steer at run end |
prefilled composer, no hanging bubble.

**Commit:** `fix(desktop): surface already_finished steer noop as composer prefill, never drop the text`

---

## FIX-5 (P1) - Doctor: actually validate `engines.node`

**Problem.** `checkNode` ignores the `pkg.engines` it receives and uses a
hardcoded `major < 20` threshold with a misleading "(>= 20.0.0)" message.
Node 20.20.1 passes as OK although the requirement is `>= 24.0.0` - it
masked the whole family of problems on clean machines.

**Evidence.** `src/cli/utils/doctor.ts:208-232`.

**Solution.** Parse `pkg.engines.node` (formats `>=24.0.0`, `^24`, `24.x`):
below the required major | **critical FAIL** with the correct message and
remediation ("install Node 24 LTS"); engines missing/unreadable | fallback
to the current threshold. `npm i -g` does not block on engines (only an
EBADENGINE warning): the doctor is the last honest place to say it.

**Tests.** Unit `checkNode` with a fake pkg: engines >=24 with node 20 |
FAIL; node 24 | OK; engines missing | fallback behavior.

**Commit:** `fix(cli): doctor validates node against package engines requirement`

---

## FIX-6 (P1) - Desktop: listeners for `harness-sidecar-status` and `harness-sidecar-log`

**Problem.** The backend emits both events (lifecycle status, sidecar
stderr - also drained to a file in `<app_data_dir>/logs/zelari-sidecar.log`)
but the frontend **has no listener at all**: every boot/spawn/crash error is
invisible. That is why "the model never responds" appears as silence instead
of "Node.js not found on PATH" / "did not send the protocol_info boot line".

**Evidence.**
- `apps/desktop/src-tauri/src/harness_sidecar.rs:289-297` (emit_status, "the
  frontend has no listener yet"), `:445-500` (stderr drain | event + file).
- Frontend check: no `listen('harness-sidecar-status' | 'harness-sidecar-log')`
  in `apps/desktop/src`.

**Solution.**
1. Listener in `agentClient.ts`: `harness-sidecar-status` | status banner
   (ready / failed / down after restart exhaustion) with the last message.
2. `harness-sidecar-log` | collapsible diagnostics panel with a ring buffer
   (cap ~200 lines), reachable from the chat; errors/stacks highlighted.
3. A persistent "down" state (after MAX_RESTART_ATTEMPTS) must stay visible
   until the next run reports an outcome.

**Tests.** Manual: start the Desktop without node in the GUI process PATH |
visible banner with the exact error. Unit on the event buffer/normalization.

**Commit:** `feat(desktop): surface harness sidecar status and stderr log in the UI`

---

## FIX-7 (P2, minor) - Queued follow-ups: do not lose them on close

**Problem.** Follow-ups (converted late steers, `follow_up_queued:`) survive
only as a system bubble + composer prefill: closing the app or a new draft =
text lost. The in-memory queue dies with the run by design (paragraph 28).

**Evidence.** `src/cli/headless/runOneTurn.ts:876-878`, `App.tsx:1131-1150`.

**Solution.** Persist pending follow-ups in the conversation
(`chatStorage`, field `pendingFollowUps`) and restore them as a prefill on
the next start until sent/discarded by the user.

**Commit:** `feat(desktop): persist queued follow-ups across app restarts`

---

## FIX-8 (P1) - Turn watchdog: idle-based, not wall-based + threshold coherence

**Problem.** The Desktop turn watchdog (`TURN_TIMEOUT_DEFAULT_SECS = 1800`)
fires on wall time and **ignores activity**: it detaches turns that are
working regularly. Reproduced on 2026-09-01 at 18:49: turn started at
18:19:52, completed at 18:49:52 (**exactly 1800s**) - the watchdog did
detach + cooperative `session.cancel` right as the agent was concluding
(last assistant.message 18:49:51, clean `session.ended`). The work's outcome
was discarded by the UI with the error `turn_timeout: run.turn did not settle
within 1800s - the model call may be hanging (network egress?)` - a
misleading message: no network hang.

**Composition of the 30' turn (from the spine, session 921987c9):**
- **1203s (20') in a single gap**: Kraken tentacle `task` - inner turns
  are off-spine (ADR-0024) | 20 minutes of total invisibility, then
  `memory_write` + 4 `tool.result` delivered in a block + final report.
- ~7' of model latencies (5 assistant|tool gaps of 60-110s, GLM provider).
- 38 tool calls of which 4 complete `npx vitest run`.

**Structural incoherence:** the Desktop turn timeout (30') is **lower**
than the max timeout of a tentacle (`TASK_TOOL_TIMEOUT_MS = 45'`): by
construction the Desktop can detach a turn the CLI would complete.
Moreover, on detach the final `run.turn` reply ends up in a pending that
nobody reads | completed work is lost by the UI even when it ends naturally.

**Solution.**
1. **Idle-deadline instead of wall-deadline** in `long_turn`
   (`harness_sidecar.rs`): the timer resets on every event received for
   the run (message_delta, tool_execution_start/end, resource snapshot,
   note). Recommended idle threshold: 300-600s (a hung model call dies
   anyway; live work is never killed by the clock).
2. Threshold coherence: `ZELARI_SIDECAR_TURN_TIMEOUT_SECS` (if kept as a
   wall cap) = `TASK_TOOL_TIMEOUT_MS`; or drop the wall cap entirely in
   favor of idle-only + the CLI budget (40 tool calls / wall per epoch).
3. On watchdog fire with a successful cooperative cancel: the detach must
   not throw away a result arriving seconds later - hold the pending for a
   grace window (e.g. 60s) before abandoning it.

**Tests.** Unit on idle-reset (events extending the deadline); manual:
long turn with a tentacle > 30' | completes without turn_timeout; run with
a hung model call | idle-timeout fires within the threshold.

**Commit:** `fix(desktop): idle-based turn watchdog replaces wall clock timeout`

---

# 3. Execution order and priorities

| # | Fix | Area | Priority | Risk |
|---|-----|------|----------|---------|
| 1 | FIX-1 anti-self-kill | CLI/safety | P0 | low (denial + tests only) |
| 2 | FIX-2 spine lock (3 commits) | core+CLI | P0 | medium (touches the writer - exhaustive tests) |
| 3 | FIX-3 pickFolder new chat | Desktop | P0 | low |
| 4 | FIX-5 doctor engines | CLI | P1 | low |
| 5 | FIX-8 idle-based watchdog | Desktop/Tauri | P1 | medium (long_turn timing) |
| 6 | FIX-4 steer noop prefill | Desktop+Tauri | P1 | medium (Rust|FE plumbing) |
| 7 | FIX-6 sidecar listeners | Desktop | P1 | low |
| 8 | FIX-7 persistent follow-ups | Desktop | P2 | low |

Sequenced like this: first stop the hemorrhages (self-kill and lock: they
cause the "never responds"), then semantic correctness (folder/session,
doctor), then observability, finally the minor one.

---

# 4. Final verification (for every commit + at the end of the plan)

```
npm run typecheck
npm run test          # including the new suites: selfKillGuard, writer takeover,
                      # sweep, checkNode, pickFolder, steer noop
npm run smoke
```

Manual on the Desktop (dev): `npm run desktop:dev` -
1. long turn with a preview server + a request to "stop the server" | the
   guard refuses the global process kill and proposes the by-port kill; the
   sidecar survives.
2. kill -9 of the sidecar mid-turn | immediate resume of the same session |
   active spine (no `locked`), visible warning if degraded.
3. folder change on a used chat | new chat, spine of the right project.
4. steer fired at a just-finished run | `not_applied` bubble + prefilled
   composer.
5. Desktop without node reachable from the GUI process | visible error
   banner.
6. `zelari-code --doctor` on Node 20 | critical engines FAIL.

---

# 5. Out of scope (annotated, not in this plan)

- PID reuse on Windows: mitigated by the heartbeat, not eliminable without
  a boot-id (a possible future `process.boottime` as hardening).
- Dedicated tentacle-activity rendering in Desktop (the NDJSON events
  already exist via `onTentacleEvent`): a possible activity card - would
  also mitigate the 20' off-spine opacity seen in the FIX-8 case.
- Communicating the Node 24 requirement in README/GUIDA + a warning at
  install time.
