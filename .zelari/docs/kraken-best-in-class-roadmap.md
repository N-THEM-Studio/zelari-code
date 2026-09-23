# Kraken — Roadmap to Best-in-Class CLI Coding Agent

> **Status:** PLAN (validated against current source on 2026-08-08).
> **Goal:** Make Kraken the *reference implementation* of a local-first, multi-provider,
> deterministically safe, parallel-subagent CLI coding agent.
> **Target horizon:** 4–6 release cycles (≈ 6–9 months at current cadence).
> **Authoring convention:** every phase lists touched files, acceptance criteria,
> and failure modes. Phases are ordered by dependency, not by priority.

---

## 0. Vision & positioning

**Where we are today (v1.29.0, Kraken v0.10.x → v1.28.x line):**
- 12 concurrent tentacles, 24 max nodes/graph (`DEFAULT_MAX_PARALLEL=12`, `DEFAULT_MAX_NODES=24`).
- 5+ LLM providers (Grok OAuth, OpenAI-compat, GLM, MiniMax, DeepSeek). MIT.
- Worktree-isolated writers, sequential merge, no auto-resolve conflicts.
- Auto-verify per writer + 1 rework round per lineage.
- Optional Level-3 world-model gate (`.zelari/world/checks.json`).
- Cross-run memory via `graphMemory.ts` (`.zelari/kraken/last-graph.json`).
- Abort signal that always settles the graph and returns a summary.

**Where we want to be:**
A CLI coding agent that — for a dev or team that doesn't want vendor lock-in and
cares about safe, deterministic multi-agent work — has no reason to switch to
Claude Code Dynamic Workflows, Codex Multi-Agent v2, or Amp, *and* ships the
features they ship (workflow runtime, multi-persona council, live progress, batch fan-out).

**The four pillars** (mapped to specific market gaps):

| Pillar | Market gap it closes | Headline capability |
|---|---|---|
| **P1 — Workflow script runtime** | Cap 12/24 vs Claude Code DW's 16/1000, Amp's 25 | Plans can be *executable scripts*, not just DAGs. Fan-out 100+ when needed. |
| **P2 — Spec council (multi-persona)** | Single `verify` vs pi-gauntlet's 7 personas, Amp's Oracle | Each writer is judged by 3 personas: spec-reviewer, conformance-reviewer, oracle. |
| **P3 — Live workbench** | Status-bar chip vs Gauntlet Loop's live HTML/MD page | `.zelari/radio/workbench.md` auto-updated; render in TUI as well. |
| **P4 — CSV / batch fan-out** | No primitive vs Codex's `spawn_agents_on_csv` | One tool call fans N workers over a CSV, each in its own worktree, results merged to CSV. |

**Plus three cross-cutting** (not pillars, but shipped alongside the pillars):

| Cross-cutting | Why |
|---|---|
| **C1 — Reusable knowledge save** | Gauntlet Loop step 8. After a successful graph, propose skill promotion. |
| **C2 — Cross-session messaging** | Omp-style: agents can talk to each other. |
| **C3 — Graph checkpoint / fork** | Mid-graph snapshot; "fork" the graph from a node, "rewind" on cancel. |

**What we explicitly do NOT chase:**

