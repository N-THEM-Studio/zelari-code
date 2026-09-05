# Changelog

All notable changes to Zelari Code are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.31.0] - 2026-09-06

The "front door" release: 2.30 stops lying about the paths it already ships, and a fresh clone gets an honest path to its first verified PASS. HANDOFF Wave 5 stays frozen: no new runtime surface, no new public API, the judge untouched (ADR-0036).

### Added

- **A1 - headless honesty** - `--once` and the graph host now pass `sessionId` to the post-council hook, so the evidence lint reads the session spine on headless exactly like the TUI (the bench and headless Kraken no longer see a blinder judge).
- **A2 - budget HOLD on the Kraken path** - the session cost-budget HOLD guard runs before the provider call on the default single-agent dispatch (shared with the council path); a budget that only stopped council turns was a lying preset.
- **B1 - first-run doctor gate** - on first run the CLI executes the doctor checks before mounting the TUI, stops on the first red with the exact fix command (`/login`, `--trust`, `--fix-path`) and requires an explicitly typed continue to proceed; `collectDoctorReport()` becomes a structured print-free API.
- **B2 - plan-first** - in a workspace without a plan the first turn forces PLAN phase (no surprise writes); `/build` is the explicit override.
- **B4 - the gate teaches** - strict BLOCKED / REPAIR_REQUIRED messages always end with the next command (`/verify`, or repair the named criterion).
- **B3 - first-15-minutes walkthrough** in `docs/GUIDA.md` - one task, Plan -> Build -> Verify chip -> PASS; evolution/fitness/provenance content moves after "your first PASS".
- **C - measurement discipline** - competitive bench `--runs` defaults to 3 (free override), the record `model` is valued or `undeclared` (never a silent null), and `docs/EVALS.md` gains the half-page measurement protocol (same custom model on both sides, declared skips, no numbers outside `report.md`).

### Docs

- W5 docs ride the release line: `docs/GUIDA.md`, `docs/MEMORY.md` and `docs/decisions/README.md` are now English; README documents `ZELARI_PERMISSION_PRESET` and `ZELARI_PROVENANCE`; the EVALS per-release snapshot stays honestly BLOCKED until a real provider run exists.

## [2.30.0] - 2026-09-05

Hardening waves W0–W4 on top of the 2.29.0 constitution: the evolution loop becomes measurable, eval anchors become tamper-evident, security gains provenance escalation at the choke-point, and governance gains cost budgets with HOLD and memory decay.

### Added

- **Evolution v0.1 — the measurable loop (W1)** — the shadow ledger now appends at the end of TUI council turns as well (verdict from the verification hook, task class from the deterministic classifier, evidence tier only when smoke actually ran); `ledgerStats` gains deterministic fitness v1 — tier-weighted pass rate (`build`/`tool-output`/`command-output` = 1, `fs-observation` = 0.9, other/missing = 0.25; HOLD/UNKNOWN excluded from the denominator), steer/rollback/cost/latency aggregates and per-class fitness; `/evolve proposals` surfaces the existing proposal store read-only (event-sourced last-record fold, corrupted lines tolerated); the honesty lint finally receives real `EvidenceRef`s derived from the session spine (`tool.call`/`tool.result` → tier `tool-output`, capped at 400, fail-open).
- **Anti-Goodhart (W2)** — 7 Tier-0 anchors sealed with sha256 (`eval/anchors/sealed.json`, `npm run evolve:seal`): drift on a sealed anchor turns the principles gate red; behavioural promote rule in `evolveDecide` — `applied` with rising `avgSteerCount` or falling tier weight throws (a rule in code, not a judgment; no ledger data ⇒ explicit skip, never invented); `--rotation-candidates` lists anonymised task classes for future hold-out anchors (human authoring only, zero auto-generation).
- **Security (W3)** — provenance ring at the tool choke-point: results from web/MCP/file reads are fingerprinted and any write/execute embedding them escalates allow→ask with an explicit reason (file→execute only; file→write stays free for legitimate refactors; `ZELARI_PROVENANCE=0` disables, fail-open throughout); SSH exfil guard — allowlisted commands matching egress patterns (curl/wget, nc/socat, `/dev/tcp`, scp/rsync hops, large base64 blobs) are denied unless the target opts in with `allowExfil`; permission presets `--permissions strict|standard|yolo` (+ `ZELARI_PERMISSION_PRESET`; `standard` is byte-identical to the historical defaults; per-category env still wins in both directions).
- **Governance (W4)** — session cost budget with HOLD: `ZELARI_SESSION_BUDGET_USD`/`ZELARI_SESSION_BUDGET_TOKENS`, warn ≥80%, HOLD ≥100% blocks the provider call before the turn (history/spine intact, fail-open on invalid values), cumulative usage recorded at `agent_end`; memory audit — deterministic confidence decay (30-day half-life, floor 0.05, computed on read — history stays immutable) and mirror-negation contradiction detection, surfaced read-only via `/memory audit` (flags for review, never auto-mutates).
- **CI** — `npm audit --audit-level=high` now blocks the verify job (moderate/low stay advisory); AGENTS.MD decisions refreshed through ADR-0036.

### Changed

- **`docs/THREAT_MODEL.md` rewritten** — MCP/file/web injection and ssh exfil now mitigated-to-guaranteed with the provenance ring and the exfil guard; new open residual declared (paraphrase evasion).

### Docs

- **`HANDOFF-v2.30.md`** — cross-machine development handoff: what shipped in W0–W4, what remains (Wave 5 + declared leftovers), and how to resume.

## [2.29.0] - 2026-09-04

Evolution wave: the proposer/judge constitution (ADR-0036) lands with a mechanical gate, all runtime state moves under one root, settings become a file, the honesty lint learns to read evidence, and the Evolution Engine ships as an opt-in shadow ledger that observes but never promotes.

### Added

- **ADR-0036 — Evolution Engine: proposer/judge separation** — the governable genome (skills, role prompts, tool budgets, routing, tentacle templates, memory heuristics) is constitutionally separated from the judge (`ToolRegistry.invoke`, sandbox/jail, blocklist, folder trust, `honesty.ts`, tier ranking, Tier-0 anchors). Nothing in the loop may self-promote; `evolvePropose`/`evolveDecide` stay human-decided.
- **`JUDGE_PATHS` + `[judge]` gate check** — `verify-principles.mjs` owns an explicit judge-path list and fails CI if evolution code imports into the judge; `scripts/touches-judge.mjs` + a new PR job label `touches-judge` on any diff touching judge paths (the label is advisory — the hard guarantee is the gate).
- **P1 invariant: proposer ≠ measurer** — "the engine that proposes is not the engine that measures; no artifact can promote itself" is now in PRINCIPLES.md, which becomes English-canonical; `docs/PRINCIPI.md` keeps the Italian translation (non-normative).
- **`docs/THREAT_MODEL.md`** — 12 vectors (prompt injection via file/web/MCP, exfiltration via `ssh_run`, malicious hooks in untrusted repos, extensions, companion tokens) × the gate covering each × status guaranteed/mitigated/open, plus the "fresh clone: what loads" table.
- **`docs/EVALS.md`** — the eval method as a public contract: evidence tiers, manifest hash as validity boundary, retention gate vs stable tag, per-release snapshot convention, anti-Goodhart rules.
- **`zelari.config.json` + `--print-settings`** — schema-Zod file settings (9 knobs, all pre-existing env), precedence `default < user (~/.zelari-code) < project (.zelari/) < env`; invalid layers warn and are ignored (fail-open); `--print-settings` reports every value with its origin.
- **Evolution Engine v0 (shadow, opt-in)** — `ZELARI_EVOLUTION=shadow` appends an outcome ledger (`.zelari/evolution/ledger.jsonl`: taskClass, verdict, evidence tier, cost/latency/toolCalls, steer/rollback) at the end of headless runs — fail-open, never alters a run's outcome, default off. Deterministic bilingual task classifier (no LLM). `/evolve status` (TUI) and `--evolve-status` (headless), both read-only.
- **Evidence-backed honesty lint** — `lintSynthesisHonesty(text, evidence?)` extracts verification claims from the synthesis and clears them only against traceable `EvidenceRef`s (tool/command/fs tiers; `verifier-llm`/`human` never clear a claim — ADR-0023/0036). `RunVerificationInput.evidence` wired from the real caller; without evidence the legacy heuristic behaves byte-identically.
- **Skill lineage** — `/promote-member` stamps promoted `SKILL.md` files with `genome`/`parent` sha256 lineage (chain-extending) plus `promotedBy`/`promotedAt`.

### Changed

- **One runtime root: `~/.zelari-code/`** — the three coexisting roots (`~/.tmp/zelari-code/`, legacy `~/.tmp/anathema-coder/`, `~/.zelari-code/`) collapse into one via a one-shot, non-destructive boot migration (backup + marker, new-wins; `ZELARI_HOME` override; pre-existing env overrides still win). 38 call sites moved to shared getters; fixes the hand-built path bug in `skillSuggest`.
- **README** — council roles legend (Caronte…Lucifero, sourced from `roles.ts`), fresh-clone trust/load table, `ZELARI_HOOKS_FAILURE` documented (fail-open in TUI, fail-closed in autonomous runs).

### Docs

- SECURITY.md links the threat model and documents hook failure modes; AGENTS.MD decisions index pending `/council` refresh for ADR-0036.

## [2.28.0] - 2026-09-04

Coherence wave: version drift closed and gate-enforced, `--help` tells the whole truth, the competitive bench harness lands, and the Desktop chat gets one session stats strip.

### Added

- **Competitive bench harness — `npm run bench:competitive` (t35/t36)** — reproducible zelari-vs-competitor runs over pinned eval anchors: agent adapters (zelari headless, `codex`, `claude`, `opencode` — soft-skip with a warning when a CLI is absent), deterministic per-agent scratch workspaces, N-run median aggregation, fully offline `--dry-run`, and a markdown report pinning versions and models. Advisory-only by design: it never gates CI. Scratch cleanup is Windows-resilient (EPERM retry, never fatal to the run).
- **`--help` completeness (t33)** — the headless execution flags (`--task-file`, `--kraken-graph` + `--kraken-graph-file`, `--plan-only`, `--run-plan`, `--gauntlet`, `--once`, `--serve-harness`) are now documented in `--help`; the parser and the help text can no longer disagree.
- **Desktop: one session stats strip (t38)** — the `KrakenProgressCard` container is gone; phase, mode and live counters live in the single session strip under the chat. One context meter (the per-message footer meter is removed — it was a second, diverging proxy for the same signal). Token trio (▲▼Σ · 🛠 · ⏱) shows in the strip only while streaming; counters only when > 0 (no more `explore 0 · verify 0`).

### Changed

- **Version drift closed and enforced (t32)** — `CORE_VERSION` (`packages/core/src/version.ts`) and the core README badge are synced to the release version, and `verify-versions` now checks both (the gate was blind to them while they drifted).
- **Desktop scroll stays where you put it (t38)** — scrolling up during generation detaches follow-on-scroll on cumulative upward intent (not just a single 32px threshold); re-attach only at the true bottom.

### Docs

- **Decisions triage (t37)** — 0015 collision resolved (council-fanout trace view → ADR-0035), draft-vault `0030` renumbered to vault `016`, ADR-0017 (unified thinking effort) parked with explicit reopening conditions, and the decisions index regenerated from the real tree.
- **Hygiene (t34)** — stray planning docs archived under `docs/plans/`, `HANDOFF*.md` files marked superseded.

## [2.27.0] - 2026-09-04

Identity wave: the product now shows the contract instead of describing it.

### Added

- **The proof is now visible in the TUI** — the StatusBar gains two permanent chips: **Verifica** (`prova: PASS | RIPARA | BLOCCATO`, projected straight from the strict-gate evaluation, updated after every gate run including the post-repair re-check) and **Permessi** (what the agent may write right now: plan never writes; build declares whether proof is mandatory or explicitly opted out — declared, never hidden). When the strict gate stops a turn, the message now explains the verdict, which criteria are still unsatisfied and why the turn cannot claim done — instead of a bare passed/total line.
- **`--doctor` is now the front door** — two new checks: `provider key` (key or OAuth token resolved for the active provider, with the exact `/login` command to fix it) and `folder trust` (is the working folder trusted, with the exact `--trust` command). An all-green doctor now ends with "ready to build (sei pronto a costruire)".
- **Tentacle radio speaks the trade** — live tentacle lines show Ricognizione / Scrittura / Verifica instead of the API names explore/general/verify (the delegation API names are unchanged).
- **`docs/GUIDE.md`** — English guide covering install, first run, the plan/build/proof gesture, the status chips, permissions and folder trust.

### Changed

- **One pitch, everywhere** — README and the npm description now lead with "open-source coding orchestrator — you choose the model, the proof is mandatory"; the council is presented as a mode (a size, per P6), not the thesis. CONTRIBUTING now asks every PR to state which principle (P1–P6) it serves and what was rejected as mere Claude-Code-mimicry.
- **Wizard as a contract** — the confirm screen points at the real doors (`/login`, `/model`, `--doctor`) instead of pretending setup ends with an API key.

## [2.26.0] - 2026-09-02

Minor: plan-task hygiene wave — declared-vs-observed enforcement for `.zelari/plan.json` tasks (`files`, `reopened`/`stale`/`overlap` signals on the Kraken radio), the evolve pipeline Fase 3.0, and the ADR-0033 edit bench harness.

### Added

- **Plan task model: `files` / `completedAt` / `flags` (t56, `e78b9f1`)** — `PlanTask` gains root-relative declared globs (`files`, shared normalizer, cap 32 entries × 260 chars), set-once `completedAt` (first completion, reopen-safe) and advisory `flags` (`reopened` | `stale` | `overlap`); `task_create`/`task_update` Zod accept `files` (plus council `fileRefs` alias) and council `createTask` stubs copy them into the plan record.
- **`ToolRegistry.setToolResultListener` (t57, `b364d2d`)** — in-process post-result seam in `@zelari/core`: a sync, fail-open listener observes every executed tool result (`{toolName, toolInput, ok}`) at the same point as the Post hook. No new deps, no JSON hook protocol.
- **TaskTouchGuard — reopened guard (t58, `e2fad16`)** — cross-session declared-vs-observed guard wired once in `createBuiltinToolRegistry` (covers TUI and headless): a mutating write landing on a completed task's `files` after `completedAt` flags the task `reopened`, appends an evidence note and emits a `task_reopened` Kraken radio event (throttled one signal per task per session, fail-open).
- **Session-start staleness sweep (t59, `c2acf7d`)** — `runTaskStalenessCheck` advisory sweep: completed tasks whose declared `files` have git commits newer than `completedAt` (threshold 24h, env `ZELARI_TASK_STALE_HOURS`) get flagged `stale` plus a `task_stale` radio event; new never-throw `gitLogSince` wrapper in `gitOps`.
- **Overlap guard (t60, `8748b9b`)** — `task_create` and `task_update`→`in_progress` with globs intersecting another `in_progress` task (pure `taskOverlap` module reusing the touch-guard vocabulary) flags `overlap` with an advisory note and a `task_overlap` radio event; never blocks the call.
- **Evolve pipeline Fase 3.0 (t70, `f1999ff`)** — `evolve:validate --with-eval` measures an eval run as a first-class `requiredValidation` row (honest ✓/✗, evidence, suggested decide command; `--eval-baseline` defaults to `latest`, `--eval-command` override used verbatim); `runMeasured --fail-insufficient` turns `insufficient-n` verdicts into exit 1 for CI-style evidence rows; the default template pins `--strict --fail-insufficient --min-runs 3` (anti-fabricated-green).
- **Edit bench harness (t79, `daa8758`)** — `npm run edit:bench`: deterministic 200-patch bench (100 TS + 100 Python across 10 families, mulberry32 fixed seed) comparing the anchored `edit` arm against a legacy-relocating baseline arm built in a git worktree at `v2.23.0`; 3 reps with first-shot fixtures, post-run residual parse-check with calibration probes, raw JSON manifest plus `report.md` delta.

### Fixed

- **Registry early-return skipped the Post hook (t57, `b364d2d`)** — successful string results going through the truncate path returned early, so Post hooks (and the new listener) never saw them; the result now mutates in place and falls through, letting every executed result reach the Post hook.

## [2.25.0] - 2026-09-02

Minor: ADR-0033 hardening wave — the anchored edit protocol gains its observability and enforcement teeth: file touch events on the spine, an AST gate that auto-reverts syntax-breaking writes, and the CLI catalog finally speaks only the anchored `edit`.

### Added

- **Spine file events (ADR-0033 t75, `c7be1e0`)** — the anchored edit and `write_file` paths now emit `file.read` / `file.applied` / `file.rejected` events on the session spine (core `fileEvents` + CLI `spineFileEvents` wiring, typed in the envelope kinds): every write decision is replayable evidence.
- **AST post-apply gate (ADR-0033 t76, `c7be1e0`)** — after `edit` / `write_file` land a change, `parseFileSymbolsDiag` re-parses the file: a parse-error auto-reverts the write (the breakage never reaches disk), unsupported extensions loud-skip with a visible reason instead of silently passing.
- **Anchored-edit catalog switch (ADR-0033 t77, `c7be1e0`)** — the CLI registers the core `edit` tool (sandbox-wrapped, `verifyWrite`); `edit_file` and `apply_diff` leave the default catalog (staying blocked in plan phase for old-session replay classification); `write_file` gains the `file_exists` WriteReject guard with opt-in `overwrite`; resource claims, budget, plan gates and tool heuristics updated for the rename.

### Fixed

- **Legacy registry test updated for the t77 catalog** — `tests/unit/cli-toolRegistry.test.ts` expected the pre-ADR-0033 31-tool list (`apply_diff` + `edit_file`); now asserts the 30-tool anchored catalog.

## [2.24.0] - 2026-09-02

Minor: the eval layer (measured, evidence-gated model comparison over the spine) and the anchored edit protocol (ADR-0033) — the two threads that turn "it works" into "we can prove which model/harness variant works better" and make every edit provably anchored to a read.

### Added

- **Eval layer** (6 commits) — variance-aware measured comparison layer (stats, `measuredGate`, `eval:measured`), `--repeat N` anchor runs with an opt-in `minMeasuredRuns` retention floor, spine+skill evidence aggregator (report-only), proposal engine driven by evidence findings, decision loop with a fail-closed evidence gate, and a validation runner that executes `requiredValidation` commands. The fail-closed rule is uniform: no pass without measured evidence.
- **Anchored edit protocol (ADR-0033, t72–t78)** — every read anchors a `snapshotId` (sha256[:16] of the full pre-truncation content); `apply_diff`/`edit` reject stale snapshots WITHOUT applying and report mismatches with line number + expected/got. The task tool opens a **general⇒verify obligation** per user turn that only a parseable verify PASS extinguishes — open debt at turn end blocks strict done (exit 4) across runOneTurn/TUI/runHeadless (the compiled-done gap previously only a hint in taskTool).

### Fixed

- **Shell-backed command spawns close stdin** — `NodeShellProvider.exec` spawned `cmd.exe`/`/bin/sh` without explicit stdio, so an inherited stdin pipe could leave an accidentally-REPL'd process waiting forever (the intermittent >30s t39 native-pack timeouts on win32, where `cmd.exe /s` quoting can mangle quoted `node -e` arguments). `stdio: ['ignore','pipe','pipe']` now guarantees EOF on stdin; the t39 override command is the quoting-proof builtin `exit 1`.

## [2.23.0] - 2026-09-01

Minor: session-steer fix wave — closes the "model never answers / agent starts but stalls" family at its roots: the agent can no longer kill its own host process, orphaned session-spine locks no longer block resume, switching folder no longer drags the old project's session along, the turn watchdog is idle-based instead of wall-based, a late steer is never silently dropped, and the sidecar stderr is finally visible in the UI.

### Added

- **Anti-self-kill guard for bash/exec (`c50d594`)** — commands targeting the agent host process tree by image name (`taskkill /IM node.exe`, `Stop-Process -Name node`, `pkill -f node`, `wmic process … delete`) or by own-tree PID are denied with a tool error that teaches the safe alternative (kill by listening port); wired into both the bash and exec spawn paths.
- **Spine lock liveness takeover + append heartbeat (`df6cf63`)** — `SessionLogWriter.acquireLock` now probes the lock owner PID (`kill(pid, 0)`): a dead owner is taken over immediately instead of blocking resume for 10 minutes, and every `append()` refreshes the lock timestamp (1 s throttle) so a reused PID with a frozen heartbeat still falls back to the staleness rule.
- **Orphan lock sweep at harness server boot (`c2b91f9`)** — `runHarnessServer()` scans `.zelari/sessions/*/writer.lock` on startup and takes over locks whose owner is gone (best-effort), healing crash→restart before the user resumes.
- **Sidecar stderr diagnostics panel (`c01bb0a`)** — `harness-sidecar-log` now has a frontend listener: a collapsible diagnostics panel with a 200-line ring buffer, reachable from the chat, error lines highlighted.
- **Persisted queued follow-ups (`c01bb0a`)** — follow-ups queued at run end survive app restarts in `chatStorage` (`pendingFollowUps`) and come back as composer prefill until sent or dismissed.

### Fixed

- **Folder switch no longer rebinds the session spine (`c01bb0a`)** — picking a new folder on a used conversation now starts a new conversation bound to that folder (the old one stays in the list, folder shown as sidebar sub-heading); a virgin conversation is rebound in place as before. Kills the cross-project contamination where project A's spine and legacy context leaked into project B.
- **`already_finished` steer noop no longer drops the text (`06d2580`, `c01bb0a`)** — `send_control` now returns the steer roundtrip payload; on `already_finished` the bubble flips to a visible `not_applied` state and the composer is prefilled (no-clobber), instead of hanging on "sent" forever with the text gone.
- **Idle-based turn watchdog (`06d2580`)** — the sidecar watchdog resets on every NDJSON event for the run (default idle 600 s via `ZELARI_SIDECAR_TURN_IDLE_TIMEOUT_SECS`, min 60 s; wall cap raised to 3000 s, above the 45 min tentacle ceiling), a cooperative cancel now waits a 60 s grace window for a late `run.turn` settlement instead of discarding it, and the error message no longer speculates about network egress.
- **Locked-spine degradation is no longer silent (`11be3a9`)** — resuming a session whose spine lock cannot be taken now emits the same explicit warning as the degraded case, instead of silently running without derived context.

### Tests

- New suites: `selfKillGuard` (lethal patterns win/posix + negatives), writer takeover (dead PID / live PID fresh heartbeat / frozen heartbeat / >10 min staleness), spine lock sweep, locked-branch warning, folder-switch planner, steer noop recovery, sidecar log ring buffer, persisted follow-ups.

## [2.22.0] - 2026-09-01

Minor: Desktop reliability hardening — the end-to-end answer to "the model never answers" on clean machines. Per-turn watchdog + child recycling on the Tauri sidecar, sidecar status surfaced in the chat UI, persistent sidecar logs, connect/idle stream timeouts for the last two bare-fetch providers, and the Node ≥ 24 requirement made consistent across doctor, preflight and Desktop spawn errors.

### Added

- **Per-turn watchdog + persistent sidecar log (`c90425a`, `32b64d4`)** — a `run.turn` that never settles now fails with the typed `turn_timeout` error (default 30 min, `ZELARI_SIDECAR_TURN_TIMEOUT_SECS`, min 60 s) instead of an infinite silent spinner; every sidecar stderr line is appended to `<app_data_dir>/logs/zelari-sidecar.log` with 5 MiB one-generation rotation.
- **Sidecar status in the chat UI (`b3e02d1`, `8c4683e`)** — `harness-sidecar-status` finally has a frontend listener: a "Backend CLI" banner with the failure reason and log path when the sidecar is not ready; informational `log` statuses (non-JSON stdout lines) don't trip it.
- **Connect + idle stream timeouts for anthropic and chatgpt (`0c1034c`)** — the last two adapters that fetched with only the caller's abort signal now share the `openai-compatible` policy (connect 90 s / idle 5 min / max 30 min, SSE pings don't reset idle). Kills the infinite-hang class in the TUI, where no watchdog exists.

### Fixed

- **Sidecar stderr drain deadlock (`32b64d4`)** — a single non-UTF-8 stderr line killed the drain thread, filled the pipe and deadlocked the child; the drain now reads bytes + lossy UTF-8 and only stops on EOF/IO error.
- **Hung-child recycling (`ef468ac`)** — on `turn_timeout`, if best-effort `session.cancel` gets no answer within the roundtrip window the child is killed (tree) and the existing supervisor restarts it with backoff — a synchronous event-loop hang no longer poisons every later roundtrip.
- **Harness session leak (`66ec1c9`)** — the Desktop created a kernel session per run and never disposed it; `session.dispose` is now sent best-effort in the run cleanup (parity with the Android companion).
- **Doctor reads the real `engines.node` (`9e180ef`)** — the hardcoded `< 20` check is replaced by the actual `package.json` requirement (≥ 24; graceful fallback to 20 when unreadable).

### Changed

- **Node minimum aligned to engines ≥ 24 (`be59c3d`, `413c6f9`)** — TUI preflight (`MIN_NODE_MAJOR`) and the Desktop "node not found" message now match `engines.node`: Node 20/22 fail explicitly at boot instead of passing the preflight and failing the doctor.

### Tests

