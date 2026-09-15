# ADR-0033 - Anchored edit: file-level snapshot, exact apply, structured error

Status: accepted (implemented - see the status table and the 2026-09-12 addendum)
Date: 2026-08-30

Relations: extends ADR-0016/0021/0024 (spine), ADR-0022 (profiles), ADR-0023/0025/0027 (strict done);
replaces the best-effort behavior of `edit_file`/`apply_diff` on the Kraken model surface.

## Context (verified on disk)

- `read_file` (`packages/core/src/core/tools/builtin/filesystem.ts`): no hash/snapshot in the result - the model has no way yet to declare "I am writing on the version I read".
- `edit_file` (same file): oldString/newString, no snapshot, no-match returned in prose. The LF/CRLF retry (`replaceFileString`) is deterministic and position-preserving - it stays.
- `apply_diff` (`packages/core/src/core/tools/builtin/diff.ts`): atomic, but **relocating by default**: hunks with "drifted" line numbers are relocated via context matching. `fuzzyMatch` (whitespace tolerance) is already opt-in.
- Three write surfaces toward the model (`write_file`, `edit_file`, `apply_diff`); `write_file` overwrites existing files without guards.
- Hook seam already present: `ToolRegistry.setLifecycleHooks` + `packages/core/src/core/hooks/`.
- Reusable AST gate: `parseFileSymbolsDiag` (`src/cli/ast/engine.ts`) already discriminates `parse-error`, `unsupported-extension`, `typescript-unavailable`.
- In-house measurement: `eval/` + `eval:measured` + `evidence:report` (package.json).
- Strict-done: `strictDoneEnabled('kraken')` is already default ON (ADR-0027, opt-out `ZELARI_STRICT_DONE=0`); but the `general -> verify` gate in the task tool is still a textual hint (`verifyHintForGeneral`, soft).

## Decision - three non-negotiable constraints

1. **FILE-LEVEL SNAPSHOT, DAY 1.** A single `snapshotId` per read: `sha256(full file content).slice(0,16)` (hex), computed runtime-side and returned in the `read_file` result. No per-line hashing: optional follow-up only if the bench shows the cheap model cannot point at the region without it.
2. **ZERO RELOCATE IN THE DEFAULT ENGINE.** Exact match on the region, always. No fuzzy tool in the Kraken v1 catalog; "relocate behind a flag" is rejected. Rule: the engine may normalize bytes (LF/CRLF), **never move the region**. The tests currently certifying relocation are flipped into reject-tests.
3. **STRUCTURED ERROR IS A DELIVERABLE OF POINT 1.** Day-1 Zod schema on every failure path; no prose rejects.

## Protocol

- Do not write what was not read (with hash): `edit` requires `snapshotId`; whole-file `write_file` only for new files (existing file -> `file_exists` reject; the guard lands with the catalog switch t77 to avoid breaking legacy callers mid-slice - but the schema defines `file_exists` from day 1).
- Model surface: **one write tool (`edit`)** + a restricted `write_file`. `edit_file`/`apply_diff` remain exported for a deprecation cycle but leave the default Kraken catalog (t77, ~15 sites).
- Single engine, two gates in series:
  1. `expectedHash !== hash(current content)` -> `stale_snapshot`, NO apply.
  2. exact region match (only tolerance: deterministic LF/CRLF normalization) -> otherwise `hunk_mismatch` + `minimalDiff`, no write.
- `WriteReject` schema (day 1):
  ```
  { ok: false,
    status: 'stale_snapshot' | 'hunk_mismatch' | 'parse_error' | 'file_exists',
    path: string,
    expectedHash?: string, actualHash?: string,
    span?: { startLine: number, endLine: number },
    minimalDiff: string,          // short unified, the conflict only
    next: { action: 're-read', path: string } }   // machine action, not an essay
  ```
- Post-apply AST gate via `PostToolUse` hook (same seam as the done-gate): TS/JS -> `parseFileSymbolsDiag`; `parse-error` -> automatic revert + `parse_error`; Python -> ruff; other languages/missing backend -> `ast: unavailable` LOUD in the result. Never silence, never fake pass.
- Spine events `file.read` / `file.applied` / `file.rejected` (envelope, replay-tolerant). `SESSION_SCHEMA_VERSION` stays 1 only if the kind enum is open; if closed -> bump with tolerant replay (to confirm in t75).
- **COMPILED DONE, BOUND CO-RELEASE:** `general -> verify` forced by the runtime (not a hint), rework = 1 same worktree/acceptance[], exit 4 by default with no flag to remember. Anchored edit without compiled done = a writer lying about finished; done on a relocating apply = a judge on a dirty disk. They land together or they do not land.

## Measurement gate (KPI)

`eval:measured`, same cheap model, 3 runs, 200 TS/Python patches, baseline = current behavior.
First-shot pass rate, tokens, corruptions. If the delta is not positive, the ADR is wrong.
Comparative review scores remain prioritization, not KPI.

## Consequences

**Positive:** clean rejects; optimistic locking between tentacles via hash; leaner catalog/prefix; provable done on a clean disk.
**Negative:** more rejects -> more re-reads (mitigated by `next` + `minimalDiff`); lower short-term pass rate on drifted contexts (accepted: clean failure > success on the wrong spot); breaking for legacy profiles (one deprecation cycle).

## Rejected alternatives

Per-line hashing at day 1 - relocate behind a flag - whole `expectedContent` instead of the hash - a fourth patch format.

## Implementation (status)

| Task | Content | Status |
|---|---|---|
| t72 | `WriteReject` zod + `snapshotId` in `read_file` | landed (2.24.0) |
| t73 | single engine (hash gate -> exact), `edit` tool | landed (2.24.0) |
| t74 | kill relocate in `apply_diff` + `minimalDiff`, flipped tests | landed (2.24.0) |
| t75 | spine events `file.read/applied/rejected` | landed (`c7be1e0`) |
| t76 | write `PostToolUse`: AST gate + auto-revert, loud skip | landed (`c7be1e0`) |
| t77 | Kraken catalog: one write tool (+ `file_exists` guard on `write_file`) | landed (`c7be1e0`) |
| t78 | compiled done: hard `general->verify`, rework = 1, exit 4 | landed (2.24.0) |
| t79 | bench: 200 patches, cheap model, 3 runs, raw JSON | landed (`daa8758`, `npm run edit:bench`) |

## Addendum (2026-09-12) — compiled done landed; the soft hint removed

t78 shipped in 2.24.0: the `task` tool runs an unconditional runtime chain
(`runAutoVerifyAfterGeneral` in `src/cli/tools/taskTool.ts`) after every
successful `general` — same acceptance[] and tree; FAIL gets at most one
rework round; the debt clears ONLY on a parseable verify PASS; a crash in the
chain leaves the debt open (never silent). Enforcement differs by surface BY
DESIGN: headless `runOneTurn` closes the turn blocked with **exit 4**
(opt-out `ZELARI_STRICT_DONE=0`), while the TUI surfaces a "turn is NOT
verified-complete" system message (no process exit).

Residual soft artifacts removed on 2026-09-12 as redundant: the
`verifyHintForGeneral` footer + its call and unit test, the stale soft-gate
docstring in taskTool, the playbook line and the GUIDA paragraph advertising
the footer. Kept for telemetry compatibility: the radio event kind `verify_hint`
(a successful `general` still logs that kind — legacy label, see
`src/cli/tools/krakenRadio.ts`).

## Out of scope (separate ADRs, same seams)

Injected LSP diagnostics on every apply (seam = hook t76) - prefix/fan-out cache (`cacheReuseExpected`, public hit-rate) - desktop spine-projection.