- A *cloud handoff* story. Local-first is the wedge. (Codex Cloud, Claude Code Web, Devin, Amp Orbs are all cloud-managed; we don't compete there.)
- A *model-zoo picker* in the TUI. Provider-agnostic is the value, not brand.
- Replacing `useChatTurn` (2000+ lines, 3 dispatchers). The slash+headless path stays the integration seam.

---

## 1. Pillar 1 — Workflow script runtime (the "DAG ceiling breaker")

### 1.1 Why

The current planner emits a JSON DAG of *tasks* (id/label/prompt/scope/deps).
That shape caps us at `MAX_NODES=24`. Claude Code Dynamic Workflows (May 2026) ships
*executable JS scripts* whose state lives in script variables, not context — that's why
they can fan out 1000 agents/run. To compete, we need plans that can express control
flow (loops, conditionals, fan-in / fan-out) without losing the deterministic
isolation guarantees that are our differentiator.

### 1.2 Design

A Kraken plan is a **TypeScript module** that the planner emits into a temp dir
(e.g. `.zelari/kraken/runs/<graphId>/plan.ts`), compiled with the existing
esbuild pipeline, and run in a Node `vm` context with a small SDK
(`runTentacle`, `emit`, `fork`, `checkpoint`, `log`, `merge`).

```ts
// .zelari/kraken/runs/<graphId>/plan.ts (LLM-emitted)
import { tentacle, emit, merge, checkpoint } from '@zelari/kraken-runtime';

const auth = await tentacle({ kind: 'explore', label: 'map auth', prompt: '...' });

const results = await Promise.all([
  tentacle({ kind: 'general', label: 'auth refactor', prompt: '...', scope: ['src/auth'], deps: [auth] }),
  tentacle({ kind: 'general', label: 'session mgmt',  prompt: '...', scope: ['src/session'], deps: [auth] }),
  tentacle({ kind: 'general', label: 'tests',          prompt: '...', scope: ['tests/auth'], deps: [auth] }),
]);

const spec = await tentacle({ kind: 'spec-reviewer', deps: results, prompt: 'compare to spec.md' });
const conf = await tentacle({ kind: 'conformance',   deps: results, prompt: 'compare to original goal' });

if (conf.verdict === 'fail') {
  await checkpoint('pre-rework');
  const rework = await tentacle({ kind: 'fix', label: 'rework', deps: results, prompt: conf.findings });
  // ... re-verify
}

await merge(results, { strategy: 'squash-sequential' });
emit({ converged: true, findings: spec.findings });
```

The script runtime (1) replaces the JSON DAG (back-compat: a small `dagToScript()`
adapter translates the old shape), (2) keeps our deterministic guarantees
(worktree per writer, scope-overlap provably disjoint, sequential merge, no auto-resolve),
(3) opens the door to *real* loops (the "Gauntlet-style indefinite rework" knob becomes possible
without a fix-budget hack).

### 1.3 Phases

#### F1.1 — Runtime SDK + vm sandbox

- **New files:**
  - `packages/core/src/kraken/runtime/index.ts` — public SDK
  - `packages/core/src/kraken/runtime/sandbox.ts` — Node `vm` wrapper with timeout + memory caps
  - `packages/core/src/kraken/runtime/compile.ts` — esbuild bundler for `.ts` plan files
  - `packages/core/src/kraken/runtime/types.ts` — `TentacleRef`, `PlanContext`, `MergeStrategy`
  - `packages/core/src/kraken/runtime/index.test.ts`
- **Modified files:**
  - `packages/core/src/kraken/index.ts` — re-export the new namespace
- **Acceptance:**
  - A hand-written `plan.ts` can `import { tentacle, merge }` and run end-to-end against the
    existing `taskTool.runTentacle` path with identical behavior to the current JSON DAG path.
  - VM sandbox aborts after configurable timeout (`ZELARI_KRAKEN_PLAN_TIMEOUT_MS`, default 30 min).
  - VM cannot read `process.env` or `fs` outside the provided capability list (capability-based,
    not blanket-deny; `merge` and `log` are explicit capabilities, not inferred).
- **Risk:** `vm` module is power-unsafe by default — must wrap every interaction. **Mitigation:**
  capability object pattern, with tests that verify `fs.readFileSync` outside the SDK throws.

#### F1.2 — Planner emits a plan.ts (vs a JSON DAG)

- **New files:**
  - `src/cli/kraken/scriptPlanner.ts` — new planner path, sibling of `planner.ts`
  - `src/cli/kraken/scriptPlanner.test.ts`
- **Modified files:**
  - `src/cli/kraken/planner.ts` — extract `KRAKEN_PLANNER_SYSTEM_PROMPT` so both planners share it;
    gate via `ZELARI_KRAKEN_PLAN_FORMAT=json|script|auto` (default `auto` → script if goal > 4
    nodes estimated, JSON otherwise)
  - `src/cli/kraken/executor.ts` — add `runScript(graph, ctx)` path that detects a plan file
    and dispatches to the runtime
  - `packages/core/src/agents/promptModules.ts` — add `KRAKEN_SCRIPT_PLANNER_MODULE` (sibling
    of the existing `KRAKEN_PLANNER_MODULE`)
- **Acceptance:**
  - The planner LLM emits a parseable TypeScript file (no JSON, no markdown fence).
  - File compiles with `tsc --noEmit` and bundles with the existing esbuild pipeline (zero new deps).
  - Compiled output is identical-behavior to the current JSON DAG executor for fixture plans.
  - Fallback: if LLM emits un-parseable TS, retry once with a corrective prompt, then fall
    back to JSON DAG (existing path) — never break the run.
- **Risk:** LLM emits plan.ts that uses features the runtime doesn't support. **Mitigation:**
  strict TypeScript types + smoke test that loads 20 hand-written fixture plans and asserts
  the runtime accepts each.

#### F1.3 — Executor runs script plans

- **Modified files:**
  - `src/cli/kraken/executor.ts` — branch on `graph.format`: if `'script'`, compile + sandbox + run;
    if `'json'`, run the existing DAG loop. Same `KrakenExecutionSummary` shape.
  - `src/cli/kraken/graphMemory.ts` — `GraphSnapshot` adds `format: 'json' | 'script'` and stores
    the plan file path, not the inline JSON
  - `src/cli/tools/krakenRadio.ts` — add `'plan_compiled'`, `'plan_runtime_event'`, `'checkpoint'`
    radio events (so the live workbench, Pillar 3, can stream plan state)
- **Acceptance:**
  - End-to-end: `/kraken graph "refactor auth to use JWT" emits a 12-node script plan,
    runs 5 writers + 5 verifies + spec + conformance + merge, converges.
  - All determinism invariants from the JSON path hold: scope-overlap, worktree per writer,
    sequential merge, no auto-resolve, abort signal settles.
  - Wall-clock budget (`ZELARI_KRAKEN_GRAPH_TIMEOUT_MS`) applies to the whole script.
  - `MAX_NODES` cap no longer applies to script plans; instead a `MAX_TENTACLES=200` cap (config).
- **Risk:** Script can call `tentacle` in a hot loop and blow budget. **Mitigation:** runtime
  counts every `tentacle()` call against a budget; `MAX_TENTACLES` enforced at SDK level, not
  at the LLM prompt level.

#### F1.4 — Loops / branching primitives

- **Modified files:**
  - `packages/core/src/kraken/runtime/index.ts` — add `while`, `until`, `race`, `barrier` (N-fan-in)
  - `packages/core/src/kraken/runtime/types.ts` — types for the new primitives
  - `packages/core/src/kraken/runtime/index.test.ts` — tests for each primitive
- **Acceptance:**
  - `while(verdict !== 'pass')` loops are bounded by a `MAX_LOOP_ITERATIONS` (default 5, env-overridable).
  - `until` same.
  - `race` returns the first completed; losers are cancelled (settle to `skipped`).
  - `barrier` waits for N tentacles; partial failures surface, not silent.

### 1.4 Backward compatibility

The JSON DAG path stays the default for tiny goals. The script path activates
when (a) env says so, or (b) the planner estimates > 4 nodes. All current
tests stay green.

---

## 2. Pillar 2 — Spec council (multi-persona quality gate)

### 2.1 Why

Today every `general` writer is judged by exactly one `verify` subagent that
emits `VERDICT: PASS|FAIL`. pi-gauntlet has 7 personas
(`implementer`, `code-reviewer`, `spec-reviewer`, `conformance-reviewer`, ...).
Amp has an `oracle` second opinion. Our single-verifier is the weakest link
in our "deterministic but rigorous" story.

The goal is *not* to ship 7 personas — that'd blow the budget — but to ship the
**3 personas that close the Gauntlet Loop's three concrete quality bars**:

1. `verify` (existing) — checks the writer's `acceptance[]` on disk.
2. `spec-reviewer` — does the diff match the spec/plan, per-requirement table?
3. `conformance` — does the delivered work meet the user's *original verbatim prompt*?

All three return a structured verdict; the script runtime (Pillar 1) is what
makes the orchestration bearable.

### 2.2 Phases

#### F2.1 — Persona registry (the type system for reviewers)

- **New files:**
  - `packages/core/src/kraken/personas/registry.ts` — `ReviewerKind = 'verify' | 'spec' | 'conformance'`
    and `ReviewerSpec { kind, systemPromptPath, verdictSchema }`
  - `packages/core/src/kraken/personas/schemas.ts` — Zod schemas per kind (a `verify` verdict is
    `VERDICT: PASS|FAIL`; a `conformance` verdict is `{ requirementsMet: RequirementVerdict[] }`)
  - `packages/core/src/kraken/personas/index.ts`
- **Acceptance:**
  - All three personas share a common surface (`{ verdict, findings, perItem? }`).
  - Adding a 4th persona is a single file + one Zod schema.
  - Existing `verify` round-trips identically (no behavior change for users).

#### F2.2 — `spec-reviewer` persona

- **New files:**
  - `packages/core/src/kraken/personas/specReviewer.ts` — system prompt + verdict schema
  - `packages/core/src/kraken/personas/fixtures.specReviewer.md` — few-shot examples
- **Modified files:**
  - `src/cli/kraken/planner.ts` — when emitting a `general` node, also emit a sibling
    `spec-review` node (NOT auto-injected by the executor; explicit per the planner's design).
- **Acceptance:**
  - Given a `general` writer that edited 3 files, `spec-reviewer` produces a per-file table
    `{ file, planned, actual, delta }` plus an overall `VERDICT: PASS|FAIL`.
  - Verdict format is parseable; same regex as `verify` (the trailer is identical on purpose).

#### F2.3 — `conformance` persona

- **New files:**
  - `packages/core/src/kraken/personas/conformance.ts` — system prompt
- **Modified files:**
  - `src/cli/kraken/executor.ts` — after convergence, if a `conformance` node is in the graph,
    run it against the *original prompt* (verbatim, not the plan) + the final diff
    (computed via `git diff` against the pre-run snapshot).
- **Acceptance:**
  - `conformance` produces `{ requirementsMet: [{ requirement, met, evidence }], overall: 'pass'|'fail' }`.
  - Output is folded into `KrakenExecutionSummary.unresolvedFindings` when overall is `fail`.

#### F2.4 — Council composition in the planner prompt

- **Modified files:**
  - `packages/core/src/agents/promptModules.ts` — `KRAKEN_PLANNER_MODULE` updated:
    "After every `general`, the executor auto-injects a `verify`. *You* may additionally
    request a `spec-reviewer` (when the task has a written spec/plan) or a `conformance`
    (always, for the last writer in the graph)."
  - `src/cli/kraken/planner.ts` — `KRAKEN_PLANNER_SYSTEM_PROMPT` updated to mention the 3 personas
- **Acceptance:**
  - For an "implement X with this spec" goal, planner emits `general` + `spec-reviewer` + verify.
  - For a "fix Y" goal, planner emits `general` + verify (no spec needed).
  - The total per-writer cost is bounded: 1 verify + at most 1 spec-review + at most 1 conformance.

### 2.3 Risk

Adding personas multiplies LLM calls. **Mitigation:** the `krakenModel` auto-pick
(F1.5 below) routes all 3 personas to *cheap* models by default; user overrides
via `ZELARI_KRAKEN_SPEC_MODEL`, `ZELARI_KRAKEN_CONFORMANCE_MODEL`.

---

## 3. Pillar 3 — Live workbench (the "I can see what's happening" pillar)

### 3.1 Why

Gauntlet Loop step 5 (the article, not the code) recommends a live HTML/MD page
that updates as work progresses. Kraken has a StatusBar chip
("graph 3/8 · 2↑") and a JSONL radio. Both are *post-hoc*. The user has no
real-time view of what each subagent is doing. Claude Code's `/workflows` view
sets the bar; we should match it without leaving our text-first ethos.

### 3.2 Phases

#### F3.1 — Workbench writer (a Markdown auto-update)

- **New files:**
  - `src/cli/kraken/workbench.ts` — `WorkbenchWriter` class: `appendEvent`, `markNode`,
    `setWave`, `snapshot`, `flush`
  - `src/cli/kraken/workbench.test.ts`
- **Modified files:**
  - `src/cli/kraken/executor.ts` — call `workbench.markNode(...)` around every `node_start`,
    `node_end`, `node_retry`, `node_fix`, `graph_converged`, `graph_failed`
  - `src/cli/kraken/graphStatus.ts` — deprecate the in-memory snapshot in favor of reading
    the workbench file
- **Output format:** `.zelari/radio/workbench.md` — a single Markdown file with:
  - Header: goal + start time + graph id
  - Per-node section: `### [id] label — STATUS (kind, scope, model, durationMs)`
  - "Latest 30 events" inline list
  - ASCII tree of the DAG with current state
- **Acceptance:**
  - File is rewritten atomically (write to `.tmp`, rename) so a tail on it never sees partial state.
  - File is human-readable and Git-diffable.
  - `ZELARI_KRAKEN_WORKBENCH=0` disables it (default ON).

#### F3.2 — TUI live view (`/kraken status` + `shift+L` peek)

- **Modified files:**
  - `src/cli/components/StatusBar.tsx` — `shift+L` opens a "live" panel (currently the
    graph chip is a static string); reads the workbench file in a 2s poll, shows the
    latest 5 events + per-node status grid
  - `src/cli/slashHandlers/krakenGraph.ts` — `/kraken status` opens the panel
  - `src/cli/slashHandlers/krakenGraph.ts` — `/kraken workbench` prints the last 80 lines
    of the workbench file to the transcript
- **Acceptance:**
  - Toggling `shift+L` does not interrupt the running graph (the panel reads the file
    via a stream, not via shared state).
  - Panel updates within 3s of any event the executor emits.

#### F3.3 — HTML render (optional, but cheap)

- **New files:**
  - `src/cli/kraken/workbenchHtml.ts` — read the Markdown and render a self-contained
    HTML page (no JS deps; CSS only) with auto-refresh via `<meta http-equiv="refresh" content="2">`
- **Acceptance:**
  - `zelari-code workbench open` opens the HTML in the default browser (or prints the path).
  - HTML is < 30KB regardless of graph size.

### 3.3 Risk

Polling the file from a TUI pollutes the input loop. **Mitigation:** use a
`fs.watch` (not a setInterval), debounced to 500ms; on a slow filesystem,
fall back to 2s polling (this is what `krakenLive.ts` already does).

---

## 4. Pillar 4 — CSV / batch fan-out primitive

### 4.1 Why

Codex CLI's `spawn_agents_on_csv` is the killer feature for "audit every file
of type X" workloads. Kraken has the underlying machinery (worktree per writer,
parallel wave selection, scope-overlap check) but no user-facing primitive.
The fix is small and high-ROI.

