# Changelog

All notable changes to Zelari Code are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

Fase 1 + Fase 2 of the v0.5.0 roadmap: monorepo extraction of
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

Fase 0 of v0.5.0 roadmap: address the two LOW-severity findings left over from the v0.4.3 audit, complete the streaming flicker fix that was only half-implemented in commit 5e0f698.

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