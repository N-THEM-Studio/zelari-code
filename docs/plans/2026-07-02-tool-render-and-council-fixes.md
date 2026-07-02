# Tool rendering + council/harness fixes (v0.7.x)

**Status:** PROPOSED — not started. Approved by: _(pending)_
**Source:** live-test transcript (2026-07-02) after the v0.7.0 static-scrollback TUI landed.

Observed in the test session:

1. `/council` dies with `HTTP 400 "Duplicate function definition provided: createPhase"` (×3, one per specialist), then the AGENTS.MD hook runs anyway and reports "5 sections changed".
2. A long agentic turn (GC-di-V8 prompt) fires the **same** `read_file`/`cat` on the same file 5+ times, then the turn ends with **no final assistant answer**.
3. Tool boxes render terribly: full-terminal-width borders with inconsistent widths per box, raw JSON envelopes with escaped `\n` inside, and summary lines that are raw JSON args truncated mid-string.

---

## A. Functional errors

### A1 — `/council` HTTP 400: duplicate tools in the request  (CRITICAL, root cause found)

`getAllTools()` (`packages/core/src/agents/tools.ts:192`) returns
`[..._allTools, ..._workspaceStubs]` **without dedup**. `_allTools`
already contains the core planner tools (`createPhase`, `addIdea`,
`createTask`, … from `CORE_TOOL_DEFINITIONS`), and the CLI council path
(`dispatchCouncilPromptImpl` → `setWorkspaceStubs(createWorkspaceStubs(ctx))`)
registers workspace stubs with the **same names**. `getProviderTools()`
(`toolSchemas.ts:231`) filters by name with `.includes()` and keeps
**both copies**, so the `tools` array sent to xAI contains `createPhase`
twice → HTTP 400 for every member whose role declares planner tools
(Caronte/Nettuno declare `createTask, createPhase`; the chairman declares
all seven — matches the 3 errors seen).

**Fix:** dedupe by name in `getAllTools()`, workspace stubs winning over
builtins — consistent with `rebuildIndex()` where the `Map` already lets
stubs shadow builtins. One-liner:
```ts
export function getAllTools(): EnhancedToolDefinition[] {
  const map = new Map([..._allTools, ..._workspaceStubs].map(t => [t.name, t]));
  return [...map.values()];
}
```
**Tests:** unit — after `setWorkspaceStubs` with an overlapping name,
`getAllTools()` has unique names and the stub version; `getProviderTools()`
returns exactly one entry per requested name. Regression test naming the
xAI error.

### A2 — turn ends with no final answer + identical tool calls repeated  (HIGH)

Two interacting harness behaviors (`packages/core/src/core/AgentHarness.ts`):

- The observe→reason loop is capped at `MAX_TOOL_LOOP_ITERATIONS = 12`
  (`AgentHarness.ts:307`). When the cap (or `maxToolCallsPerTurn`) is hit,
  the run just **stops** — no closing provider call, so the user gets tool
  noise and no answer. That matches the transcript tail (last event is a
  `bash` result, then silence).
- Nothing stops the model from re-issuing the **identical** call
  (`read_file` same path ×3, `cat` same file ×3 in the transcript), burning
  the iteration budget.