### 4.2 Phases

#### F4.1 — `kraken_spawn_on_csv` tool

- **New files:**
  - `src/cli/tools/krakenCsvFanout.ts` — implements the tool
  - `src/cli/tools/krakenCsvFanout.test.ts`
- **Modified files:**
  - `src/cli/tools/taskTool.ts` — register the new tool alongside `task` (it's a sibling,
    not a replacement)
  - `src/cli/toolRegistry.ts` — wire the registration
- **Tool contract:**
  ```ts
  input: {
    csv_path: string,         // absolute or cwd-relative
    id_column: string,        // e.g. "path"
    output_csv_path: string,
    output_schema: ZodSchema, // per-row schema
    instruction_template: string, // supports {column} placeholders
    agent_kind: 'explore' | 'verify' | 'general',  // default 'verify' (read-mostly default)
    scope_template?: string,  // optional, applied per row to scope the work
    max_concurrency?: number, // default = ZELARI_KRAKEN_MAX_PARALLEL
    max_runtime_seconds?: number,
  }
  output: { rows: <parsed-json>[], totalRows, completedRows, erroredRows }
  ```
- **Acceptance:**
  - Each row spawns one tentacle; concurrency capped at `ZELARI_KRAKEN_MAX_PARALLEL`.
  - Each tentacle has the row substituted into `instruction_template` (handlebars-light: `{col}`).
  - Per-tentacle scope (when `scope_template` given) is fed to the scope-overlap check; if any
    pair overlaps, the executor refuses and surfaces the conflict (consistent with our safety stance).
  - Results are appended to `output_csv_path` atomically (write to `.tmp`, rename).
  - On row failure: row's `status` = `error`, `last_error` populated; the run continues.
  - Per-row tool budget defaults to `ZELARI_KRAKEN_NODE_TIMEOUT_MS` (300s), per-row runtime
    defaults to `ZELARI_KRAKEN_CSV_ROW_TIMEOUT_S` (900s).