- New `adapters-timeout.test.ts` (4: connect abort ×2, idle watchdog, SSE pings don't reset idle); prereq suite updated for the 24 floor (15 passing); doctor suite green (3). `cargo check`, root and desktop `tsc --noEmit` clean.

## [2.21.0] - 2026-09-01

Minor: native Unreal Engine 5.8+ MCP support — the first non-stdio MCP transport (Streamable HTTP), the `unreal-mcp` preset and the `unreal-editor` builtin skill. Zero new dependencies (P5: `fetch` + minimal SSE parser).

### Added

- **MCP Streamable HTTP transport (`src/cli/mcp/httpTransport.ts`)** — the MCP client speaks HTTP alongside stdio: POST JSON-or-SSE responses, `Mcp-Session-Id` header, automatic re-handshake + call replay on session loss (404), `nextCursor` pagination on `tools/list`, per-request abort, DELETE on close. Config v2 per server: `type` (`stdio`|`http`), `url`, `timeoutMs`, `serial` — wired into `--set-mcp` (`--url`, `--timeout`).
- **`unreal-mcp` preset** — `zelari-code --set-mcp-preset unreal-mcp` (endpoint override `UNREAL_MCP_URL`) connects to UE 5.8+'s in-editor MCP server (loopback Streamable HTTP, protocol `2025-03-26`): 120 s timeout, serial call queue (no overlapping calls on the game thread). HTTP servers unreachable at discovery stay pending and are retried every turn — the editor may start after zelari.
- **`unreal-editor` builtin skill** — teaches the UE Tool Search discovery path (`list_toolsets` → `describe_toolset` → `call_tool`), the serial-call rule and the not-yet-running-editor failure model.

### Tests

- New `cli-mcpHttp.test.ts` (7) against a real `node:http` fake server: handshake + session header, cursor pagination, SSE responses, 404 re-init + replay, serial queue (max 1 in-flight call), per-server timeout, pending-HTTP retry. Existing stdio suite (7) green; `tsc --noEmit` clean.

## [2.20.0] - 2026-08-31

Minor: closes the post-2.19 residuals — provider-side output ceiling for grok conversation calls, ask-by-default EXECUTE/NETWORK permissions with resource claims in the picker, and pressure-aware memory retrieval with skill catalog gating.

### Fixed

- **Grok conversation truncation — root cause (`18d9c9a`)** — `openai-compatible` conversation calls sent no `max_tokens` (only callers passing `generation.maxTokens`, e.g. compaction, set one), so grok-4.x hidden reasoning ate the provider-default completion budget and visible output arrived truncated — every affected session paid a recovery turn. New opt-in `maxOutputTokens` provider capability (`GROK_CAPS`: 32 768) now caps conversation calls; `ZELARI_MAX_OUTPUT_TOKENS` overrides at runtime; explicit `generation.maxTokens` always wins. Billing stays per actual tokens — the cap removes the recovery-turn tax, not token cost.
- **Ask flow no longer shows bare categories** — the permission ask handler now always receives the expanded resource claims (even with no policy layers — never categories alone) and the matched rule as `policyNote`; the picker renders `Claims: · process: git push origin main` plus the `[policy]` rule note above the prompt.

### Changed

- **EXECUTE/NETWORK default to `ask` (`480cdb4`)** — `ZELARI_PERMISSION_EXECUTE` / `ZELARI_PERMISSION_NETWORK` flip `allow` → `ask`; read/write stay `allow` (covered by folder trust + sandbox). Escape hatches unchanged: env allow, `ZELARI_AUTO=1`. Headless and sub-agents are unaffected (explicit policy or `auto: true`).
- **Pressure-aware retrieval (`4c4fbf8`)** — the CLI budget pipeline (ADR-0032 canonical compiler) resolves a retrieval policy per turn from measured occupancy: bands at 0.5/0.8 tighten memory packing (2000/1200/600 chars, 8/6/4 items) and bias scoring toward precision via the new optional `RecallQuery.weights` (the core stays pressure-blind by design — it only receives resolved weights). Under high pressure, high-cost skills (`estimatedCost: 'high'`) are hidden from the tool catalog but remain loadable by name — capability preserved, spend gated.

### Tests

- New/extended: `cli-openai-compatible-profiles` max_tokens regression (2), `budget/retrievalPolicy` (6), `cli-skillTool` catalog gating (1), `cli-toolPermissions` default-ask anti-regression + escape hatches, new `cli-permissionPickerClaims` (3), permission-policy injections across the jail/exec suites. Full suite green at release: 420 files / 4119 tests passed, 1 skipped; `tsc --noEmit` clean.

## [2.19.0] - 2026-08-30

Minor: closes the T4 thread (ADR-0032) — the budget pipeline's occupancy lands on the session spine as additive `context.projection` fields, with the first consumers (`zelari inspect` + Desktop panel) and late-binding spine holders on the headless hosts.

### Added

- **Budget occupancy on the spine (t51/t52)** — single `budgetNoteHandle` seam in `modelContextBuilder` (1 definition, 4 wire-ups: one-turn, council, mission, kraken-graph): every projection emits a `context.projection` note carrying the budget-side fields (`occupancy` fraction, `policy`, `limit` in chars) alongside the existing memory-side fields (`contextChars` / `returnedCount`, disjoint writers on the same subject). `SCHEMA_VERSION` stays 1.
- **Late-binding spine holders** — headless hosts type the memory sink holder as `LateBindingSpineHolder` and, after the spine binds, flush the buffered telemetry notes (cap 32, `droppedEvents` counter) instead of silently dropping them when memory is created before the spine exists. Never auto-flushes on the TUI path.
- **Occupancy in the consumers (t54)** — `zelari inspect` Support lens renders the last budget tail (`(last: 62% warn (limit 200k))`); Desktop `HarnessStatePanel` extracts and displays `lastOccupancy` / `lastPolicy` / `contextLimit` from the last budget record.

### Fixed

- **`deriveHarnessState` parses projection notes (t50)** — new never-throw `parseProjection` in the spine read-model; closes the TS2304 compile break left by the resource-gated turn and aligns the `durationMs` assert.

### Tests

- T4 suites: 10 files / 99 tests; `test:session` 15 files / 101. Full suite green at release: 418 files / 4105 tests passed, 1 skipped; `tsc --noEmit` clean (root + desktop).

## [2.18.1] - 2026-08-31

Patch: three harness feedback fixes from the 2.18 incident postmortem (resource-gate exhaustion on a BUILD turn + provider-truncated `---TOOLS---` block). The recurring class: the harness instructing the model to do what another harness layer denies, or failing silently where the model believes it acted.

### Fixed

- **Hard-limit denials no longer advise gated verification actions (t47)** — the two gate denial sites appended "Prioritize verification/repair actions" unconditionally, but at the `maxToolCalls` hard limit every call is denied, verification included; the model obeyed the advice and burned the turn retrying guaranteed denials (incident spine: tsc denied immediately after a hard-limit denial). Protected-zone denials keep the advice (essential tools are still allowed there); hard-limit denials order finalization. `toolCallGate` return type widened with `hardLimit?: boolean` (already produced by BudgetRuntime and propagated by `sessionSpine.gateResourceToolCall`).
- **Build-liveness recovery skipped when the gate is exhausted (t48)** — `planBuildRecovery` re-entered with `toolChoice: 'required'` after a zero-mutation stop, forcing tool calls the gate guaranteed to deny (incident: two recovery turns, 6m16s of reasoning). Recovery now probes the gate with `edit_file` (essential-set: denied only at the hard limit or on a fail-closed gate crash) and skips, letting the zero-mutation stop surface honestly via `build_liveness_stalled`. Inert when no gate is configured.
- **Truncated `---TOOLS---` blocks salvaged and reported (t49)** — a block cut before `---END---` (provider truncation) matched no parse branch: every salvage strategy sat behind the closing marker, so complete prefix calls were lost with the tail. `parseTextToolCallsDetailed` runs the same strategies on the partial body: complete prefix calls execute, the truncated tail is dropped (auto-closing a cut string argument would write garbage). `extractToolObjects` scans args brace-balanced/string-aware — the old non-greedy regex silently pushed calls with EMPTY args on nested objects; unparseable args now skip the call. The model is no longer blind: `text_tools_parse_failed` / `text_tools_truncated` advisory events carry a distinct truncated-vs-malformed message, and the feedback note reaches the model context on both paths (rolling-history push + `sessionSpine` `user.message` mirror, same contract as the `tool_call_truncated` guidance).

### Tests

- New suites — `agentHarnessToolGate` hard-limit section (3), `agentHarnessBuildLiveness` gate-exhausted skip (1), `agentHarnessTextToolsFeedback` (3), `core-parseTextToolCalls` truncated-block section (5), `sessionSpine` text-tools mirroring (2). Full suite green at release: 417 files / 4094 tests passed, 1 skipped; `tsc --noEmit` clean.

## [2.18.0] - 2026-08-31

Minor: closes the declared 2.17 debts — ADR reconciliation, an honest spine contract on graph runs, the first `harness_state` consumers (CLI + Desktop), and two harness fixes (grep `include` semantics, truncated tool-call recovery).

### Added

- **`zelari inspect <session-id>`** — first CLI consumer of `harness_state`: per-turn verdict with `unknown ≠ pass` blockers, Support lens (context projections / memory events / compactions), `--json` output, not-found exits 1 without a stack trace. Bare `zelari inspect` keeps the existing env-inspect behavior.
- **Desktop `HarnessStatePanel`** — first GUI consumer of `harness_state`: the sidecar recognizes the final NDJSON event per session and emits a Tauri `harness-state` event; defensive `normalize.ts` (unknown ≠ pass), `useHarnessState` subscription, panel mounted after `VerificationStatusCard`; absent state renders nothing.
- **Spine v1.1 graph node envelope** — `graph.node_started` / `graph.node_ended` state-only event pair per node attempt (`nodeId`, `agent`, `ok`, `durationMs`); zero model content on the spine; tolerant replay keeps `SCHEMA_VERSION` at 1; `merge` nodes stay radio-only. Replaces the envelope-only special case in ADR-0024.

### Changed

- **ADR-0024 amended (v1.1)** — the graph host is now a spine hot path with a measurable per-node envelope contract (closes the H1 self-contradiction on graph runs).
- **ADR-0031 / ADR-0032 promoted** from the council vault to `docs/decisions/` (recall asymmetry is deliberate; budget pipeline is the canonical projection compiler); AGENTS.MD decision index refreshed to real accepted state.

### Fixed

- **grep_content `include` semantics** — include globs without `/` or `**` now also match the file basename at any depth (parity with `grep -r --include`); path-anchored globs unchanged; `scopeWarnings` and the tool description realigned. Previously `*.md` matched only root-level files while omitting the parameter matched everything — a silent trap for every agent.
- **Truncated tool-call recovery** — a `tool_calls` finish reason with zero complete calls no longer leaves the model blind: after the forced stop the harness injects the recovery guidance into the model context (fallback history) and a `user.message` spine note, XOR-guarded against duplication. First-ever test coverage of this path (4 tests).

### Tests

- Full suite green at release: 416 files / 4080 tests; new/updated suites — `v4-walk`, `search`, `core-agentHarness-toolCallTruncated`, `sessionSpine`, `krakenGraphSpine` (differential honest pin), `inspectSession` (7), `harnessState/normalize` (5), Rust sidecar classifier (4, `cargo check` clean).

## [2.17.0] - 2026-08-30

Minor: wiring-first release - the session spine now sees every headless host, projection decisions are measurable, and HarnessState v1 (read-model + Turn Completion Contract) ships on all four hosts. Closes the W1-W6 wiring gaps and t37 (LSP anti-thrash).

### Added

- **HarnessState increment 1-3** - typed read-model over the session spine (`deriveHarnessState`/`readHarnessState`, pure O(n)) with a Turn Completion Contract enforcing ADR-0023 (`unknown ≠ pass`, `verification-verdict-BLOCKED` blocker) and a Support lens fed by the new telemetry. Consumed as the final `harness_state` NDJSON event on all four headless hosts (one-shot, council, mission, graph); read failures degrade to a stderr warning and never touch the exit code.
- **Projection telemetry (W2)** - per-turn `context.projection` note (contextChars, returnedCount) and `memory.recall_end`/`memory.consolidate_end` wired on every call site (TUI chat/council, runOneTurn, headless council/mission, kraken graph TUI, `/kraken graph` slash, mission fileBackend). Invariant, test-asserted: memory contents never land on the spine.
- **Steer over HTTP** - companion server exposes `POST /v1/runs/:id/steer` (400 on missing/malformed text, 404 mirroring cancel) routed to the live turn's control queue via NDJSON `session.steer`.
- **Headless `--mission-strict` / `--no-mission-strict`** knobs.

### Changed

- **Kraken-graph on the spine (W1)** - `runHeadlessKrakenGraph` opens the session log (mode kraken, resolved workspace), gates `session.started` on `--output json`, and closes it on every exit (completed/error/cancelled on SIGINT); spine failures never change the exit code. ADR-0024 is no longer bypassed by default-on graph runs.
- **Strict knobs via per-invocation env overlay** - `ZELARI_STRICT_DONE`/`ZELARI_MISSION_STRICT` are threaded through `options.env` into the strict build gate instead of mutating `process.env` (race-prone on the concurrent sidecar).
- **Desktop strict-done default aligned with the CLI (W6, post QA t21)** - `DEFAULT_DESKTOP_PREFS.strictDone = true` (ADR-0025); the sidecar no longer pins `ZELARI_STRICT_DONE=0`. Persisted explicit `false` stays opt-out.
- **Session spine vocabulary cleanup (W5)** - removed dead event kinds `kraken.task`, `context.injected` (zero writers) and `session.harness_drift` (zero readers); tolerant replay preserved; the 1.x mirror removal TODO is re-planned with explicit preconditions. ADR-0031 (recall asymmetry is deliberate, opt-in measurable) and ADR-0032 (budget pipeline is the canonical projection compiler) recorded, promoted from the council vault to `docs/decisions/`.

### Fixed

- **Policy gate spine location + one-shot warning** - `recordPolicyLoadBlockedOnSpine` receives the resolved workspace so the spine lands under `<workspace>/.zelari/sessions` (was: the CLI cwd); the one-shot emits a single `[policy]` stderr line while the sidecar keeps gating every turn.
- **LSP multi-workspace thrash (t37)** - `getSharedLspManager` kept one `{cwd, manager}` slot, so switching roots disposed the previous manager and respawned every language server. Now a `Map<resolvedRoot, LspManager>` reuses stable instances per root, and the kernel sidecar threads its per-workspace `lspManager` into serve turns (`instanceof`-guarded; fake `{dispose}` falls back to the per-root map). `ZELARI_LSP=0` and `lspProvider: null` opt-outs unchanged.

### Tests

- Sidecar lifecycle contract (spawn/reap/backoff constants, `sidecar_died` sites, no `--headless` fallback), strict exit-4 e2e via runOneTurn (BLOCKED provenance through NDJSON), harness_state emission, LSP per-root reuse + dispose-all, desktop prefs flip with a grep-gate against re-pinning the env var.

Patch: tentacle budget resets every Desktop message.

### Fixed

- **Desktop tentacle spawn cap** — `ZELARI_KRAKEN_MAX_TASK_SPAWNS` (default 6) is per parent *turn*, but the sidecar never called `resetTaskSpawnCount()` (`runHeadless` only). After six `task` spawns in the process lifetime further tentacles failed and the lead fell back to lead-only. Reset at `dispatchHeadlessTurn`.

## [2.16.4] - 2026-08-30

Patch: Desktop Kraken tentacles on the sidecar.

### Fixed

- **Desktop Kraken tentacles** — sidecar `run.turn` kept `mode: "agent"` (Rust mapped `kraken`→`agent`) so selection/delegation playbooks gated on `mode === "kraken"` never loaded; the lead ran alone. Canonicalize `agent`→`kraken` and forward Kraken model + delegation fields per turn.

## [2.16.3] - 2026-08-30

Patch: Desktop sidecar honors the Open Folder workspace.

### Fixed

- **Desktop sidecar workspace** — 2.16.0's long-lived `--serve-harness` child is spawned without `current_dir`, and `createCliRunTurn` ignored `session.create`'s `workspaceRoot`. Tool search, memory, session spine and the "You are running in" prompt all used the Tauri exe directory (`Z:\Zelari Desktop` on Windows) instead of the Open Folder project. `opts.cwd` now threads that root through every dispatch path (kraken / council / zelari / graph / gauntlet) without `chdir`, so parallel sessions on different folders stay isolated. Desktop UI surfaces (file tree, Memory panel) were already using the conversation cwd — the split-brain was agent-only.
- **Desktop sidecar dispatch** — `createCliRunTurn` always called `runOneTurn` (kraken single-agent), so council / zelari / graph / gauntlet never hit their `runHeadless` loops. They now go through `dispatchHeadlessTurn` (no process-fatal handlers).
- **Headless policy gate** — strict `policy.json` load runs before API-key resolution again. The 2.16.3 dispatch extraction returned exit 1 (`no API key`) instead of 2 (`policy-load-failed`) when a broken policy file was present.

## [2.16.2] - 2026-08-29

Unblocks npm publish after 2.16.1 CI failed on a flaky memory test (2.16.1 was never published).

### Fixed

- Concurrent SQLite memory WAL test: single-digit ids (`0`–`9`) were dropped by `memoryTokens` (min length 2), so exact-content dedupe collapsed writers and Linux CI saw 26/30 nodes.

## [2.16.1] - 2026-08-29

Patch for the Desktop 2.16.0 harness sidecar handshake.

### Fixed

- **Desktop harness sidecar** — spawn now passes `--serve-harness` (and `ZELARI_SERVE_HARNESS=1`). 2.16.0 launched the interactive TUI instead, so the first stdout line was PluginGate's "Checking for optional tool plugins…" and the handshake failed with `harness sidecar unavailable`.
- **CLI sidecar recovery** — empty-argv + Desktop sidecar env fingerprint (piped stdio, `ANATHEMA_DEV` + `ZELARI_SKIP_PREFLIGHT` + `ZELARI_MEMORY_V2`) starts the NDJSON server even without the flag, so an already-installed 2.16.0 Desktop works after updating the CLI.
- **PluginGate first paint** — `skipGate` no longer emits the detecting spinner on the first Ink frame (piped / non-TTY).

## [2.16.0] - 2026-08-29

Kernel hardening release (HARNESS-10): fail-closed autonomous runs, an OS-level jail choke-point around process tools, and a single long-lived Harness App Server.

### Added

- **OS jail choke-point (`spawnJailed`)** - `src/cli/safety/osJail.ts` + `jails/{darwin,linux,win32}.ts`. `JailSpec` derives from the already-intersected claims/contract/layers (root = sandboxed workspace, network deny/allow from host claims, env allowlist, writable = root + tmpdir + `~/.zelari-code`) — no second policy engine. `ZELARI_OS_JAIL=off|advisory|required`; when `required` and the OS backend is unavailable the tool is **DENIED**, never silently downgraded (win32 is honestly unavailable today). `exec_process` no longer calls raw `child_process`; blocklist stays as defense-in-depth. CI grep-gate `scripts/verify-os-jail.mjs` fails if a raw spawn reappears on the jailed paths.
- **Harness App Server (`--serve-harness`)** - `packages/core/src/harness/appServer.ts` (kernel, no React): long-lived server, N sessions, per-workspace refcounted services (one `LspManager`/policy cache/proof writer per root, reused across sessions); proof writes are never cancelled by a client disconnect. `src/cli/serve/harnessServer.ts` speaks NDJSON over stdio on the unchanged headless protocol v2; `session.steer`/`session.cancel` are session-scoped. `runOneTurn.ts` extracted from `runHeadless.ts` as a reusable library (zero behavior change).
- **ExtensionAPI seam (not a plugin framework)** - `packages/core/src/harness/extensionApi.ts`: `registerTool` (same Zod + permissions path as builtins — ContractCompiler remains the last intersect), `onPreToolUse`, sandboxed-FS only (no process/net). Loads from `~/.zelari-code/extensions` and from trusted-project `.zelari/extensions`; `extensions.lock` sha256 verified before import (batch-reject in strict mode, warn+skip in TUI); kill switch `ZELARI_EXTENSIONS=0`. Extension hook crashes deny with `extension-hook-failed` in fail-closed surfaces.
- **Post-execute source diagnostics** - tools with write/execute permissions trigger LSP diagnostics on claimed source paths after `execute` (same channel/timeout/opt-out as the edit loop), so edits made via an interpreter no longer stay blind.
- **Desktop harness sidecar** - `apps/desktop/src-tauri` talks to one long-lived `--serve-harness` sidecar (supervisor, restart backoff); the 4 parallel runs become 4 sessions on the same server; typed errors and `harness-sidecar-status` events instead of silent `--headless` fallback; shutdown drains pending completion proofs before killing the process tree. Companion `runManager` gains client mode behind `ZELARI_HARNESS_SERVER=1` (default spawn behavior byte-identical).

### Changed

- **Hooks fail-closed in autonomous runs** - `HookFailureMode` (`fail-open|fail-closed`): in strict policy-load surfaces (headless/mission/CI) a PreToolUse crash, timeout, invalid JSON, or deny without reason now **DENIES** the call (`hook-failed`) instead of allowing it; the empty catch around `runPreToolUse` in `ToolRegistry.invoke` is gone. `ZELARI_HOOKS_FAILURE` overrides; TUI stays allow+log.
- **completionGate catch no longer opens the gate** - a thrown gate evaluation returns `BLOCKED` with `unknownChecks` (strict-done exit 4), not `OPEN_GATE`. Budget exhaustion stays `BLOCKED` as before; the two paths are no longer conflated.
- **toolCallGate throw no longer fail-opens** - same `HookFailureMode` wiring: gate throw ⇒ DENY (`gate-failed`) in fail-closed runs, allow+log in TUI.
- **bash joins the contained-spawn paths** - CLI `bash` resolves its cwd through `resolveSandboxedPath` (missing cwd ⇒ workspace root, never the raw process cwd) and the builtin spawns `/bin/sh -c` / `cmd.exe /d /s /c` with `shell:false` via an injected `spawnSeam`. `LifecycleHookRunner.execCommand` drops `shell:true` for explicit argv (`splitHookCommandLine`).
- **Companion CORS allowlist** - `access-control-allow-origin: *` removed; origins must be allowlisted (`ZELARI_COMPANION_ALLOWED_ORIGINS`, loopback-only default); non-browser clients unaffected.

### Fixed

- Stale `@zelari/core/harness` mock in headless tests missing `ExtensionRegistry` (4 broken tests after the extension loader wiring).
- `wrapWithSandbox` now calls the existing `verifyContainment` before write/edit/apply_diff execute (junction/symlink escapes deny with a typed error and are audited).

## [2.15.0] - 2026-08-29

Desktop experience release: the headless control plane reaches the chat UI.

### Added

- **In-run steering (Desktop)** - the composer stays live while an agent/council run is in flight on a protocol-v2 CLI: submitting sends a `steer` control event instead of queuing a new task. Steer bubbles track the ack cycle (`sent → accepted → applied`, or `rejected`) and never claim success before `control_applied` (§24). Capability-gated on `protocol_info`: old CLIs keep the previous disabled-composer behaviour.
- **Follow-up handoff (Desktop)** - steers that arrive after the run ends are surfaced by the CLI as `follow_up_queued`; the UI shows the queued text in chat and prefills the composer (never overwriting what the user is typing).
- **Memory on by default in Desktop runs** - `run_task` now sets `ZELARI_MEMORY_V2=1` for spawned CLI children (explicit user opt-out `ZELARI_MEMORY=0`/`ZELARI_MEMORY_V2=0` still wins), so the Memory panel finally reads a live archive instead of a permanently empty store. Empty-states differentiate "store empty" vs "type a query" vs "no matches".

### Changed

- **Settings redesign (Desktop)** - 48 → 12 files: six focused sections (General, Models & Providers, Agents, Extensions, Connections, System), autosave with per-control busy/toast feedback, shared primitives (`SettingsCard`, `SettingsRow`, `Toggle`, `SelectInput`, `StatusPill`), token-based `settings.css` with complete light theme, `Esc` closes and `Ctrl/Cmd+,` opens settings. Provider/agent prefs now save through granular callbacks instead of a global Save button.
- **Chat performance (Desktop)** - `content-visibility: auto` on concluded assistant messages and `overscroll-behavior: contain` on the chat column.

### Fixed

- Settings layout: broken flex chain (`app-settings-body`) left sections unscrollable and clipped; header spacing; stale dark-nav override beating the new skin.
- Settings tooltips near viewport edges were clipped; placement is now measured (`flip-left` / `drop-below`).
- Light theme: memory panel selects rendered white-on-white (missing `--panel` token, unwired `--option-*` vars); option popups now follow the active theme everywhere.
- `--set-config` / `set_app_config` error message now says "provide at least one of …" instead of implying all flags are required.

## [2.14.0] - 2026-08-27

Releases B, C and D of the authority &amp; verification roadmap: policy loading
is fail-closed wherever the harness runs autonomously, every tool declares its
resource claims, shell rules survive wrapper tricks, verification speaks six
ecosystems, Completion Proofs are transaction-grade attestations, the
TaskContract compiles into capability policy and verification plan, reviewers
are picked by risk, and the scheduler arbitrates file/semantic ownership,
worktrees, model reputation and spawn ROI.

### Added

- **Strict policy loading (P0.B)** — `PolicyLoadMode`: headless, mission and CI default to `strict`, where a malformed policy file blocks execution with a machine-readable `PolicyLoadError` (exit 2, `policy-load-failed` NDJSON event, BLOCKED event on the spine). Interactive TUI stays `permissive` (warning). Override with `ZELARI_POLICY_LOAD_MODE`.
- **Resource claims policy engine (P0.C1)** — every tool declares `ResourceClaim`s (path / process / network / mcp / ssh); `policy.json` v2 adds `claims` matching (v1 rules still honored); all claims are evaluated before execution and intersected restrict-only; subagent capabilities are a subset of the parent's. `apply_diff` now checks **every** `---`/`+++` header path.
- **Structured process tool `exec_process` (P0.C2)** — spawns without a shell; raw-shell commands are normalized best-effort (`env X=…`, `command`, `bash -lc`, `cmd /c`) so a `git push* = deny` rule can no longer be bypassed by `env FOO=x git push`. Executed commands are audit-logged for the Completion Proof.
- **Symlink-safe sandbox (P0.D)** — `resolveSandboxedPath` resolves the nearest existing ancestor via realpath and case-folds on win32/darwin (junction cross-drive rejected); `verifyContainment()` closes the check→write swap race at the choke-point.
- **Multi-ecosystem verification adapters (P1.A)** — deterministic plans for Node (npm/pnpm/yarn/bun detected via `packageManager` + lockfile), Python (pytest / ruff / mypy when configured), Rust (cargo check/test/clippy), Go (go test/vet), Java (Gradle wrapper-aware, Maven) and .NET (dotnet test/build). Missing checks never fabricate failures.
- **Transaction-grade Completion Proof (P1.B)** — atomic persistence (tmp → fsync → rename); `required` mode in headless/mission (PASS without a persisted proof ⇒ BLOCKED); JSON v2 wrapper carries the spine evaluation verbatim plus sha256 attestations (commitSha, diff, contract, verification plan, harness manifest, self-sealing proof digest); `validateCompletionProof` verifies offline.
- **TaskContract compiler (P1.C)** — contracts gain `scope` (`allowedPaths`/`forbiddenPaths`) and `risk`; allowed paths compile into capability rules intersected **last** at the tool choke-point; `verificationHint` acceptance criteria compile into deterministic verification criteria in the same CompletionPolicy (ADR-0030).
- **Risk-based verifier routing (P1.D)** — low risk ⇒ deterministic verification only; medium ⇒ cheapest cross-family reviewer; high ⇒ strongest cross-family reviewer; critical ⇒ two independent reviewers from two families distinct from the builder, pessimistic merge, divergences recorded as evidence. Reviewer input stays blind to builder narration.
- **Adaptive orchestration v2 (P1.E)** — `OrchestrationDecision` replaces the no-op `automatic` delegation policy: six strategies (lead-only → mission), deterministic rule table first, confidence/rationale/latency estimates, decision telemetry on the session spine.
- **File ownership arbitration (P2.A)** — writer tentacles carry scope globs; overlapping admissions are deferred (not failed) until the owner finishes; case-fold aware on win32/darwin.
- **Semantic ownership (P2.B)** — same-file parallel writes allowed when owned symbols are disjoint (AST-injected, fail-closed when symbols are undeclared).
- **Worktree scheduling (P2.C)** — `ZELARI_KRAKEN_WORKTREE=auto`: low overlap ⇒ parallel worktrees, high overlap ⇒ sequential execution, estimated before spawning.
- **Transactional tentacles (P2.D)** — opt-in `ZELARI_KRAKEN_TRANSACTIONAL=1`: checkpoint → run → PASS keeps a correlated recovery point, FAIL restores and drops it; restore failures are reported honestly.
- **Model reputation (P2.E)** — per-model verified-solve metrics with 30-day half-life in an append-only JSONL store; verifier routing consults reputation **only inside** cross-family pools (routing rules unchanged, fallback identical).
- **Spawn ROI controller (P2.F)** — every spawn is scored `expectedGain / (cost + latency + duplicationRisk)`; low-score spawns are deferred (not failed) with telemetry; fail-open on missing data.

### Changed

- `ZELARI_KRAKEN_WORKTREE` gains the `auto` value (`1` / off unchanged); strict policy loading is the new default for headless, mission and CI.

### Fixed

- **`applyTaskContractUpdate` dropped new fields on steer** — the update helper rebuilt the contract without spreading unknown fields, silently discarding `scope`/`risk`; now preserved.
- **Completion proof adapter mirror** — `completionProofProbe` no longer hardcodes a stale adapter list; a tripwire test fails when the registry and the probe diverge.

## [2.13.0] - 2026-08-27

Policy layers can only tighten permissions, writer tentacles get 45 minutes,
and Windows CRLF files stop breaking `edit_file` / `apply_diff`.

### Added

- **Policy layering restrict-only (P0.A)** — global (`~/.zelari/policy.json`) and project (`.zelari/policy.json`) rules are evaluated as **separate layers**. Matched effects intersect most-restrictive-wins (`deny > ask > allow`), so a project `allow` can no longer mask a global `deny` or `ask`. Escape hatch: `ZELARI_POLICY_PRECEDENCE=legacy` restores the v1 concatenate / first-match-wins behavior.

### Changed

- **Kraken writer tentacle timeout 15 → 45 minutes** — `TASK_TOOL_TIMEOUT_MS` (and the aliased graph writer budget `DEFAULT_WRITER_NODE_TIMEOUT_MS`) is now 2_700_000 ms. Explore/verify stay at 5 minutes. Override with `ZELARI_KRAKEN_WRITER_NODE_TIMEOUT_MS` / `ZELARI_KRAKEN_NODE_TIMEOUT_MS`.

### Fixed

- **`edit_file` / `apply_diff` on Windows CRLF files** — matching is newline-agnostic (model LF vs file CRLF) and the original terminator is restored on write, so a working-tree CRLF file no longer fails with `no match for oldString`. `apply_diff` also relocates hunks whose `@@` line numbers drifted after an earlier insert; ambiguous equally-close matches still refuse to guess.

## [2.12.0] - 2026-08-26

Harness Hardening: deterministic verification becomes the default.
"Models propose, harness proves" is now the shipped behavior of every
Kraken BUILD turn, and the harness keeps proof of it.

### Added

- **Completion Proof** — every turn evaluated by the strict gate writes ".zelari/completion-proof.md" (+ ".json") with gate outcome, criteria evidence, changed files and verifier verdicts; the JSON payload mirrors the session-spine "verification.run" event (no duplicated state). Renderer is deterministic and write failures never break the turn.
- **Tentacle capability inheritance** — kraken sub-agent registries now intersect the parent permission policy (deny > ask > allow per category, "auto" as AND); a child can never exceed the lead. Fail-closed at the existing enforcement seam.
- **Policy engine v1** — optional ".zelari/policy.json" (project) and "~/.zelari/policy.json" (global) with per-agent rules ("lead|explore|general|verify"), per-command and per-path glob patterns ("git push*", "src/**"), first-match-wins, effects allow/ask/deny. "ask" degrades to deny without an approval handler; an invalid policy file warns and is ignored, never crashes; opt out with ZELARI_POLICY=0.
- **Blind verifier v2** — the independent completion reviewer receives the original task, a git diff summary and a test-output excerpt instead of the builder narration (no builder reasoning, no synthetic summary as the only input). Adds cross-family model selection helpers (inferModelFamily, pickDifferentFamily, resolveCrossModelVerifier); the verify tentacle resolves a qualified "provider/model" ref when candidates exist.
- **Orchestration policy "auto"** — pure chooseOrchestration() tiers (solo -> tentacles -> graph -> council) from task shape; headless "--mode auto" parses and logs the choice, fail-closed to solo. No behavior change without the flag.
- **Eval gate: verified solve rate** — optional minVerificationGatePassRate retention policy (0-1) rejects a candidate whose verified solve rate is below threshold (fail-closed when not measurable); reports gain a "Verified solve rate" line; two new strict-gate anchors (strict-gate-completion-proof, strict-gate-false-done). Existing presets unchanged.

### Changed

- **Strict done gate ON by default on the Kraken surface** — was opt-in (ZELARI_STRICT_DONE=1); opt-out with ZELARI_STRICT_DONE=0 (or "false"). Unanchored completion claims stay BLOCKED by default.
- **Criteria pack v1 ON by default** — typecheck/test/build run as deterministic gate criteria, auto-unbinding on repos without the npm scripts (no false blockers); opt-out with ZELARI_VERIFY_PACK=0 (or "off"/"false").
- Docs: GUIDA and "--strict-done" help text now describe the new defaults and opt-outs.

## [2.11.2] - 2026-08-26

### Added

- **Kraken cross-provider model routing** — qualified refs `provider/model` (e.g. `glm/glm-4.7-air`) in `ZELARI_KRAKEN_EXPLORE_MODEL` / `ZELARI_KRAKEN_GENERAL_MODEL` / `ZELARI_KRAKEN_VERIFY_MODEL` / `ZELARI_KRAKEN_PLANNER_MODEL` / `ZELARI_KRAKEN_SUB_MODEL` now route tentacles and the Graph planner to a different provider, resolved with its own credentials and base URL. Unqualified ids keep the previous behavior (lead provider); refs whose prefix matches no configured provider fall back to the raw id. New `parseQualifiedModelRef()` in `krakenModel.ts`; split applied in `toolRegistry.ts` (tentacle stream), `planner.ts` and `scriptPlanner.ts`.
- **Desktop — cross-provider model selects** — the four Kraken model selects in Settings now render one optgroup per configured provider (active provider keeps unqualified values for backward compatibility), so Explore/General/Verify/Planner can target models of other logged-in providers without changing the lead.
- **GUIDA** — documented `ZELARI_KRAKEN_DELEGATION`, qualified `provider/model` refs and the planner precedence (env wins over the forwarded lead model) in the Kraken env table plus a new "Routing dei modelli" section.

## [2.11.1] - 2026-08-26

### Fixed
- **Kraken Graph Planner model precedence** — ZELARI_KRAKEN_PLANNER_MODEL now wins over the lead model forwarded by headless/Graph callers. New shared resolveKrakenPlannerModel() used by both planner.ts and scriptPlanner.ts; until 2.11.0 the Settings value was silently ignored because runHeadless always forwarded the lead model as opts.model.

### Added
- **Kraken Delegation Policy** — new ZELARI_KRAKEN_DELEGATION=automatic|prefer|aggressive|lead-only prompt playbook injected into Kraken/Zelari lead turns (automatic leaves the prompt unchanged). Desktop Settings → Kraken gains a Delegation policy select wired through RunTaskArgs → Tauri env ZELARI_KRAKEN_DELEGATION.

## [2.11.0] - 2026-08-25

Frontier Runtime Upgrade: one shared runtime for Kraken, Council and Zelari
gains an observer/intervention layer, a bidirectional headless control plane,
tentacle activity telemetry, per-role context projection, a run flight
recorder and an A/B eval harness. No new orchestration mode.

### Added

- **Runtime observer bus** (`@zelari/core`, `ZELARI_RUNTIME_OBSERVERS=1`) — priority-ordered observers with per-observer failure modes (`ignore`/`warn`/`fail-closed`) and cooperative interventions (`deny_tool`/`stop`/`inject`/`retry`/`replace`) applied at safe boundaries in `AgentHarness`.
- **Runtime guards** — `RepetitionGuard` (canonical tool-call fingerprint), `FailureSignatureGuard` (normalized command+exit+tail signature), `DuplicateSearchGuard` (near-identical search queries), `NoProgressGuard` (consecutive unproductive turns), plus `ReasoningWatchdog` provider telemetry (TTFT / stream-idle warnings, never auto-aborts).
- **Live steering** — headless protocol v2 (`protocol_info`, `control_accepted` / `control_applied` / `control_rejected`): `steer` / `follow_up` / `cancel` events on stdin NDJSON, drained at turn boundaries by `SteeringObserver`; late steers convert to follow-ups. Desktop gains a `send_control` Tauri command with piped stdin and a capability-gated control client.
- **Kraken Activity** — tentacles emit `agent_spawned` / `agent_status` / `agent_tool` / `agent_ended` BrainEvents (resolved model, provider, worktree, graph node) on headless stdout; new Desktop Kraken Activity panel with lead/tentacle/graph detail, warnings and pending controls.
- **Per-role context policy** — `AgentContextPolicy` for lead/explore/general/verify plus a pure `ContextProjector` (tool-result projection, pairing-safe history windows) and `parentContextForRole`: tentacle sub-agents can be seeded with a bounded parent digest instead of full transcripts via `task` `parentTranscript` (opt-in).
- **Run flight recorder** (`ZELARI_RUN_RECORD=1`) — `.zelari/runs/<id>/` with manifest, ordered trace, per-agent logs and metrics; centralized `redactRuntimePayload()` redaction and retention policy (`ZELARI_RUN_RETENTION_DAYS` / `_MAX_MB`, never deletes active runs).
- **Eval arms (A/B harness)** — `tools/eval/arms/`: env-diff arms with removal semantics, NDJSON metric extraction from existing BrainEvents, aggregation/comparison tables and `guards` / `model-routing` experiment presets.

### Changed

- **Headless JSON** emits `protocol_info` v2 at startup when stdin is a pipe (TTY untouched); consumers should ignore unknown event types. Default behavior is unchanged when all new flags are off.

## [2.10.0] - 2026-08-25

### Added
- **Desktop — Kraken Model Routing** — new Settings → Defaults card to route Explore, General and Verify tentacles plus the Graph planner to dedicated models. `Inherit` persists no model id and the Tauri bridge strips any inherited `ZELARI_KRAKEN_*_MODEL` env from the headless CLI process.
- **Desktop — Settings tooltips** — accessible ⓘ help (hover, keyboard focus, Escape) on Kraken routing, strict gates, native criteria pack, advisory review, Best-of-N, Gauntlet Loop and execution profile.

### Changed
- **Desktop — Provider settings** — "Verification model" renamed to "Advisory verification model" to keep the LLM judge distinct from the Verify tentacle model.

## [2.9.2] - 2026-08-24

Restores the 2.9.0 tree as npm `latest`. 2.9.1 remains on the registry but
is no longer the install target.

### Changed

- **Restore 2.9.0** — lockstep version metadata only. The 2.9.1 Grok/xAI
  streaming patch is not included. `npm install -g zelari-code` resolves
  here.

## [2.9.0] - 2026-08-24

OpenAI-compatible provider reliability and prompt-cache stability release,
covering Grok/xAI, DeepSeek, MiniMax, and Z.ai/GLM.

### Added

- **Provider-neutral BUILD liveness** — mutation-required runs track tool and
  successful mutation evidence by registry permissions and argument-aware
  effects. A bounded two-turn recovery prevents false completion without an
  infinite loop; exhausted or provider-error runs terminate explicitly.
- **Grok conversation affinity** — OpenAI-compatible Grok requests send a
  stable, validated `x-grok-conv-id` derived from the harness session. The
  first zero-mutation recovery can require a tool call; later recovery remains
  prompt-only so normal completion is never globally forced.
- **Provider profiles** — separate Grok, DeepSeek V4, MiniMax M2/M3, and
  Z.ai/GLM capability profiles centralize context windows, reasoning replay,
  prompt-cache behavior, sampling, and recovery serialization.

### Changed

- **Ephemeral resource tail** — `resource.snapshot` remains durable session
  state but no longer rewrites persistent model history. The current resource
  status is appended only to the live provider request and is still included
  in token-budget calculations, preserving the stable cacheable prefix.
- **Headless/TUI/Mission consistency** — all primary hosts and general task
  agents use the shared liveness policy; headless no longer maintains a second
  tool-name-based write retry.

### Fixed

- Grok can no longer finish a mutation-required BUILD run with text-only
  success and zero writes.
- Provider failures before a required mutation can no longer be reported as a
  successful agent completion.
- Dry-run write tools and read-only explore/verify task agents do not satisfy
  mutation evidence.

### Tests

- Added focused coverage for zero-write Grok recovery, bounded failure,
  stable conversation affinity, provider serialization, ephemeral cache-tail
  invariants, legacy resource-status replay, and provider-aware token budgets.

## [2.8.0] - 2026-08-23

Native shared cognitive memory, promoted from MVP to a stable local V1.2
surface across Core, CLI, Council/Kraken, MCP, and Desktop.

### Added

- **Native memory contracts** — `@zelari/core/memory` now exposes typed nodes,
  relations, immutable revisions, provenance, lifecycle state, scoring,
  bounded context assembly, policies, adapters, and graceful no-op fallback.
- **SQLite memory spine** — project-local schema v2 uses WAL, FTS, typed graph
  edges, concurrent-writer handling, forward-only migrations with locking and
  consistent backups, legacy JSONL import, consolidation, and health metrics.
- **Hybrid semantic retrieval** — optional injected embeddings add persistent,
  versioned semantic search with paged interruptible indexing, stale-vector
  invalidation, worker-side ranking, provider timeouts, and lexical fallback.
- **Native orchestration integration** — AgentHarness, Council, Kraken
  tentacles, missions, interactive sessions, and headless runs can share and
  reuse bounded project knowledge across processes and restarts.
- **Inspection and interoperability** — `/memory` commands, safe AGENTS.md
  promotion, a read-only Desktop explorer, a versioned Desktop JSON API, and
  an opt-in MCP stdio server for external agents.
- **Memory evaluation suite** — repeatable recall, precision, stale/duplicate
  injection, token-efficiency, semantic-gain, and real SQLite latency metrics.

### Security

- Secret scanning and private-reasoning removal apply before persistence.
- External access enforces project trust, canonical scope, visibility,
  ownership, payload limits, relation validation, and bounded write rates.
- MCP remains disabled unless explicitly enabled and is never required by the
  native memory path.

### Changed

- Vitest now caps the whole repository at 50% of available workers, preventing
  process-heavy Git and SQLite suites from starving each other in CI while
  retaining the existing per-test timeout guarantees.

## [2.7.0] - 2026-08-23

Desktop UI alignment: project-grouped chat history, colored file tree, and
collapsible task panels.

### Added

- **Project-grouped chat history** — the desktop session sidebar groups chats
  by project folder with collapsible headers (chevron + chat count), state
  persisted in localStorage; every group is collapsible, including the one
  containing the active chat.
- **Colored file tree** — Files tab icons are tinted per folder name and file
  extension (VS Code Material-style palette: TypeScript cyan, JS/JSON amber,
  CSS blue, SCSS/images purple, HTML orange, configs/scripts green).
- **Collapsible task panels** — Tasks and Project sections above the
  conversation are collapsible with clickable headers and persisted state.

### Changed

- **Mock-aligned dark theme** — near-black (#050508) background, cyan/violet
  accents (#00e5ff / #c084fc), gradient New chat button and Active/Archived
  tabs, 2x2 suggestion chips with per-chip gradient borders, glowing circular
  send button.
- **Right rail sizing** — Files/Git panel honors collapsed (36px) and
  narrow-window (160px) widths; 292px only when expanded on wide windows.

## [2.6.3] - 2026-08-23

2.6 closure hardening: mission budget governance, deep harness-manifest
provenance, and a real CI retention gate.

### Added

- **Mission budget-aware continuation** - `evaluateBudgetContinuation()` from
  `@zelari/core` now governs the Mission driver lifecycle (not just advisory):
  budget pressure plus repeated/identical implementation gaps produce
  `hold`/`pivot`/`repair` decisions, pivot reduces the specialist roster, and
  `repairHistory` persists across resume.
- **Deep harness-manifest fingerprinting** - the session lifecycle manifest is
  now built from real tool specs (`name` + `description` + `inputSchema`) via
  the new `ToolRegistry.fingerprints()` accessor, threaded from the TUI and
  headless hosts (best-effort: degrades gracefully when specs are unavailable).
  Tool description/schema changes now change the manifest hash.
- **Eval result store + CI retention gate** - new `tools/eval/runAnchors.ts`
  CLI runs the anchor suite with a real headless runner and deep suite
  provenance, seeding the versioned result store; `runGate` gains
  `--baseline-store`, `--baseline latest` and `--candidate all` (multi-manifest
  suites); the retention workflow compares the stable-tag baseline against the
  candidate for real and is blocking when API credentials exist (declared
  shadow otherwise - never fake outcomes in the store).

### Fixed

- **Headless deep-specs guard** - sessions no longer break when a tool
  registry without fingerprint support is injected.

## [2.6.2] - 2026-08-23

Resource-budget repair release: restores the documented per-turn hard limit
without losing cumulative session telemetry or interrupted-turn resume safety.

### Fixed

- **Per-turn `maxToolCalls` enforcement** — a turn that spends its full budget
  no longer leaves the whole session permanently exhausted. Every explicit new
  user turn starts a fresh execution epoch at 0/N; resuming an interrupted turn
  restores the usage of that same epoch.
- **Headless session-event cleanup** — tests close the session handle before
  removing its temporary directory and retry transient Windows cleanup races.

### Added

- **Resource execution epochs** — `resource.epoch_started` events separate the
  active turn budget from cumulative `ResourceLedger` telemetry. Snapshots and
  invariants now preserve and validate both views across TUI, headless, council,
  Mission and resume flows.

## [2.6.1] - 2026-08-23

Hardening release: turns the 2.6 primitives into end-to-end guarantees
(correctness fixes, single resource authority, harness manifest lifecycle,
real candidate-vs-baseline regression gate).

### Fixed

- **TaskContract parser** — acceptance criteria are recognized only from
  explicit patterns (`- [ ]` / `- [x]` / `Acceptance:` / `Criterion:` /
  `Verify:` / `Test:` / `Success:`); narrative lines no longer become false
  criteria (a contract without explicit patterns gets `acceptanceCriteria:
  []`). Seeding is now default-on (`ZELARI_TASK_CONTRACT=0` opts out).
- **Gauntlet zero-budget ordering** — `budgetGate` returns `hold` at zero
  remaining budget before the finalize-verify reserve check (0 → hold,
  reserve-only → finalize-verify, ample → repair).
- **Single RESOURCE STATUS** — `ModelContextBuilder` no longer appends a
  second resource-status tail; the latest-only `resource.snapshot`
  projection is the single model-visible status across TUI, headless,
  resume and post-compaction.
- **RegressionGate missing anchors** — candidate-vs-baseline comparison
  runs on the union of anchor IDs; a baseline-PASS anchor with no candidate
  record is a REGRESSION (or an explicit BLOCKED), so anchors can no longer
  disappear from the gate.
- **Harness change classification** — `HarnessChangeSet` keeps structural /
  behavioral / cosmetic buckets separate instead of flattening to a single
  `overall` where behavioral hid structural; structural changes trigger the
  full structural gate; unknown behavioral fields get Tier 0 + full
  behavioral anchors — never zero.
- **`runGate` candidate comparison** — baseline and candidate summaries
  load separately and feed `evaluateRegressionGate` (baseline suite =
  baseline, current suite = candidate); validity violations reach the gate
  instead of a hardcoded empty array; `--baseline none` is rejected
  (exit 2).
- **Version manifests** — repair release: all manifests (root, core,
  desktop, tauri, lockfiles) back in lockstep at 2.6.1.

### Changed

- **ResourcePolicy is the single tool-budget authority** —
  `ZELARI_MAX_TOOL_CALLS` now aliases `ResourcePolicy.maxToolCalls` instead
  of adding a second independent cap; per-turn sub-agent caps are derived
  clamps that can never exceed the remaining session budget.
- **Hard `maxToolCalls` semantics** — usage is no longer clamped at the
  limit: denied calls keep the real count, `overrun` is reported in
  snapshots, and `resource.limit_reached` / `resource.overrun` events are
  emitted.
- **Argument-aware verification reserve** — the spine gate seam is now
  `toolCallGate(toolName, args, context)`: bare `bash` counts as
  verification-essential only for test/typecheck/build/git-diff style
  commands, not arbitrary exploration.

### Added

- **Harness manifest lifecycle** — every new session registers
  `session.harness_manifest` (TUI, headless, desktop bridge) via a shared
  `noteHarnessLifecycle` helper; resume compares original vs current hash
  and records `session.harness_drift` (non-blocking).
- **Canonical `CORE_VERSION` + deep fingerprints** — `@zelari/core`
  exports `CORE_VERSION` (no more `require.resolve` with `0.0.0` fallback);
  tool fingerprints hash name + description + inputSchema; skills hash a
  content digest.
- **TUI/headless budget parity** — shared
  `restoreBudgetRuntimeFromSession()` rebuilds the ledger identically in
  every host (12/40 used → remaining 28 in both TUI and headless); TUI now
  attaches a real `BudgetRuntime` (gate + resume) instead of a pass-through.
- **Steer versioning** — relevant user steer messages emit versioned
  `task.contract_updated` events (append-only, user-over-derived authority).
- **ResourceReserveGate in the completion lifecycle** — non-PASS with an
  exhausted budget ends `BLOCKED/resource-exhausted` in headless runs
  instead of a false done; the Gauntlet loop consults the budget gate.
- **Eval provenance + token budgets** — anchor runs record real
  `harnessManifestHash` / `resourcePolicyHash`, enforce `maxTokens`
  (`budget-exceeded-tokens`), and report token-accurate `RunCost`
  (input/output/cache-hit tokens, tool calls, wall ms, USD) with
  `toolCostUsd` included in cost-per-verified-solve.
- **Historical anchor set expanded 3 → 15** (5 local bugfix, 4 multi-file,
  3 verification/evidence, 2 session resume, 1 resource budget) with
  deterministic fixtures; **CI eval retention gate is Tier-0 blocking**
  against the latest stable tag baseline (never `none`).

## [2.6.0] - 2026-08-22

### Added

- **Canonical Harness Manifest.** `HarnessManifestV1` (zod-validated) hashes
  the effective harness: profile hash, prompt hashes (kraken/gauntlet/
  council/mission), tool and skill manifest hashes, policy hashes (routing,
  verification, completion, compaction, resource) and runtime versions.
  `hashHarnessManifest()` is deterministic (stable serialization, no
  timestamps); `diffHarnessManifest()` + `classifyHarnessChanges()` classify
  changes as behavioral / structural / cosmetic. Every session can register
  `session.harness_manifest` (opt-in via `ZELARI_HARNESS_MANIFEST=1`).
- **Central ResourceBudget / ResourceLedger.** Host-owned
  `ResourcePolicy` (per-profile defaults: kraken 40 tool calls, 6
  verification reserve, 4 repair reserve, 15 min wall clock) drives
  `computeBudget()` with four pressure states (ample / normal /
  constrained / critical). The CLI `BudgetRuntime` counts tool calls
  through the spine mirror, rebuilds the ledger from the session log on
  resume (no double counting, monotonic usage) and emits `resource.snapshot`
  events (first use, stage or pressure change, reserve threshold crossing,
  usage delta).
- **Model-visible resource status, latest-only.** `deriveMessages()`
  projects only the latest `resource.snapshot` into the model surface as a
  `RESOURCE STATUS` system block; older snapshots remain in the durable
  ledger. TUI and headless both inject the projection.
- **Verification budget reserve.** `resourceReserveGate` keeps
  deterministic PASS authoritative and returns `BLOCKED
  resource-exhausted` instead of a false done when the remaining budget
  cannot fund required evidence. Enforcement modes: `advisory` (default)
  and `protected` (`ZELARI_RESOURCE_ENFORCEMENT=protected`), wired through
  a new `toolCallGate` seam on `AgentHarness` — denied calls surface a
  model-visible reason without consuming the doom-loop budget.
- **First-class TaskContract.** `task.contract` events carry a versioned
  goal + constraints + acceptance criteria with user-over-derived
  authority (`TaskContractConflictError` on removal of required items or
  unauthorized goal rewrites). Seeding from the first user message is
  opt-in via `ZELARI_TASK_CONTRACT=1`; compaction prefers the contract
  over regex extraction (fallback preserved).
- **Budget-aware continuation.** `budgetContinuation` decides
  complete / repair / pivot / hold from verification state + remaining
  budget + repair history (repeated identical gaps favor pivot; critical
  pressure favors hold). Advisory-only; `passByBudget` is locked to false.
- **Historical anchor set + harness regression gate.** JSON+zod anchor
  manifests under `eval/anchors/` with deterministic fixtures, hard
  budgets and exit-code success checks. `tools/eval` provides the anchor
  runner, retention policy presets (stable: 0 regressions /
  experimental: 1 / research: 2), regression gate (commit rule: validity
  AND regressions within budget AND cost within policy), §8.6 reports,
  targeted anchor selection from manifest diffs, a file-based eval result
  store keyed by manifest hash, and the `npm run eval:gate` entry point.
  Bootstrap anchors: Tier 0 local bugfix, Tier 1 multi-file rename,
  Tier 1 resource-budget exhaustion.
- **Unified cost metric.** `costPerVerifiedSolve()` extends the existing
  verification metrics (verified solve rate, false-done rate) with
  cost / wall-time / tool-calls per verified solve and a pareto report.
- **CI.** `eval-retention-gate.yml` runs the gate in Phase 1 shadow mode
  (report-only) on push/PR.

### Changed

- **Session event vocabulary (additive).** Six new state-only kinds:
  `session.harness_manifest`, `task.contract`, `task.contract_updated`,
  `resource.snapshot`, `resource.limit_reached`, `resource.reserve_entered`.
  `SESSION_SCHEMA_VERSION` stays 1; replay of old logs is unaffected and
  old readers ignore the new kinds. `validateResourceAndContractEvents()`
  enforces monotonic usage, coherent remaining values, non-negative
  reserves and contract version monotonicity.
- **Gauntlet budget awareness.** The gauntlet policy derives budget
  pressure and discourages non-essential delegation under constrained
  budgets without changing critic or CompletionPolicy authority.
- **MIGRATION.md** documents the new events, projections, seam and
  environment flags.

## [2.5.0] - 2026-08-21

### Added

- **Durable session compaction surface.** `deriveMessages()` treats
  `session.compacted` with `{fromSeq,toSeq,checkpoint}` as a replacement
  of that closed interval (later coverings swallow earlier checkpoints).
  The JSONL ledger stays append-only. Legacy `{summary}` events without a
  range still append. Invariants flag invalid ranges and tool-pair splits
  across the compact boundary.
- **Shared durable ModelContextBuilder.** TUI, council and headless now use
  one derive → measure → compact → persist → flush → re-derive pipeline.
  Desktop and companion serve inherit it through headless. Spine-derived
  messages carry seq/range provenance, so chained compactions do not resurrect
  raw events; summary-only events remain the compatibility fallback when the
  source has no seq.
- **Structured compaction state and telemetry.** Checkpoints prepend a
  deterministic state block retaining required criteria, unresolved failures,
  verification/evidence refs, affected files, user constraints and mission
  state. JSONL compaction metrics report token savings, repeated-checkpoint
  rate, summary strategy and replay restore failures; LLM checkpoints also
  retain provider/model provenance.

## [2.4.0] - 2026-08-21

### Changed

- **Gauntlet is a host loop, not a prompt.** The Desktop toggle forwards
  `--gauntlet` / `ZELARI_GAUNTLET=1`. The CLI runs capped builder (`task
  general`) + isolated critic (`task verify`) rounds. The parent cannot
  write (`write_file` / `edit_file` / `apply_diff` / `bash` stripped). Stop
  is `PASS` with tool evidence, `BLOCKED`, round cap (default 3), or cancel.
  `unknown ≠ pass`. Live `gauntlet_progress` card; no `progress.html`.
  The Goal is decomposed into scoped pieces (LLM JSON, 60s timeout, then a
  single-piece fallback). Disjoint scopes may run in parallel. Critics
  compare against optional on-disk quality bars (blind A/B when two bars
  are given); `WINNER: A|B|TIE` is recorded on the piece result. Host
  wall clock defaults to 45 minutes (`ZELARI_GAUNTLET_WALL_MS`, `0` disables)
  and aborts in-flight tentacles. Desktop Graph and Gauntlet toggles are
  mutually exclusive.

### Fixed

- **Reasoning heartbeat in Desktop.** Hidden `thinking_delta` tokens now
  drive `Reasoning · 2m 14s` on the run spinner instead of looking stalled.

## [2.3.0] - 2026-08-21

### Added

- **Desktop Gauntlet Loop**: top-bar toggle (and Settings) appends the builder/critic
  loop instructions to the next Goal. Chat shows a badge, not the full prompt;
  overlay and resume stay in lockstep via Desktop prefs.
- **Crash-safe tool recovery**: dangling `tool.call` events are classified
  (`retry-safe` vs `inspect-first`). Resume writes `tool.interrupted` on the
  session spine; mutating tools are never retried blindly.
- **Relational session invariants**: `validateSessionTrace` checks seq, tool
  pairing, duplicate results, evidence `seq` anchors, and completion-before-verification.
- **Scope discipline**: event-backed `analyzeScope` on changed files. Unexpected
  source paths are advisory (`unknown`), not a deterministic fail; lockfiles and
  generated dirs are split out.
- **Tool concurrency classifier**: `task agent=general` is exclusive; explore/verify
  tentacles stay parallel-safe.

### Fixed

- **Orphan tentacles after `task` timeout**: the registry now aborts a child
  AbortController on timeout and `runSubAgent` calls `harness.cancel()`, so a
  timed-out general tentacle stops writing. Writer budget is 15 minutes
  (`TASK_TOOL_TIMEOUT_MS`), matching the Kraken graph.
- **`read_file` empty range**: `maxBytes` applies to the selected line range, not
  a prefix of the file. Out-of-range starts report `LINE_RANGE_EMPTY`.

## [2.2.0] - 2026-08-20

### Added

- **Desktop verification controls**: Settings → Defaults now exposes persistent
  controls for the Kraken strict gate, Mission strict gate, native criteria
  pack, advisory verifier (automatic/on/off), and experimental Best-of-N.
- **Overlay parity**: the floating Desktop overlay applies the same execution
  profile, verification gates, verifier preference, and experiment settings as
  the main chat.

### Fixed

- **Authoritative Desktop switches**: disabling a gate or Best-of-N now
  explicitly overrides inherited process environment variables instead of
  allowing them to silently re-enable the feature.
- **Preference migration**: existing Desktop settings retain their previous
  profile, strict-gate and Best-of-N choices while adopting safe defaults for
  the new controls.

## [2.1.2] - 2026-08-20

### Fixed

- **Desktop release updater manifest**: serialize platform upload jobs so
  concurrent `tauri-action` runs cannot race while merging `latest.json` or
  omit the signed Windows installer from automatic updates.

## [2.1.1] - 2026-08-20

### Fixed

- **Deterministic release installs**: require npm `>=11.7.0`, pin the workspace
  package manager, and verify both constraints before publishing.
- **Clean npm artifacts**: remove stale TypeScript output before builds and
  pre-publish checks, and exclude compiled test files from the CLI package.
- **License coherence**: `@zelari/core` now ships the same Apache-2.0 license as
  the monorepo, enforced by the principles gate.
- **Desktop development dependencies**: update transitive `postcss` and `nanoid`
  versions to resolve the two outstanding high-severity audit findings.
- **Repository hygiene**: remove accidental binary/temp installer artifacts and
  keep the retained upgrade specifications under `docs/plans/`.

## [2.1.0] - 2026-08-20

### Added

- **2.1 T4 — advisory verifier in the lifecycle**: `VerifierService` review is now
  wired into the normal headless Kraken completion path (after the strict gate and
  the repair pass). Opt-in: dedicated `verifier` in `provider.json` or
  `ZELARI_VERIFIER_REVIEW=1` (`=0` forces off). Advisory-only by construction:
  it can never flip a deterministic verdict (`REJECTED` cannot block a `PASS`,
  `CONFIRMED` cannot unblock a `REPAIR_REQUIRED`); results land as
  `verification.run.verifier.advisory` on the session spine.
- **2.1 T6 — native criteria pack standalone**: `ZELARI_VERIFY_PACK` no longer
  requires Kraken Selection nor strict-done; guarded against empty-PASS. Headless
  and TUI share the same condition.
- **2.1 T5 — original-tool-backed evidence provenance**: verify-tentacle evidence
  anchors to the RAW tool executions captured at run time
  (`observation: 'tool-result'`, sha256 digest, `provenance:
  'tentacle-tool-capture'`) instead of re-emitting the agent's note. Notes without
  a matching capture fall back to the explicitly-marked deprecated path
  (`provenance: 'note-fallback'`); `verification.run` events carry an
  `evidence.provenance` counter.
- **ADR-0027 / ADR-0028**: strict Kraken stays opt-in in the CLI; the adaptive
  native-pack default moves to the host (Desktop preference), keeping CLI/CI
  deterministic.

### Changed

- **BREAKING**: Node.js `>= 24` is now required (`engines` in `zelari-code` and
  `@zelari/core`): the CI matrix dropped Node 20 because the dependency tree no
  longer installs cleanly on it.
- Documentation aligned with the stable line: prerequisites tables
  (README/GUIDA/CONTRIBUTING) and stale "alpha" wording removed from the 2.0 guide.

### Removed

- **2.1 T9 — `history_snapshot` COMPAT MIRROR removed (BREAKING)**: the CLI no
  longer emits end-of-turn `history_snapshot` events (task, council, mission and
  kraken-graph surfaces). The session spine (`--resume <id>`) is the canonical
  multi-turn context; Desktop derives fallback history from its chat UI. The
  zero-write BUILD warning survives as a plain `log` event.
## [2.0.1] - 2026-08-20

### Fixed

- **Desktop Settings → Update CLI** no longer reports "CLI is up to date"
  when the installed CLI is a prerelease (`2.0.0-alpha.4`) and npm `latest`
  is a newer release (`2.0.0`). SemVer comparison now treats prerelease as
  older than release, so "Update CLI" becomes available and the message
  explains the upgrade path.

## [2.0.0] - 2026-08-20

Zelari Code 2.0 is out of alpha.

### Desktop

- Desktop shell (`@zelari/desktop`, Tauri `zelari-desktop`) is now **2.0.0**
  in lockstep with the CLI. Settings → App updates tracks GitHub
  `/releases/latest` (signed installers). Settings → Update CLI follows
  the npm `latest` dist-tag.

### Changed

- **Event-backed evidence is now the strict default (ADR-0026).**
  `STRICT_BUILD_POLICY.requireEventBackedEvidence` is `true`. A `pass` whose
  only evidence is an unanchored note (no `EvidenceRef.seq`) is **BLOCKED**.
  Production hosts already pass a spine `emit`; `anchorSelectionEvidence()`
  stamps `verification.evidence` events so those notes remain valid. Callers
  that evaluate the policy without an emitter must either inject `emit` or
  set `requireEventBackedEvidence: false`.
- **Kraken strict-done stays opt-in** (`--strict-done` / `ZELARI_STRICT_DONE=1`).
  Mission stays default ON (`ZELARI_MISSION_STRICT=0` to opt out). Turning
  Kraken strict ON by default would exit 4 on every 1.x-style task whose only
  evidence is a verify-tentacle note — rejected for 2.0.0, revisit in 2.1.

### Added

- ADR-0026 (`docs/decisions/0026-rc-defaults-event-backed-and-strict.md`).
- Lock test: notes without a spine emitter cannot satisfy the 2.0 gate.

## [2.0.0-alpha.8] - 2026-08-20

### Added - Exit-3: product surface, docs, portability and hardening

- **Desktop verifier round-trip smoke (Exit-3.1)**: `src/cli/kraken/verifierResolution.ts`
  bridges the persisted Desktop override (`provider.json` → `krakenVerifier`) into the
  VerifierService 2.0 `ModelSelection` (`inherit | fixed`); `verifierRoundTrip.test.ts`
  drives the full §9 chain through the real `--set-config` channel - Inherit (A → A),
  Dedicated (A+B → B), Reset (B → clear → A) - and asserts the effective model logged
  in the spine `verification.run` event.
- **Profile smoke matrix (Exit-3.2)**: `src/cli/profileMatrix.test.ts` - 6 cells
  (minimal/kraken/council/mission × plan/build) × 3 legs (profile loader, session
  metadata with `toolManifestHash`, capability gate on the real tool registry: plan
  strips mutators). Source-assertion invariants: council+plan, mission = build-only.
- **GUIDA 2.0 (Exit-3.3)**: `docs/GUIDA.md` +155 lines - Host/Profile/Phase, Session
  spine canonical path (deriveMessages → derivedToAgentMessages), resume/export/fork
  (fork documented honestly as core API, no CLI flag in alpha), deterministic
  verification + Strict Done defaults (ADR-0025) + LLM verifier advisory with wiring
  status declared, legacy session/history marked compatibility-only.
- **MIGRATION 2.0 (Exit-3.4)**: `MIGRATION.md` rewritten for the 2.0 line - the
  fundamental shift (consumer-provided history → append events → deriveMessages →
  AgentHarness), resume/fork/lineage, profile metadata, verification contract with
  event-backed EvidenceRef, honest alpha breaking changes (mission strict ON → exit 4).
- **CI multi-OS (Exit-3.5)**: `.github/workflows/ci.yml` gains a smoke matrix
  3 OS × Node 20/24 (session/runtime/verification core + CLI spine + bundle + bin
  --version); the full verify gate stays on Ubuntu/Node 24.
- **Headless e2e session smoke (Exit-3.6)**: `src/cli/headlessE2eSession.test.ts`
  drives the real `runHeadless` pipeline (kraken + council) with a deterministic
  provider stub - run → session_started → resume (same log, monotonic seq) → export →
  fresh replay → identical deriveMessages trajectory on three independent sources.
- **Dependency triage (§15)**: `npm audit fix` → 0 vulnerabilities (nanoid/postcss via
  vitest→vite, undici via jsdom - all dev-only, unreachable in the shipped bundle);
  `docs/security/dependency-triage-2.0.0-alpha.7.md` is the signed snapshot.
- **Cleanup (§16)**: removed 3 of 5 `@ts-nocheck` (TUI 1.x hooks) with the one type
  fix they were hiding; `history_snapshot` emit sites now carry explicit
  COMPAT MIRROR (ADR-0024) markers.

### Changed

- Local test parity: node_modules was stale (vitest 2.1.9 vs declared ^4.1.9); after
  resync the suite collects 52 previously-invisible files under tests/unit/ - the
  full suite is now 341 files / 3451 tests on vitest 4.1.9. Two cold-start timeouts
  raised (cli-toolDisplay first importer → 30s; kraken e2e → 90s).

## [2.0.0-alpha.7] - 2026-08-20

### Added — Exit-2: native Verification 2.0 in the Kraken/mission path

- **Verifier advisory lock tests (Exit-2.3)**: `src/cli/kraken/verifierAdvisoryLock.test.ts`
  locks the composition contract end-to-end — deterministic evidence stays the only
  completion authority: unknown/fail + LLM CONFIRMED → BLOCKED/REPAIR_REQUIRED with the
  review downgraded to advisory; PASS + LLM REJECTED → verdict untouched, exit 0.
- **Native criteria pack in the strict path (Exit-2.4)**: `src/cli/kraken/nativeVerification.ts`
  binds `zelari-coding/v1` criteria to the repo's real npm scripts (env-overridable,
  timeout-clamped) and merges engine results into the same `evaluateCompletion` —
  opt-in during the alpha via `ZELARI_VERIFY_PACK=1`.
- **Event-backed evidence (Exit-2 P1)**: new spine kind `verification.evidence`; the core
  engine emits raw observations (command, exit code, sha256 digest, output tails) and
  anchors each deterministic `EvidenceRef` to the spine `seq`. New
  `requireEventBackedEvidence` policy flag (default off in alpha, RC gate) +
  `eventBackedEvidenceComplete` metric; unanchored verifier notes can no longer pose as
  tool output when the flag is on.
- **Mission continuation policy (Exit-2.5)**: `packages/core/src/mission/continuationPolicy.ts`
  — advisory by construction (`goalRewrite:false`, `doneByScore:false` literals); required
  criteria incomplete → always `continue`; budget exhausted → `hold-for-user` (never done).
  Wired as spine kind `mission.progress` (state-only, not model surface); the mission loop
  records advice but never obeys it — deterministic rules stay the only authority.
- **ADR-0025 — strict done defaults per surface**: missions close under the strict evidence
  gate by default (opt-out `ZELARI_MISSION_STRICT=0` / `--no-strict-done`); Kraken keeps the
  1.x-compatible opt-in (`ZELARI_STRICT_DONE=1`). A blocked mission "success" now exits 4 and
  records `mission-strict-blocked` instead of a clean zero. Lock tests in
  `src/cli/kraken/strictDefaults.test.ts`.

### Fixed

- `criteriaPack.v1`: `options.X ?? default` ignored the documented `null` ("criterion without
  check"); `null` now disables the criterion, `undefined` keeps the default.
## [2.0.0-alpha.6] - 2026-08-19

### Added — Exit-1/E1.4: Desktop resume-from-spine

- Headless dispatch (kraken/council/zelari) emits a `session_started` NDJSON event
  (sessionId + spine status) right after opening the session spine
  (`sessionStartedEvent()` in `src/cli/headlessSpine.ts`), so hosts can capture
  the session id on turn 1 and resume the same event log on every following turn.
- Desktop: `RunTaskArgs.sessionId` is forwarded by the Rust host as
  `--resume <id>`; `Conversation.sessionId` is captured from `session_started`
  and persisted per chat (`apps/desktop` types/App). `--history` remains the
  one-shot import for fresh logs and the declared fallback for degraded/disabled
  spines — no longer the primary multi-turn brain.
- Contract tests: `src/cli/headlessSessionEvent.test.ts` (announce, resume
  round-trip continues the same log/seq, kill-switch announces `disabled`).

### Changed — Exit-1/E1.5+E1.8: legacy context quarantined (single-source spine)

- **E1.5 — the budget pipeline measures the spine-derived model history, not the 1.x store.** Both TUI paths (`useChatTurn.ts`) now feed `applyBudgetPolicyAsync` with the spine-derived seed: the single-agent path measures `historyForModel` (and a compaction replay replaces the current turn's seed, so the model sees exactly what was measured), while the council path derives `councilHistory` from the mirror first. `compactInPlace()` is removed from the council hot path (v1.36 parity with the single-agent path — it rewrote history before measuring and busted the cache prefix), and a compaction on the council path now emits the durable `session_compacted` event (previously store-only: the compaction boundary was invisible to the spine and the derived history drifted from the store).
- **E1.5 — `src/cli/sessionManager.ts` is deprecated as a model-context source** (header contract): it remains 1.x UI persistence (session list, `/resume` marker, branch marker) and a read-only migration source. It never participates in `deriveMessages`.
- **E1.8 — ADR-0024 closes the dual-write question:** `docs/decisions/0024-single-write-model-context.md` records that the session spine is the only model-context source on every hot path, the 1.x store/sidecar are a mirrored export/UI surface during the alpha (removal evaluated at 2.0.0-rc), the discrete fallback stays the turn-safety policy, and `ZELARI_SESSION_SPINE=0` is emergency-only. The `sessionSpine.ts` header now states the post-E1.x contract.
- **Architectural gate:** new `src/cli/legacyContextIsolation.test.ts` (in `npm run test:session`) encodes the Exit-1 grep criteria as CI — no `applyBudgetPolicyAsync(getHistory())`, `opts.history` only inside `seedHeadlessModelHistory` calls, spine modules never import `sessionManager`, no second history brain on the headless path.

### Added — Exit-2/E2.1: completion verdict readable back from the session spine

- `@zelari/core/verification` exports `sessionEvidence`: `parseVerificationRunPayload` / `lastVerificationRun` / `snapshotToCompletionEvaluation` reconstruct a CompletionEvaluation from `verification.run` events in the session log alone — no in-process registry — so hosts, mission retries and audits can confirm why a turn finished (P1 applied to the decision itself). Discipline: missing/malformed → null (no evidence, never a pass); non-strict records are readable snapshots but never admissible as completion evidence; unknown verdicts degrade to BLOCKED.
- `SessionSpineMirror.lastVerificationRun()` (and the headless handle delegation) exposes the last strict verification record of the current session; `evaluateStrictBuildGateFromSession(mode, snapshot)` in the kraken bridge rebuilds the strict gate evaluation from it. Round-trip covered by `verificationBridge.session.test.ts` (evaluate → payload → spine append → replay → same verdict, blockers add up, missing record = open-not-pass).

### Changed — Exit-2/E2.2: strict done gate enforces the run outcome (deterministic evidence only)

- **Completion policy tiers (core):** `CompletionPolicy` gains `admissibleTiers`; `STRICT_BUILD_POLICY` (used by the kraken strict gate) admits only deterministic tiers (`tool-output`, `command-output`, `fs-observation`, `human`). A criterion whose passing evidence is `verifier-llm`-only is `unknown` — an advisory LLM score alone is never proof of done (P1; Exit-2 criterion "score LLM da solo non basta"). The default policy keeps every tier admissible (legacy behaviour unchanged).
- **Headless enforcement:** when `ZELARI_STRICT_DONE=1` and the completion gate is still blocked after the automatic repair pass, the kraken BUILD run now closes non-success — dedicated `STRICT_DONE_EXIT_CODE = 4` (distinct from transport `3` and usage `2`), spine session status `stopped` instead of `completed`, and an explicit NDJSON log line with the verdict summary. A "done" claim without sufficient evidence can no longer exit 0 in strict mode.
- **TUI:** after the repair pass, an unresolved strict gate surfaces `[kraken] strict done: … turn is NOT verified-complete` instead of passing silently.
- **Tests:** core policy tier cases (LLM-only blocks, mixed passes, default unchanged), bridge `strictGateExitCode` (strict blocked → 4, open → 0, strict-off legacy blocked → 0), and the `legacyContextIsolation` architectural gate now asserts the headless exit-path wiring.

## [2.0.0-alpha.5] - 2026-08-19

### Alpha exit plan — what is left for 2.0

Zelari 2.0 is in alpha. The 2.0 architecture is in the tree (`@zelari/core` session spine, runtime seams/profiles, deterministic verification with advisory LLM verifier, mission state), but leaving alpha is gated on explicit criteria:

- **C1–C3 (blocking, Exit-1):** the Session event log must become the single source of truth for the model context. Progress: `@zelari/core/session` now exports the single `derivedToAgentMessages()` adapter (E1.1), and the headless hot path (kraken/council/zelari in `runHeadless.ts`) seeds prior turns from the spine via `seedHeadlessModelHistory()` — legacy `--history` is a one-shot import into a fresh log (or the declared fallback when the spine is degraded/disabled), not the model-context brain (E1.2). The TUI loop derives from the spine on the same shared policy (E1.3). Replay determinism and the model-visible⟺logged invariant are now CI-gated by `src/cli/sessionReplayInvariant.test.ts` (E1.6/E1.7, `npm run test:session`). The Desktop now captures `session_started` and resumes the conversation spine via `--resume <id>` (E1.4; Rust host + `Conversation.sessionId`). Remaining: 1.x sessionManager read-only deprecation (E1.5), dual-write closure ADR (E1.8). Kill-switch `ZELARI_SESSION_SPINE=0` keeps the legacy behavior for emergency/debug.
- **C6 (Exit-2):** strict/mission completion requires deterministic verification evidence from the session; the LLM verifier stays advisory and can never flip CompletionPolicy.
- **C4/C5/C7/C8 (Exit-3):** coherent versions/README/docs, verifier config round-trip, CI matrix, aligned documentation.

Explicitly NOT alpha-exit criteria (post-2.0 or experimental flags): best-of-N/logprob selection, experimental code-mode, remote sandboxes, new council roles.

### Fixed

- `src/cli/providerConfig.ts`: `loadProviderConfig()` (async) now delegates to the same merge/env logic as `getProviderConfig()` (shared `mergeStoredProviderConfig` + `applyEnvOverrides`). Previously a dedicated `krakenVerifier` override survived a sync read but was silently dropped by any async load, and the async fallback ignored `ANATHEMA_ACTIVE_PROVIDER`/`OPENAI_MODEL` env overrides (Exit-0 E0.1). Round-trip parity is covered by `src/cli/providerConfig.test.ts` (E0.2).

### Changed

- **E1.6/E1.7 — replay determinism + model-visible⟺logged are a CI gate (Exit-1).** New `src/cli/sessionReplayInvariant.test.ts` (6 tests) proves on a scripted multi-turn run (legacy import → live turn with streamed reply, tool call/result, compaction): the whole history reconstructs from `events.jsonl` alone via a fresh `SessionSpineMirror.adopt` (cross-process resume, gap-free seq); two replays derive deep-equal; the seed is the documented semantic-equal mapping (compacted→user, orphan tool results dropped, `<think>` preserved); every derived message traces back to a MODEL_SURFACE event by `seq` (forward P1 invariant); every surface event either derives or is excluded by declared policy (`tool.call` without `includeToolCalls`); the next-turn harness history rebuilds from the spine with zero process memory. New `npm run test:session` script runs the full session gate (9 files / 56 tests: core session suite + CLI spine/headless/history-seed/replay-invariant); the CI `Tests` step is labeled accordingly.
- **E1.2 — headless model context is spine-derived (Exit-1).** All three headless modes (`runHeadlessSingle`/`runHeadlessCouncil`/`runHeadlessZelari`) now seed prior turns through `seedHeadlessModelHistory()` (`src/cli/headlessSpine.ts`): a fresh spine log imports legacy `--history` one-shot as `user.message`/`assistant.message` events, then history is derived (`deriveMessages` → `derivedToAgentMessages`); a resumed session derives from the log and ignores new legacy input (spine wins over the 1.x rolling JSON). `opts.history` no longer feeds harness messages directly. New `SessionSpineMirror.assistantMessage()`/`flush()`/`derivedPriorTurns()` support the path; covered by `src/cli/headlessHistorySeed.test.ts` (import, resume precedence, kill-switch fallback, event order invariant).
- **E1.3 — the TUI chat loop builds the model context from the spine too (Exit-1).** `useChatTurn.dispatchPrompt` now derives the prior-turn seed via the shared `derivedModelSeed()` policy (`src/cli/headlessSpine.ts`) BEFORE logging the current user prompt, and feeds it to the `AgentHarness` messages (was `...getHistory()`, the in-process 1.x rolling store). `historySeedLen` tracks the actual seed so the finally-snapshot slice stays coherent. The rolling store remains the declared fallback (degraded/disabled spine, or a spine log still empty while the store carries replayed 1.x history) and keeps feeding render + budget heuristics. Shared seed policy: user/assistant pass through (assistant scrubbed, `<think>`/`---QUESTION---` preserved), compacted summaries map to a user message (the 1.x store convention), orphan tool results are dropped (providers reject unpaired `role:'tool'`).
- README.md no longer hardcodes a CLI line version (was stale at "Current line: 1.35.1" while the package is 2.0.0-alpha.x) — the npm version badge is the live source; `docs/GUIDA.md` "Versione documento" now tracks the package version (Exit-0 E0.3).
- `scripts/verify-versions.mjs` additionally fails on hardcoded versions in README.md and on a `docs/GUIDA.md` "Versione documento" that drifts from `package.json` (Exit-0 E0.4).

## [2.0.0-alpha.4] - 2026-08-19

Channel-aware CLI/Dekstop updater: pre-release builds now track their matching npm dist-tag (`alpha`/`beta`/`next`) instead of being pinned to the older stable `latest`. This fixes the Desktop showing "CLI is up to date (v1.49.0)" while the 2.0 alpha CLI sits on the `alpha` tag — the check, the "Update CLI" button, `/update` and the status line all derive the channel from the running version.

### Changed
- `src/cli/updater.ts`: `distTagForVersion()` + `registryUrlForTag()`; `checkForUpdate()` and `performUpdate()` default to the channel matching the current version (pre-release → its dist-tag, stable → `latest`); explicit `channel` override for `performUpdate`.
- `src/cli/slashHandlers/updater.ts`: `/update` now reports and installs the channel-aware tag.
- Desktop `lib.rs`: `dist_tag_for()` + `fetch_npm_latest_cli(node, tag)`; `check_cli_update` compares against the channel of the app version and returns `channel`; `update_cli` defaults to the app's channel instead of `latest`.
- Desktop UI: `CliUpdateSection` shows the active channel and the matching install command; status line in `App.tsx` shows `npm <channel> v<version>`.
- Lockstep bump to 2.0.0-alpha.4 (root, core, desktop, tauri.conf, Cargo.toml/Cargo.lock, package-lock).

## [2.0.0-alpha.3] - 2026-08-19

Release-pipeline fix for the Windows desktop build (MSI bundler rejects non-numeric prerelease ids; NSIS-only on Windows) carried over from alpha.2, with the full lockstep version bump so the tag matches every manifest.

### Changed
- Lockstep bump to 2.0.0-alpha.3 across root zelari-code, @zelari/core, apps/desktop, tauri.conf.json, Cargo.toml/Cargo.lock and package-lock.json.

## [2.0.0-alpha.2] - 2026-08-19

Release-pipeline hardening: the tag now carries the full lockstep version bump (root, core, desktop, tauri.conf, Cargo.toml/Cargo.lock, lockfile) so publish/desktop workflows verify cleanly; workflow fix for prerelease dist-tag carried over from alpha.1.

### Changed
- Lockstep bump to 2.0.0-alpha.2 across root zelari-code, @zelari/core, apps/desktop, tauri.conf.json, Cargo.toml/Cargo.lock and package-lock.json.

### Fixed (workflow)
- **Windows desktop build failed on the MSI target** — Tauri's MSI bundler rejects non-numeric semver pre-release ids (`2.0.0-alpha.2` → "optional pre-release identifier in app version must be numeric-only and cannot be greater than 65535 for msi target"); macOS (DMG) and Linux (AppImage/deb) accept them, which is why only `desktop (windows-latest)` failed. Reproduced locally with `npx tauri build`. Fix: the release-desktop matrix now builds Windows with `--bundles nsis` only (NSIS accepts pre-release versions) while macOS/ubuntu keep `args: ""`.

## [2.0.0-alpha.1] - 2026-08-19

Second 2.0 pre-release: Linux CI fixes for the runtime seams (path jail + shell timeout process-group kill) and the version-lockstep bump that makes the publish/release-desktop tag pipeline green again.

### Fixed
- **Path jail on POSIX** — WorkspaceProvider.resolve now treats backslash as a path separator on every OS (shared resolveJailed helper used by LocalWorkspace and WorktreeWorkspace). Previously `..\file` stayed *inside* the jail on Linux (backslash is an ordinary filename char there), letting relative paths smuggle out of the workspace root. Regression test: providers.test.ts "treats backslash as a separator on every OS (no POSIX smuggle)".
- **Shell timeout left orphan processes on POSIX** — NodeShellProvider now spawns detached (own process group) on non-Windows and killTree sends SIGKILL to the whole group (process.kill(-pid)), so `sh -c "sleep 30"` no longer leaves the grandchild sleep running after the timeout. Regression test: "timeout kills the whole POSIX process group, not just the shell".
- **package-lock.json version drift** — the lockfile still carried 1.49.0 after the 2.0.0-alpha.0 bump, which could break `npm ci` in CI. Regenerated in lockstep.

### Changed
- Lockstep bump to 2.0.0-alpha.1

### Fixed (workflow)
- **npm publish of prereleases failed** — npm requires an explicit `--tag` for prerelease versions (`2.0.0-alpha.*`); the publish workflow called `npm publish` without one, so every alpha/beta tag failed at the publish step after tests passed. `publish.yml` now derives the dist-tag from the version (`alpha` / `beta` / `next` / `latest`) for both `@zelari/core` and the CLI. Reproduced locally: `npm publish --dry-run` fails without `--tag`, succeeds with it.
- **Desktop release version drift** — the desktop job verifies tag == package.json == tauri.conf.json == Cargo.toml; only package.json was bumped to alpha.1. Aligned `tauri.conf.json`, `Cargo.toml` and `Cargo.lock` to 2.0.0-alpha.1. (root zelari-code, @zelari/core, apps/desktop, devDependency exact match, lockfile).

## [2.0.0-alpha.0] - 2026-08-19

First 2.0 pre-release: the reconstructability + verifiability spine lands in `@zelari/core` (Phases 0–2 plus the deterministic verification contract of Phase 3A; CLI/Desktop surfaces keep working unchanged on the 1.x paths). Full plan: `.zelari/plans/2026-08-18-zelari-2.0-verifica-e-piano-implementazione.md`.

### Added
- **Session spine (ADR-0016 ratified, ADR-0021)** — `@zelari/core/session`: append-only JSONL log with `schemaVersion`, monotonic `seq`, single-writer ownership lock (stale-lock takeover), replay validation (corrupt lines / gaps / duplicates reported, never fatal), `deriveMessages` as the single model-history path, fork/resume lineage, portable session export. Default location `.zelari/sessions/<id>/events.jsonl`, override via `ZELARI_SESSIONS_DIR`.
- **Execution seams + profiles (ADR-0022)** — `@zelari/core/runtime`: `WorkspaceProvider` (local + git worktree, path-jailed), `FsProvider`/`ShellProvider` (node + in-memory impls for tests), `SubagentProvider` seam, `ExecutionContext` bundle, and versioned profiles `minimal/v1`, `kraken/v1`, `council/v1`, `mission/v1` with `toolManifestHash`.
- **Deterministic verification (ADR-0023)** — `@zelari/core/verification`: `Criterion` / `EvidenceRef` (tier + sha256 digest) / `VerificationResult` (`pass|fail|unknown`, `unknown ≠ pass` everywhere), `VerificationEngine` (command/file checks, zero LLM), `CompletionPolicy` → `PASS | REPAIR_REQUIRED | BLOCKED` (a clean "done" without sufficient evidence is blocked), Zelari Coding Criteria Pack v1, false-done metrics.
- **Optional VerifierService (Phase 3B, alpha)** — `@zelari/core/verification/verifier`: enable/disable, `inherit | fixed` model selection reusing the 1.49 `--verifier-provider/--verifier-model` channel semantics, effective provider/model always logged, progress score labeled `experimental`, hypothesis ranking, BoN N=3 primitive with **declared discrete fallback**; verifier output is advisory and can never flip `CompletionPolicy` (no P2 bypass).
- **Mission state from the spine (Phase 4, core)** — `@zelari/core/mission`: `deriveMissionState` projects `design → build → verification → done`, progress and replan counts from the session log; resume = reopen the log.
- **Experimental flags registry (Phase 5)** — `@zelari/core/experimental`: `ZELARI_EXPERIMENTAL` CSV gate (`bon`, `remote-sandbox`, `e2b-provider`, `generated-orchestration`, `nested-delegation`), all OFF by default.
- **Host CLI on the session spine** — headless dual-write (`--profile`, `--resume`, `--export-session`, `--strict-done`, `zelari-code --session-export`), TUI observe path, mission `mission.phase` + interrupt without `session.ended`.
- **Desktop 2.0 surface** — Settings: execution profile, strict BUILD gate, experimental BoN; chat: deterministic `verification_run` card (source/tier explicit, never a %); Tauri spawn forwards `--profile` / `--strict-done` / `ZELARI_EXPERIMENTAL=bon`.
- **Version coherence gate** — `npm run verify:versions` + CI step: root version === `@zelari/core` version, exact devDep match, CHANGELOG entry required.

### Fixed
- Version drift: root devDependency `@zelari/core` was `1.48.1` while the workspace package was `1.49.0` (registry-copy split-brain risk). Both now move in lockstep at `2.0.0-alpha.0`, enforced by the new gate.

### Notes
- Naming deviations from the plan §3A.1 due to pre-existing council barrel exports: the evidence tier type ships as `EvidenceRefTier` (was `EvidenceTier`) and the session listing entry as `SessionListEntry` (was `SessionSummary`). Semantics unchanged.

## [1.49.0] - 2026-08-18

### Added
- **Kraken Verified Selection (ADR-0020, Fasi 0-10)** — adaptive path selection for Kraken turns, behind `ZELARI_KRAKEN_SELECTION=1` (default off; when off the behavior is byte-identical to previous releases):
  - **Plan-safe candidate contracts** — explore/task tentacles are write-gated in plan mode (cap 3 candidates, `kraken_select` runs once, no blend).
  - **`kraken_select` tool** — a dedicated verifier (default = the parent Kraken model, override via `--verifier-provider`/`--verifier-model`/`--verifier-clear`, absent config = inherit) judges candidates with structured verdicts and `needs_more_evidence`; never throws — 0/1 usable candidates short-circuit without an LLM call.
  - **Adaptive playbook** — simple requests go direct, ambiguous ones spawn 2-3 candidates, required checks route into the plan's verification section (PLAN) or the verify tentacle's automatic Acceptance (BUILD).
  - **Structured verify reports** — verify tentacles report `<verify-report>` blocks per required check; `unknown ≠ pass`, `checksPassed` tracked in the `kraken_progress` projection.
  - **Completion/repair gate** — `fail`/`unknown` checks block a clean BUILD completion; max 1 automatic repair pass (headless retry + TUI enqueue), no second recovery system.
  - **Metrics** — `kraken_metrics` NDJSON event with `selection_used`, `candidate_count`/`candidate_tokens` (real usage deltas), `selection_tokens`/`latency`, fallback reasons, `needs_more_evidence`, verification pass/fail/unknown, `repair_triggered`/`repair_succeeded`. Turns without selection emit nothing (zero overhead).
- **Desktop Kraken progress/metrics card** (`KrakenProgressCard`) — renders the live `kraken_progress` phase (explore/verify/writes/checks chips, selecting/repairing phases) and the end-of-turn `kraken_metrics` summary; defensive readers ignore unknown payload fields and never throw on CLI/Desktop version drift.
- **Desktop Settings — "Kraken — Verification model"** — "Same as current model (recommended)" default, optional custom provider+model override, reset to inherit; persisted via the existing `--set-config` CLI flags.

### Changed
- `KrakenProgressPhase` union now includes `selecting` and `repairing`; `KrakenProgressPayload` carries optional `checkTotal`/`checksPassed` (additive — Desktop parsers are defensive by design).



## [1.48.1] - 2026-08-18

### Fixed
- **Grok stream stall — SSE keep-alives defeated the idle timeout** — `readChunkWithTimeout` reset the idle timer on *every* TCP chunk, including keep-alive frames (blank lines / `: ping` / `data:` with no choices) that Cloudflare-style gateways send periodically. A stalled model (grok-4.6 observed: process alive, socket ESTABLISHED, zero tokens for 20+ minutes) looked "alive" forever because each keep-alive restarted the 5-minute idle budget — the timeout never fired.
  - The idle budget now measures silence since the last **useful** delta (text / thinking / tool_call / usage), not since the last network byte. `markUseful()` stamps every content emission; keep-alive frames no longer count.
  - Fails fast with a clear error ("no content tokens — keep-alive frames don't count") after `ZELARI_PROVIDER_STREAM_IDLE_MS` (default 5 min) of content silence; the absolute cap `ZELARI_PROVIDER_STREAM_MAX_MS` is unchanged.
  - Regression tests cover both directions: keep-alive-only streams time out; active content streams never false-timeout.

## [1.48.0] - 2026-08-18

### Fixed
- **Unattended-build deadlocks (Grok "stuck working" with no errors)** — grok-4.6 is trained (grok-build style) to call `ask_user` mid-task; the tool-loop blocked forever on the picker promise while the TUI kept showing the generic `working` spinner. Every blocking wait is now bounded and visible:
  - `ask_user` clarification pickers (kraken + council paths in `useChatTurn`) are wrapped by `askUserTimeout` — default 5 minutes, tunable via `ZELARI_ASK_USER_TIMEOUT_MS` (`0` disables). On timeout the loop continues with a documented assumption note instead of hanging.
  - `createPermissionAskHandler` applies the same bound to every permission picker it creates (kraken / council / zelari / broker callers all inherit it). On timeout the request is denied with an explanatory note and the tool remains re-runnable.
  - `usePermissionBroker` external-agent question waits are bounded too — an unseen question can no longer orphan a turn.
  - `LiveRegion` renders an explicit "waiting for YOUR answer" banner with elapsed seconds whenever a picker is pending, replacing the silent spinner (wired in `app.tsx` via `pickerSince`).
- **Grok OAuth refresh hang** — `refreshGrokToken` now uses `AbortSignal.timeout(30s)`: a stalled `auth.x.ai` response becomes a visible, recoverable error instead of an infinite pending promise (previously indistinguishable from a dead model).

### Added
- `src/cli/hooks/askUserTimeout.ts` — shared bounded-wait helper (`ZELARI_ASK_USER_TIMEOUT_MS`, default `300000`, `0` = off) used by all ask-user / permission paths.

## [1.47.2] - 2026-08-17

### Fixed
- **DeepSeek HTTP 400 on tool catalog** — strict OpenAI-compatible validators (DeepSeek) require every `function.parameters` schema to be `type: "object"` at the root. `inspect_command` (1.46.0) was the first registry tool with a Zod union at the root of its input schema, so `zodToJsonSchema()` emitted `{anyOf:[…]}` with no root type and every DeepSeek run failed with `schema must be a JSON Schema of 'type: "object"', got 'type: null'`.
  - `zodToJsonSchema()` now guarantees an object root: unions of object branches are flattened (union of properties, `required` = intersection, discriminator literals collapse into an `enum`); unions with non-object branches pass through untouched.
  - `inspect_command` ships an explicit flattened `jsonSchema` (11-operation enum derived from the Zod union, per-operation optional params); runtime validation still runs on the Zod discriminated union.
  - The council catalog (`harnessToolBridge`) now prefers `tool.jsonSchema`, so union tools no longer degrade to `properties: {}`.
  - Regression tests assert every tool across all registry profiles (readOnly / planMode / full) serializes with `parameters.type === 'object'`.

## [1.47.1] - 2026-08-17

### Fixed
- **Publish CI** — `observe_batch` integration test now pins the repo root via `import.meta.url` so `npm test --workspace=@zelari/core` (cwd `packages/core`) does not resolve `src/cli/tools` against the core package. Same pattern as `inspect_command` in 1.46.1.

## [1.47.0] - 2026-08-17

### Added
- **Ground Truth observation meta** — `read_file` / `grep_content` / `list_files` now carry a typed `meta.status` (`complete` / `empty` / `partial` / `failed`) plus counts and short sentinels (`SEARCH_EMPTY_SCOPE`, `TREE_EMPTY`, `FILE_NOT_FOUND`, `DIR_EMPTY`, `EMPTY_FILE`). A completed search with zero matches is no longer confused with an empty scope. The AgentHarness appends a deterministic one-line footer only for non-clean observations.
- **Context-growth metrics (log-only)** — `BrainContextMetricsEvent` (`context_metrics`) is emitted once per run before `agent_end`: tool round-trips, UTF-8 bytes of tool results that entered history, history surface at request time, cache-hit tokens. Folded into `metrics.jsonl` and surfaced by `zelari-code --doctor`. Never rendered into the model-facing prompt.
- **`observe_batch`** — up to 8 independent read-only observations (`read_file` / `grep_content` / `list_files`) in one round-trip. Default `resultMode: evidence` keeps only deterministic evidence (counts, ranges, top matches) in context. Failures isolate; 48 KB aggregate cap; kill-switch `ZELARI_OBSERVE_BATCH=0`.
- **SessionSurface + `retrieve_observation`** — cold or oversized tool results project to a stable stub (`OBSERVATION ref=#N …`) while the JSONL log stays the source of truth. `retrieve_observation` rematerializes on demand. Stubs never expand (prefix-cache safe). Kill-switch `ZELARI_SESSION_SURFACE=0`.
- **Provider harness profiles** — `capabilitiesFor(model)` is the single model-aware policy object (context window, compaction thresholds, sampling). `deepseek-v4*` keeps the existing 1M window + priced cache; every other model stays on the default 400k profile. No DeepSeek-only product logic.

### Changed
- Compaction thresholds and default temperature now read from the harness profile instead of scattered literals. Per-request `generation.temperature` still wins (compaction replay stays at 0.1).

## [1.46.1] - 2026-08-17

### Fixed
- **`inspect_command` typecheck on hoisted monorepos** — resolve `typescript/bin/tsc` (and `npm-cli.js`) by walking up from the workspace root, not assuming `<cwd>/node_modules`. The publish job `npm test --workspace=@zelari/core` runs with cwd `packages/core`, where TypeScript is not installed locally; 1.46.0 failed four S3.5 fixtures with a false `TYPESCRIPT_UNAVAILABLE`. Tests now pin the repo root via `import.meta.url`.

## [1.46.0] - 2026-08-17

### Added
- **`inspect_command` (plan / read-only / explore)** — typed, no-shell inspector (`git_status` / `git_log` / `git_diff` / `git_show` / `git_branch_current` / `git_ls_files`, `typecheck`, `node_version`, `npm_ls` / `npm_outdated` / `npm_view`). The tool builds argv and `spawn`s with `shell: false`; `typecheck` redirects `tsBuildInfoFile` to a temp dir and guards the workspace so `composite` / `incremental` projects cannot leave `.tsbuildinfo` behind. Kill-switch: `ZELARI_INSPECT_COMMAND=0`.
- **LSP navigation in plan mode** — all five LSP tools (`go_to_definition`, `find_references`, `hover_type`, `document_symbols`, `rename_symbol` preview) are `permissions: ['read']`, so plan/explore keep the full ladder `ast → lsp → grep → read_file`. Missing servers surface an explicit degraded status instead of a silent empty result.
- **Observation Integrity (P1 / ADR-0019)** — a negative conclusion requires a completed, sufficiently scoped observation. EMPTY is evidence; DEGRADED / ERROR are not; TRUNCATED is partial only. The same rule is in the plan-mode banner and the Kraken explore prompt.

### Fixed
- **`ast_outline` silent empties** — `createAstTools(root)` now sandboxes paths against the workspace root (same root LSP already received). `parseFileSymbolsResult` reports a typed status (`ok` / `unsupported` / `typescript-unavailable` / `file-not-found` / `read-error` / `parse-error`); only a successful parse of a file with no declarations is EMPTY.
- **`grep_content` empty-scope masquerading as "not found"** — results now include `filesWalked` / `filesSearched` / effective filters. Zero files selected emits `SEARCH_EMPTY_SCOPE` ("Do not interpret this result as pattern not found"). Explicit `include: []` emits `DEPRECATED_INPUT` (accepted in 1.46; rejected in 1.47).

### Changed
- Plan-mode banner lists `inspect_command` and the Observation Integrity rule so agents refuse to conclude "does not exist" from degraded or zero-scope tool results.

## [1.45.0] - 2026-08-16

### Added
- **`--task-file` headless flag (CLI + Desktop bridge)** - `zelari-code --task-file <path>` (and `--kraken-graph-file <path>`) reads the headless prompt from a file instead of argv; the Desktop Rust bridge spills prompts larger than 8 KB to a `zelari-task-*.txt` temp file (best-effort cleanup at end of run, inline fallback if the spill fails), fixing Windows `CreateProcess` os error 206 ("filename or extension is too long") on long first messages - the same mitigation already adopted for `--history-file`.
- **Unit tests for headless flag parsing** - `src/cli/headless.test.ts` covers file reads, last-flag-wins precedence, missing/empty file validation errors and `--task`/`--kraken-graph` mutual exclusion (8 cases).

### Fixed
- **Live Tasks panel declutter (Desktop)** - completed and cancelled project tasks no longer render in the Live Tasks panel: empty phase groups collapse automatically, and the whole Project section (or the panel itself) disappears when nothing is active. The plan summary line keeps counting closed tasks, so progress numbers stay accurate.

## [1.44.0] - 2026-08-16

### Added
- **Post-council plan drift check** - `postCouncilHook` now runs a deterministic `plan.json <-> canonical` reconciliation after every council run: duplicate milestones, phases/tasks resurrected under retired slugs (canonical blocklist), canonical phases missing from the plan and tasks outside any known phase are reported as findings (errors/warnings) in `.zelari/drift-report.json`; fail-open by design (never throws, skip with `ZELARI_DRIFT_CHECK=0`).
- **Phase-grouped Project panel (Desktop)** - workspace project tasks render under their plan phase headers (`P0 -> Release` ordering from `phases[].order`) with per-phase counts, instead of a flat wall of tasks; the plan parser preserves `phaseId` / `phaseLabel` / `phaseOrder` from both the ADR-0018 envelope and the legacy nested `phases[].tasks[]` layout, and sorts by phase order so the panel always shows the plan's intended sequencing.

### Changed
- Desktop re-reads `.zelari/plan.json` of the active workspace on window focus, so plan normalizations performed while the app is open appear without a restart (previously re-read only at startup, workspace switch and run-finished).
## [1.43.0] - 2026-08-16

### Added
- **Workspace task store + task tools (ADR-0018)** - `task_create` / `task_update` / `task_list` operate on the canonical `.zelari/plan.json` envelope (schemaVersion + counter) with atomic tmp+rename writes, `.bak` backup and defensive caps; enabled on the `full` profile and plan mode; coexists with council plan writes (root fields preserved, `done`/`completed` dual vocabulary normalized both ways).
- **First-class task brain events** - `task_update` / `task_snapshot` in `@zelari/core/events` carry `BrainTaskPayload` (5 canonical statuses, session-todo vs workspace-plan source) with type guards; the CLI emits them on the headless NDJSON channel only after durable writes succeed.
- **Concurrent multi-run desktop** - Rust `RunRegistry` replaces the single-flight `RunState`: max one active run per workspace (canonicalized cwd key) and up to `MAX_PARALLEL_RUNS = 4` global runs; `cancel_run` accepts a specific `runId`.
- **Run-event envelope** - every `agent-event`, `agent-stderr`, `run-started` and `run-finished` now carries `runId` + `conversationId` + `cwd`; the frontend routes by envelope, never by active chat, so background runs keep writing to their own conversation while you chat elsewhere.
- **Workspace-aware conversations** - each conversation keeps its own `cwd` (legacy `zelari-desktop-workdir` value migrated on load) and its own session todos; files, git and mentions follow the selected conversation's workspace.
- **Unified Live Tasks panel** - session todos and workspace project tasks in one surface; project tasks parsed from `plan.json` (ADR-0018 envelope and council legacy shapes), updated optimistically from `task_update` events and reconciled from disk on `run-finished`; `blocked` status rendered for workspace tasks.

### Changed
- Desktop no longer blocks new chats, chat switching or opening folders while a run is active; the composer is disabled only when the *current* conversation has an active run. The sidebar shows per-conversation running and unseen-completion badges.

### Fixed
- **Cross-chat event contamination** - agent events were routed through the active conversation id (`activeIdRef`); every event is now attributed by its run envelope (test-grade invariant: no `activeIdRef` in the event path).
- **Legacy `done` tasks rendered as pending** - the desktop plan parser now normalizes council `done` to `completed` (caught by the 59-task real-plan fixture).
- **Council `writePlan` dropped the task-store envelope** - unknown root fields (`schemaVersion`, `counter`) are now preserved on every plan write, so the two writers can share one file.

## [1.42.0] - 2026-08-15

### Fixed (context & cache upgrade)
- **Rolling-history off-by-one with two system messages** — `seedLen` assumed exactly 1 system prefix; with stable+volatile system prompts the current user message leaked into the rolling history and got compacted away. The seed now derives from the actual `systemMessages.length`.
- **AgentHarness snapshots reported the transport family instead of the provider** — `provider: "openai-compatible"` hardcoded; now carries the real routed provider id (e.g. `deepseek`).
- **Few-but-huge histories never compacted under token pressure** — the `2 × maxMessages` count gate blocked occupancy-driven compaction; `force: true` now bypasses it and honors the requested window literally (`resolveMaxMessages`), with the naive cut clamped at 0.

### Added
- **Routed request snapshots + deterministic fingerprints** (`@zelari/core/harness`): `createRoutedRequestSnapshot` records provider/model/system prefix/canonical (lex-sorted) tool schemas + conversation with SHA-256 `headerFingerprint`/`requestFingerprint`; `compareReplayPrefix` (telemetry-only) reports prefix divergence. `AgentHarnessConfig.onRequestSnapshot` emits at both routing sites.
- **Full-request meter with provider-usage anchoring** (`src/cli/budget/requestMeter.ts`): measures system + tool schemas + `reasoningContent` + `toolCallId` + role overhead, anchors the stable header to provider-reported `promptTokens` when the header fingerprint matches, and never subtracts `cachedPromptTokens` from context pressure. `requestSnapshotStore` (per-session, `/clear`-aware) keeps the last snapshot + usage.
- **Cache-aware compaction via prefix replay** (`src/cli/budget/llmCompact.ts` rewritten): the summarizer request is `SYSTEM(original) + TOOLS(original, sorted) + DROPPED PREFIX + COMPACTION_INSTRUCTION` routed through the live `providerStream` — byte-identical prefix up to the trailing instruction, so the provider KV/prefix cache keeps hitting (cached tokens ≈ 1/10 cost). Accidental tool calls reject the summary; `ZELARI_COMPACT_MODEL` forces a different model and marks `cacheReuseExpected: false`.
- **Prune → remeasure → summarize pipeline** (`applyBudgetPolicyAsync`): ≥80% prunes oversized tool results in place (cache-preserving) and remeasures BEFORE calling the summarizer; ≥85% compacts with force+replay (retry with minimal window for few-but-huge cases); ≥95% emergency hard trim. Summaries that don't shrink the dropped source are rejected (P13).
- **Checkpoint-as-user (P12)**: the compaction summary is now a `user` message wrapped in `<compacted-summary>` instead of a new `system` block — the system prefix stays byte-stable across turns for cache reuse.
- **`session_compacted` event** extended with fingerprints, estimated sizes, pruned count, and `cacheReuseExpected`; cache telemetry line surfaced in budget warnings.
- **Regression suite** `tests/unit/cli-context-cache-upgrade.test.ts` (26 cases covering the spec's 22 mandatory checks).

## [1.41.0] - 2026-08-15

### Fixed
- **Desktop swallowed real CLI errors** - Tauri `invoke` rejections are plain strings, so `e instanceof Error` fallbacks discarded the CLI stderr. New `errText()` surfaces the actual message for provider/model/thinking persistence and CLI status (e.g. `invalid --thinking value 'xhigh'`).
- **“Failed to set thinking effort” with no explanation** - when the installed CLI rejects a thinking value (older CLI vs newer app), the status line now tells you exactly that and how to fix it (`npm i -g zelari-code@latest`).

### Added
- **Settings CLI/app version mismatch warning** - “CLI package (npm)” card now compares the installed CLI version against the app version and warns when the CLI is older (the root cause of missing xHigh/Max rejections), with a one-click Update CLI.

## [1.40.0] - 2026-08-15

### Fixed
- **Desktop thinking picker ignored the selected model** — options are now computed from the toolbar model, so Grok 4.6 shows xHigh immediately and DeepSeek shows High/Max (no more silent Low/Medium/High fallback).
- **Toolbar model change was not persisted** — switching provider/model now writes `provider.json` so the next snapshot and the next turn use the same model.

### Changed
- Default models: Grok / OpenAI-compatible → `grok-4.6`, ChatGPT → `gpt-5.6-codex`, Anthropic → `claude-sonnet-4-6`.

## [1.39.0] - 2026-08-15

### Added
- **Native xhigh / max thinking levels** — `/effort xhigh` and `/effort max` (plus Desktop Thinking dropdown) on models that accept them natively: grok-4.6 (`xhigh`), GPT-5.4 (`xhigh`), GPT-5.6 (`xhigh`+`max`), DeepSeek V4 (`max`), Claude Sonnet 4.6 (`max`), Claude Opus 4.7+ (`xhigh`+`max`), GLM-5.x (`max`). Other models keep low/medium/high (or budget tokens) and clamp instead of 400.

### Changed
- Desktop thinking picker is now **per-model** (`thinkingCapability.efforts` from `--print-config`), not a fixed Low/Medium/High list.

## [1.38.0] - 2026-08-15

### Added
- **ChatGPT Codex device OAuth** — start/poll uses Codex JSON (`device_auth_id` + `user_code`) instead of RFC 8628 form-urlencoded, which was returning HTTP 400.

### Changed
- **Desktop chrome** — slightly tighter glass topbar; session list stays archive/delete only.

### Removed
- **Desktop Workbench toggle** and **Export MD / JSON** buttons from the topbar and session list (in-chat todos remain).

## [1.37.0] - 2026-08-14

### Added
- **Unified thinking-effort selection** — new `/effort` slash command sets reasoning depth for every supported model: `auto` / `off` / `low` / `medium` / `high` (OpenAI & xAI `reasoning_effort`) and `budget:<tokens>` (Anthropic `budget_tokens`). Persisted per provider in `provider.json`; unsupported combinations degrade to `auto` with a warning instead of erroring.
- **Desktop thinking-effort selector** — a Thinking-effort dropdown in the model bar, with provider-aware options exposed via `--print-config` (`thinkingCapability`) and persisted through `--set-config --thinking <spec>`.
- **ADR-0016 & ADR-0017** — architecture decisions for an event-sourced session log and the unified thinking-effort control.

## [1.36.0] - 2026-08-14

### Added
- **DeepSeek context caching (thinking wire + V4 pricing)** — `thinking` / `reasoning_effort` sent explicitly for DeepSeek (default `high`, kill `ZELARI_DEEPSEEK_THINKING=off`); assistant `reasoning_content` is passed back only on tool-call turns (DeepSeek otherwise ignores and bills it); V4 prices corrected (flash cache hit `$0.0028`; pro `$0.435` in / `$0.87` out / `$0.003625` cache hit).
- **Stable prompt prefix for cache-friendly providers** — headless now emits two `system` blocks (stable identity + tools, then volatile workspace/RAG); tool schemas (`body.tools`) and the `AVAILABLE TOOLS` block are sorted canonically so the cached prefix no longer busts when tool registration order changes.
- **Tool-result prune on compaction** — oversized `role: 'tool'` results are truncated in place (head + marker + tail) before turns are dropped, preserving the append-only cache prefix. Tunable via `ZELARI_TOOL_RESULT_MAX_CHARS` / `ZELARI_TOOL_RESULT_TAIL_CHARS`.
- **Context budget aligned to DeepSeek v4** — `deepseek-v4-*` models default to 1M-token context (was 400k).

### Fixed
- **Desktop session todos reset every message** — the per-message headless process is now seeded with the prior todo list (`--todos <json>`), so the Tasks panel persists across turns.
- **Empty `todo_read` wiped the Tasks panel** — empty todo lists now parse as `null` instead of a truthy empty array.

## [1.35.1] - 2026-08-14

### Fixed
- **Desktop session todos never appeared** — `tool_execution_end` does not carry `toolName`, so the UI never recognized `todo_write` / `todo_read`. Names are now tracked from start events; the task list paints from `todo_write` args immediately and refreshes from the tool result.
- **Desktop live work was a fading thinking line** — the run card now keeps a this-turn tool feed (`read_file`, `write_file`, …) so you can see what the agent is doing while it runs.
- **Companion APK manifest merge** — removed a conflicting `CaptureActivity` `screenOrientation` override that blocked `assembleDebug`.

## [1.35.0] - 2026-08-14

### Added
- **Companion QR pairing** — Desktop Settings → Connections → **Mobile connection** starts `zelari-code serve` bound for Tailscale/LAN (`0.0.0.0`), detects the PC Tailscale IPv4 (`100.64–127.x`), and shows a QR (`zelari://pair?url=…&token=…`). The Android companion scans it (camera), fills URL + token, and connects. Loopback addresses (`127.0.0.1` / `localhost`) are rejected on the phone with a clear explanation.
- **Anthropic prompt cache breakpoints** — the Anthropic provider sends `cache_control` on the stable system block and the last conversation message; `ZELARI_PROMPT_CACHE_TTL=1h` adds the extended-cache beta header. Cache read/creation tokens fold into usage (`cachedPromptTokens`).
- **Read-only tool-result cache** — `withResultCache` wraps `read_file` (invalidated on mtime+size), `grep_content`, and `list_files` (5 min TTL). Kill switch `ZELARI_TOOL_CACHE=0`, cap 200 entries, skip payloads over 256KB.

### Changed
- **Prompt/token cost path** — tool JSON schemas are memoized on the registry; OpenAI-compatible message mapping is incremental (`WeakMap`); council `member_cost` folds into StatusBar session stats and metrics `run` records now include `tokens` / `costUsd`.
- **Streaming CPU** — tool-call args parse once at flush; text-loop detection scans a bounded tail; `cleanAgentContent` runs at 16ms (including council); session JSONL batches appends (32 events / 250ms) with turn-end `flush()`.
- **Lifecycle hooks** — hook JSON is reloaded only when file mtime/size changes, not on a 30s TTL.
- **Diff / walk** — LCS trims common prefix/suffix and refuses regions over 4M cells; exclude globs are compiled once per walk; `read_file` splits the file once.
- **Desktop companion bind** — default listen address for Mobile connection is `0.0.0.0` (phone/Tailscale/LAN), not `127.0.0.1`.
- **License: MIT → Apache-2.0** — the entire monorepo (CLI, `@zelari/core`, Desktop, Companion) is Apache-2.0 ([ADR-0009](docs/decisions/0009-apache-2-0-license.md)).
- **First-principles manifesto + CI gate** — `PRINCIPLES.md` (P1–P6) and `npm run verify:principles` on every PR ([ADR-0010](docs/decisions/0010-first-principles-manifesto.md)).

### Fixed
- **`ZELARI_SHELL=powershell.exe` lost to Git Bash** — an explicit PowerShell override now wins over auto-detected Git Bash.
- **Typecheck after the v1.35 batch** — `SessionJsonlWriter.ensureDir` maps `mkdir` to `void`; `show_diff` hunk ops use an explicit type; OpenAI mapper imports `AgentMessage`.

## [1.34.0] - 2026-08-13

### Added
- **ChatGPT and Anthropic subscription OAuth** — `/login chatgpt` runs the Codex device/magic-link flow; `/login anthropic` opens the Claude magic-link page, then `/login anthropic CODE#STATE` completes it. Tokens (access + refresh, plus ChatGPT account id) live in `keys.json`. API keys remain optional (`sk-…`).
- **Desktop Settings OAuth** — Provider tab can Sign in / Refresh token / Sign out for Grok, ChatGPT, and Anthropic. New CLI flags: `--login-oauth`, `--refresh-oauth`, `--logout-oauth`.
- **Model discovery for ChatGPT and Anthropic** — live `/models` after OAuth, with static fallbacks (`gpt-5.2-codex`, `claude-sonnet-4-5`, …). Chat routes ChatGPT through the Codex Responses API and Anthropic through Messages.

### Changed
- **`/provider <id> refresh`** now force-refreshes OAuth tokens even when they are not near expiry (same as Desktop Refresh token).

## [1.33.2] - 2026-08-12

### Fixed
- **Desktop release flakiness (Windows/Linux bundler)** — pinned `tauri-action` to the exact commit the floating `@v0` tag resolves to (reproducible builds, no silent breakage from the `action-v1.0.0` move) and added a 60-minute job timeout. Windows/Linux installer builds intermittently failed at the bundler tool download (NSIS/AppImage); re-running the failed jobs completes the release.

## [1.33.1] - 2026-08-12

### Fixed
- **CI: changelog notes path resolution** — `extractChangelogNotesFromFile` resolved a relative `CHANGELOG.md` against `process.cwd()`. Under `npm test --workspace=@zelari/core` the cwd is `packages/core`, so the file ENOENT'd, the `changelog-notes` test failed, and the `publish-core` job aborted before `npm publish`. Relative paths now resolve against the repo root (the script's directory parent).

## [1.33.0] - 2026-08-12

### Added
- **Desktop Workbench <-> Kraken plan/build** — the Workbench gains `Plan` and `Tasks` tabs. With a Kraken graph active, `plan` runs the CLI in plan-only mode (`--plan-only`, writes a plan file and captures its id) and `build` executes the saved plan (`--run-plan <id>`); the `Tasks` tab renders the live session todo list (`pending`/`in_progress`/`completed`/`cancelled`).

### Removed
- **Bennett's Razor tooltip** — the "Bennett's Razor" pill and its explainer modal were removed from the Desktop app (component and CSS dropped).

### Fixed
- **Kraken plan file serialization** — `plan-<id>.json` is now written as `{ id, nodes: [...] }`; previously `JSON.stringify` serialized the `TaskGraph.nodes` `Map` as `{}`, so `--run-plan` (which expects an array) failed.
- **Desktop App updates 404** — a notes-only GitHub Release marked `--latest` hid `latest.json` (`/releases/latest/download/latest.json` → 404, Settings showed "Could not fetch a valid release JSON from the remote"). `publish.yml` now creates the CLI release with `--latest=false`; `release-desktop.yml` marks latest only after signed artifacts upload.
- **GitHub Release notes on tag push** — extracting the CHANGELOG section no longer builds a RegExp from `## [1.32.0]`. YAML/bash/`node -e` quoting dropped the `\[` escapes, so Node compiled `/## [1.32.0]…/` and died with `Unterminated character class`. Notes are now sliced by heading text (`scripts/changelog-notes.mjs`, inline fallback in `publish.yml`).

## [1.32.0] - 2026-08-12

### Added
- **Folder trust for project-scoped execution** — project MCP servers and lifecycle hooks now load only for trusted folders. Trust can be managed with `/trust`, `/trust remove`, or `zelari-code --trust`; the persisted store lives at `~/.zelari-code/trust.json`, with `ZELARI_FOLDER_TRUST` overrides for CI and lockdown. User-global MCP and hooks remain active.
- **Lifecycle hooks** — `PreToolUse`, `PostToolUse`, `SessionStart`, and `SessionEnd` hooks can run local commands or HTTP endpoints. Hooks are fail-open on crashes, timeouts, and invalid responses; only an explicit deny decision blocks a tool call.
- **Unified environment inspection** — `zelari-code --inspect [--json]` reports project configuration sources, skills, MCP status, lifecycle hooks, plugins, AGENTS.md, mode/phase, and folder trust.

### Changed
- **MCP startup security** — an untrusted project `.zelari/mcp.json` is ignored with an actionable warning instead of starting project-provided processes automatically.

### Tests
- Added lifecycle-hook coverage for allow, explicit deny, invalid output, process failure, timeout, HTTP hooks, matching, and execution order; MCP integration tests now cover the folder-trust gate.

## [1.31.1] - 2026-08-12

### Fixed
- **MCP preset `qwen-mm-plugins` could not start** — the builtin preset ran bare `uvx qwen-mm-plugins-core`, which fails to resolve because the package is published only on GitHub (tag `qwen-mm-plugins-core-v1.0.1`), not on PyPI. The preset now emits the upstream installer's PEP 508 spec (`uvx --from "qwen-mm-plugins[core] @ git+https://github.com/QwenLM/Qwen-MM-Plugins.git@qwen-mm-plugins-core-v1.0.1" qwen-mm-plugins-core`) and sets `PYTHONIOENCODING=utf-8` to avoid the cp1252 crash on Windows when the server prints `✗` during `--check-system`. Verified on Windows: 72 packages installed, MCP stdio handshake + `tools/list` (read_image, media_info, read_video, ...) OK.
- **`@` mention parser: POSIX absolute paths were dropped on Linux/CI** — `@/tmp/...` outside the project root now resolves, consistent with the Windows `@C:...` fix from v1.31.0. Regression-covered in `tests/unit/cli-atMentions.test.ts`.

## [1.31.0] - 2026-08-12

### Added
- **Native vision, no third-party APIs** — images travel to the active model as OpenAI-compatible `image_url` content blocks, using the same provider key as the text turn; no DashScope or other external vision service is involved. New `AgentImage` type + `images?` field on `AgentMessage` (`packages/core/src/core/AgentHarness.ts`); `modelSupportsVision()` recognizes vision-capable models (grok-4, glm-4.5v, qwen-vl, minimax-m2, gpt-4o, ...) with a `ZELARI_VISION=1/0` override, and a text fallback warns when the active model cannot take pixels. `@image.jpg` mentions in the CLI now inline the file as base64 (absolute Windows paths `@C:\...` work, and images outside the project root are allowed); the Desktop drop-to-attach reads images as base64 and emits `@<path>` so the attachment reaches the CLI. End-to-end verified with the real `grok-image-…` file on Desktop.
- **Built-in skill: `qwen-mm-plugins-install-setup`** — the full Qwen-MM-Plugins guide (capabilities table, per-harness install commands, system deps, API-key config, usage, verification checklist) shipped as a builtin skill in `@zelari/core` (`packages/core/src/agents/skills/builtin/qwenMmPlugins.ts`), registered in `BUILTIN_SKILL_MODULES`.
- **MCP integration presets: `composio` and `qwen-mm-plugins`** — `mcpPresets.ts` now exposes factory-built presets: `composio` (500+ app integrations via `npx composio-mcp`, key read at apply time) and `qwen-mm-plugins` (multimodal MCP tools via `uvx`, capability selected with `QWEN_MM_PLUGIN`, keys via env). New `/integrations` slash command lists presets + status.
- **External-agent permission broker (OpenMausBot pattern)** — `zelari-code --permission-mcp <socket>` runs a standalone MCP stdio server; an external CLI (e.g. `claude --permission-prompt-tool "zelari-code --permission-mcp <socket>"`) forwards `approve`/`ask_user` requests to the parent zelari process over a local socket (`ZELARI_PERM_SOCKET`), routed through the existing TUI permission picker and policy (`defaultPermissionPolicy`, `resolveToolPermission`, session grants). New modules: `permissionBroker.ts`, `mcpPermissionServer.ts`, `permissionCli.ts`, `brokerHandlers.ts`, `usePermissionBroker.ts`. Zero new dependencies (`node:net` JSON-lines).
- **Local-CLI provider** — `ZELARI_LOCAL_CLI=claude` (or any external agent CLI) drives the harness through an external CLI's `stream-json` protocol: zelari spawns the CLI in print mode, translates its events into `ProviderDelta`, and permission prompts flow back to the zelari broker. New modules: `src/cli/provider/localCli/claudeProvider.ts`, `claudeStreamJson.ts` (pure `buildClaudeInputLines` + `createClaudeStreamParser`).

### Fixed
- **`@` mention parser: absolute Windows paths were dropped** — `@C:\...` was rejected because the drive-letter token contains `@` (the token collector discarded anything with `@` inside), and the Windows-absolute regex matched `/` but not `\`. Both fixed; `@C:/Users/.../image.jpg` and `@C:\Users\...\image.jpg` now resolve. POSIX absolute `@/tmp/...` paths also resolve, so outside-root images work on Linux/CI too. Regression-covered in `tests/unit/cli-atMentions.test.ts` (6 tests).
- **Desktop drop-to-attach for images was a no-op** — `readFileAsAttachment` returned "binary — path only", so dropping an image produced a prompt with no pixels. Now reads images as base64 and emits `@<path>`.

### Changed
- **MCP presets are factories** — env-dependent config (`COMPOSIO_API_KEY`, `DASHSCOPE_API_KEY`, `SERPER_API_KEY`, `QWEN_MM_PLUGIN`) is read at apply time, never captured at module load.

### Tests
- New/updated suites: `cli-atMentions` (image inlining + Windows paths), `cli-vision-provider` (vision gate), `cli-mcpPresets` (composio/qwen-mm factories), `cli-permissionBroker`, `cli-mcpPermissionServer`, `cli-brokerHandlers`, `cli-localCliProvider`.

## [1.30.4] - 2026-08-09

### Fixed
- **Desktop: the Bennett's Razor modal could not be closed once scrolled** - the v1.30.3 frost added `backdrop-filter` to `.razor-modal`, which is also the modal's scroll container; in WebView2 a backdrop-filter on a scroll container breaks `position: sticky` on its descendants, so the head row with the × close button scrolled away with the content and the modal became effectively unclosable. The modal is now a flex column: the head is a `flex-shrink: 0` row outside the scroll area (sticky removed) and `.razor-modal-body` owns the scrolling (`flex: 1 1 auto; min-height: 0; overflow-y: auto`). The × is always visible; the frost is unchanged.

## [1.30.3] - 2026-08-09

### Fixed
- **Desktop: Workbench panel and Bennett's Razor modal still showed the chat through them** - the v1.30.1 alias fix made both surfaces resolve `--bg-elev` to `rgba(28, 28, 32, 0.72)`, a 72%-alpha glass with **no** backdrop blur, so the chat stream scrolling underneath stayed clearly visible through the panel and the modal. Every other overlay in the app (sidebar, glass capsules, cards) pairs its translucent fill with `backdrop-filter: blur(28px) saturate(160%)`, which frosts what is behind it; these two were the only surfaces missing the blur, so they read as broken. Both now pin a local `--bg-elev` (near-opaque `rgba(18, 18, 22, 0.95)`) plus the same `blur(28px) saturate(160%)` recipe as `.sidebar`; child blocks that reference the token (workbench head / meta / body / tabs, razor modal head) inherit it, so each surface reads as one solid block. Light theme mirrors it with a near-white fill (`rgba(250, 250, 252, 0.96)`).

## [1.30.2] - 2026-08-08

### Fixed
- **Desktop: any `position: fixed` right-rail panel sat on top of the OS window controls** - the v1.30.1 alias fix closed the *transparent* part of the workbench bug, but a second issue was still open: both `.workbench-panel` and `.razor-modal-backdrop` had `top: 0` / `inset: 0`, so the workbench panel's own close (×) button overlapped the OS window's minimize/maximize/close controls on the frameless titlebar. A click that landed a few pixels high on the panel's × instead closed the whole Zelari app. Added `--titlebar-h: 36px` in `:root` and shifted both surfaces to start at `top: var(--titlebar-h)`. The razor modal is also now vertically centered in the *content* area, not in the area that includes the titlebar.
- **Desktop: workbench panel still read as "transparent"** even with the alias fix, because `.workbench-panel-head`, `.workbench-panel-meta` and `.workbench-panel-body` inherited `transparent` from the parent and let the chat stream leak through. Pinned `background: var(--bg-elev)` on each so the panel reads as one solid block top-to-bottom and is robust against future tweaks that swap the parent background.

## [1.30.1] - 2026-08-08

### Fixed
- **Desktop: Workbench panel opened behind the rest of the UI and read as transparent** - the side panel that hosts the Kraken graph visualizer and the live markdown tail had two overlapping defects:
  1. `var(--bg-elev)` was referenced by 12+ selectors across the app (`.workbench-panel`, `.workbench-panel-tabs`, `.razor-modal`, the weakness tip, the kraken-graph side card, the `wb-*` blocks) but never defined anywhere - the canonical name is `--bg-elevated`. `var(--bg-elev)` with no fallback resolves to `unset`, so the background was fully transparent and the content underneath leaked through. Added a backwards-compatible alias `--bg-elev: var(--bg-elevated)` in both the dark and light theme blocks; every existing call site now picks up the right value. Follow-up can rename the call sites and drop the alias.
  2. `.workbench-panel` sat at z-index 800 - just below the Bennett's Razor modal backdrop (1000), so opening the modal covered the panel. Bumped to 1100 and added `isolation: isolate` so the `position: fixed` is anchored to the viewport even if a future ancestor ever gains a `transform` / `filter` / `backdrop-filter` (which would otherwise re-anchor the fixed element to that ancestor and could let sibling content visually "leak" over the panel).

## [1.30.0] - 2026-08-08

### Added
- **Kraken: weakness-based hypothesis selection (Bennett's Razor)** - port of the principled selection rule from Bennett, M. T. (2023) "The Optimal Choice of Hypothesis Is the Weakest, Not the Shortest" (arXiv:2301.12987v4). The planner and verify personas can now be steered toward the *weakest* consistent hypothesis (smallest extension `|Z_l|`, "no more specific than necessary") instead of the most concise (MDL). A new `packages/core/src/kraken/weakness.ts` ships `BENNETTS_RAZOR` (the explanatory banner) and `WEAKNESS_METER_PROMPT` (the LLM meter prompt) plus a pure-TS heuristic `rankByWeakness<T>()`, `pickWeakest()`, and `filterByWeakness()` so the choice is testable without an LLM. ADR 013 documents the trade-off vs MDL. Opt-in in the planner via `ZELARI_KRAKEN_PLANNER_BENNETTS_RAZOR=1` (default off in v1.30.x; the LLM cost is real, the LLM benefit is real, but the heuristic covers the cheap cases).
- **Kraken: weakness meter wiring** - the persona verdict's local weakness score (specificity scan) is now optionally refined by an LLM meter (`ZELARI_KRAKEN_WEAKNESS_METER=1`, `measureWeaknessViaLLM` in `src/cli/kraken/weaknessMeter.ts`). The meter is **silent on failure** (returns `null` on HTTP non-2xx, malformed JSON, zod reject, network error) so the local heuristic remains the source of truth and the executor never propagates meter exceptions. A new `node_meter` radio event lands in `.zelari/radio/*.jsonl` so the Desktop can show a "tightly asserted PASS" vs "loosely claimed PASS" distinction in the workbench.
- **Kraken: workflow script runtime (Pillar 4)** - users can now express multi-step graph tasks as a single declarative script that runs in-process inside Node's `vm` module with a capability-based allow-list (`scriptPlanner.ts` + `runtime/`). No child process, no shell-out per step. The runtime injects only the host functions the script declares; untrusted code can read the graph state, claim nodes, and emit radio events but cannot reach `process`, `fs`, or the network unless the host opts in. `scriptPlanner.ts` bundles the script with esbuild and runs a static typecheck pass before execution, so a malformed script is caught at planner time. Slices B/C+D/E/G/J-C1/K catch-up included: spec council (`personas/`), `WorkbenchWriter` with atomic write + 500ms debounce, `/kraken fanout` slash command, `/kraken workbench` viewer, `skillSuggest.ts` (LLM-driven `ZELARI_KRAKEN_SKILL_SUGGEST=1`). ADR 012.
- **Kraken: deps in the workbench digest** - each `WorkbenchNode` now carries an optional `deps?: string[]`, surfaced as a `← a, b, c` column between `kind` and `scope` in the Wave table. The retro-compatible Wave table parser in the Desktop visualizer now reads the deps column too and renders it as a small badge group.
- **Kraken: pre-flight plan review (headless + Desktop)** - `--plan-only` / `ZELARI_KRAKEN_PLAN_ONLY=1` writes the planner's output to `.zelari/radio/plan-<id>.json` and exits 0, so a user can review a graph before any worker touches the filesystem. `--run-plan <id>` / `ZELARI_KRAKEN_RUN_PLAN=<id>` loads the saved plan and skips the planner. The Desktop `PlanReviewPanel.tsx` (Slice N+4) lists plan files (most-recent first), shows the node table inline, and offers an "Approve & copy run command" affordance that copies `zelari-code --run-plan <id>` to the clipboard. The user pastes it in a terminal; the GUI does NOT spawn a child process in this MVP because that needs a Tauri command + cancel/status stream + re-attach on focus, which is a separate lifecycle design.
- **Desktop: Bennett's Razor UI surface (Slice N)** - four new components ship the weakness direction to the user:
  - `BennettsRazorExplainer.tsx` - a pill in the header that opens a modal with the full paper argument (specificity vs brevity, why LLMs are prone to fabrication, when to enable the planner's opt-in). Zero deps, Escape/click-outside to close.
  - `WeaknessBadge.tsx` - a 3-bucket badge (tight / medium / loose) using the same local heuristic the workbench uses, so a verdict PASS looks different from a loosely-claimed PASS.
  - `WorkbenchLiveTail.tsx` - polls `.zelari/radio/workbench-*.md` every 1.5s and re-renders, with a tiny zero-dep markdown parser for headers/lists/code.
  - `KrakenGraphVisualizer.tsx` + `WorkbenchPanel.tsx` - the full Slice N #1: a tabbed panel (Graph / Tail), ASCII-style topology, per-node color by kind, weakness dot, click-to-inspect side card. Edges are now drawn as an SVG overlay with `useLayoutEffect` + `ResizeObserver`, positions from `getBoundingClientRect()` translated into container-relative coords, with a marker arrowhead that reuses the existing CSS palette.
- **Kraken: 3 platform-specific test gaps closed** - `cli-skillsMd.test.ts` (global home loader scan), `cli-taskTool-worktree.test.ts` (cross-platform `readdirSync` vs `execFileSync('ls')`), `core-shellTool.test.ts` (PowerShell as a valid resolver). Re-verified: full suite is green on Windows.

### Robustness
- **Kraken: CSV fanout rename race** - three concurrent workers in the fan-out pool were all `fs.rename`-ing into the same target path; on Windows the destination is briefly locked during a rename, and a sibling rename fails with EPERM/EBUSY (or, when a tmp-file suffix also collided, ENOENT). The atomic writes are now serialized through a `Promise` chain (`writeChain` in `runCsvFanout`), with a random hex suffix kept on the tmp filename as a second line of defense. Tail semantics are unchanged: each worker still rewrites the full output, and the final file always contains every completed record. 5/5 consecutive full-suite runs now green; before the fix the suite was flaky at ~50% on `marks every row as error when the host is unreachable`.

## [1.29.0] - 2026-07-28

### Fixed
- **Kraken graph: a `verify` node's verdict was never read** — a node was `done` whenever its tentacle finished without an execution error, so a verify that ran correctly and concluded "this work is wrong" was recorded exactly like one that concluded "this is correct": the graph converged over the known defect. The only iteration the engine could do was on execution failure (retry, then a `fix` node), never on quality. The auto-injected verify prompt now asks for a `VERDICT: PASS` / `VERDICT: FAIL` trailer, parsed by a new pure `parseVerifyVerdict` in `@zelari/core`; the verify node itself stays `done` either way (reporting a defect is it working), while a FAIL sends the **writer** back through a bounded rework round. The parser takes the LAST trailer, because models routinely echo the instruction before answering and a first-match scan inverted the gate on exactly the verbose runs where the judgement matters most. A missing trailer is `unknown` — non-blocking, but reported, since a gate that has silently stopped working is worse than no gate. See `.zelari/docs/enanchement.md`.

- **Kraken graph: dependency edges carried no information** — a node's `result` was stored and never read, so a dep edge was a pure ordering constraint. An `explore` node's findings were computed and thrown away; the `general` nodes it "fed" started from zero, and the auto-injected `verify` node knew only the three-word label of the work it was checking. Each node now receives its completed dependencies' conclusions as a `## Context from completed upstream tasks` section (per-dep cap 2800 chars, 8000 total, mirroring the council path's `MAX_PRIOR_CHARS`), and the planner is told this so it can write dependent prompts that build on upstream findings instead of duplicating the research.
- **Kraken graph: the merge node never merged anything** — `buildGraphFromPlan` points a `merge` node at the auto-injected `verify` nodes, but worktree handles are recorded against the *writer* node ids, so looking only at direct deps found nothing, reported "nothing to merge" and converged while every tentacle's work stayed stranded on its branch. (The existing test constructed the merge node with deps on the general nodes directly — a shape the planner never produces — so it passed.) The executor now walks up through non-writer deps to find the writers, merges them ancestors-first, and drops each handle once merged.
- **Kraken graph: a successful fix still reported the graph as failed** — the repaired node was left terminally `error`, and since `isConverged` requires every node to be `done`/`skipped`, a fully repaired graph printed "graph did not converge" and listed the repaired node in `failedNodeIds`. Worse, the cross-run snapshot then filed it under "failed — needs to be finished or repaired", so the next `continua` redid work the fix had already completed. A node whose fix succeeds is now marked `done`, keeping the original failure visible in its result line.
- **Kraken graph: verify tentacles inspected the wrong tree** — with `ZELARI_KRAKEN_WORKTREE=1` the writer works in an isolated worktree and the merge happens *after* verification, so a verify tentacle pointed at the parent tree was checking a tree that provably did not contain the work yet. `runTentacle` gains a `cwdOverride` and the executor points each verify at its writer's worktree (falling back to the parent tree when there is no single tree to check).

### Added
- **Kraken graph: bounded rework rounds** — on a verify FAIL the executor spawns a `rework` node (carrying the reviewer's findings, inheriting the writer's scope/acceptance) plus a fresh verify, and repoints whatever waited on the old verify (typically the `merge`) at the new one so a branch cannot be merged mid-rework. The rework runs **inside the writer's existing worktree** (`allowWorktree: false` on its deps, `cwdOverride` from the generalized `inheritedWorktreeCwdFor`): a second worktree on the same scope means a second branch, which the merge walk would merge never or twice. Rounds are counted per **lineage**, not per node — a rework is itself a writer, so a per-node counter reset every round and chained reworks forever. `ZELARI_KRAKEN_MAX_REVIEW_ROUNDS` (default 1), budgeted separately from the fix budget so a quality rework never eats the repair budget.
- **Kraken graph: degraded convergence** — when the rework budget is spent with the verify still failing, the graph converges (losing every sibling's good work to one residual defect helps nobody) but says so: the writer's result is marked `[accepted with unresolved verify findings]`, `KrakenExecutionSummary.unresolvedFindings` carries the verdict, the digest gains an `unresolved verify findings` section, and the cross-run snapshot lists the node under "Completed but REJECTED by review" instead of "do NOT redo this work" — `formatSnapshotForPlanner` no longer early-returns on a converged run, which previously meant a converged-but-rejected graph told the next planner nothing at all.
- **Kraken graph: whole-run wall-clock budget** — `ZELARI_KRAKEN_GRAPH_TIMEOUT_MS` (default 0 = off). Per-node timeouts bound each tentacle but say nothing about the total; a wide graph plus retries, fixes and reworks could run far longer than any single node's budget unnoticed. Expiry routes through the existing cancellation path, so the run still settles and still prints its digest.
- **Kraken graph: the planner sees the project** — planning was a one-shot completion given the goal text and nothing else, so it invented directory layouts and every `scope` it produced was a guess. Since scopes are exactly what the executor uses to decide which writers may run in parallel, a hallucinated scope made that decision meaningless. The planning prompt now carries the same workspace listing the council path uses (tree, stack, npm scripts; `ZELARI_KRAKEN_PLANNER_WORKSPACE_CHARS`, default 3000), and the system prompt tells the model to build scopes from paths that exist.
- **Kraken graph: cancellable runs** — `KrakenGraphExecutor` accepts an `AbortSignal`. Aborting stops admitting nodes and cancels every in-flight tentacle immediately (an abort listener, so a stuck writer does not have to finish first); the run then settles normally — running nodes end as errors, never-started nodes as `skipped`, no retries and no fix spawns — so the caller always gets a summary. Wired to SIGINT in `--kraken-graph`: the first Ctrl-C stops the graph gracefully and still prints the digest, a second one hard-quits. Previously Ctrl-C killed the process mid-run, leaving worktrees and half-written files behind with no summary at all.
- **Kraken graph: run digest** — `/kraken graph` and `--kraken-graph` now print one line per node (status, kind, wall-clock, first line of its conclusion or error) under the ASCII topology. The topology answers "did it converge"; answering "what did these eight tentacles actually do" previously meant reading `.zelari/radio/*.jsonl` by hand. `KrakenExecutionSummary` gains `durationsMs` and `cancelled`.

### Changed
- **Kraken graph: the fix budget scales with the graph** — a flat `DEFAULT_FIX_BUDGET = 3` was blind to graph size: on a 20-node graph it was spent on the first three failures and every later one went terminal, cascade-skipping its dependents, so the bigger the graph the less repair it got. Default is now `max(3, ceil(nodes/2))`, resolved in `execute()` once the size is known; `ZELARI_KRAKEN_FIX_BUDGET` still wins outright.
- **Kraken graph: acceptance criteria are enforced** — the planner's system prompt now states that `acceptance` drives a verify that can send work back, and asks for criteria settled by opening a file or running a command rather than subjective ones (an uncheckable criterion just burns a rework round).
- **Kraken graph: rolling scheduler replaces wave-at-a-time execution** — the executor awaited `Promise.all` over a whole wave, so one 15-minute writer held back every node that became ready a second later and left the concurrency budget idle for the duration. Nodes are now admitted on every completion, checked for parallel-safety against what is actually running; the same scope-disjointness rules and `ZELARI_KRAKEN_MAX_PARALLEL` cap apply.
- **Kraken graph: per-kind tool budget** — writers (`general`/`fix`) run at `deep` thoroughness instead of the `medium` previously hardcoded for every node kind; read-only `explore`/`verify` stay at `medium`.
- **Kraken graph: StatusBar chip** — the live graph counts are now published before the admitted nodes start, so the `n↑` running indicator actually appears (it was only ever sampled after the work had already settled).

### Robustness
- **Kraken graph: a throwing tentacle no longer aborts the graph** — the scheduler races in-flight nodes, so a rejected promise would have abandoned every other tentacle mid-write. An unexpected throw is now recorded as that node's failure and handled by the normal retry/fix machinery.

## [1.28.0] - 2026-07-25

### Fixed
- **Kraken graph: timed-out tentacles kept running and writing** — the node timeout only bounded how long the executor *waited*; the sub-agent was never cancelled, so a retry (and then a fix node) spawned onto the same scope while the original was still editing. Observed for real: three tentacles wrote `src/ships/` concurrently and produced two parallel implementations of the same modules. `runSubAgent`/`runTentacle` now accept an `AbortSignal` — breaking the `for await` over `AgentHarness.run()` unwinds the generator — and the executor aborts on timeout, waits `ZELARI_KRAKEN_CANCEL_GRACE_MS` (default 30s) for the run to unwind, and refuses to re-spawn a node whose previous attempt could not be confirmed stopped.
- **Kraken graph: a plan that cannot change anything reported success** — a "continua" prompt was planned as a single read-only `explore` node; the graph ran, converged and reported `1/1 done` having touched no file. The planner now rejects a plan with no `general` node and re-asks with corrective feedback.
- **Kraken planner: draft JSON inside a model's `<think>` block was mistaken for the answer** — reasoning models such as MiniMax-M3 stream their chain-of-thought inside `message.content` wrapped in `<think>` tags, and sketch partial JSON while reasoning. The extractor took the first balanced `{...}` it found, so planning failed with `nodes: expected array, received undefined`. Reasoning blocks are now stripped, and the extractor walks every balanced object and picks the first one carrying the key the caller asked for.

### Added
- **Kraken graph: cross-run memory** — the last graph's terminal state is persisted to `.zelari/kraken/last-graph.json` and fed to the next planning pass as a "previous attempt" briefing (done / failed / never-ran, with scopes, and the goal it belonged to). A follow-up plans the remaining work instead of replanning the goal blind. New module `src/cli/kraken/graphMemory.ts`.

### Verified
End-to-end against MiniMax-M3 (the model these failures were first reported on): a fresh goal planned a 7-node DAG, ran two writers in parallel on disjoint scopes and converged 7/7 with code that runs; a follow-up `continua` on a deliberately unfinished graph planned only the 2 remaining nodes — instead of the single do-nothing `explore` node it used to produce — and converged 2/2.

## [1.27.2] - 2026-07-25

### Fixed
- **Kraken planner: raw control characters in the model's JSON** — `Bad control character in string literal in JSON at position N`. The planner asks each node for a self-contained *multi-line* `prompt`, so models routinely emit real newlines inside the string instead of `\n` escapes — illegal JSON that the loose-JSON repair pass copied through verbatim, so both parse attempts failed identically. The repair pass now escapes every character below U+0020 inside string literals (single- and double-quoted), leaving already-escaped sequences untouched.
- **Kraken graph: writer nodes timed out at 5 minutes** — `tentacle timed out after 300000ms` killed `general`/`fix` nodes doing real multi-file work (project scaffolds, subsystems), taking their dependents down as cascade skips. The wall-clock budget is now per node kind: 300s for read-only `explore`/`verify`, **900s** for writers. `ZELARI_KRAKEN_NODE_TIMEOUT_MS` still overrides every kind (unchanged semantics, `0` disables); `ZELARI_KRAKEN_WRITER_NODE_TIMEOUT_MS` overrides just the writer budget.

## [1.27.1] - 2026-07-25

### Fixed
- **Kraken planner timeouts** — the planning request had a hardcoded 90s ceiling that slow reasoning models blew past on a non-streaming call, surfacing as the opaque `failed to produce a valid task graph after 2 attempts — This operation was aborted`. The budget is now configurable via `ZELARI_KRAKEN_PLANNER_TIMEOUT_MS` (default 300s, matching `ZELARI_KRAKEN_NODE_TIMEOUT_MS`; `0` disables it), the error names the variable to raise, and transport failures (timeout, HTTP, network) no longer burn the corrective-feedback retry — re-asking a model that never answered only doubled the wait. New `ZELARI_KRAKEN_PLANNER_MODEL` points planning at a fast non-reasoning model without changing the main model.

### Docs
- `docs/GUIDA.md` gains a Kraken Graph env section and drops two stale Kraken notes (worktree auto-merge has been wired since 1.26.0; the correct opt-out is `ZELARI_KRAKEN_WORKTREE_AUTO_MERGE=0`, not `ZELARI_KRAKEN_AUTO_MERGE=0` as the 1.26.0 entry stated).

## [1.27.0] - 2026-07-25

### Added
- **Kraken Graph engine (F1-F6)** — DAG-based multi-tentacle planning and execution, replacing the single-parent-orchestrates-flat-tentacles model for complex goals: pure DAG primitives + scope-overlap parallelism policy (`packages/core/src/kraken`), a parallel/retry/fix/sequential-merge executor bounded by `ZELARI_KRAKEN_MAX_PARALLEL` / `ZELARI_KRAKEN_FIX_BUDGET`, an LLM planner that turns a goal into a validated task graph, StatusBar/ASCII graph observability, and end-to-end wiring via `/kraken graph <goal>` and the `--kraken-graph <goal>` headless flag. Gated by `ZELARI_KRAKEN_GRAPH`.
- **Desktop: Kraken Graph toggle** — topbar control wires the `--kraken-graph` headless flag into Desktop's run pipeline; headless graph results now render as a normal assistant chat message.
- **Companion Android: provider/model picker** — fetches host config (`/v1/config`) to list providers/models and passes an explicit provider/model on run start instead of relying on the host's persisted default; adds `/v1/runs` (active + recent) plumbing; default mode switches from `agent` to `kraken`.

### Fixed
- **Kraken Graph** — tentacle wall-clock time bounded (`ZELARI_KRAKEN_NODE_TIMEOUT_MS`, default 300s) so a hung sub-agent can no longer wedge the whole headless process; graph tentacles now inherit the caller's resolved provider/model instead of the persisted default; planner recovers loose/malformed LLM JSON (single quotes, bareword keys, trailing commas) and raised its `max_tokens` budget (4096 -> 8192, overridable) with a fallback to `reasoning_content` when a reasoning model truncates its JSON answer.

## [1.26.0] - 2026-07-23

### Added
- **Kraken mode** — single-harness super-agent (rename of `agent`). Status bar / Desktop / `/mode` / `--mode kraken`. Legacy `agent` still accepted as alias.
- **Kraken lead playbook** — parent orchestrates `task` tentacles (explore / general / verify) with Goal·Scope·Acceptance contracts.
- **Task contracts** — optional scope[] + acceptance[] on task; spawn cap via `ZELARI_KRAKEN_MAX_TASK_SPAWNS` (default 6).
- **Kraken model routing (K5)** — `ZELARI_KRAKEN_SUB_MODEL` / `_EXPLORE_MODEL` / `_VERIFY_MODEL` / `_GENERAL_MODEL` for cheaper tentacles.
- **Kraken radio (K8)** — tentacle events in `.zelari/radio/<session>.jsonl`; slash `/kraken` shows status.
- **Kraken worktree opt-in (K7)** — `ZELARI_KRAKEN_WORKTREE=1` isolates general tentacles under `.zelari/worktrees/`; `KEEP=1` retains branch.
- **Worktree auto-merge (K7)** — on tentacle success, `mergeKrakenWorktree` squash-merges the worktree branch into the parent HEAD **before** cleanup, so isolated edits are never lost. Opt out with `ZELARI_KRAKEN_AUTO_MERGE=0`; `KEEP=1` disables both merge and cleanup.
- **Kraken live tracking (K10)** — `krakenTentacleStart`/`End` radio events on every terminal path (spawn, error, success); StatusBar shows a live `tentacles 1↑ 2✓` chip (CLI + Desktop).
- **Verify-hint footer (K4)** — after task general, result reminds parent to run verify; spawn counter resets each parent turn.

### Changed
- Default dispatch mode label: **kraken** (was agent). Mission build path labeled `build@kraken`.
- Zelari mission design stays on council; implementation slices still on the single harness (now Kraken identity).
- `@zelari/core` devDependency aligned to release version (no more 1.24 → 1.25 drift).

## [1.25.0] - 2026-07-23

### Added
- **Skills in Desktop (Extensions)** — create/list/remove user & project `SKILL.md` skills (`~/.zelari-code/skills/`, `.zelari/skills/`); CLI `--print-skills` / `--set-skill` / `--remove-skill`.
- **Import skill from URL** — Settings → Extensions → New skill → **Convert with model** (`--generate-skill-from-url`) uses the selected provider/model to draft id, description, body.
- **Skill picker** — Desktop composer ★ Skills; CLI `/skills` and bare `/skill` open an interactive SelectList (parity with `/provider`).
- **@-tag paths** — Desktop `@` autocomplete + Project panel `@`; CLI expands `@path` into `[Tagged paths]` context (shared `atMentions`).
- **Companion host `zelari-code serve`** — opt-in HTTP + SSE for remote clients (Tailscale/LAN): auth bearer token, project allowlist, single-flight headless runs. ADR-0015.
- **Desktop: Start companion serve** — Settings → Connections → Android companion (start/stop, bind/port, copy URL/token).
- **Android companion app (MVP)** — `apps/companion-android` (Compose): connect, projects, mode/phase, chat stream, cancel. See `apps/companion-android/README.md`.

### Fixed
- **Provider stream timeouts** — connect timeout vs stream-idle vs stream-max (no more hard kill of active multi-minute streams); clearer errors; fewer timeout retries.
- **Desktop `ANATHEMA_DEV` + CLI source** — no longer forces tsx source load (fixed “Failed to load provider config” at Desktop boot).
- **CLI entry** — prefer dist bundle for Desktop; `desktop:dev` runs `build:cli` first so new flags ship with Tauri.

### Note
- Install CLI: `npm i -g zelari-code@1.25.0` (or from monorepo: `npm run build:cli && npm install -g .`).
- Companion: `zelari-code serve --bind <tailscale-ip> --port 7421 --project <repo>` or Desktop **Start companion serve**.
- Android: open `apps/companion-android` in Android Studio or `npm run companion:android`.

## [1.24.0] - 2026-07-22

### Added
- **Mission budget cap** — third stop-rule for the `/zelari` mission loop. Set `ZELARI_MISSION_MAX_COST` (USD) or `ZELARI_MISSION_MAX_TOKENS` to hard-stop runaway loops. Defaults off (zero regression). Token usage is accumulated per-slice from the LLM `message_end` usage and converted to cost via the existing pricing table.
- **Council trace view** — every mission slice now persists a structured trace entry (member, latency, token cost, tool calls, errors) to `.zelari/trace/<missionId>.json`. Enables post-mission observability: who ran, in what order, how much each step cost.
- **Event-driven triggers (`--once`)** — new headless flag that acquires a PID lockfile (`.zelari/trigger.lock`), forces `MAX_ITER=1`, and releases on exit. Enables cron-driven and git-hook-triggered autonomous missions without a daemon. Ships with `scripts/zelari-cron-example.sh` and `scripts/zelari-git-hook.mjs` templates.

### Note
- Use `npm i -g zelari-code@1.24.0`.

## [1.23.0] - 2026-07-21

### Added
- **Turn Completion Contract** (agent system prompt) — every turn must end as Done (paths + verify), Checkpoint (short resoconto + ask_user to continue), or one blocking question. Forbids endless "procedo con…" monologues.
- **Status-theater early stop** — phrases like "Aggiorno todo / Procedo con / Ora creo" trip the text-loop guard at ×2 (not only ×3).
- **Post text-loop recovery** — injects a system recovery hint (inspect disk → at most one write → Done or resoconto+ask); Desktop banner **Continue with tools**; CLI tip after `assistant_text_loop`.

### Changed
- Stronger single-agent identity / coding practices for large multi-file tasks (thin vertical slices per turn).

### Note (Desktop)
- Update CLI: `npm i -g zelari-code@1.23.0`. Rebuild Desktop for the recovery banner.

## [1.22.1] - 2026-07-21

### Fixed
- **Desktop release build** � removed unused `exportConversation` import in `App.tsx` that failed `tsc` (noUnusedLocals) and blocked Tauri installers for v1.22.0.

### Note
- Functional features ship in **1.22.0**. Use `npm i -g zelari-code@1.22.1`; Desktop installers attach to this tag.
## [1.22.0] - 2026-07-21

### Added
- **Agent context longevity (OpenCode-inspired)** — oversized tool results spill full text to a managed dir (`~/.tmp/zelari-code/tool-output/`) while the transcript keeps a head/tail preview; env `ZELARI_TOOL_SPILL`, `ZELARI_TOOL_OUTPUT_DIR`.
- **LLM / extractive history compaction** — at ≥85% context occupancy the rolling history is replaced with a continuity summary (extractive always; optional LLM rewrite). Env `ZELARI_LLM_COMPACT`, `ZELARI_COMPACT_MODEL`.
- **Tool permissions allow/ask/deny** — policy by category with env `ZELARI_PERMISSION_*` and `ZELARI_AUTO=1`. TUI picker: Allow once · Allow always (tool) · Allow always (category) · Deny. Session grants clear on `/clear`|/new.
- **doom_loop guard** — third identical tool+args call returns a hard error so the model must change approach.
- **Typed `task` subagents** — `agent=explore|general|verify` + `thoroughness=quick|medium|deep` with profile-specific tool sets; summary-only return to parent.
- **Lazy `skill` tool** — catalog of skill names/descriptions; body loaded on demand (SKILL.md compatible).
- **Session `todo_write` / `todo_read`** — multi-step task list for the agent; TUI status chip + Desktop Tasks panel.
- **Desktop folder-pick export** — Export MD/JSON with native directory dialog and write-to-disk (complements 1.21.0 Blob export).

### Changed
- **`applyBudgetPolicyAsync`** used on agent/council turns so compaction can call the provider for a continuity brief when enabled.
- **Headless/Desktop** permission policy defaults to auto-allow (no interactive hang).

### Note (Desktop)
- Installer does **not** upgrade the coding engine. Use `npm i -g zelari-code@1.22.0` (or Settings → Update CLI). Rebuild Desktop for todos UI + folder export.

## [1.21.0] - 2026-07-21

### Added
- **Copy single message (Desktop)** — every assistant reply (collapsed or open), user bubble (on hover), and code block now has a copy button with transient 'Copied' feedback. Assistant prose is scrubbed with the same pipeline as the chat display, so copied text is clean (no leaked tool-call scaffolding).
- **Export a session as Markdown (Desktop)** — new `⤓` button in the sidebar per-conversation actions. Triggers a Blob download (`zelari-<title>-<YYYYMMDD-HHmm>.md`) with metadata, member attribution for council replies, and the same tool-call scrubbing. Disabled when the conversation is empty; works for both active and archived sessions.
- **`exportSession.ts` module** — pure functions (`conversationToMarkdown`, `slugifyTitle`, `exportFileName`, `hasExportableMessages`) shared by the Desktop UI; 18 new vitest unit tests under `desktop-export-session.test.ts`.

### Removed
- **`fff` from the optional plugins catalog** — `fff-mcp` does not exist on the npm registry (404 verified), so the Install button always exited with code 1. Wire `fff` manually via `~/.zelari-code/mcp.json` (`{"mcpServers":{"fff":{"command":"fff-mcp","args":[]}}}`). `ZELARI_FFF` kill-switch is preserved in the docs; fff support itself is unchanged.

### Fixed
- **Opaque `npm exited with code 1` in the Desktop plugin banner** — the actual npm error (and the last 4 KB of output) is now surfaced inline in `PluginInstallBanner` under a collapsible 'npm output' details block, next to the failed plugin label. Banner stays visible while any failed plugin is pending. Makes -D install failures (EPERM, ENOSPC, proxy errors, broken shims) diagnosable without leaving the app.

## [1.20.0] - 2026-07-20

### Added
- **PowerShell as fallback shell on Windows** — when Git Bash is not available, the agent now auto-detects PowerShell (`pwsh.exe` for PS7+, `powershell.exe` for PS5.1) and runs commands via `-Command` instead of falling back to the broken cmd.exe path. Eliminates at the root the shell-escaping and `.cmd`-path issues that consumed tool-call budget and stalled multi-step tasks on Windows without Git Bash.
- **`--fix-budget` command** — Windows-only one-shot that writes `ZELARI_MAX_TOOL_LOOP_HARD=180`, `ZELARI_MAX_TOOL_LOOP_ITERATIONS=60`, `ZELARI_CONTEXT_LIMIT=400000` to the User registry (idempotent, no admin prompt). Companion to `--fix-path`. On POSIX it prints an advisory `~/.bashrc` snippet.
- **`budget` row in `--doctor`** — surfaces whether the recommended ZELARI_* caps are set; points users to `--fix-budget` (Windows) or the export commands (POSIX).
- **PowerShell guidance in system prompt** — the agent receives explicit PowerShell syntax hints (`ls`/`cat` aliases, `$env:VAR`, `&&` in PS7+) so it writes compatible commands instead of cmd.exe syntax.

### Changed
- **Default tool-loop budget raised out-of-the-box** — `AgentHarness` soft cap 30 → 60 (hard cap 90 → 180), phase-aware `tokenBudget` plan 40 → 60 / build 90 → 120, headless 30 → 60, `ZELARI_CONTEXT_LIMIT` default 200k → 400k. Prevents the agent from being force-summarized mid-task by `runFinalAnswerTurn()` on long multi-step implementations. The existing text-loop detector still guards against pathological loops.
- **`prereqChecks.ts` PowerShell mirror** — `resolveAgentShellSync` now has the same 3-state detection (bash → PowerShell → cmd.exe) as `shellResolver.ts`, so `--doctor` reports the actual shell the agent will use instead of claiming cmd.exe when PowerShell is in fact available.

### Fixed
- **Agent stops without completing (Windows, no Git Bash)** — root-caused to a combination of (a) hard cap 90 cutting off multi-step work and forcing a no-tools summary, (b) cmd.exe shell-escaping consuming 30+ tool-calls per turn, (c) context-compaction losing state across the forced continuation. The PowerShell fallback + raised defaults resolve all three.
- **`node_modules/@zelari/core` junction** — pointed at the previous drive after the repo was copied across volumes; recreated at install path.

## [1.19.0] - 2026-07-19

### Added
- **Plan@multiagent · build@agent** (default Zelari mission policy) — design-phase stays on the **council**; implementation slices run on the **single-agent** harness (`missionSlice` + write-count + zero-write retry).
- **Feature flags** — `ZELARI_BUILD_VIA_AGENT` (default on; set `0` for legacy council implementer), `ZELARI_COUNCIL_CAN_BUILD=1` (allow free-form council to implement via Lucifero), `ZELARI_MODE_MAX_TOOLS_AGENT` (default 40).
- **`buildPolicy.ts`** — pure policy helpers for the experiment matrix.
- **GUIDA** — mode×phase matrix and env table updated for the hybrid mission path.
- **Dogfood notes** — `docs/plans/2026-07-19-plan-multiagent-build-agent-dogfood.md`.

### Changed
- **Zelari mission emit labels** — `build@agent` vs `council completo` / Minosse+Lucifero depending on policy.
- **`/mode` descriptions** — reflect plan@council → build@agent and council plan-only default.
- **Council free-form + build** — soft-gated to design-phase + plan-mode tool registry unless `ZELARI_COUNCIL_CAN_BUILD=1`.

### Fixed
- **False mission success with zero project writes** — `completion.ok` ignored when `writeCount === 0` (agent slice + mission driver).
- **Soft-gate without mutator strip** — design-phase force now also enables planMode so product `write_file` is not on the free-form council registry by default.

### Note (Desktop)
- Installer does **not** upgrade the coding engine. Use `npm i -g zelari-code@1.19.0` (or Settings → Update CLI). Point monorepo Desktop at the new CLI with `ZELARI_CLI_PATH` if developing from source.

## [1.18.1] - 2026-07-18

### Added
- **`browser_check` deep probes** — actions `evaluate` (page JS, JSON-safe), `press` (keyboard), `waitForText`; optional `textSample` body snippet.
- **`smokeStrength`** — tool result is `weak` when only crash-absence (no selector/text/evaluate); `asserted` when DOM/JS checks ran. Stops overclaiming “fix verified” from a short wait with no errors.

### Changed
- **Tool + prompt guidance** — prefer DOM assertions over `window.*` (ES modules hide symbols); no analysis spiral on re-exporting globals.
- **TOOLS.md** documents the new actions and weak-smoke semantics.

### Note (Desktop)
- Update the coding engine: `npm i -g zelari-code@1.18.1` (installer does not upgrade the CLI).

## [1.18.0] - 2026-07-18

### Added
- **Assistant text-loop guard** (`assistant_text_loop`) — `AgentHarness` detects degenerate repeated prose (same diagnosis / “I’ll fix…” block ×N), stops generation early, seals a collapsed transcript, and emits a recoverable error so Desktop/CLI do not stream max_tokens of spam.
- **Desktop clarification UI** — `---QUESTION---` blocks render as a choice card (not stripped). Incomplete JSON shows a fallback hint; picking a choice sends the answer as the next user turn.
- **Desktop plugin install banner** — detects missing optional tools (Playwright, eslint, ruff, LSP, …) for the open folder and offers one-click install.
- **CLI plugin flags** — `zelari-code --plugins-status [--cwd]` and `--plugins-install <id> [--cwd]` (JSON for Desktop/scripts). Playwright install also runs `npx playwright install chromium`.

### Fixed
- **Desktop questions invisible** — scrubber no longer deletes `---QUESTION---` before render (CLI had a picker; Desktop did not).
- **Playwright / browser_check on Desktop** — PluginGate existed only in the Ink TUI; Desktop headless path had no install path. Clearer `browser_check` error with install commands.
- **Playwright post-install** — package install alone left Chromium missing; installer now fetches Chromium after `npm i -D playwright`.

### Changed
- **Prompt** — tool-usage / coding practices: act with tools, do not restate the same diagnosis in a loop.

### Note (Desktop)
- Installer does **not** upgrade the coding engine. Use `npm i -g zelari-code@1.18.0` (or Settings → Update CLI). Rebuild/reinstall Desktop for the clarification card + plugin banner.

## [1.17.1] - 2026-07-18

### Changed
- **Unified durable context load** — `loadDurableContext()` async (shared by agent/council/zelari/headless) with short process cache; avoids double materialize and sync/async drift. Zelari mission passes memory-only RAG; compose injects HEAD once.
- **Agent mode sees durable HEAD** — HEAD materialization merged into volatile context (not only council/zelari).
- **Cache stats single source** — `computeSessionStatsDelta` delegates to `accumulatePromptCacheStats`; richer `/cache stats` (premium, hash, busts, TTL pref).
- **Checkpoint policy** — hard mission commits prefer linking the mission-start checkpoint instead of creating a new one every slice.
- **`/state status`** — shows reusable discovery count, parent, verification, checkpoint, stablePromptHash.
- **GUIDA** — honest `ZELARI_PROMPT_CACHE_TTL` docs (OpenAI-compat = prefix stability; Desktop uses global CLI engine).

### Fixed
- **Double durable block** on Zelari path (mission materialize + compose sync fallback).
- **`stablePromptHash` plumbing** through `tryStateCommit` when provided.

### Note (Desktop)
- Installer does **not** upgrade the coding engine. Use `npm i -g zelari-code@1.17.1` (or Settings → Update CLI).

## [1.17.0] - 2026-07-18

### Added
- **Durable State Layer** (Palmer *State, Not Tokens*) — verified accumulation under `.zelari/state/` (`commits/`, `artifacts/`, `HEAD.json`). `DurableStateStore` types in `@zelari/core`; file backend + fail-open `getStateStore`.
- **State commits after verification** — Zelari Mode auto-commits verified success layers and soft progress commits when files were written; Council commits after verify/completion PASS with Lucifero writes.
- **Prompt stable/volatile split** (Cache Wars) — `buildSystemPromptSplit` / `systemMessagesFromSplit`: identity+tools stay in a byte-stable prefix; workspace/RAG/durable state stay volatile. Agent + Council assembly updated.
- **Prompt-cache instrumentation** — session hit rate, premium vs cached tokens, stable bust count; StatusBar shows `N% hit`; `/cache stats`.
- **Slash commands** — `/state status|commit|show|restore [--no-tree]`, `/cache stats`.
- **composeContext durable injection** — council/zelari auto-load HEAD materialization into volatile RAG (cap `ZELARI_CTX_DURABLE_CHARS`).
- **History compaction state-aware** — tighter default window when durable HEAD exists.

### Fixed
- **Typecheck: `ask_user` permissions** — extend `ToolPermission` with `'ui'` so `permissions: ["ui"]` typechecks (unblocked CI after v1.16.0).

### Docs
- ADR `docs/decisions/012-durable-state-and-prompt-cache.md`; GUIDA section for durable state + cache env vars.

## [1.16.0] - 2026-07-18

### Added
- **Desktop liquid-glass UI** — greyscale/white glass palette, aurora backdrop, slim topbar, speech-to-text in composer, file drag-and-drop attachments, follow-stream detach chip, live activity (thinking phrases + rotating tool labels without per-tool cards), reply accordion with tokens/time/tools stats, council member-per-card streaming.
- **Desktop Project panel** — improved Files/Git layout; **Show in Explorer** on project root, tree rows, and git entries.
- **`ask_user` tool (Grok Build–style)** — native clarifying question that **blocks the harness tool-loop** until the TUI SelectList resolves, then returns a tool_result so the **same turn continues**. Preferred over `---QUESTION---` text markers. Headless soft-proceeds with an assumption message.
- **Cua Driver opt-in** — `zelari-code --set-mcp-preset cua` writes MCP entry for trycua/Cua Driver desktop computer-use; `--doctor` checks `cua-driver` on PATH; skill `computer-use-cua`; kill switch `ZELARI_CUA=0`; council skips Cua tools unless `ZELARI_CUA_COUNCIL=1` (context hygiene). Docs in GUIDA/TOOLS.

### Changed
- **Context hygiene (anti-hallucination)** — unified `composeProjectContext` for agent/council/zelari/headless: product tree first, plan as **draft ops** (not RAG), design vault as **index only**, epistemic banners, section char caps. Prior council member outputs truncated (~2.8k each). Collaboration directive: hypotheses, not authority. Memory hits capped per line.
- **Zelari mission budget** — `ZELARI_MISSION_MAX_ITER` default is **6 implementation slices**; the initial **design-phase is free** (does not consume the budget). Override env still honoured. Stall detection remains `ZELARI_MISSION_MAX_STALL` default 2 zero-write implementation slices.
- **Zelari implementer-retry roster** — implementation attempts **2+** run **Minosse + Lucifero only** (`skipSpecialists`), not a full 6-member council. Design + first implementation stay full roster.
- **Council members honour tool-loop env** — `ZELARI_MAX_TOOL_LOOP_ITERATIONS` / `ZELARI_MAX_TOOL_LOOP_HARD` are forwarded into every council member harness (TUI + headless), not only the single-agent path.
- **Settings UI** — white nav sidebar, roomier layout; primary actions are text pills (not composer circles).
- **Overlay detachable** — greyscale glass chrome aligned with Desktop.

### Fixed
- **Assistant turn separation** — a new user message opens a new reply card (no stacking into the previous assistant bubble).
- **Tool-call prose leak scrub** — while streaming, only *closed* tool/think blocks are removed; trailing unclosed scaffolding is stripped only at end-of-turn (prevents deleting the final answer after a broken open tag).
- **Hide headless bootstrap system lines** in desktop chat (`[headless] mode=…`, `[headless] MCP tools:…`).
- **Interactive `---QUESTION---` pause** — parse tolerates missing `---END---` and MiniMax junk after JSON; harness skips trailing text-tools when a question with choices is present (no false `text_tools_parse_failed`); TUI shows `[in attesa di risposta]` + SelectList; council already awaited via Promise. Typed short answers still bind via rolling history.
- **Recoverable harness errors no longer abort the tool-loop** — `text_tools_parse_failed`, truncated tool calls, and other `severity: 'recoverable'` events no longer set `hadError` / force `agent_end.reason='error'`. Only `fatal` aborts. Stops MiniMax garbled text-tool dumps from killing multi-step runs mid-task.

## [1.15.0] - 2026-07-17

### Added
- **Schema loop / world model** — skill `schema-loop` + tool `update_world_hypothesis`, `set_world_checks`, `run_backtest`, `record_world_observation` (persistenza sotto `.zelari/world/`). Kill switch: `ZELARI_SCHEMA_LOOP=0`.
- **`.github/dependabot.yml`** — Dependabot weekly per npm (root, `packages/core`, `apps/desktop`), cargo (`apps/desktop/src-tauri`) e github-actions.
- **`HANDOFF-v0.10.0.md`** — handoff operativo prep v0.10.0 (non tocca `HANDOFF.md` SUPERSEDED).

### Fixed
- **Hermetic MCP in unit tests** — `ZELARI_MCP_USER=0` salta `~/.zelari-code/mcp.json`; test headless/useChatTurn disabilitano MCP (`ZELARI_MCP=0`) per evitare spawn di server personali e timeout.

### Changed
- Docs (`GUIDA.md`, `TOOLS.md`) documentano world-model tools e env MCP hermetic.

## [1.14.4] - 2026-07-16

### Fixed
- **Desktop (Windows): spawn CLI** — resolve npm `zelari-code.cmd` shims to `node …/bin/zelari-code.js` before `CreateProcess`. Fixes `Failed to spawn zelari-code: batch file arguments are invalid` (Rust ≥ 1.77 batch-arg hardening). Version probes and headless runs share the same unwrap path; clearer error if the JS entry is missing.

## [1.14.3] - 2026-07-16

### Fixed
- **CI / tool-loop tests** — mocks that finish with `stop` after tools must be stateful (re-entry yields a final answer). Unblocks npm publish after 1.14.2 gate failure.

## [1.14.2] - 2026-07-16

### Fixed
- **MiniMax-M3 agent tool loop** — when the model emits tool calls but finishes with `stop` (or only `[DONE]`), the harness now forces `finish=tool_calls` so results are fed back instead of ending mid-task after “I’ll examine…”.
- **OpenAI-compatible stream tool flush** — leftover tool-call accumulators are flushed on `finish`/`[DONE]`; empty args and `stop`→`tool_calls` upgrade when tools ran; basic `reasoning_details` streaming support.
- **Provider history keeps `<think>`** — multi-turn provider history no longer strips MiniMax/GLM think tags (required for interleaved tool use). Display still scrubs them in the TUI.
- **False `text_tools_parse_failed`** — bare mention of “MiniMax” in assistant prose no longer triggers a parse-failed error; only real tool-dump markers do.

### Changed
- **Default Grok model** — static default for `grok` / `openai-compatible` is now **`grok-4.5`** (xAI flagship; API `reasoning_effort` defaults to high). Pricing table includes `grok-4.5` and `grok-4.3`.

## [1.14.1] - 2026-07-14

### Fixed
- **CI tests** — the headless single-agent `AgentHarness` mock in `tests/unit/headless-run.test.ts` was missing `getMessages()`, which `runSinglePass` started calling on both return paths in 1.14.0 (message-history snapshot). This made 4 tests throw `TypeError: harness.getMessages is not a function` and blocked the `@zelari/core@1.14.0` publish gate. Added the method to the mock to mirror the real public API.

## [1.14.0] - 2026-07-14

### Fixed
- **Desktop multi-turn / plan→build amnesia** — chat UI is the source of truth for `--history`; short continues (`procedi`, `conferma`, …) re-anchor prior assistant plan text so a fresh headless process cannot claim an empty session.
- **Agent BUILD prose-only “already done”** — BUILD phase prompts require on-disk writes; headless forces one implementation retry when `write_file`/`edit_file` never succeed; plan text is treated as a SPEC, not proof of disk state.
- **Overlay HUD** — no auto-open on Desktop launch; mic is click-to-toggle (no auto-send); final answer rendered without raw markdown noise (`**`, unpaired markers).
- **History seed quality** — agent history snapshots are user/assistant only (tool tails no longer blow the message budget); headless history parse coerces content safely.

### Changed
- Overlay opens only via title bar **◉**; voice accumulates in the input until the user sends with Enter/→.
- Agent/council continue anchors and BUILD system prompts emphasize implement-on-disk after plan confirmation.

## [1.13.0] - 2026-07-12

### Added
- **Desktop: floating overlay HUD** — always-on-top detachable bar (voice + text → same headless agent). Compact glass UI, mode/phase selects, collapsible final-answer panel with auto window resize. Opens at minimum size on Desktop launch (title bar **◉** to re-open).
- **Proprietary confidentiality policy** — system prompt module for agent and council packs: never reveal system/role prompts, skill fragments, tool catalog dumps, or internal council/runtime pipeline. Forced into `buildSystemPrompt` even if custom modules override base types.
- **Output redaction** — `scrubProprietaryLeak` in `cleanAgentContent` strips high-signal system-prompt dumps (defense in depth).
- **Installer branding** — NSIS header/sidebar assets + app icon pipeline docs (`apps/desktop` scripts).

### Fixed
- **Desktop: double stream deltas** — StrictMode async `listen` cleanup race no longer doubles assistant text (`CCiaoiao`); same fix on overlay event subscriptions + submit lock.
- **Desktop: thinking body** — product UI no longer renders raw `thinking_delta` content (spinner only until assistant text).

### Changed
- Headless fallback system prompt includes a minimal proprietary confidentiality clause if full prompt build fails.

## [1.12.1] - 2026-07-11

### Fixed
- **CI tests** — tool registry expects `ssh_status` / `ssh_run`; design-phase workspace-tool assertions use `resolveRoleSystemPrompt` (mode-split addenda), not base `systemPrompt` alone.

## [1.12.0] - 2026-07-11

### Added
- **Desktop: SSH Connections** — Settings → Connections registers deploy/monitor hosts (`~/.zelari-code/ssh-targets.json`). Auth modes: **password** (IP + user + password), **ssh-agent**, **key file** (private + `.pub`). Passwords live in `~/.zelari-code/ssh-secrets.json` (never in chat / LLM prompt). Agent tools: `ssh_status`, `ssh_run` (command allowlist). Kill switch: `ZELARI_SSH=0`. CLI: `--print-ssh-targets`, `--set-ssh-target`, `--remove-ssh-target`, `--test-ssh-target`, `--print-ssh-pubkey`.
- **Desktop: MCP Extensions store** — browse/install common MCP servers into Claude-compatible `mcp.json` (project or user). CLI helpers for list/set/remove MCP config used by the shell.
- **Desktop: first-run CLI setup guide** — installer ≠ global CLI; Setup overlay installs Node/CLI when missing; Settings → Update CLI via npm.
- **Desktop: Project panel** — Files | Git tree beside chat (lazy directory listing).
- **Desktop: Cursor-like chrome** — frameless window + custom TitleBar; unified Settings layout; tool calls as structured **ToolCallCard**s; Mode / Phase / Provider bar polish.
- **Desktop: multi-turn history** — conversation history + short-reply anchoring for council/agent (“procedi”, “1”, “sì”); agent clarification protocol reintroduced in prompts.
- **CLI: public key helper** — `--print-ssh-pubkey --path <private-or-.pub>` for copy into server `authorized_keys`.

### Fixed
- **DeepSeek / reasoning models** — echo `reasoning_content` in the tool loop so multi-step runs do not 400.
- **Desktop Connections page** — blank/black panel when loading SSH targets fixed (robust list + form rendering).
- **Prompt packs** — agent vs council identity/language policy cleaned; less amnesia on multi-turn council continue.

### Changed
- Desktop default SSH form prefers **password** (IP + username + password) for the common VPS flow; key/agent remain available.
- Docs: README, `docs/GUIDA.md`, and `apps/desktop/README.md` cover Desktop setup, MCP store, and SSH.

## [1.11.0] - 2026-07-10

### Fixed
- **Desktop: multi-turn context** — the desktop agent no longer loses context between messages. Conversation history now round-trips (desktop → Rust → CLI via `--history-file`) and short replies ("procedi", "1", "sì") are re-anchored to the last clarifying question. Backward-compatible: invalid history degrades to stateless.
- **Desktop: `<think>` tag leak** — model reasoning no longer appears as visible `<think>...</think>` prose in the chat. The provider now reads `reasoning_content`/`reasoning` fields (GLM/DeepSeek/Qwen/MiniMax) into the dedicated thinking channel, and a new `streamScrub` helper strips any inline think tags + `---QUESTION---` blocks from the headless stream.
- **Desktop: silent freeze on truncated tool calls** — the agent no longer hangs forever ("muore e basta") when MiniMax truncates a `write_file` payload mid-stream. Truncated tool calls (`finish_reason=tool_calls` with no emitted tool) are now detected and surfaced as a recoverable error.
- **Desktop: HTTP hang protection** — provider fetch now has a hard timeout (`AbortSignal.timeout`, default 5min, `ZELARI_PROVIDER_TIMEOUT_MS`) so a stalled connection can't freeze the harness.
- **Desktop: crash handler** — uncaught exceptions / unhandled rejections in headless mode now emit a visible error event instead of killing the process silently.

## [1.10.0] - 2026-07-10

### Added
- **Desktop: Open Folder** — pick a working directory per window (VSCode-style: one window = one folder). Native folder picker via `tauri-plugin-dialog`; the chosen folder is passed as `current_dir` to the spawned CLI so the agent operates on the user-selected project. Choice persists across restarts.

## [1.9.4] - 2026-07-10

### Fixed
- **Release workflows** — correct tag version resolution on `workflow_dispatch`; build `@zelari/core` before CLI; optional updater signing (installers still build without `TAURI_SIGNING_PRIVATE_KEY`).
- **CLI startup** — clean 3-line banner (no messy dual-column ASCII); compact one-line preflight warnings.
- **Sidebar logo** — exact v1.6.0 Braille emblem restored on the right.

### Added
- **Desktop Update CLI** — Settings + topbar when npm latest is newer than installed CLI.

## [1.12.1] - 2026-07-10

### Fixed
- **Release workflows** — correct tag version resolution on `workflow_dispatch`; build `@zelari/core` before CLI; optional updater signing (installers still build without `TAURI_SIGNING_PRIVATE_KEY`).
- **CLI startup** — clean 3-line banner (no messy dual-column ASCII); compact one-line preflight warnings.
- **Sidebar logo** — exact v1.6.0 Braille emblem restored on the right.

### Added
- **Desktop Update CLI** — Settings + topbar when npm latest is newer than installed CLI.

## [1.13.0] - 2026-07-10

### Fixed
- **Release workflows** — correct tag version resolution on `workflow_dispatch`; build `@zelari/core` before CLI; optional updater signing (installers still build without `TAURI_SIGNING_PRIVATE_KEY`).
- **CLI startup** — clean 3-line banner (no messy dual-column ASCII); compact one-line preflight warnings.
- **Sidebar logo** — exact v1.6.0 Braille emblem restored on the right.

### Added
- **Desktop Update CLI** — Settings + topbar when npm latest is newer than installed CLI.

## [1.14.0] - 2026-07-10

### Fixed
- **Release workflows** — correct tag version resolution on `workflow_dispatch`; build `@zelari/core` before CLI; optional updater signing (installers still build without `TAURI_SIGNING_PRIVATE_KEY`).
- **CLI startup** — clean 3-line banner (no messy dual-column ASCII); compact one-line preflight warnings.
- **Sidebar logo** — exact v1.6.0 Braille emblem restored on the right.

### Added
- **Desktop Update CLI** — Settings + topbar when npm latest is newer than installed CLI.

## [1.16.0] - 2026-07-10

### Fixed
- **Release workflows** — correct tag version resolution on `workflow_dispatch`; build `@zelari/core` before CLI; optional updater signing (installers still build without `TAURI_SIGNING_PRIVATE_KEY`).
- **CLI startup** — clean 3-line banner (no messy dual-column ASCII); compact one-line preflight warnings.
- **Sidebar logo** — exact v1.6.0 Braille emblem restored on the right.

### Added
- **Desktop Update CLI** — Settings + topbar when npm latest is newer than installed CLI.

## [1.18.0] - 2026-07-10

### Fixed
- **Release workflows** — correct tag version resolution on `workflow_dispatch`; build `@zelari/core` before CLI; optional updater signing (installers still build without `TAURI_SIGNING_PRIVATE_KEY`).
- **CLI startup** — clean 3-line banner (no messy dual-column ASCII); compact one-line preflight warnings.
- **Sidebar logo** — exact v1.6.0 Braille emblem restored on the right.

### Added
- **Desktop Update CLI** — Settings + topbar when npm latest is newer than installed CLI.

## [1.18.1] - 2026-07-10

### Fixed
- **Release workflows** — correct tag version resolution on `workflow_dispatch`; build `@zelari/core` before CLI; optional updater signing (installers still build without `TAURI_SIGNING_PRIVATE_KEY`).
- **CLI startup** — clean 3-line banner (no messy dual-column ASCII); compact one-line preflight warnings.
- **Sidebar logo** — exact v1.6.0 Braille emblem restored on the right.

### Added
- **Desktop Update CLI** — Settings + topbar when npm latest is newer than installed CLI.

## [1.19.0] - 2026-07-10

### Fixed
- **Release workflows** — correct tag version resolution on `workflow_dispatch`; build `@zelari/core` before CLI; optional updater signing (installers still build without `TAURI_SIGNING_PRIVATE_KEY`).
- **CLI startup** — clean 3-line banner (no messy dual-column ASCII); compact one-line preflight warnings.
- **Sidebar logo** — exact v1.6.0 Braille emblem restored on the right.

### Added
- **Desktop Update CLI** — Settings + topbar when npm latest is newer than installed CLI.

## [1.20.0] - 2026-07-10

### Fixed
- **Release workflows** — correct tag version resolution on `workflow_dispatch`; build `@zelari/core` before CLI; optional updater signing (installers still build without `TAURI_SIGNING_PRIVATE_KEY`).
- **CLI startup** — clean 3-line banner (no messy dual-column ASCII); compact one-line preflight warnings.
- **Sidebar logo** — exact v1.6.0 Braille emblem restored on the right.

### Added
- **Desktop Update CLI** — Settings + topbar when npm latest is newer than installed CLI.

## [1.21.0] - 2026-07-10

### Fixed
- **Release workflows** — correct tag version resolution on `workflow_dispatch`; build `@zelari/core` before CLI; optional updater signing (installers still build without `TAURI_SIGNING_PRIVATE_KEY`).
- **CLI startup** — clean 3-line banner (no messy dual-column ASCII); compact one-line preflight warnings.
- **Sidebar logo** — exact v1.6.0 Braille emblem restored on the right.

### Added
- **Desktop Update CLI** — Settings + topbar when npm latest is newer than installed CLI.

## [2.6.0] - 2026-07-10

### Fixed
- **Release workflows** — correct tag version resolution on `workflow_dispatch`; build `@zelari/core` before CLI; optional updater signing (installers still build without `TAURI_SIGNING_PRIVATE_KEY`).
- **CLI startup** — clean 3-line banner (no messy dual-column ASCII); compact one-line preflight warnings.
- **Sidebar logo** — exact v1.6.0 Braille emblem restored on the right.

### Added
- **Desktop Update CLI** — Settings + topbar when npm latest is newer than installed CLI.

## [2.10.0] - 2026-07-10

### Fixed
- **Release workflows** — correct tag version resolution on `workflow_dispatch`; build `@zelari/core` before CLI; optional updater signing (installers still build without `TAURI_SIGNING_PRIVATE_KEY`).
- **CLI startup** — clean 3-line banner (no messy dual-column ASCII); compact one-line preflight warnings.
- **Sidebar logo** — exact v1.6.0 Braille emblem restored on the right.

### Added
- **Desktop Update CLI** — Settings + topbar when npm latest is newer than installed CLI.

## [minor] - 2026-07-10

### Fixed
- **Release workflows** — correct tag version resolution on `workflow_dispatch`; build `@zelari/core` before CLI; optional updater signing (installers still build without `TAURI_SIGNING_PRIVATE_KEY`).
- **CLI startup** — clean 3-line banner (no messy dual-column ASCII); compact one-line preflight warnings.
- **Sidebar logo** — exact v1.6.0 Braille emblem restored on the right.

### Added
- **Desktop Update CLI** — Settings + topbar when npm latest is newer than installed CLI.

## [2.17.0] - 2026-07-10

### Fixed
- **Release workflows** — correct tag version resolution on `workflow_dispatch`; build `@zelari/core` before CLI; optional updater signing (installers still build without `TAURI_SIGNING_PRIVATE_KEY`).
- **CLI startup** — clean 3-line banner (no messy dual-column ASCII); compact one-line preflight warnings.
- **Sidebar logo** — exact v1.6.0 Braille emblem restored on the right.

### Added
- **Desktop Update CLI** — Settings + topbar when npm latest is newer than installed CLI.

## [2.19.0] - 2026-07-10

### Fixed
- **Release workflows** — correct tag version resolution on `workflow_dispatch`; build `@zelari/core` before CLI; optional updater signing (installers still build without `TAURI_SIGNING_PRIVATE_KEY`).
- **CLI startup** — clean 3-line banner (no messy dual-column ASCII); compact one-line preflight warnings.
- **Sidebar logo** — exact v1.6.0 Braille emblem restored on the right.

### Added
- **Desktop Update CLI** — Settings + topbar when npm latest is newer than installed CLI.

## [2.25.0] - 2026-07-10

### Fixed
- **Release workflows** — correct tag version resolution on `workflow_dispatch`; build `@zelari/core` before CLI; optional updater signing (installers still build without `TAURI_SIGNING_PRIVATE_KEY`).
- **CLI startup** — clean 3-line banner (no messy dual-column ASCII); compact one-line preflight warnings.
- **Sidebar logo** — exact v1.6.0 Braille emblem restored on the right.

### Added
- **Desktop Update CLI** — Settings + topbar when npm latest is newer than installed CLI.

## [2.30.0] - 2026-07-10

### Fixed
- **Release workflows** — correct tag version resolution on `workflow_dispatch`; build `@zelari/core` before CLI; optional updater signing (installers still build without `TAURI_SIGNING_PRIVATE_KEY`).
- **CLI startup** — clean 3-line banner (no messy dual-column ASCII); compact one-line preflight warnings.
- **Sidebar logo** — exact v1.6.0 Braille emblem restored on the right.

### Added
- **Desktop Update CLI** — Settings + topbar when npm latest is newer than installed CLI.

## [1.9.3] - 2026-07-10

### Fixed
- **Release Desktop CI** — build `@zelari/core` before root `tsc` (clean checkout had no `packages/core/dist` → TS2307 on macOS/Linux). Root `build`/`build:cli` scripts now always build core first.
## [1.9.2] - 2026-07-10`n`n### Fixed`n- **CI headless-run** — allow leading `[headless]` NDJSON log line (count >= 6).`n- **Desktop** — topbar Update button when a newer release is available.`n`n## [1.9.1] - 2026-07-10

### Added
- **Desktop auto-update** — Tauri updater plugin checks GitHub Releases (`latest.json`), Settings → “App updates” (check / download & install / relaunch), quiet check on launch. Release workflow signs artifacts via `TAURI_SIGNING_PRIVATE_KEY`.

## [1.9.0] - 2026-07-10

### Added
- **Zelari Desktop (Tauri 2)** — installable shell (`apps/desktop`) that streams `zelari-code --headless` into a modern chat UI (Agent / Council / Zelari, Plan / Build, provider & model, Settings).
- **Headless dispatch parity** — `--mode agent|council|zelari`, `--phase plan|build` (plan strips project mutators); zelari mission path in headless.
- **Desktop config CLI** — `--print-config`, `--set-config` (provider/model/endpoint), `--set-key`, `--discover-models` for Settings / IPC (no secrets in print).
- **Desktop UX** — API key + custom OpenAI-compatible endpoint in Settings; model list refresh on select open; Active/Archived chat sessions (localStorage); thinking animation; light structured reply rendering (tables/lists without raw markdown noise); run stats (duration/tools/chars).
- **Desktop branding** — pyramid logo as app icon (transparent bg) + in-app brand mark; GitHub Actions workflow publishes Windows/macOS/Linux installers on `v*` tags.

### Fixed
- **CLI logo visibility** — StartupBanner two-column ASCII logo (no space-padding collapse); Sidebar always shows compact ASCII on Windows (Braille optional on tall non-Windows).
- **Windows UV_HANDLE_CLOSING** — safer headless exit (flush/MCP before `process.exit`); desktop side-car uses process-tree kill, skip preflight, accept discovery JSON when Node aborts after stdout.

### Changed
- Version alignment: CLI, `@zelari/core`, and Desktop ship as **1.9.0**.

## [1.8.3] - 2026-07-10

### Added
- **Dynamic tool-loop budget (continue until complete)** — soft cap (`ZELARI_MAX_TOOL_LOOP_ITERATIONS`, default 90 from CLI budget / 30 harness default) auto-extends in chunks up to a hard ceiling (`ZELARI_MAX_TOOL_LOOP_HARD`, default soft×3). Emits `[budget] Tool budget extended…` and keeps tools available so multi-step work is not cut off mid-task. Final no-tools summary only at the hard ceiling.
- **MiniMax / invoke text-tool recovery** — parse `<minimax:tool_call>`, `<invoke name="…">`, and display-mangled variants so tool calls still execute when the model does not emit native `tool_calls`.

### Fixed
- **Context meter showed cumulative session tokens** (e.g. `474k/200k`) — StatusBar now uses last-turn context occupancy (`contextTokens`), not lifetime totals.
- Text-format tools after a native tool in the same turn (e.g. `updateTask` after `read_file`) are no longer dropped.

## [1.8.2] - 2026-07-10

### Fixed
- **CI: `cli-useChatTurn` failures** — think-scrub no longer calls `setMessages` with a same-ref no-op (emptied the test chat buffer); provider rolling history keeps `---QUESTION---` blocks (`stripQuestion: false`) so short-answer binding tests and live behavior stay correct.

## [1.8.1] - 2026-07-10

### Fixed
- **Terminal destroy on window resize** — banner logo no longer reflows on every resize (froze at first paint); sidebar show/hide uses hysteresis (96→88 cols) so edge thrash stops; resize events coalesced to 120ms and no-op size updates skipped; dynamic region hard-capped in height with `overflow:hidden`; sidebar/git file list budgeted vs terminal rows.
- **Model `<think>` blocks leaked into the TUI** — scrub complete + unclosed think tags on stream and at turn end; history also cleaned.
- **`grep_content` failed when `include` was a string** — accept string or string[] (models often emit `"*.ts"` bare).
- **`---TOOLS---` multi-array parse failure** — merge stacked JSON arrays (`][{…}][{…}]`), strip fences, recover light over-escape.

### Changed
- ASCII logo restored **top-right** in the Static banner (not bottom sidebar).

## [1.8.0] - 2026-07-10

### Added
- **Shared conversation context across agent / council / zelari** — rolling provider history (`conversationContext`) so short answers to clarifying questions bind in every mode; `/clear` and `/new` reset it.
- **Short-answer anchoring** — if the model asked a `---QUESTION---` and the user replies with a choice / number / short token, the next turn re-states the question for the model.
- **Interactive council clarifications** — `onClarification` pauses the council, opens the SelectList picker, injects the answer for subsequent members.
- **Plan / build work phase** (orthogonal to dispatch mode) — `/plan [goal]`, `/build [goal]`, `/view-plan`. Plan phase strips write/edit/bash/apply_diff; council is forced to design-phase. StatusBar shows `◇ plan` / `◆ build`.
- **UI: brand + version on the right of StatusBar** (and banner first line); Sidebar is git-changes only. Context meter `used/limit` (default limit 200K, override `ZELARI_CONTEXT_LIMIT`).
- **fff MCP plugin** — optional fast codebase search (`fff-mcp`); boot gate + `/plugins install fff`; wire via `~/.zelari-code/mcp.json`. Opt out: `ZELARI_FFF=0`.

### Changed
- Sidebar no longer shows the large Braille emblem / wordmark at bottom-right (moved to StatusBar right cluster per product request).

### Added (PR-D completion)
- **Parallel tool execution** — consecutive read-only tools (and multi-`task`) run via `Promise.all` in the agent harness; write/execute stay serial. Cap: `ZELARI_MAX_PARALLEL_TOOLS` (default 6). Opt out: `ZELARI_PARALLEL_TOOLS=0`.
- **Dynamic token budget** — `applyBudgetPolicy` warns at 70%, auto-compacts at 85%, hard-trims at 95% of `ZELARI_CONTEXT_LIMIT`; plan phase uses lower default tool-loop cap than build.

## [1.7.2] - 2026-07-10

### Fixed
- **Plugin boot gate re-prompted forever after "Install now"** — three detection bugs made optional tools look missing every launch even when already installed:
  1. **Playwright** was installed with `npm i -D` into the project, but presence (and `browser_check`) used a bare `import('playwright')` from the globally installed CLI process, which cannot see the project's `node_modules`. Both detect and runtime now resolve via `loadPlaywright(cwd)` (`createRequire` from the workspace first, then bare import).
  2. **LSP globals** (especially `pyright-langserver`) were probed with `<bin> --version`. Language servers often reject that flag and exit non-zero with empty stdout, so pyright was reported missing forever despite a working global install. Detection now matches runtime: project-local `resolveBin`, then **PATH file existence** (`isBinaryOnPath`), never `--version`.
  3. **PluginGate** re-runs `detect(cwd)` after a successful npm install; if the package is still not loadable it reports a clear failure instead of a false green.
- **`browser_check` ignored project-local Playwright** — the tool now passes `ctx.cwd` into the loader so a `-D` install in the workspace actually enables automation.

### Added
- **`loadPlaywright(cwd?)`** / **`isBinaryOnPath(bin)`** — shared detection helpers used by the plugin registry and browser driver (unit-tested).

## [1.7.1] - 2026-07-10

### Fixed
- **Windows preflight false-fail when only WSL bash is on PATH** — without Git for Windows, `where bash` returns `C:\Windows\System32\bash.exe` (WSL launcher). The agent-shell resolver treated it as Git Bash, probed `node` inside Linux (missing), and hard-failed boot even though Windows Node was fine. WSL launchers (`System32`, `SysWOW64`, `WindowsApps`) are now rejected; the agent falls back to `cmd.exe` with a WARN to install Git for Windows. Also prepends `dirname(process.execPath)` to the agent shell PATH so dual-PATH Node installs are more resilient.

## [1.7.0] - 2026-07-09

### Added
- **Response-language policy across all 3 modes (single, council, zelari)** — the agent now replies in the user's language for the entirety of its response, including the final synthesis, clarifying questions (`---QUESTION---` blocks), and tool-call descriptions. Detection uses a dependency-free heuristic: non-Latin script ranges (CJK / Cyrillic / Arabic) win first, then unique-accent owners (ñ → es, ã/õ → pt, ç → fr, ß → de), then function-word majority scoring. Default fallback is `it` (N-THEM Studio CLI). Override with `ZELARI_RESPONSE_LANG=<it|en|fr|es|de|pt|nl|zh|ja|ko|ru|ar>` or `=auto` to re-enable detection. Wired through:
  - Single agent (`useChatTurn.dispatchPrompt`): language-policy module appended to `customPromptModules` alongside `SINGLE_AGENT_IDENTITY_MODULE`, priority 5 so it sorts before the base-identity module (10).
  - Council (`runCouncilPure.buildAgentMessages`): the module is built ONCE per run from the user message and reused for every member (specialists, oracle, chairman). Injected as an extra system message so it always lands regardless of any `aiConfig` overrides.
  - Zelari mode: delegates to the council path — single source of truth.
  - Headless (`runHeadless.ts` single-mode): the previously-inline 3-line prompt was routed through `buildSystemPrompt()` (same builder as the TUI). Two regressions in one: headless now also gets the 7 missing behavioral directives that the inline prompt skipped AND the language-policy directive.

- **`envNumber()` helper** (`src/cli/utils/envNumber.ts`) — centralized parser for env-var integers, replaces the duplicated `Number.parseInt + Number.isFinite + clamp` pattern that was scattered across `useChatTurn.ts`, `runHeadless.ts`, `historyCompaction.ts`, `councilConfig.ts`, `slashCommands.ts`, `zelariMission.ts`, and `openai-compatible.ts`. Behavior:
  - empty / unset / `undefined` / `null` tokens → default
  - non-finite (NaN, `abc`, `1e3`, `30x` partial parses, `30.5` floats) → default (rejects the silent `parseInt("30x")` → 30 trap)
  - below min → clamped to min (preserves `ZELARI_HISTORY_TURNS=0` as "disable" by using `min:0`)
  - above max → clamped to max
- **22 unit tests** (`tests/unit/cli-envNumber.test.ts`) pin every branch and regression-pin each existing env var (`ZELARI_MAX_TOOL_CALLS`, `ZELARI_MAX_TOOL_LOOP_ITERATIONS`, `ZELARI_PROVIDER_MAX_RETRIES`, `ZELARI_HISTORY_TURNS`).
- **27 unit tests** (`tests/unit/core-languagePolicy.test.ts`) pin the detection heuristic (unique-accent, script range, function-word scoring, code-block stripping, tie-break) and the directive-module shape consumed by `buildSystemPrompt`.

### Changed
- `useChatTurn.ts`, `runHeadless.ts`, `historyCompaction.ts` now read env vars through `envNumber()` instead of inline parse-and-clamp IIFEs.

## [1.6.0] - 2026-07-09

### Fixed
- **Single-agent lost all conversation context between turns** — the root cause of the "clarifying question forgotten" bug. Every `dispatchPrompt` rebuilt `messages: [{system}, {user}]` from scratch (`useChatTurn.ts:383-386`), so the assistant turn from the previous turn — including any `---QUESTION---` clarifying block — never reached the provider on the next turn. The model had no way to bind a short reply ("full", "sì", "la seconda", "ancora") to its own prior question, so it treated the answer as a new ambiguous request. This was not a matching bug (there was no matcher: the `---QUESTION---` block is a text convention, and `parseClarificationRequest` was only called in the council path). It was a structural statelessness: the transcript was rebuilt from scratch each turn, with prior turns living only in the React display state and the JSONL sidecar (both write-only w.r.t. the provider). v1.6.0 adds an in-memory `AgentMessage[]` accumulator (`historyRef`) that carries prior turns forward: the seed for turn N is `[system, ...history, user_N]`, and after the run the assistant+tool tail is snapshotted for turn N+1. The "glasmorphism" answer in the bug report matched by semantic coincidence (rare word); "full" failed because, without the question in context, a common word has no anchor.

### Added
- **Rolling-history compaction with atomic tool-chain drop** (`src/cli/hooks/historyCompaction.ts`) — left unchecked, the accumulator grows without bound. `compactHistory()` trims it on a count basis (default `ZELARI_HISTORY_TURNS=6`, `0` disables → pre-1.6.0 stateless behavior, garbage falls back to the default rather than silently disabling). The hard invariant: it never splits an `assistant(tool_calls) → tool(result)` chain — a naive cut landing between the two is extended backward to include the whole chain, because strict providers (MiniMax/GLM) return HTTP 400 for an orphaned `role:'tool'` without its declaring assistant (the `core-agentHarness-toolResultOrder` regression). A `[history]` marker is prepended when messages are dropped.
- **Clarifying-question picker** — when the assistant ends a turn with a `---QUESTION---` block, `dispatchPrompt` now parses it (reusing `parseClarificationRequest`/`cleanAgentContent` from `@zelari/core`) and opens the existing `SelectList` picker (`PickerRequest.kind: 'clarification'`) so the user picks from the offered choices instead of typing. The raw JSON block is stripped from the display. Esc cancels the picker → free-text fallback, which still binds correctly because rolling history (above) now lets the model see its own question. The picker is ergonomic; rolling history is the actual fix.
- **`AgentHarness.getMessages()`** — public getter exposing the live transcript the harness accumulates during `run()`, so the chat loop can snapshot the turn's tail. Read-only contract; callers copy before retaining.

### Changed
- **`PickerRequest.commandPrefix` is now optional** — `kind: 'clarification'` uses an `onAnswer` callback instead of the slash-command `commandPrefix`. Existing `/provider` and `/model` pickers are unchanged.

## [1.5.5] - 2026-07-08

### Fixed
- **`--doctor` false-positive FAIL on `react-dom`** — every clean global install reported `FAIL runtime deps missing runtime deps: react-dom`. Root cause: `checkRuntimeDeps()` in `src/cli/utils/doctor.ts` hardcoded a required list that included `react-dom`, but (a) the CLI never imports `react-dom` — Ink renders via `react-reconciler` — and (b) `react-dom` ships in `devDependencies`, so `npm install -g` does not provide it. The `require.resolve` probe therefore threw on every global install, surfacing a phantom critical failure. The list now contains only the genuine runtime externals (`react`, `ink`, `ink-text-input`) plus `zod` as an install-coherence probe.

## [1.5.4] - 2026-07-08

### Fixed
- **Single-agent crash on missing LSP binary (`spawn typescript-language-server ENOENT`)** — when `typescript-language-server` (or any LSP server: `pyright-langserver`, `gopls`, `rust-analyzer`) was not on PATH, the first LSP tool call in a single-agent turn crashed the whole process. Root cause: `child_process.spawn` does not throw synchronously on a missing binary — it emits the `'error'` event asynchronously on the next tick, and `src/cli/lsp/manager.ts` had no `child.on('error', …)` handler (the only spawn site in `src/cli/` without one; the other 7 all attach it). The synchronous `try/catch` around `spawn()` could not catch it, and with no global `uncaughtException` handler, the event killed the process — violating the documented contract that "a missing server binary resolves to an empty/neutral result so the tools degrade cleanly." `getServer()` now attaches `child.on('error', …)`, which marks the language unavailable in the cache (no retry storm), rejects the in-flight initialize, disposes the client, and emits a once-per-language `[zelari-code]` warning naming the missing binary. A regression test (`LspManager spawn-failure handling`) reproduces the exact Node behavior (ENOENT via `queueMicrotask`) and asserts the fallback results, the single warning, and the no-retry cache behavior.

### Changed
- **Single-agent tool-loop cap raised from 30 to 90** — `ZELARI_MAX_TOOL_LOOP_ITERATIONS` default in `useChatTurn.ts` raised 30 → 90 (override still honored). Lets the single agent complete larger multi-file read→edit→verify tasks without hitting the cap mid-work. The council `chairmanBudget` (`ZELARI_MODE_MAX_TOOLS_LUCIFER`, default 30) is intentionally left untouched.
- **Node DEP0190 compliance for `child_process` spawn with `shell:true`** — passing an args array to `spawn`/`spawnSync` with `shell:true` is deprecated (DEP0190) and escapes args inconsistently. The three win32 `shell:true` spawn sites (`diagnostics/engine.ts` eslint/tsc runner, `plugins/registry.ts` global-bin `--version` probe, `workspace/projectSmoke.ts` `npm run` runner) now build a pre-quoted command line via the existing `buildCmdLine()` util instead of relying on the deprecated array form. `plugins-registry.test.ts` updated for the platform-dependent calling convention. Behavior unchanged on POSIX.

## [1.5.3] - 2026-07-08

### Changed
- **Single-agent now uses `buildSystemPrompt()`** — the 90%-of-usage path previously built its system prompt as an inline array (`useChatTurn.ts:283-317`), bypassing the builder the council uses. It was missing 7 of 11 behavioral directives: anti-confabulation ("don't invent facts/paths"), act-don't-describe ("actually write/edit files"), output self-check, clarification protocol (`---QUESTION---` format), safety guardrails, output formatting, and tool-usage guidelines. v1.5.3 routes the single agent through `buildSystemPrompt()` with a new `SINGLE_AGENT_IDENTITY_MODULE` that overrides the council-flavored `base-identity` module — the persona is now "Zelari Code, interactive AI coding agent in your terminal", not "member of an AI Council". Shell/platform/working-directory guidance is preserved (passed via the agent's `systemPrompt`). This also activates the `customPromptModules` override mechanism for the main path, which was previously inert.

### Added
- **Tool-result truncation (head + tail)** — a `read_file` on a 5000-line file used to dump ~100k tokens verbatim into the LLM transcript, re-sent every subsequent provider turn. `ToolRegistry.invoke` now truncates results over 200 lines (configurable via `ZELARI_TOOL_RESULT_LINES`) to head + tail with a marker naming the omission: `… [+4800 lines omitted — showing head:100, tail:100 of 5000 total] …`. Applies to all tools uniformly (single choke-point), covers string results and object results with a `content` field (the common `read_file`/`show_diff` shape). Results under the cap pass through with zero overhead; errors are never truncated.

## [1.5.2] - 2026-07-07

### Added
- **Provider retry/backoff** — the #1 cause of council/zelari runs dying before reaching the verify gate was a single transient HTTP failure (429/5xx/network error) terminating the whole member turn. `openaiCompatibleProvider` now retries on the initial response (before any stream byte is read, so there's no mid-stream state to recover): retryable statuses are 429/500/502/503/504, plus network errors (fetch throws). Up to 3 retries (4 fetches worst case), exponential backoff (500ms × 2^attempt, capped 8s), honors the `Retry-After` header. `abortableSleep` respects the caller's `AbortSignal` so `.cancel()` during a backoff window exits immediately. Non-retryable statuses (4xx except 429) still fail fast. Tunable via `ZELARI_PROVIDER_MAX_RETRIES`.

### Changed
- **Tool-loop cap raised from 12 to 30** — the #2 cause was `MAX_TOOL_LOOP_ITERATIONS=12` (hardcoded in `AgentHarness.run()`). Complex council implementations that read→edit→verify across 6-8 files routinely exhausted 12 rounds, then got forced into a no-tools final-answer turn that couldn't write files → incomplete deliverable → verify FAIL. The cap is now configurable via `AgentHarnessConfig.maxToolLoopIterations` (default 30) and overridable at runtime via `ZELARI_MAX_TOOL_LOOP_ITERATIONS` (wired in `useChatTurn.ts` + `runHeadless.ts`). The "final-answer guarantee" still fires at the new threshold.

## [1.5.1] - 2026-07-07

### Fixed
- **Council/zelari couldn't use browser_check, LSP, or AST tools** — the council and zelari paths advertise tools through the static agents catalog (`getAllTools()` → `getProviderTools()`), not through the executor's `toOpenAITools()` like the main agent does. `browser_check`, the 5 LSP navigation tools, `ast_outline`, `find_symbol`, and `semantic_search` were registered in the shared executor (so `filterExecutable` kept their names) but absent from the catalog, so `getProviderTools` silently dropped them — the council's models were never told these tools existed. v1.5.1 bridges the gap: `cliToolToEnhanced` (exported from core) derives catalog entries from the executor's `ToolDefinition`s, and `registerCliToolsIntoCouncilCatalog()` injects them into the catalog from `councilDispatcher.ts` (and `runHeadless.ts`, via the same `dispatchCouncil` path). Kill-switches are respected at registration time; harness builtins are skipped (no shadowing); eslint/ruff diagnostics were already working (they're an edit-wrapper side-effect, not a catalog entry).

## [1.5.0] - 2026-07-07

### Added
- **Plugin manager** — zelari-code now detects optional tool dependencies that are missing but useful (Playwright → `browser_check`, typescript-language-server / pyright → LSP navigation, eslint / ruff → post-edit diagnostics) and offers to install them. Three discovery paths:
  - **Boot gate** (`PluginGate`): after the splash, before the App mounts, surfaces a `[Install now / Maybe later / Don't ask again]` prompt for each missing plugin. Installation is buffered (mirrors `/update`). Skips on non-TTY, `ZELARI_NO_PLUGIN_PROMPT=1`, or when nothing is missing. Per-plugin scope: `-D` for project-local linters + Playwright, `-g` for cross-project LSP servers.
  - **`/plugins` command**: on-demand status table (ignoring `dontAskAgain`) plus `/plugins install <id>` for direct install.
  - **`--doctor`**: a new `plugins` row reports missing tools as WARN (never critical — optionals never block boot).
  - Binary names are sourced from the existing registries (`DEFAULT_PROVIDERS`, `LSP_SERVERS`, `defaultPlaywrightLoader`), preserving a single source of truth. Detection mirrors how each feature resolves its binary (`resolveBin` walk, `--version` probe, dynamic import). Preferences persist to `~/.tmp/zelari-code/plugins.json`.
- **Windows PATH auto-fix** — the npm global prefix (`%AppData%\npm`) missing from the user PATH is the single most common "command not found" cause on Windows. Now auto-fixed at install time (`scripts/repair-path.mjs`, idempotent exact-entry match, opt-out `ZELARI_NO_PATH_REPAIR=1`) and at runtime via `zelari-code --fix-path`. Scope is HKCU ("User"), never HKLM. `--doctor` now points Windows users at `--fix-path`.

### Fixed
- **Windows backslash-in-display-paths** — LSP tool results and diagnostic output emitted `src\a.ts` on win32 where every other path uses `src/a.ts`. Extracted `relativePosix()` into `src/cli/utils/paths.ts` (shared with the existing `shortenCwd`); both `lsp/tools.ts` and `diagnostics/engine.ts` now use it, replacing two duplicated private helpers. This was a real production bug surfaced by 4 previously-failing tests.
- **checkpoint CRLF on Windows** — `cli-checkpoint.test.ts` inherited `core.autocrlf=true` from the system gitconfig, so restore wrote `original-a\r\n` instead of `original-a\n`. Fixed by setting `core.autocrlf=false` in the test's `gitInit` helper (mirrors `cli-gitOps.test.ts`), making the test environment-independent. The checkpoint module itself is byte-exact by design; the bug was the test environment.

## [1.4.1] - 2026-07-07

### Fixed
- **prereqChecks test env leak**: `applyScenario()` inherited the host's `SHELL=/bin/bash` into the test env, causing the win32 `checkAgentBash` test to see a real bash via `resolveAgentShellSync()` instead of falling back to cmd.exe. `SHELL`/`ZELARI_SHELL` are no longer copied from the host — only the scenario object can inject them.

## [1.4.0] - 2026-07-07

### Added
- **Automatic prerequisite checks (`prereqChecks.ts`)** — agent-shell-aware probes for node/git/bash. Detects the "node visible to main process but invisible to the agent's bash" PATH mismatch that broke the Anathema-Studio council on 2026-07-07. Powers boot-time preflight, `--doctor` rows, and post-update prerequisite warnings.
- **`postinstall` git warning** — `scripts/postinstall.mjs` now warns when `git` is missing at install time so users know `/diff` and `/undo` will be disabled.
- **`--doctor` agent-shell rows** — `src/cli/utils/doctor.ts` extended with rows reporting node/git/bash as seen by the agent's shell (not just the main process).
- **Updater prerequisite warnings** — `slashHandlers/updater.ts` surfaces prereq warnings after updates.
- **12 unit tests** (`tests/unit/cli-prereqChecks.test.ts`) covering the agent-shell probes and the regression case.

## [1.3.0] - 2026-07-06

### Added
- **`/mode [agent|council|zelari]` command** — a terminal-independent way to
  switch the dispatch mode, equivalent to shift+tab (no arg cycles). Some
  terminals/multiplexers intercept or don't emit a shift+Tab sequence, so this
  guarantees mode switching always works. The shift+tab cycle was also
  extracted to a single shared source of truth (`nextMode`) and pinned with a
  regression test that locks the Ink key-parsing contract (`\x1b[Z` and the
  Kitty `\x1b[9;2u` both map to tab+shift) the shift+tab handler depends on.
- **Browser verification loop (`browser_check`).** Visual verification for
  web work: the agent opens a URL in a headless browser, optionally runs
  click/fill/goto/wait actions, and gets back the signals an LLM can act on —
  console errors, uncaught page exceptions, failed network requests, the final
  title/URL, whether an expected selector appeared, and a saved screenshot
  path. Far stronger than "the tests pass" for front-end changes. Playwright
  is an OPTIONAL dependency, loaded lazily — the tool degrades with install
  instructions when it (or a browser) isn't present, so nothing is forced on
  users who don't need it. Opt out with `ZELARI_BROWSER=0`.
- **Semantic code search (`semantic_search` + `/index`).** Concept-level
  retrieval over the codebase: describe what you're looking for in plain
  language ("where is rate-limit backoff handled?") and get the most relevant
  code chunks even when they share no literal keyword with the query — where
  grep can't reach. `/index` walks the project's source files, embeds them via
  the active provider's `/embeddings` endpoint, and persists the vectors to a
  JSON store (`/index status` shows stats); `semantic_search` embeds the query
  and ranks chunks by cosine similarity. Pure-JS (no native vector DB),
  embedding model configurable via `ZELARI_EMBED_MODEL`, and fully
  best-effort — it degrades with a clear message when the provider has no
  embeddings endpoint or no index exists yet. Opt out with `ZELARI_SEMANTIC=0`.
- **AST structural tools for TS/JS (`ast_outline`, `find_symbol`).**
  Precise, offline structural targeting via the TypeScript compiler API:
  `ast_outline` returns every declaration in a file (function/class/method/
  interface/type/enum/variable) with its line range and exported flag;
  `find_symbol` returns a named declaration's EXACT source span + text so the
  agent can edit it node-accurately instead of fuzzy string matching. Both are
  read-only, so they're available to sub-agents too. `typescript` moves to a
  runtime dependency but is loaded lazily and kept OUT of the CLI bundle
  (marked external), and the tools degrade to empty results when it's
  unavailable or the file isn't TS/JS. Opt out with `ZELARI_AST=0`.
- **LSP code intelligence (IDE-grade navigation tools).** The agent can now
  drive real language servers over LSP for compiler-accurate navigation
  instead of guessing with grep: `go_to_definition`, `find_references`,
  `hover_type` (the real resolved type/docs), `document_symbols` (a file's
  structural outline), and `rename_symbol` (previews the workspace-wide blast
  radius of a rename before you touch anything). Servers
  (typescript-language-server, pyright, gopls, rust-analyzer) are resolved at
  runtime from `node_modules/.bin` then PATH — started lazily, one per
  language, shared across turns — and the tools degrade silently when none is
  installed. Opt out with `ZELARI_LSP=0`. Built on a dependency-free
  JSON-RPC/LSP core (framing + client) so no new runtime dependency is added.

## [1.2.0] - 2026-07-06

### Added
- **Sub-agent delegation (`task` tool).** The agent can now delegate a
  focused, read-only research/exploration sub-task to an isolated sub-agent
  that runs in its own fresh context and returns only a concise conclusion —
  keeping the main conversation lean on large repos ("find where X is handled
  and summarize how it works" costs the parent one tool result, not 20 file
  reads). The sub-agent gets a read-only tool registry (read/list/grep/
  show_diff/fetch/web) with no write/edit/bash and, crucially, no `task` tool
  of its own, so sub-agents cannot mutate the repo or recurse. The underlying
  harness self-bounds at 12 tool-loop turns. Registry gains `readOnly` /
  `enableTask` options for building the isolated sub-registry.
- **Workspace checkpoints & atomic rollback.** `/checkpoint [label]`
  snapshots the working tree as a restore point, and `/rollback [id|latest]`
  restores it exactly — reverting modified files, recreating deleted ones,
  and removing files created after the snapshot. Every autonomous Zelari
  mission now takes a checkpoint before it starts and prints the id, so a
  bad run can be undone in one command (opt out: `ZELARI_CHECKPOINT=0`).
  Snapshots use git plumbing (throwaway index → `write-tree` →
  `commit-tree` → a `refs/zelari/checkpoints/*` ref) so they capture tracked
  **and** untracked files without ever touching your index, HEAD, branch, or
  stash list. `/rollback` with no argument lists the available checkpoints.
- **Post-edit diagnostics loop (compiler-verified editing).** After a
  successful `write_file` / `edit_file` / `apply_diff`, a fast file-scoped
  checker runs on the touched file and its errors/warnings are appended to
  the tool result under `diagnostics`, so the model sees real compiler
  feedback in the same turn and can fix it immediately — instead of editing
  blind. Ships with ESLint (js/ts/jsx/tsx/mjs/cjs) and Ruff (py) providers
  behind a small `DiagnosticProvider` interface (LSP-pluggable). Binaries
  resolve from the project's `node_modules/.bin` first, then PATH. Fully
  best-effort: unsupported file types, missing linters, timeouts, and
  unparseable output never affect the edit. Opt out with `ZELARI_DIAGNOSTICS=0`;
  tune the per-check budget with `ZELARI_DIAGNOSTICS_TIMEOUT_MS` (default 5s).
- **Prompt-cache accounting & surfacing.** OpenAI-compatible providers
  (DeepSeek, GLM, Grok, OpenAI) cache the stable prompt prefix
  (system prompt + tool schema + early transcript) server-side and bill
  those tokens at a steep discount. The CLI now parses the cache-hit count
  from provider usage — both the OpenAI/xAI/GLM shape
  (`prompt_tokens_details.cached_tokens`) and the DeepSeek shape
  (`prompt_cache_hit_tokens`) — bills cached tokens at the model's
  `cachedInput` rate (DeepSeek ~10× cheaper; 0.25× default for models
  without an explicit rate), and shows cumulative session cost plus
  `(N cached)` in the status bar. No request-side changes are needed —
  caching is automatic server-side — and the system prompt prefix was
  verified free of volatile tokens so cache hits are not broken.

## [1.1.1] - 2026-07-06

### Fixed
- **`/update --yes` failing with `npm exited with code 127` /
  "Shim target not found: npm.cmd".** When Node/npm is managed by a shim
  tool (Volta, nvm-windows, fnm) and its `npm` shim is broken, the
  self-update spawned `npm` through the shell and died with exit 127 — the
  update never ran and the hint was unhelpful. `performUpdate` now retries
  automatically via the `npm-cli.js` bundled with the running Node
  (`node <npm-cli.js> install -g …`, resolved from `process.execPath`),
  bypassing the broken `.cmd`/shim layer entirely. When even that is
  unavailable, the failure hint now names the likely cause (a stale
  version-manager shim) and gives the exact repair command per manager
  (`volta install node`, `nvm use`, `fnm use`) instead of the generic
  `npm install -g` advice (which can't help when npm itself won't launch).

## [1.1.0] - 2026-07-06

### Added
- **DeepSeek provider** (`/provider deepseek`) — the DeepSeek global
  platform is now a first-class provider (OpenAI-compatible, base URL
  `https://api.deepseek.com`, env var `DEEPSEEK_API_KEY`). It is fully
  wired for `/v1/models` discovery: after `/login deepseek <key>` the
  model list is fetched in the background, and `/model` opens the picker
  with the discovered ids. Ships with `deepseek-v4-flash` and
  `deepseek-v4-pro` as the discoverable defaults (default model
  `deepseek-v4-pro`) plus pricing entries for both. Available from the
  first-run wizard, `/provider`, `/model`, and `/models refresh`.

### Fixed
- **Windows "command not found" after `npm install -g`.** On some
  Windows machines npm unpacked the package under
  `<prefix>\node_modules\zelari-code\` but never created the
  `<prefix>\zelari-code.cmd` bin shim, so the command was missing even
  though `npm ls -g` listed the package ("as if the command wasn't
  saved"). The `postinstall` script now auto-repairs this specific case:
  when the shim is **missing** it writes the standard npm shim trio
  (`.cmd`, `.ps1`, and a POSIX `sh` wrapper for Git Bash) pointing at the
  installed package. It only ever creates shims that are absent — it
  never overwrites an existing shim (which could shadow another tool),
  so a shim pointing elsewhere still only produces the diagnostic
  warning. Opt out with `ZELARI_NO_SHIM_REPAIR=1`.

## [1.0.3] - 2026-07-06

### Added
- **`zelari-code doctor`** (alias `--doctor`) — diagnostic command that
  checks bin shim health, node version, CLI bundle presence, runtime
  dependency resolvability, and whether the npm global prefix is on
  the current `PATH`. Prints a clear fix command for each failure
  (e.g. `npm install -g zelari-code@latest --force` for a missing
  shim, or `export PATH="$(npm prefix -g)/bin:$PATH"` for a missing
  PATH entry). Exits non-zero on any critical failure so it can be
  used in install scripts. Runs BEFORE the bundle is loaded so it
  works on a broken install.
- **`postinstall` script (`scripts/postinstall.mjs`)** — runs after
  every `npm install -g` and verifies the global bin shim is present
  and points to the right package install. On a broken shim it logs
  a clear, actionable warning to stderr (not stdout) with the exact
  fix command and does NOT fail the install. Local installs are
  skipped silently (the `.bin/` symlink npm creates is sufficient
  there). Failures are caught and swallowed — a broken postinstall
  can never break the install.

### Changed
- **`/update --yes` error output is now actionable.** Previously the
  user saw only `npm error: <last line>`; now they see the full npm
  stdout+stderr, the exit code, and a targeted recovery hint based
  on the actual error class: `ERESOLVE` / `EPEERINVALID` →
  `--legacy-peer-deps`; `EACCES` / `EPERM` → sudo / Administrator
  guidance; `ENOENT` for `npm` → PATH fix; `zelari-code not found` /
  `EEXIST` / `EBUSY` in output → `--force` + `zelari-code doctor`;
  otherwise → `--verbose` + `--force` fallback. The hint builder is
  unit-tested (`cli-updater-failure-hint.test.ts`).

## [1.0.2] - 2026-07-06

### Fixed
- **Version drift in the CLI.** `src/cli/main.ts` exported a hardcoded
  `VERSION = '1.0.0'` literal, while `package.json` was already at `1.0.1`.
  `--version`, the app banner, the splash, the sidebar and the wizard
  therefore showed `v1.0.0` after `1.0.1` was published. Moreover, the
  self-update check (`updater.ts`) correctly read `package.json` via
  `getCurrentVersion()`, so it compared `1.0.1` against the npm registry's
  `1.0.1` and reported "no update available" - the user saw `v1.0.0` and
  `/update` proposed nothing. `VERSION` now derives from `package.json`
  (single source of truth). Same treatment for
  `clientInfo.version` in the MCP handshake (`src/cli/mcp/mcpClient.ts`,
  hardcoded at `0.7.9`).
- **DevDependency `@zelari/core` pinned to `1.0.0`** in `package.json`
  (exact pin, no caret). This made the root typecheck fail with `TS2305`
  on every new export of the 1.0.1 workspace. Updated to `1.0.1`
  (current workspace version).
- **Duplicated section in `AGENTS.MD`**: the auto-curated block
  (Tech Stack / Decisions / Conventions / Build / Open Questions) had
  been appended a second time during a previous run. The duplicate copy
  also contained stale references (`@zelari/core 0.7.0`,
  `esbuild ^0.24.0`, `vitest ^2.1.9`). Removed; a future `/council` run
  regenerates it correctly from `package.json`.

## [1.0.1] - 2026-07-06

### Added
- **Zelari mission stall detection.** The `runZelariMission` loop now
  receives from the council the number of files written in the slice
  (`write_file`/`edit_file`) and the `degraded` verdict. When an
  *implementation* slice writes **0 files** for N consecutive iterations
  (default 2, configurable via `ZELARI_MISSION_MAX_STALL`, `0` disables)
  the mission stops with status `stalled` and an actionable message
  instead of burning the entire iteration budget on identical empty runs.
  This is exactly the case documented with composer-2.5: the synthesis
  declares "done" but never produces the deliverable -> `DEGRADED_RUN` ->
  `completion.ok=false` forever.
- New mission status `stalled` in `MissionStatus` and new environment
  variable `ZELARI_MISSION_MAX_STALL`.

### Changed
- **Stricter implementation prompt.** The implementation slice now
  explicitly requires creating/modifying the real files with
  `write_file`/`edit_file` and states that a run claiming completion
  without writing any file is a failed run.
- `dispatchCouncilPromptImpl` and the `SliceRunResult` type now propagate
  `writeCount` and `degraded` to the mission loop; no change for the
  normal `/council` path. Drivers that do not report `writeCount` keep
  the previous behavior (no stall detection).

## [1.0.0] - 2026-07-05

First stable release. Introduces **Zelari-mode** (multi-run autonomous
missions), **file-based project memory** and **Italian prompt** support
for design-phase detection.

### Added
- **Zelari-mode - third TUI mode.** `shift+tab` now cycles `agent -> council -> zelari`. In zelari mode a free-form prompt becomes a structured **mission brief** (intent, stack, deliverable, assumptions, out-of-scope, MVP slice) and the council runs in a loop - design-phase then implementation for greenfields - until `completion.ok` is green on the MVP slice or the iteration budget is exhausted. Equivalent command `/zelari <prompt>`. The brief is shown and requires confirmation (`ok`), except auto-start with `ZELARI_MISSION_AUTO=1`. State persisted in `.zelari/mission-state.json`.
- **Project memory (file-based, zero dependencies).** New `MemoryBackend` interface in `@zelari/core` (subpath `@zelari/core/memory`) and `FileMemoryBackend` implementation in the CLI: per-project JSONL log in `.zelari/memory/log.jsonl` with keyword search. Every slice's outcome is persisted and re-injected into the council as `ragContext` across iterations (never the whole JSONL). Opt-out with `ZELARI_MEMORY=0` (degrades to a no-op). No native binaries, no vector store - the interface is a seam for a future semantic backend.
- **Mission classifier + brief** (`classifyMission`, `buildMissionBrief` in `@zelari/core/council`): pure heuristics (IT/EN) for intent `greenfield|extend|fix|redesign`, stack inference and MVP slice with task budget.
- **Dedicated chairman tool budget.** New `maxToolCallsChairman` in `PureCouncilConfig`: in zelari mode Lucifero gets a higher budget (default 30, `ZELARI_MODE_MAX_TOOLS_LUCIFER`) while specialists and the oracle stay on the shared default.
- New environment variables: `ZELARI_MEMORY`, `ZELARI_MISSION_AUTO`, `ZELARI_MISSION_MAX_ITER`, `ZELARI_MODE_MAX_TOOLS_LUCIFER`.
- ~40 new unit tests (IT keywords, file memory, mission/brief, zelari loop, `/zelari` parsing).

### Changed
- **`resolveCouncilRunMode` understands Italian.** `DESIGN_KEYWORDS` now includes `costruisci|crea|progetta|sviluppa|realizza|vetrina|pannello|gestionale|nuovo progetto|da zero|...`; `IMPLEMENTATION_KEYWORDS` includes the Italian fix verbs (`correggi|rifattorizza|implementa|...`) and `PLAN_CONTINUE` the Italian continuation terms. The noun `sistema` is **deliberately excluded** from fix verbs so as not to downgrade greenfields like "costruisci un sistema gestionale" (build a management system).
- `dispatchCouncilPromptImpl` returns the slice outcome (`completionOk`/`ran`/`synthesisText`) and accepts per-slice overrides (`ragContext`, `runMode`, `maxToolCallsChairman`); no change for the normal `/council` path.

### Security
- Fixed the 5 Dependabot vulnerabilities (1 critical, 1 high, 3 moderate) in the test/build **devDependencies** chain (`vitest`/`vite`/`vite-node`/`@vitest/mocker`/`esbuild`): bumped `vitest` `^2.1.9 -> ^4.1.9` and `esbuild` `^0.24.0 -> ^0.25.0`. `npm audit` now reports 0 vulnerabilities. Note: these dependencies were never published anyway (the `files` field includes only `bin`/`dist`/docs), so end users were not exposed; the update cleans the dev/CI environment. Suite unchanged: 1127 tests green on vitest 4.

## [0.7.12] - 2026-07-04

### Fixed
- **Council/agent tool calls fail on MiniMax and GLM (`tool result's tool id ... not found (2013)`, HTTP 400).** The `AgentHarness` appended the `role:'tool'` message (result) to the transcript **during** the `tool_call` delta, but the `role:'assistant'` message declaring that `tool_calls` only at the following `finish` -> invalid order `[tool, assistant]`. xAI/grok tolerated the inverted order (matching by id regardless of position); MiniMax and GLM validate strictly and reject the request because the tool result has no **preceding** assistant tool_calls. Tool results are now buffered during the turn and flushed **after** the assistant message, giving the order required by the OpenAI schema: `assistant(tool_calls)` -> `tool(result)`. Applies to the normal path, the anti-duplicate cache and the `maxToolCallsPerTurn` skip. The fix unblocks every strict-validating OpenAI-compatible provider, not just MiniMax/GLM.

### Added
- Regression test `core-agentHarness-toolResultOrder` - verifies that the assistant declaring the `tool_calls` always precedes the related `tool` results (single and multi-tool case in the same turn).

## [0.7.11] - 2026-07-04

### Fixed
- **Model discovery now respects the custom endpoint.** `discoverModelsForProvider` resolved the base URL from the static `PROVIDER_BASE_URLS` map, ignoring the endpoint set with `/provider custom <url>`: after pointing `openai-compatible` at a third-party gateway, `/model refresh`, `/discover`, the `/model` picker and the startup auto-refresh kept querying the default host (usually with a 401 -> "discovery failed"). Discovery now resolves the base URL with the same priority as chat (`resolveBaseUrl`): `options.baseUrl` (tests) -> persisted custom endpoint (`getCustomEndpoint`) -> `OPENAI_BASE_URL` (for `openai-compatible`) -> static default.
- **Discovery default for `openai-compatible` aligned with chat.** Discovery used `https://api.openai.com/v1` while chat (`PROVIDER_ENDPOINTS`) uses `https://api.x.ai/v1`: discovery and chat probed different hosts. Both now start from `https://api.x.ai/v1`.
- **MiniMax endpoint fixed** -> `https://api.minimax.io/v1` (international endpoint, OpenAI-compatible with `/chat/completions` and `/models`). Previously chat and discovery used two different and both wrong hosts (`https://api.MiniMax.chat/v1` and `https://api.minimaxi.chat/v1`), hence the 401 "invalid api key" on prompts.
- **GLM / Z.AI endpoint fixed** -> default to the GLM Coding Plan `https://api.z.ai/api/coding/paas/v4` (chat + discovery). Previously chat pointed to `https://api.z.ai/v1` (404) and discovery to `https://api.z.ai/api/paas/v4`: inconsistent hosts. Pay-per-token API users can run `/provider custom https://api.z.ai/api/paas/v4`.
- **Chat <-> discovery <-> keyStore consistency.** The three places defining base URLs per provider (`PROVIDER_ENDPOINTS`, `PROVIDER_BASE_URLS`, `PROVIDERS[].baseUrl`) had gone out of sync for glm/minimax; they now agree.

### Changed
- `v3-U-modelDiscovery` tests isolated also from `provider.json` (`ANATHEMA_PROVIDER_CONFIG_FILE`) and `OPENAI_BASE_URL`, since discovery now reads the custom endpoint; new cases for persisted custom endpoint, `OPENAI_BASE_URL` override and `options.baseUrl` precedence.
- `docs/GUIDA.md`: new "Custom OpenAI-compatible endpoint" section with the recommended flow; clarified that no selectable `custom` provider exists (the custom endpoint is set on the active provider).

## [0.7.10] - 2026-07-04

### Highlights
- **Full-width status bar**: two groups justified at the terminal edges - identity on the left (mode, provider, model, cwd), run status on the right (timer, queue, session). Both groups truncate instead of wrapping (`wrap="truncate"` + differentiated `flexShrink`), so the bar is always exactly one line: previously on narrow terminals it wrapped, crushing the dynamic region.
- **Animated work indicator**: new `<WorkingIndicator>` (Braille spinner + rotating verbs thinking/working/reasoning/assembling + animated dots + elapsed time, e.g. `? thinking... (12s)`). Replaces the static `? working.` which was **dead code**: the LiveRegion early-return ignored `busy`, so nothing appeared between dispatch and the first token. The spinner also appears in the status bar next to the timer during a run.
- **Interactive pickers for providers and models**: `/provider` and `/model` without arguments open a navigable list (`<SelectList>`: up/down with wrap-around, enter selects, esc cancels, V on the active item, scrolling window for long lists). The selection re-enters the normal slash pipeline (`/provider <id>` / `/model <id>`), so persistence and messages are identical to the typed command. `/model show` and `/provider list` keep the old textual outputs.
- **Model discovery actually wired**: background refresh at startup when the cache is older than 6h (the trigger was documented but never connected), auto-discovery when opening the `/model` picker (with fallback to cache/defaults on failure), new alias `/discover` for `/models refresh`.
- **Fix status bar update after switching**: `handleProviderSet` passed a `ProviderSpec` instead of the `ProviderConfig` to the App state (the displayed model never updated) and `handleModelSet` did not update the state at all.

### Added
- `src/cli/components/Spinner.tsx` (`Spinner` + `WorkingIndicator`, shared 100ms ticker), `src/cli/components/SelectList.tsx` (`windowStart` exported and tested), `handleProviderPicker`/`handleModelPicker` + `buildModelPickerItems` (pure, tested) in `slashHandlers/provider.ts`.
- Kind parser `provider_picker`/`model_picker`, commands `/discover`, `/model show`, `/provider list`; `openPicker` in `useSlashDispatch`.
- Tests: `cli-picker.test.ts` (10 - item builder + windowing), LiveRegion busy case, picker/discover parser.

### Changed
- `StatusBar`: full-width space-between layout; spinner instead of `?` during a run; session moved to the right group.
- `LiveRegion`: `elapsedMs` prop forwarded from the App (timer in the work indicator).
- `docs/GUIDA.md`: provider/model table updated (pickers, `/discover`, `/model show`, `/provider list`).

### Fixed
- LiveRegion early-return that made the "working" indicator unreachable (now includes `busy`).
- `ProviderConfig` refresh in the App state after `/provider <id>` and `/model <name>`.

## [0.7.9] - 2026-07-04

### Highlights
- **Agent/council switch with `shift+tab`**: free-form (non-slash) prompts are routed to the single agent or the 6-member council pipeline depending on the active mode, shown in the status line (`? agent` / `? council`). Same path as `/council <text>`.
- **Right sidebar**: N-THEM emblem in Braille art (2x4 dot grid per cell - ~4x denser than ASCII), wordmark + version + branch, and the working tree's modified files with `+added`/`-removed` per file (new hook `useGitChanges`: `git status --porcelain` + `diff --numstat` unstaged+staged, 4s polling, re-render only on changed snapshot). Lives in the dynamic region next to the input block (a full-height column cannot coexist with the native `<Static>` scrollback); auto-hidden below 96 columns.
- **Status line redesigned and moved BELOW the input box**: tokens and cost, current mode, provider, model, session, cwd (with `~` for home) and the **execution timer** (`? 12s` during a run, `last 34s` when finished - new hook `useExecutionTimer`).
- **Duplicate banner fix**: `<Static>` was remounted when `sessionId` arrived from bootstrap (key change) and reprinted the banner into the scrollback. The Static now receives no items until the session exists -> banner printed exactly once. Also removed the skill list from the banner (duplicate of `/help`).
- **DEP0190 fix (Node 24)**: three call-sites used `spawn(cmd, argsArray, { shell: true })` (args concatenated WITHOUT escaping). `mcpClient` (MCP server spawn at first prompt) and `updater` (`npm install -g`) now build the win32 command line with explicit quoting via the new `utils/cmdline.ts` helper and pass a single string; `shellResolver` runs `where bash` without a shell (it is a real .exe).
- **Council run-mode detection** (`implementation` vs `design-phase`): keyword heuristics + plan presence (`planDetect.hasWorkspacePlan`), `ZELARI_COUNCIL_MODE` override; mode banner in member prompts (workspace emissions mandatory only in design-phase) and complete-design post-processor skipped in implementation runs. Explicit council tier lite(3)/full(6) via `ZELARI_COUNCIL_TIER`/`ZELARI_COUNCIL_SIZE` (`councilConfig.ts`).

### Added
- `src/cli/hooks/useGitChanges.ts` (numstat/porcelain/rename parsers exported and tested), `src/cli/hooks/useExecutionTimer.ts`, `src/cli/components/Sidebar.tsx`, `src/cli/utils/paths.ts` (`shortenCwd`), `src/cli/utils/cmdline.ts` (`quoteCmdArg`/`buildCmdLine`), `src/cli/councilConfig.ts`, `src/cli/workspace/planDetect.ts`, `packages/core/src/council/runMode.ts` + `modeBanners.ts`.
- Tests: `cli-git-changes` (16), `cli-useExecutionTimer` (4), `cli-cmdline` (6), `cli-councilConfig`, `core-councilRunMode`.
- README: ASCII logo + v0.7.9 feature.

### Changed
- `StatusBar`: `mode`/`cwd`/`elapsedMs`/`lastMs` props; tokens and cost removed from the UI (internal tracking remains).
- Startup banner: 3 lines (wordmark+version+provider/model, cwd, command hint + shift+tab).
- `tests/unit/cli-updater.test.ts`: platform-agnostic spawn assertion (win32 string / POSIX array).
- `.gitignore`: `mcps/` excluded (local clones of MCP servers).

## [0.7.5] - 2026-07-03

### Highlights
- **Root fix for tool hallucinations in the council**: `getAllTools()` contained NO harness tools at all (read_file, bash, list_files...) - members read "you operate on a real codebase" with zero file tools in AVAILABLE TOOLS and hallucinated `Read`/`Glob`/`list_dir`. New `harnessToolBridge` in core: harness built-ins enter the agents catalog with JSON schemas derived from the real zod ones. Plus: executable filter extended to the prompt text (v0.7.5 in `buildAgentMessages`), prompt module and skill prose made tool-agnostic, "Did you mean" aliases in the ToolRegistry (`Read`->`read_file`, `searchRAG`->`searchDocuments`, etc.).
- **Web tools**: `fetch_url` (http(s)-only, HTML->text, 15s timeout, 40k char cap) and `web_search` (DuckDuckGo HTML without a key; `TAVILY_API_KEY` for Tavily). Registered in the CLI (10 built-ins) and required by the `research-analyst` skill.
- **Minimal stdio MCP client**: initialize/tools/list/tools/call via newline-delimited JSON-RPC, zero dependencies. Claude-Desktop-compatible config in `.zelari/mcp.json` or `~/.zelari-code/mcp.json`; tools registered as `mcp_<server>_<tool>` on both paths (the server's JSON schema forwarded to the provider via the new `ToolDefinition.jsonSchema` field). Lazy singleton, one-time warning for broken servers, `ZELARI_MCP=0` to disable.
- **SKILL.md loader** (shared opencode/Hermes/Claude Code format): discovery from `.zelari/skills/`, `.claude/skills/`, `.opencode/skills/`, `~/.zelari-code/skills/` - any skill from those ecosystems works with `/skill <name>`.
- **`/skill` requiredTools wiring**: dispatchPrompt registers the workspace stubs the skill declares (with `searchRAG`->`searchDocuments` mapping) - previously planning skills asked the model to use tools absent from the registry.
- Complete tool/skill/MCP map in `docs/TOOLS.md`. +38 tests (875 total).

## [0.7.4] - 2026-07-03

### Highlights
- **council->agent loop closed**: the single agent now registers the `updateTask` workspace stub when a plan exists (`.zelari/plan.json`), so it can mark tasks `in_progress`/`done` going through the mutex and atomic write instead of editing the JSON by hand. Dedicated guideline in the system prompt (only when a plan exists - zero cost on fresh projects).
- **`buildZelariReadHint` + "Next task to work on"**: the plan summary now points to ONE concrete task to start from (first `in_progress`, otherwise by priority critical>high>medium>low) and the single agent's system prompt includes the workspace summary + `.zelari/` reading hint.
- **Browser popup fix during tests**: `runGrokOAuthFlow` ALWAYS opened the real browser (`cmd /c start`) - the "fully mocked" device-flow test opened a tab on auth.x.ai with the fake user_code on every `npm test`. Added `openBrowserImpl` (same DI as `fetchImpl`/`sleepImpl`); production unchanged.
- **Repaired corrupted auto-edit in `useChatTurn.ts`**: the "system prompt + harness + event loop" block was duplicated (~218 lines, broken try/catch, undefined variables) from a v0.7.4 changeset applied halfway. Removed the duplicate and rewired the intent correctly.

### Added
- `src/cli/workspace/workspaceSummary.ts`: `buildZelariReadHint()` + "**Next task to work on:**" block in `buildPlanSummary()` with `pickNextTask()` (in_progress first, then priority).
- `src/cli/hooks/useChatTurn.ts`: best-effort registration of `updateTask` in the single agent's tool registry when `buildPlanSummary` finds a plan; `toolList` computed after registration so the tool appears in "# Available Tools".
- `src/cli/grokOAuth.ts`: `GrokOAuthOptions.openBrowserImpl` option to inject the browser-launcher.
- `tests/unit/cli-useChatTurn.test.ts`: +2 tests (updateTask registered with a plan; workspace registry NOT created without a plan) + mock of `workspaceSummary.js` (tests no longer scan the repo's real cwd).

### Fixed
- `tests/unit/cli-workspaceSummary.test.ts`: `describe` of `buildPlanSummary` closed too early - the v0.7.4 tests were out of scope (esbuild syntax error).
- `tests/unit/cli-grokOAuth.test.ts`: the device-flow test now stubs the browser and verifies that `verification_uri_complete` is opened (URL with pre-filled code).
- `tests/unit/core-shellTool.test.ts`: dedicated vitest timeout (30s) for the 2 tests that spawn a real shell - on Windows spawning Git Bash takes ~12s versus the default 5s.

## [0.6.2] - 2026-07-02

### Highlights
- **TUI flicker eliminated**: chat message height estimate corrected for real wrapping (Box paddingX + message marginLeft = `width-4`), `chatWidth` recomputed (`columns - 40` instead of `- 44`), `overflow="hidden"` added on root/row. `pickVisibleMessages` no longer lets the transcript grow beyond the terminal, the cause of the full-screen repaint producing visible flicker.
- **Tool/agent rendering as CollapsibleToolOutput**: every tool invocation is now a single `role: 'tool'` message updated in place (status glyph `?`/`V`/`?`, summary + expandable body), no longer 2-4 loose system lines.
- **Cross-message text duplication fix**: `streamContent` separated from `assistantContent`, bubble finalized on `message_end` / tool start. Previously the post-tool bubble redrew the entire turn text.
- **Session resume replays tools as `role: 'tool'`**: no more `[tool_result] undefined -> ok`, `tool_execution_end` updates in place via `toolCallId`.
- **CI publish workflow hardened** (v0.6.2 audit): build order, `npm publish` from root, tag/package.json match check, sequential core->CLI publish, post-bundle smoke test, OIDC-only.
- **`@zelari/core` publishability fix** (v0.6.2 audit CRITICAL-1): `moduleResolution: Bundler` -> `NodeNext`, 26 relative imports extended with `.js` (plus 2 inline `import()`). Resolved the `ToolContext` re-export conflict between `agents/tools.ts` and `core/tools/toolTypes.ts`. Without this, the published npm package would have broken every Node.js ESM consumer with `ERR_MODULE_NOT_FOUND`.
- **+9 new tests** in `tests/unit/cli-toolDisplay.test.ts` (270 LOC): messageHelpers, dispatchPrompt dup, eventsToMessages replay, pickVisibleMessages wrap.

### Added
- `src/cli/hooks/messageHelpers.ts`: `finalizeStreamingAssistant()` to seal the trailing streaming bubble; `TOOL_RESULT_PREVIEW_CHARS=600` + `TOOL_ARGS_PREVIEW_CHARS=120` constants; `appendToolStart`/`updateToolMessageEnd` with `toolCallId` + separate result.
- `src/cli/components/CollapsibleToolOutput.tsx`: status glyph `?`/`V`/`?` in the summary.
- `src/cli/app.tsx`: `overflow="hidden"` on root/row.
- `tests/unit/cli-toolDisplay.test.ts`: 9 unit tests for the new rendering.
- `package-lock.json`: version sync 0.5.0 -> 0.6.2.

### Fixed (post-release audit, agy Gemini 3.5 Flash)
7 agy findings (1 CRITICAL, 3 HIGH, 2 MEDIUM, 1 LOW) all verified and fixed:

- **CRITICAL-1** - `@zelari/core` relative imports WITHOUT `.js` extension + `moduleResolution: Bundler` -> published npm package non-functional for Node.js ESM consumers (`ERR_MODULE_NOT_FOUND`). Fix: switch to `NodeNext`, 26 `.js`-extended imports, resolved the `ToolContext` re-export conflict (renamed to explicit `export type` in `harness/tools/index.ts`).
- **HIGH-2** - `workflow_dispatch` ignored the `tag` input, checking out `main`. Fix: `ref: ${{ github.event.inputs.tag || github.ref }}` on both jobs.
- **HIGH-3** - `publish-cli` and `publish-core` parallel -> CLI published before core. Fix: `needs: publish-core` on `publish-cli`.
- **HIGH-4** - `@zelari/core: "^0.6.2"` permissive (accepts future 0.6.x) for a coupled release. Fix: exact pin `"0.6.2"`.
- **MEDIUM-5** (defer): duplicated test suites (`prepublish` re-runs typecheck+build+test). Out of scope for this fix.
- **MEDIUM-6** - `package.json` version not validated against the tag. Fix: `Verify tag matches package.json version` step on both jobs.
- **LOW-7** - Missing post-bundle smoke test. Fix: `npm run smoke` step on `publish-cli`.
- **LOW-3 (v0.6.2 tool fix)** - `CompactMessage` interface not extended with `toolResult`/`toolCallId`/`memberName`/`memberId`. Fix: added.
- **LOW-4 (v0.6.2 tool fix)** - Status glyph `ok=undefined && durationMs=defined` -> `V` instead of `?`. Fix: direct check.
- **LOW-5 (v0.6.2 tool fix)** - Session resume `tool_execution_end` truncated at 600 chars without a `.`. Fix: append `.`.
- **MEDIUM-2 (v0.6.2 tool, false positive discarded)**: agy flagged removal of `toolCall`/`toolResult` event backward compat. Verified: the `BrainEvent` type only includes `tool_execution_start`/`tool_execution_end`, not the legacy names.

### Changed
- `packages/core/tsconfig.json`: `module: ESNext + moduleResolution: Bundler` -> `module: NodeNext + moduleResolution: NodeNext`.
- `packages/core/src/**`: 26 relative imports `.js`-extended (automatic script).
- `packages/core/src/harness/tools/index.ts`: `export *` removed for `toolTypes.js` (`ToolContext` re-export conflict); now explicit `export type`.
- `package.json`: `@zelari/core: "*"` -> `"0.6.2"` (exact pin for coupled release).
- `.github/workflows/publish.yml`: build order, sequential core->CLI, version check, smoke test, dispatch tag handling.

Test: 771 -> 771 (0 new, but 1 regression for HIGH-1 blank transcript in toolDisplay.test.ts).

## [0.6.0] - 2026-07-02

### Highlights
- **Real Lucifero chairman**: the council chairman (Lucifero) now generates an actual synthesis based on the outputs of the 5 specialists + Minosse, with typewriter streaming, tool calls enabled and a robust fallback on LLM error. Replaces the stub that only produced `[Chairman synthesis for: ...]`. **No more 5 loose threads - the council now has a single, reasoned final answer.**
- **Visible reasoning for Lucifero**: free via the `memberId`/`memberName` pattern introduced in v0.5.0. The CLI shows `? Lucifero` (in purple) in the chairman message header, aligned with the other 5 specialists.
- **7 new E2E tests** in `tests/unit/council-chairman.test.ts` covering: presence of `memberId="lucifer"`, at least 1 `message_delta` with the chairman ID, `member_cost.errored=false` on success, backward compat with `councilSize: 3` (no chairman), chairman LLM error handling.
- **ADR-0006** documents the decision to make Lucifero real in v0.6.0 instead of v0.5.0 (scope creep avoided) and the alternatives considered (graceful fallback vs hard fail).

### Added
- `packages/core/src/agents/councilApi.ts`: real chairman loop (~110 lines) based on `AgentHarness`, with `buildAgentMessages(chairman, userMessage, agentOutputs, ...)`, `message_delta` streaming via `onSynthesisChunk`, error detection on `event.severity !== 'cancelled'`, fallback string `[Chairman synthesis failed: <reason>]` if the chairman LLM fails.
- `tests/unit/council-chairman.test.ts`: 7 E2E tests with mock provider.
- `docs/plans/2026-07-02-v0-6-0-roadmap.md`: v0.6.0 plan (Phase 0 = real chairman, Phase 1+ = future slices).
- `docs/decisions/0006-lucifero-chairman-real.md`: ADR with context, decision, alternatives, consequences.
- `package.json`: `pretest` script rebuilding `@zelari/core` before tests (prevents stale dist).

### Fixed (post-release audit, agy Gemini 3.5 Flash)
4 runtime bugs found by the agy audit workflow gate, all fixed with regression tests:

- **HIGH-1** - The chairman loop's `catch` overwrote `fullText` with `"Error: ..."`, preventing the fallback string `[Chairman synthesis failed: ...]` from ever rendering (because `fullText.length > 0` made the check false). Fix: `catch` now saves the error in a separate `lastErrorMessage`, leaving `fullText` intact.
- **HIGH-2** - `openaiCompatibleProvider` used `config.signal` (closed in the factory scope, typically `undefined`) instead of `params.signal` (the AgentHarness per-call signal). Result: `cancel()` did not abort the HTTP request. Fix: `signal: params.signal`.
- **HIGH-3** - `openaiCompatibleProvider` used `config.model` instead of `params.model`, silently breaking the `agentModels` config (all council members ended up on the default model). Fix: `body.model: params.model`.
- **HIGH-4** - The specialist and oracle loops did NOT check `event.type === 'error'`, so if AgentHarness converted a network error into a BrainErrorEvent (severity='recoverable'), `errored` stayed `false` and the failure was logged as success in `member_cost`. Fix: check added to both loops.

Test: 759 -> 761 (+2 regressions: exact chairman fallback, errored specialist on error event).

### Changed
- Version bump `0.5.0` -> `0.6.0` in `package.json` (root), `packages/core/package.json`, `src/cli/main.ts`, `src/cli/wizard/index.tsx`, `README.md`.

### Deferred to v0.6.1
- **Grounding helper**: would add 1 extra LLM call + source scoring. Postponed to not blow up v0.6.0's scope (atomic chairman release).
- `--no-chairman` opt-out flag: not needed until users ask for it.
## [0.5.0] - 2026-07-02

Phase 4 of the v0.5.0 roadmap: stable release. The CLI, the
`@zelari/core` monorepo package, the first-run wizard, the
visible-reasoning council, and the headless mode are all in.

This is the **first release where `@zelari/core` is a standalone,
publishable package** (MIT-licensed, 9 subpath exports, 752/752
tests green). If you have code that imported from pre-0.5.0 internal
paths, see [MIGRATION.md](MIGRATION.md).

### Highlights

- **First standalone release of `@zelari/core`** (MIT). 9 curated
  subpath exports; see `packages/core/package.json` for the full
  list. The `src/main/core/`, `src/agents/`, `src/shared/`,
  `src/types/` paths are gone — no shim, by design (see
  [ADR-0005](docs/decisions/0005-deprecate-legacy-src-paths.md)).
- **First-run wizard** with keyStore wiring and a no-`process.exit`
  bridge into the regular TUI. `--no-wizard`, `--reset-config`, and
  `ZELARI_NO_WIZARD=1` for skipping.
- **Visible reasoning**: council member identity (`memberId` /
  `memberName`) now propagates from the 6-member debate through the
  event stream into the chat header. Caronte, Minosse, etc. are no
  longer anonymous in the TUI.
- **Headless mode** (`--headless --task X [--council] [--output json|plain]`):
  runs without Ink, for CI/CD and scripting. Reuses the same
  AgentHarness and dispatchCouncil code paths as the TUI, so event
  shape is identical (including the new memberId/memberName).
- **5 ADRs** in `docs/decisions/` documenting the monorepo, MIT
  license for `@zelari/core`, versioning policy, public API surface,
  and the no-shim policy.

### Bundle / size

- CLI bundle: ~1015 KB (was ~1011.8 KB at v0.5.0-dev.0; +~3 KB for
  `headless.ts` and `runHeadless.ts`).
- `@zelari/core` tarball: 147.9 KB, unpacked 571.3 KB, 181 files.

### Verification

- 752 unit tests passing (12 added in `headless-flags.test.ts`, 5 in
  `headless-run.test.ts`).
- `npm run typecheck` clean.
- `npm pack --dry-run` clean: LICENSE + subpath exports + dist match.

### Changed

- `src/cli/main.ts` no longer mounts Ink unconditionally. The new
  `pickRootComponent()` returns a `{kind: 'wizard' | 'app' | 'headless' | 'done'}`
  discriminator. The wizard runs on first launch (or when
  `provider.json` is missing); headless mode short-circuits the TUI
  on `--headless --task X`.
- All `VERSION` constants bumped from `0.5.0-dev.0` to `0.5.0` in
  `package.json`, `packages/core/package.json`,
  `src/cli/main.ts`, `src/cli/wizard/index.tsx`, `README.md`.

### Migration

See [MIGRATION.md](MIGRATION.md). Summary: import paths changed, the
tool itself is wire-compatible for the CLI use case.

## [Unreleased]


## [1.22.1] - 2026-07-21

### Fixed
- **Desktop release build** � removed unused `exportConversation` import in `App.tsx` that failed `tsc` (noUnusedLocals) and blocked Tauri installers for v1.22.0.

### Note
- Functional features ship in **1.22.0**. Use `npm i -g zelari-code@1.22.1`; Desktop installers attach to this tag.
### Added (Fase 3 — council reliability)
- **Visible reasoning**: every `agent_start`, `agent_end`, `message_start`,
  `message_delta`, `message_end` event now carries optional `memberId` +
  `memberName` so the UI can label which council member is speaking.
  `dispatchCouncil` (packages/core) threads `agent.id` / `agent.name`
  into the AgentHarness config; `useChatTurn` propagates them to the
  `ChatMessage`; `ChatStream` renders the member name in the assistant
  message header (e.g. `· Caronte` in magenta).
- **Headless mode** (`zelari-code --headless --task X [--output json|plain]
  [--council] [--provider <id>] [--model <name>]`): runs a single task
  without mounting the TUI. Two execution paths:
  - `--task X` (default): single `AgentHarness` run.
  - `--task X --council`: the same 6-member council pipeline the TUI
    uses (event shape identical, including memberId/memberName).
  Output: NDJSON (one JSON object per line) or plain text (streamed
  message deltas). Exit codes: 0=ok, 1=user error, 2=runtime, 3=agent error.

## [0.5.0-dev.0] - 2026-07-02

Phase 1 + Phase 2 of the v0.5.0 roadmap: monorepo extraction of
`@zelari/core` + first-run onboarding wizard (complete slice).

### Added
- **Monorepo via npm workspaces** (`packages/core/` as `@zelari/core`).
  The provider-neutral agent loop (AgentHarness), ToolRegistry, council
  orchestration, built-in skills, shared events, and types now live in
  a standalone workspace package. The CLI in `src/cli/` is a thin
  consumer of `@zelari/core/...`. See [docs/decisions/0001-monorepo-for-zelari-core.md](docs/decisions/0001-monorepo-for-zelari-core.md).
- **First-run wizard** (`src/cli/wizard/`): when `provider.json` is
  missing on disk, the CLI renders an Ink wizard instead of `<App>`.
  Steps: welcome → provider → model → apikey → confirm. The wizard
  uses the existing `setActiveProviderId` / `setModelForProvider` /
  `keyStore.setApiKey` setters to persist the chosen config + API key
  on commit. The wizard transitions transparently into the regular
  TUI 1.2s after commit() runs (no `process.exit`, no need to
  re-launch).
  - CLI flags: `--no-wizard` (skip), `--reset-config` (force re-run).
  - Env override: `ZELARI_NO_WIZARD=1`.
  - Decision is pure: `shouldRunWizard(input)` is fully unit-tested
    and order-of-precedence verified.
- **CLI meta-flags** (`--version`, `--help`, `-v`, `-h`): previously
  the CLI mounted Ink on every invocation, which produced React
  warnings on `--version` and polluted pipes. Now they print + exit
  cleanly without touching the TTY.
- **Architecture Decision Records (ADRs)** in
  `docs/decisions/0001-0005`:
  - 0001 — Monorepo for @zelari/core (accepted retroactively on
    commit `6ec90be`).
  - 0002 — Publish @zelari/core to npm under MIT (auto-accepted).
  - 0003 — Versioning coupled 0.5.x, splits at 0.6.0 (auto-accepted).
  - 0004 — Public API surface limited to 9 barrel subpaths
    (auto-accepted).
  - 0005 — Deprecate legacy src/main/core, src/agents, src/shared,
    src/types paths (auto-accepted).
- **README "First Run" section**: visual guide to the wizard, the
  5-step flow, the transition behaviour, and the skip/reset flags.

### Changed
- `src/cli/wizard/runWizard.tsx`: replaced the old `process.exit(0)`
  after commit() with a `PostCommitBridge` component that renders a
  brief "✓ Setup complete!" banner and then mounts `<App>` in the
  same Ink tree. No CLI restart needed.
- `src/cli/wizard/useWizardState.ts`: distinguishes
  `apiKeyValue === undefined` (no value provided) from
  `apiKeyValue === ''` (whitespace-only). Commit guard treats empty
  as "skip persist" without changing user-visible behaviour.
- `src/cli/wizard/runWizard.tsx`: 'q' now quits from any step (was
  welcome-only). Enter on the model step with empty input
  auto-seeds the default and advances — no more "stuck on model".
- `src/cli/main.ts`: now branches on `shouldRunWizard()` and renders
  either `<RunWizard>` or `<App>`. Also intercepts `--version` /
  `--help` to avoid mounting Ink.
- 39 source files re-imported from `@zelari/core/...` subpaths
  (zero `src/main/core/`, `src/agents/`, `src/shared/`, `src/types/`
  imports remain in `src/cli/`).
- `package.json` (root) now declares `workspaces: ["packages/*"]` and
  depends on `@zelari/core: "*"`.
- `tsconfig.json` (root) adds `paths` for `@zelari/core/*` and excludes
  `packages/` from the root source include.

### Fixed
- Audit-driven fixes to the wizard UX:
  - **MEDIUM**: pressing Enter on the model step with empty input
    was a silent no-op (riga 73-78 di `runWizard.tsx`). Now re-seeds
    the default model and advances to the apikey step.
  - **MEDIUM**: 'q' only quit the wizard from the welcome step. Now
    quits from any step.
  - **LOW (caught by tests)**: `selectApiKey('keystore', undefined)`
    silently coerced undefined to '' via `value ?? ''`, hiding the
    difference between "no value provided" and "empty value". Now
    keeps `undefined` semantically distinct; commit guard still
    short-circuits on either.

### Tests
- 735/735 passing (was 692, +43 over 4 new test files). New tests:
  - `wizard-firstRun.test.ts` — 14 tests covering all priority
    combinations of `--reset-config`, `--no-wizard`,
    `ZELARI_NO_WIZARD`, and config-file presence.
  - `wizard-useWizardState.test.ts` — 17 tests covering the wizard
    state machine end-to-end (step transitions, cursor wrapping,
    model override, commit idempotency, back-navigation, API key
    persistence with env/keystore/skip/empty/undefined).
  - `cli-main-wizard.test.ts` — 4 integration tests verifying that
    `main.ts` branches correctly on the combined flag+env+file
    inputs.
  - `wizard-postCommit.test.ts` — 8 tests covering the post-commit
    state shape (committed flips, model + provider carried forward)
    plus audit-driven edge cases (whitespace, undefined, fire-and-
    forget after key persist error).
- TypeScript clean (`npm run typecheck`).
- Bundle 1011.8 KB (was 996.7 KB; +15 KB for wizard UI + bridge).

### Known issues
- Smoke test (`npm run smoke`) revealed a pre-existing
  `Encountered two children with the same key` warning from
  React-reconciler, originating in the App's `Sidebar` / `ChatStream`
  components (not introduced by this release). Workaround for the
  smoke test: the new `--version` / `--help` handlers exit before
  mounting Ink, so the warning no longer appears when the user
  passes those flags. Tracked for v0.5.0 stable cleanup.

## [0.4.4] - 2026-07-01

Phase 0 of v0.5.0 roadmap: address the two LOW-severity findings left over from the v0.4.3 audit, complete the streaming flicker fix that was only half-implemented in commit 5e0f698.

### Fixed
- **LOW: SRP violation in `src/cli/slashHandlers/git.ts`** (v0.4.3 follow-up): the file owned 5 unrelated responsibilities (`/diff`, `/undo`, `/compact`, `/update`, `/promote-member`). Split into 4 files by domain: `git.ts` (kept, now only `/diff` and `/undo`), `transcript.ts` (new, `/compact`), `updater.ts` (new, `/update` + `/update --yes`), `promoteMember.ts` (new, `/promote-member`). Each file defines its own typed `SlashContext` (GitSlashContext / TranscriptSlashContext / UpdaterSlashContext / PromoteMemberSlashContext). `useSlashDispatch` import block updated to import from the 4 new locations. **Zero behavior change** — purely structural refactor.
- **LOW: misleading `/checkout` message** (`src/cli/slashHandlers/branch.ts`): the old message said "Restart zelari-code to load it", implying hot-swap. In reality the active branch is read once at startup and the session is bound to the in-memory branch for the lifetime of the process. Replaced with an explicit 3-line warning: the new branch only takes effect on the next launch, and the current session still belongs to the previous branch.
- **CRITICAL: `/checkout` was a silent no-op** (`src/cli/slashHandlers/branch.ts`, found by agy audit on this refactor — a real bug masquerading as a message-style issue): the file imported `setCurrentBranch` / `getCurrentBranch` from `branchManager.js`, but those are no-op STUBS (`return null` / `// no-op stub`). The real file-based implementations live in `sessionManager.ts` (read/write `currentBranch.txt`). Without this fix, every `/checkout <name>` since v0.4.3 silently failed to persist the active branch on disk, and `/branches` would show stale data on next launch. Fixed by importing the persistence functions from `sessionManager.js` instead. (The v0.4.3 audit flagged this as a "no-op stub" follow-up but did not actually fix it.)
- **HIGH: `GitSlashContext` required unused `messages` field** (`src/cli/slashHandlers/git.ts`, found by agy): the type inherited `messages: ChatMessage[]` from the original fat `SlashContext` but neither `/diff` nor `/undo` read it. Callers had to pass it (or the `// @ts-nocheck` in `useSlashDispatch` hid the mismatch). Tightened the type to `{ setMessages }` only.
- **HIGH: `/checkout` message lines exceeded 80 cols** (`src/cli/slashHandlers/branch.ts`, found by agy): the original 3-line replacement had a 125-char second line. Re-wrapped to keep every line under 80 chars.
- **MEDIUM: `setInput` declared in 4 context types but never used** (`{transcript,updater,promoteMember,branch}.ts`, found by agy): input clearing is centralized in `useSlashDispatch`. Removed the dead field from the 4 context interfaces.
- **LOW: tracker-prefix comment** (`branch.ts`): removed the `// v0.4.4 (LOW-2 audit fix)` comment per agy finding (the explanatory note was redundant with the new CHANGELOG entry).

### Changed
- `src/cli/slashHandlers/branch.ts`: `handleBranchCheckout` now emits a 3-line system message instead of a single line. The user-visible string changed from `[checkout] active branch set to "X". Restart zelari-code to load it.` to `[checkout] active branch set to "X". ⚠ This only takes effect on the next zelari-code launch — your current session still belongs to the previous branch. Run /exit (or Ctrl+C) and start zelari-code again to load the new branch.`
- `src/cli/slashHandlers/branch.ts`: `setCurrentBranch` / `getCurrentBranch` are now imported from `sessionManager.js` (file-based `currentBranch.txt` persistence) instead of `branchManager.js` (no-op stubs). This is a behavior fix: `/checkout` now actually persists the active branch on disk.

### Tests
- 692/692 passing (no test count change — refactor was behavior-preserving, and the agy audit did not add new test files; future follow-up: add direct handler tests for the 6 handlers in `slashHandlers/` as flagged by agy MEDIUM-2)
- TypeScript clean (`npm run typecheck`)

### Audit
- **agy (Gemini 3.5 Flash) review on the v0.4.4 refactor** — found 1 CRITICAL (`/checkout` silent no-op, the bug hiding behind the LOW-2 message change), 2 HIGH (tighten `GitSlashContext`, fix message width), 2 MEDIUM (drop unused `setInput` from 4 contexts, add direct handler tests), 1 LOW (drop tracker-prefix comment). All 5 are addressed in this release except MEDIUM-2 (deferred — the existing tests cover the command parsing and the underlying core APIs, so the handler test gap is lower-priority than the bug fixes landed here).

## [0.4.3] - 2026-07-01

### Fixed
Independent audit (agy Gemini 3.5 Flash on v0.4.2) found 10 issues across CRITICAL/HIGH/MEDIUM/LOW. All CRITICAL + HIGH + relevant MEDIUM addressed:

- **CRITICAL: `/council` crashes at runtime** (`useChatTurn.ts`): the hook returned the raw `dispatchCouncilPromptImpl(text, deps)` under the property `dispatchCouncilPrompt`, but `useSlashDispatch` called it with one argument. Result: `Cannot destructure property 'sessionId' of 'undefined'` whenever the user typed `/council …`. Wrapped `dispatchCouncilPromptImpl` in a `useCallback` that captures hook-scope deps and returns a single-argument function. New regression test in `cli-useChatTurn.test.ts`.
- **CRITICAL: split-brain session id on `/new`**: `sessionKindRouter('new')` minted idA to disk, then `useSlashDispatch` minted idB in memory + writerRef. Restart loaded idA from disk and found an empty session. Fixed by having `useSlashDispatch` mint the id first and pass it via a new `forcedNewId` parameter to `sessionKindRouter`. New regression test verifies on-disk marker matches generatedId.
- **HIGH: stale closures in `InputBar`**: the v0.4.1 `React.memo` comparator intentionally ignores `onChange`/`onSubmit` identity, which means stale closure references inside the memo'd render would route `/submit` against pre-stream values of `messages`/`sessionId`/etc. Mirrored both callbacks through `useRef` so the always-fresh closure is read at call-time.
- **HIGH: `eventsToMessages` schema mismatch**: the function checked for the old `tool_call` / `tool_result` event types that no longer exist after the v3-W refactor; every tool invocation was silently dropped during session resume. Switched to `tool_execution_start` / `tool_execution_end` and used the new fields (`args`, `isError`).
- **HIGH: no direct coverage of the 4 core hooks**: added `cli-useChatTurn.test.ts` using `@testing-library/react`'s `renderHook` (new devDep). The dispatchPrompt-error test would have caught the split-brain bug too.
- **MEDIUM: `useTerminalSize` bootstrap stale**: if `stdout` resolved after the initial render (test bootstrap, some terminal wrappers), the size stayed at 80×24 until a manual resize. Added an immediate `setSize` inside the effect when stdout becomes available.
- **MEDIUM: unhandled rejection in `dispatchPrompt` setup**: throws from `providerFromEnv` / `resolveFailoverStream` / `AgentHarness` construction happened BEFORE the existing try/catch, escaping unhandled. Wrapped the setup in a try/catch that surfaces a `[dispatch error]` message and resets busy. New regression test.

### Added
- `@testing-library/react` + `react-dom` + `jsdom` as devDeps (for hook tests under jsdom env)
- `cli-useChatTurn.test.ts` (4 tests covering both dispatch paths + error handling)
- `cli-sessionKindRouter.test.ts` (5 tests including forced-id split-brain regression)

### Audit limitations
- GLM 5.2 CLI not installed locally → second opinion from agy only. Subagent Hermes rejected with 404 (delegation not enabled in this profile).
- LOW-severity findings left for follow-up: SRP violation in `git.ts` (contains `/compact`, `/update`, `/promote-member`); `handleBranchCheckout` message says "Restart zelari-code" but `setCurrentBranch` is currently a no-op stub.

## [0.4.2] - 2026-07-01

### Changed
- **app.tsx split (v0.4.2 audit)**: the 2200-line monolithic `app.tsx` is now a 175-line shell that composes 4 focused hooks. Logic moved to:
  - `src/cli/hooks/useTerminalSize.ts` — reactive stdout dimensions with resize coalescing
  - `src/cli/hooks/useSession.ts` — session bootstrap + `/sessions` `/resume` `/new` lifecycle
  - `src/cli/hooks/useChatTurn.ts` — `dispatchPrompt` (single LLM) + `dispatchCouncilPrompt` (multi-agent)
  - `src/cli/hooks/useSlashDispatch.ts` — router for every `/command` (1340-line `handleSubmit` if/else chain)
  - `src/cli/hooks/chatStats.ts` — `computeSessionStatsDelta`
  - `src/cli/hooks/eventsToMessages.ts` — BrainEvent → ChatMessage replay
  - `src/cli/hooks/steer.ts` — `applySteerInterrupt`
  - `src/cli/hooks/skillCompare.ts` — `formatSkillCompare` family
  - `src/cli/hooks/messageHelpers.ts` — `appendSystem` / `appendUser` / `appendOrExtendStreamingAssistant` / `appendToolStart` / `appendToolEnd` / `updateToolMessageEnd` (eliminates 50+ inline `setMessages` boilerplates)
  - `src/cli/utils/duration.ts` — `formatDuration`
  - `src/cli/slashHandlers/git.ts` — `/diff` `/undo` `/compact` `/update` `/promote-member`
  - `src/cli/slashHandlers/branch.ts` — `/branch` `/branches` `/checkout`
  - `src/cli/slashHandlers/workspace.ts` — `/workspace` `/workspace_show` `/workspace_sync` `/workspace_reset`
  - `src/cli/slashHandlers/provider.ts` — `/provider*` `/login` `/login oauth` `/model*` `/models`
  - `src/cli/slashHandlers/skills.ts` — `/skill-stats` `/skill-compare` `/council-feedback` `/steer`
- App.tsx now re-exports the legacy helpers so existing imports keep working. New code should import directly from the hook modules.

### Refactor
- **app.tsx**: 2200 LOC → 175 LOC. Single-responsibility per file (50-300 LOC each).
- **handlers**: each slash-command handler is now a 30-80 LOC pure-ish function. Independently unit-testable without booting Ink/React.
- **message helpers**: 50+ inline `setMessages(prev => [...prev, { id: crypto.randomUUID(), role: 'system', content, ts }])` patterns collapsed into reusable `appendSystem` / `appendUser` / `appendOrExtendStreamingAssistant`.

### Fixed
- **Test mock fragility**: replaced `vi.spyOn(sessionManager, 'setCurrentSessionId')` (didn't intercept — the spy was on the module namespace but the function inside `sessionKindRouter` had already captured the top-level binding) with **observable-state tests** that redirect `ANATHEMA_CURRENT_SESSION_FILE` env var and read back the marker file.

## [0.4.1] - 2026-07-01

### Fixed
- **TUI flicker during LLM streaming**: ChatStream and the surrounding components were re-rendering on every streaming token delta (~20-50/sec). Added `React.memo` wrappers with custom prop comparators on `Header`, `Sidebar`, `InputBar`, `ChatStream`, and `CollapsibleToolOutput`. Moved the `visibleMessages` computation (formerly O(N) per render with multiple `content.split('\n')` calls) into a memoized pure helper `pickVisibleMessages` keyed on `[messages, height, width]`.
- **TUI border reflow on expanded tool output**: `CollapsibleToolOutput` was rendering body as `body.split('\n').map((line) => <Text>{line}</Text>)` — N draw calls for an N-line body. Now renders the body as a single `<Text>{body}</Text>`; Ink coalesces consecutive text into one cohesive block.
- **Terminal resize flicker**: `useStdout().on('resize')` was triggering `setSize` on every event, causing 100+ redraws during a fast tmux pane drag. Added a 16ms (~1 frame at 60Hz) coalescing timer so a burst of resize events collapses into one state update.
- **`CollapsibleToolOutput` uncontrolled state stuck on initial value**: `useState(defaultExpanded)` was never updated when `defaultExpanded` changed post-mount (e.g. session resume). Added a `useEffect` sync.
- **`Sidebar` truncation race**: the `... (more in /skills)` indicator was pushed into `visibleSkillLines` in place, mutating the slice result. Now computed as a separate `truncated` boolean in `useMemo` so the visibleLines array stays pure.

### Performance
- ChatStream now does ~1 visible-message computation per actual state change instead of ~1 per streaming token. With 20 tokens/sec from the LLM, this is a ~20× reduction in `split`/`ceil`/`unshift` work per second.

## [0.4.0] - 2026-07-01

### Added
- **`grep_content` recursive mode** (auditing fix): `path` can now be a directory; the tool walks it (respecting `include`/`exclude` globs and `maxDepth`) and searches each matched file. Backward-compatible — existing single-file callers unchanged. Defaults exclude `node_modules`, `dist`, `.git`, etc.
- **`show_diff` tool**: unified diff between current file content and proposed content. Read-only preview before applying edits. Zero-deps LCS implementation (Myers-simplified, ~150 LOC).
- **`apply_diff` tool**: apply a unified-diff patch to a file. Parses `---/+++/@@` headers, applies hunks sequentially, atomic on first failure. Supports `fuzzyMatch=true` (tolerates whitespace differences) and `dryRun=true` (preview without writing).
- **`_walk` helper**: shared recursive directory walker with glob filtering, used by both `list_files` and `grep_content`.

### Changed
- **`list_files`**: refactored to use the new shared `_walk` helper (eliminates ~80 LOC of duplicate walk/glob logic).
- **Tool count**: builtin tools are now 8 (was 6): `read_file`, `write_file`, `edit_file`, `list_files`, `grep_content`, `bash`, `show_diff`, `apply_diff`.

### Fixed
- **Multi-hunk `apply_diff` bug**: the previous "apply-hunk-to-current-state" algorithm lost the file prefix between hunks. Rewritten as a single-pass walk over the original file with atomic per-hunk validation — each hunk's `oldStart` correctly refers to the ORIGINAL file, not the post-previous-hunk state.
- **`grep_content` `args.maxMatches` undefined trap**: defaults (maxMatches=50, maxDepth=8, include/exclude) are now applied via Zod schema parse — callers passing partial args get the right behavior.

## [0.3.2] - 2026-07-01

### Fixed
- **Version drift**: `VERSION` in `src/cli/main.ts` was stale at `0.2.2`, `package.json` was at `0.3.0`, while the published tag was `0.3.1`. Background update check was therefore comparing wrong version against npm registry (false "outdated" or missed update hint). All three now aligned to `0.3.1`.

### Changed
- **Stale Electron path** in `src/cli/councilDispatcher.ts` JSDoc — comment cited `electron/cli/toolRegistry.ts` (path no longer exists after v3-W refactor). Now references `src/cli/toolRegistry.ts` and reflects the current 6 built-in tools (was 5).
- **`src/types/cli-globals.d.ts`**: removed `Window.electronAPI` ambient type (runtime never used it after the v3-W Node-only refactor). Other ambient types (`showDirectoryPicker`, `ImportMeta.env`) preserved for shared-source typecheck compatibility.
- **Skill example in `src/agents/skills/builtin/docs.ts`**: changelog-generation example updated from `v0.2.0 / AnathemaBrain` (stale) to `v0.3.1 / zelari-code` to avoid misguiding the model.
- **`docs/plans/2026-07-01-council-workspace-cli-stubs.md`**: `Generated by ... v0.2.2 patterns` comment refreshed to `v0.3.0`.

### Notes
- Patch release (no breaking changes). No new tests needed — fix is version-string + comment alignment only.

## [0.3.0] - 2026-07-01

### Changed
- **Council roles renamed** to the 9 bosses of Dante's Inferno:
  - Sisyphus (Orchestrator) → **Caronte** (1°-2° confine)
  - Prometheus (Planner) → **Nettuno** (7° cerchio)
  - Hephaestus (Ideator) → **Gerione** (8° cerchio)
  - Atlas (MindMapper) → **Plutone** (4° cerchio)
  - Oracle (Critic) → **Minosse** (2° cerchio)
  - Chairman (Synthesizer) → **Lucifero** (9° cerchio)
  IDs updated everywhere (roles, swap map, slash commands, tests, docs).
  Use new IDs in `/promote-member <id>` and `swapMembers()` calls.

### Added
- **Council Workspace (v3-W)**: project-local `.zelari/` persistence for council output (plan/risks/decisions/reviews/docs), replacing the Electron-only `ctx.createPhase`/etc. injection in CLI mode
- **AGENTS.MD auto-maintenance**: 5 sections (`tech-stack`, `decisions`, `conventions`, `build`, `open-questions`) auto-curated from `.zelari/` with marker-delimited blocks; manual sections preserved verbatim; idempotent hash-based writes (no git diff when unchanged)
- **Mini YAML parser/serializer**: zero-deps subset (scalars, flow/sequence/block-sequence arrays, flow/block maps) in `src/cli/workspace/storage.ts`
- **Per-key mutex** for filesystem writes (`workspaceMutex`) — concurrent council tools serialize per-artifact without blocking the global loop
- **`/workspace` slash command family**: 7 sub-commands — list, show (plan|decisions|risks|agents|docs), sync, reset
- **60 new tests** (618 total): 17 storage / 16 stubs / 11 agentsMd / 9 wiring / 16 slash commands / 9 misc integration — all passing
- **README section**: "Council Workspace" with layout diagram, slash command reference, and AGENTS.MD format

### Notes
- `.zelari/` is auto-gitignored; `AGENTS.MD` at project root is committed
- Disable AGENTS.MD auto-curation with `ZELARI_AGENTS_MD=0` env var
- Dogfood: `zelari-code`'s own `AGENTS.MD` will be generated by its first `/council` invocation (planned for v3-W follow-up)

## [0.1.0] - 2026-06-30

### Added
- Initial standalone release of Zelari Code CLI
- Multi-agent council system: 6 roles (Caronte, Nettuno, Gerione, Plutone, Minosse, Lucifero)
- Slash command system with 30+ commands (skills, providers, sessions, branches, etc.)
- 7 built-in coding skills: refactoring, testing, debugging, review, planning, docs, git-ops
- Provider-agnostic LLM streaming: OpenAI-compatible, xAI Grok (OAuth + refresh), GLM/Z.AI
- Built-in tools: filesystem (read/write/edit), shell (bash), search (grep), git operations
- Rich TUI with Ink + React (header, chat stream, sidebar, input bar)
- Cross-provider failover on transient errors
- Cost tracking per-turn + cumulative USD
- Metrics + skill history logging to `~/.tmp/zelari-code/`
- Session management: JSONL transcripts, resume, compaction
- Branch isolation (worktree-per-session mode)
- Self-update mechanism: `/update` slash command + silent registry check on startup
- GitHub Actions workflow for automated npm publish on tag push

### Notes
- Extracted from [AnathemaBrain](https://github.com/N-THEM-Studio/AnathemaBrain) v3-N release
- Standalone repo: zero Electron deps, ~750KB bundle, only requires Node.js ≥ 20
- Future v3-T refactor will split monolithic `app.tsx` (1748 LOC) into typed hooks