**Fix (three parts):**
1. **Final-answer guarantee:** when the loop exits due to the iteration cap
   or tool-call limit, make ONE more provider call with `tools` omitted and
   a synthetic system nudge ("tool budget exhausted — answer now with what
   you have"), so every turn ends with assistant text.
2. **Duplicate-call short-circuit:** keep a per-turn map of
   `hash(toolName + canonicalized args) → result`. On a repeat, skip
   execution and feed back the cached result prefixed with
   `[duplicate call — result repeated; do not call this tool again with the
   same arguments]`. Emit the start/end events (flagged) so the UI shows
   `↩ repeated` instead of a fresh box.
3. **Budget for single-prompt turns:** `dispatchPrompt` (`useChatTurn.ts`)
   currently sets NO `maxToolCallsPerTurn` (council uses 5). Set a sane
   default (e.g. 25, env-overridable `ZELARI_MAX_TOOL_CALLS`) so a flailing
   model can't loop for 12 full iterations of junk.

**Tests:** harness unit — cap-hit yields a final no-tools provider call;
duplicate args short-circuit executes once; events flagged; budget default
applied in dispatchPrompt.

### A3 — AGENTS.MD hook runs after a failed council  (MEDIUM)

`dispatchCouncilPromptImpl`'s `finally` runs `runPostCouncilHook`
unconditionally: in the test, all members errored (A1) yet the hook
"updated 5 sections" — auto-writing AGENTS.MD from a run that produced
nothing (and dirtying the working tree). **Fix:** track
`fatalErrors`/`membersCompleted` while iterating events; run the hook only
if at least one member completed and the chairman produced output.
**Tests:** hook skipped on all-error run; still runs on success.

### A4 — council errors are anonymous and repetitive  (LOW)

Three identical `[error] HTTP 400 …` lines with no member attribution.
**Fix:** prefix errors with the member name when the event carries
`memberName` (`[error · Caronte] …`), and after N (=2) identical
consecutive provider errors, abort the remaining members with a single
`[council aborted: repeated provider error]` line instead of grinding
through every specialist.

---

## B. Visualization of agent work

(Complements Phase 3 of `2026-07-02-static-scrollback-tui.md` — these
formatters ARE that plan's "finalize policy"; land them as pure functions
usable by both the current renderer and the Static one.)

### B1 — per-tool result formatter (kill the raw JSON envelope)

New pure module `src/cli/components/toolFormat.ts`:
`formatToolResult(toolName, resultJson) → { lines: string[], meta?: string }`
- `bash` → real (unescaped) `stdout` lines; append `stderr` (dimmed) and
  `exit N` only when non-zero/non-empty.
- `read_file` → the `content` field with real newlines.
- `write_file`/`edit_file` → one line: `wrote 10.3 KB → path` (no box).
- `list_files` → `N entries in <dir>` + first ~10 names, comma-joined.
- unknown tool / unparseable JSON → current raw fallback.
Truncate by **lines** (default 8, `ZELARI_TOOL_OUTPUT_LINES`) with
`… (+K lines)` tail, replacing the 600-char `TOOL_RESULT_PREVIEW_CHARS`
mid-string cut.

### B2 — per-tool summary line (kill raw-JSON args)

`formatToolSummary(toolName, args) → string`:
- `bash` → the `command` string; `read_file`/`write_file`/`edit_file` →
  path relative to cwd; `list_files` → dir + depth; `grep_content` →
  pattern + path. Fallback: current JSON preview.
Truncate at the available column width (measured, not `slice(0,120)`), so
summaries never cut mid-JSON-string like
`{"path":"…","content":"Scrivi una spiegazione estremamente det`.

### B3 — box geometry

Bordered boxes currently have no `width`, so Ink stretches each to its
longest line → the mixed-width wall of boxes in the transcript. Fix:
`width = min(terminalWidth - 6, 100)` on the tool-body Box, and drop the
border entirely for one-line results (write_file/edit_file success) — a
single `✓ [write_file] wrote 10.3 KB → prompt_lungo_gc_v8.md (9ms)` line.

**Tests (B1–B3):** pure-function unit tests per tool type (escaped `\n` →
real lines, stderr/exit rendering, line-based truncation, width clamp,
relative-path summaries); ink-testing-library snapshot for the one-line
vs boxed variants.

---

## C. Known issues to note (not blocking, document or defer)

- **bash tool on Windows quoting:** `echo "---"` prints the literal quotes
  and `\r\n` shows up in stdout (`"---" \r`) — the "bash" tool is evidently
  executing via cmd/PowerShell semantics on win32. Investigate
  `@zelari/core/harness/tools/builtin/shell` and either route through Git
  Bash when available or rename/document the tool as `shell` with
  platform-accurate system-prompt guidance (the model writes POSIX because
  the tool is called "bash").
- **`/model default-grok`:** the stored grok model id came from discovery;
  if xAI rejects it after the A-fixes land, surface a clearer error and
  suggest `/models` + `/model grok-4`.

---

## Order of work & sizing

| Step | Item | Size | Risk |
|---|---|---|---|
| 1 | A1 dedupe (unblocks `/council` entirely) | XS | none |
| 2 | A3 hook gating + A4 error attribution | S | low |
| 3 | B1+B2+B3 formatters (pure fns + wire-in) | M | low — display only |
| 4 | A2 harness: final-answer guarantee + dup short-circuit + budget | M | medium — core loop, needs careful tests |
| 5 | C investigation (shell on win32) | S | — |

Steps 1–3 can ship as v0.7.1 immediately; step 4 touches
`@zelari/core` AgentHarness and deserves its own commit + full-suite run.
Full `vitest run` + manual smoke (the same GC-di-V8 prompt and
`/council confronta due approcci…`) after each step.