#### F4.2 — Slash handler `/kraken fanout`

- **Modified files:**
  - `src/cli/slashHandlers/krakenGraph.ts` — new `handleKrakenFanout(ctx, args)` registered
    alongside `handleKrakenGraph`
  - `src/cli/headless.ts` and `src/cli/runHeadless.ts` — `--kraken-fanout=<json>` flag
- **Acceptance:**
  - `/kraken fanout review.csv --col path --out results.csv --instruction "review {path}"`
    runs the tool and prints the result table to the transcript.

---

## 5. Cross-cutting

### C1 — Reusable knowledge save (skill auto-promote)

**What:** after a converged graph, if a writer+verify pair was rejected N times and
eventually converged, the convergence pattern (acceptance + verify prompt + a one-line
summary) is proposed as a skill. `/promote-skill` already exists; we add an
auto-suggest at the end of a converged run.

- **New files:** `src/cli/kraken/skillSuggest.ts`
- **Acceptance:** the suggestion is *only* offered (not auto-applied); user accepts via `/promote-skill <id>`.

### C2 — Cross-session messaging

**What:** Omp's "agents talking to each other". Two tentacles in the same graph can
exchange a short message via `await sendTo(peerId, { text })` (in the script runtime).

- **New files:** `packages/core/src/kraken/runtime/messaging.ts`
- **Acceptance:** tested in F1.4; budget-capped to N messages per tentacle per turn.

