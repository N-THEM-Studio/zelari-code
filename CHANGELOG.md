# Changelog

All notable changes to Zelari Code are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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