### C3 — Graph checkpoint / fork / rewind

**What:** mid-graph snapshot. The user can `/kraken fork <nodeId>` to split a run,
`/kraken rewind <nodeId>` to restart from a node.

- **New files:** `src/cli/kraken/checkpoint.ts` (graph-level, not workspace-level —
  distinct from the existing `src/cli/checkpoint/` which is git plumbing)
- **Acceptance:** snapshot is a JSON of `{ graphId, goal, currentGraphState, completedNodeResults }`;
  the runtime can resume from any node.

---

## 6. Cross-cutting infra: model routing upgrades

### F5.1 — Per-persona model resolution (already half-built, finish it)

- **Modified files:**
  - `src/cli/tools/krakenModel.ts` — extend `resolveKrakenSubModel` to also resolve
    for `spec-reviewer` and `conformance` kinds (currently the cheap-auto-pick only
    fires for `explore`/`verify`)
  - Add `ZELARI_KRAKEN_SPEC_MODEL`, `ZELARI_KRAKEN_CONFORMANCE_MODEL`, `ZELARI_KRAKEN_ORACLE_MODEL` env
- **Acceptance:** all 3 personas default to a cheap model if one is discoverable.

### F5.2 — Per-provider sub-model profile (à la Amp's routing)

- **New files:** `src/cli/kraken/routing.ts` — declarative per-provider routing
  (e.g. "for Grok: explore→grok-3-mini, verify→grok-3-mini, general→grok-4, spec→grok-4, conformance→grok-3-mini")
- **Modified files:** `src/cli/kraken/routing.test.ts`
- **Acceptance:** providers can ship their own `routing.json` in their package; the routing
  resolver reads it. Default routing = "explore/verify/spec/conformance → cheap, general → flagship".

---

## 7. Sequencing & dependencies

```
F1.1 (runtime SDK)  ──┐
                      ├──► F1.2 (planner emits script) ──► F1.3 (executor runs script) ──► F1.4 (loops)
F2.1 (persona registry) ──► F2.2 (spec) ──► F2.3 (conformance) ──► F2.4 (planner prompt)        ──┐
                                                                                                  ├──► F1.5 + F2.5
F3.1 (workbench writer) ──► F3.2 (TUI live view) ──► F3.3 (HTML render)                            ──┤
                                                                                                  ├──► C1, C2, C3
F4.1 (CSV tool) ──► F4.2 (slash handler)                                                           ──┘
```

**Suggested execution order (1 slice = 1 PR-sized chunk):**

1. **Slice A** — F1.1 + F1.3 (runtime + executor adapter; planner can stay JSON for now)
2. **Slice B** — F1.2 (planner emits script; back-compat fallback to JSON)
3. **Slice C** — F2.1 + F2.2 (persona registry + spec-reviewer)
4. **Slice D** — F2.3 (conformance; ties into F1.3 because conformance runs after convergence)
5. **Slice E** — F3.1 + F3.2 (workbench writer + TUI live view)
6. **Slice F** — F1.4 (loops / branching)
7. **Slice G** — F4.1 + F4.2 (CSV fan-out)
8. **Slice H** — F2.4 (planner prompt update to use 3 personas)
9. **Slice I** — F5.1 + F5.2 (model routing)
10. **Slice J** — C1, C2, C3 (skill auto-suggest, cross-session messaging, fork/rewind)
11. **Slice K** — F3.3 (HTML render, optional UX sweetener)

Each slice = at most one week of focused work + a checkpoint PR.

---

## 8. Risk register

| Risk | Severity | Mitigation |
|---|---|---|
| LLM emits unsafe `plan.ts` (reads `process.env`, infinite loop) | High | Capability-based SDK; tests assert `fs`/`process` are inaccessible outside the SDK; runtime counts every `tentacle()` call against `MAX_TENTACLES`. |
| Spec council 3× LLM cost per writer | High | Auto-route spec/conformance to cheap models (F5.1); allow user opt-out via `ZELARI_KRAKEN_COUNCIL=verify-only`. |
| Workbench file thrashes under fast event bursts | Medium | Debounced `fs.watch`; append-only events list capped at 200 entries; older events archived. |
| CSV fan-out leaks worktrees on cancel | Medium | `runTentacle`'s existing abort-signal path already cleans up; verify with a test that asserts `git worktree list` is empty after Ctrl-C mid-batch. |
| Script planner fallback to JSON loses determinism invariants | Low | The DAG executor's invariants are in `executor.ts`; the script runtime is a *layer on top* that calls into the same primitives. JSON fallback path is the existing one — invariants guaranteed by existing tests. |
| Conformance reviewer needs git diff; we have worktrees, not the parent HEAD | Low | The diff is taken at the worktree level (per-writer); for the *whole* graph we need a pre-run snapshot, which `krakenWorktree.ts` already takes (it has a snapshot-before-merge primitive). |
| LLM planner produces a script that calls `merge` mid-loop | Medium | `merge` is a one-shot per plan; runtime rejects a second `merge()` call with a structured error that the planner can read and self-correct. |
| F1.3 increases wall-clock time vs JSON path | Low | JSON path stays the default for small goals; script is opt-in. A/B benchmarks on the fixture suite will tell us. |

---

## 9. Acceptance criteria for the *whole* roadmap (the "best in category" bar)

After all slices land, Kraken must demonstrate:

1. **Fan-out scale**: a single goal plans and runs ≥ 100 tentacles in one graph, with
   ≤ 12 concurrent (per our safety choice) and ≤ 30 minutes wall-clock for a fixture workload
   that takes Claude Code DW ≥ 5 minutes.
2. **Multi-persona rigor**: for a "ship X with spec.md" goal, every writer is judged by
   `spec-reviewer` + `verify` + `conformance`. A regression in any of the three fails the
   graph (so the user sees the verdict, not a silent pass).
3. **Live observability**: a user can `tail -f .zelari/radio/workbench.md` and see the
   graph progress in real time without touching the TUI.
4. **Batch primitive**: a 500-row CSV review runs in `ceil(500/12) * <per-row cost>` and
   produces a results CSV; the user can resume from row 230 if cancelled.
5. **Reusable knowledge**: a converged graph that hit the same spec 3 times proposes a skill
   that the user can promote; the next graph picks it up automatically.
6. **Backward compat**: the entire v1.29 test suite still passes. Existing users see no
   behavior change unless they set `ZELARI_KRAKEN_PLAN_FORMAT=script` or use a new slash
   command.
7. **Provider-portable**: the same fixture graph runs end-to-end on Grok (OAuth),
   OpenAI-compat, GLM, MiniMax, and DeepSeek with at most a `provider.json` switch.

If we hit all 7, Kraken is the only MIT CLI coding agent that ships (a) safe parallel writes,
(b) spec council, (c) live workbench, (d) batch fan-out, (e) cross-provider LLM. That is a
real category claim, not a marketing one.

---

## 10. Open questions for you (Andrea)

Before I touch any code, I want to lock in 3 decisions:

1. **License posture for the script runtime.** Today Kraken's runtime goes in `@zelari/core`
   (MIT). The plan.ts is user-facing DSL — do we want to keep it MIT, or gate it behind a
   commercial license? My read: MIT, the DSL is just sugar over the existing primitive.
2. **`MAX_TENTACLES` cap.** Default 200 (vs today's `MAX_NODES=24`). Bigger number, but
   safety invariants are per-tentacle, not per-graph — so 200 is fine. Confirm?
3. **Script runtime: in-process `vm` vs subprocess.** `vm` is faster, but shares memory with
   the parent. Subprocess is slower but bulletproof. My read: `vm` with capability-based
   access (no `fs`/`process` outside the SDK). If we ever want user-uploaded plans from a
   registry, we'd revisit. Confirm?

The other 90% of the plan is executable without further input. Dimmi cosa ne pensi,
quali priorità vorresti vedere per prime, e se ci sono use case specifici che vuoi
coprire (es. "deve poter girare su un dataset di 10k file per un audit di sicurezza").
