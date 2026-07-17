# Changelog

All notable changes to Zelari Code are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
- **Drift di versione nella CLI.** `src/cli/main.ts` esportava un letterale
  `VERSION = '1.0.0'` hardcodato, mentre `package.json` era già a `1.0.1`.
  `--version`, il banner dell'app, la splash, la sidebar e il wizard
  mostravano quindi `v1.0.0` dopo la pubblicazione di `1.0.1`. Inoltre il
  self-update check (`updater.ts`) legge correttamente `package.json` via
  `getCurrentVersion()`, quindi confrontava `1.0.1` con l'`1.0.1` del
  registro npm e segnalava "nessun aggiornamento disponibile" — l'utente
  vedeva `v1.0.0` e `/update` non proponeva nulla. `VERSION` ora deriva da
  `package.json` (unica fonte di verità). Stesso trattamento per
  `clientInfo.version` nell'handshake MCP (`src/cli/mcp/mcpClient.ts`,
  era hardcodato a `0.7.9`).
- **DevDependency `@zelari/core` bloccata a `1.0.0`** in `package.json`
  (pin esatto, senza caret). Questo faceva fallire il typecheck del root
  con `TS2305` su tutti i nuovi export del workspace 1.0.1. Aggiornato a
  `1.0.1` (versione corrente del workspace).
- **Sezione duplicata in `AGENTS.MD`**: il blocco auto-curato
  (Tech Stack / Decisions / Conventions / Build / Open Questions) era
  stato accodato una seconda volta durante un run precedente. La copia
  duplicata conteneva inoltre riferimenti stale (`@zelari/core 0.7.0`,
  `esbuild ^0.24.0`, `vitest ^2.1.9`). Rimossa; un futuro run di
  `/council` rigenera correttamente da `package.json`.

## [1.0.1] - 2026-07-06

### Added
- **Rilevamento di stallo della missione zelari.** Il loop `runZelariMission`
  ora riceve dal council il numero di file scritti nello slice
  (`write_file`/`edit_file`) e il verdetto `degraded`. Quando uno slice di
  *implementation* scrive **0 file** per N iterazioni consecutive (default 2,
  configurabile con `ZELARI_MISSION_MAX_STALL`, `0` disabilita) la missione si
  ferma con stato `stalled` e un messaggio azionabile invece di consumare
  l'intero budget di iterazioni su run identici a vuoto. È esattamente il caso
  documentato con composer-2.5: la synthesis dichiara "fatto" ma non produce il
  deliverable → `DEGRADED_RUN` → `completion.ok=false` all'infinito.
- Nuovo stato missione `stalled` in `MissionStatus` e nuova variabile
  d'ambiente `ZELARI_MISSION_MAX_STALL`.

### Changed
- **Prompt di implementation più stringente.** Lo slice di implementation ora
  richiede esplicitamente di creare/modificare i file reali con
  `write_file`/`edit_file` e dichiara che un run che afferma il completamento
  senza scrivere alcun file è un run fallito.
- `dispatchCouncilPromptImpl` e il tipo `SliceRunResult` propagano ora
  `writeCount` e `degraded` verso il loop di missione; nessun cambiamento per il
  percorso `/council` normale. I driver che non riportano `writeCount`
  mantengono il comportamento precedente (nessun rilevamento di stallo).

## [1.0.0] - 2026-07-05

Primo rilascio stabile. Introduce **Zelari-mode** (missioni autonome multi-run),
la **memoria di progetto file-based** e il supporto **prompt in italiano** per il
rilevamento della design-phase.

### Added
- **Zelari-mode — terza modalità della TUI.** `shift+tab` ora cicla `agent → council → zelari`. In modalità zelari un prompt libero diventa un **mission brief** strutturato (intent, stack, deliverable, assunzioni, out-of-scope, slice MVP) e il council gira in loop — design-phase poi implementation per i greenfield — finché `completion.ok` è verde sullo slice MVP o si esaurisce il budget di iterazioni. Comando equivalente `/zelari <prompt>`. Il brief viene mostrato e richiede conferma (`ok`), salvo auto-start con `ZELARI_MISSION_AUTO=1`. Stato persistito in `.zelari/mission-state.json`.
- **Memoria di progetto (file-based, zero dipendenze).** Nuova interfaccia `MemoryBackend` in `@zelari/core` (subpath `@zelari/core/memory`) e implementazione `FileMemoryBackend` nella CLI: log JSONL per-progetto in `.zelari/memory/log.jsonl` con ricerca per keyword. Gli esiti di ogni slice vengono persistiti e re-iniettati nel council come `ragContext` tra le iterazioni (mai l'intero JSONL). Opt-out con `ZELARI_MEMORY=0` (degrada a no-op). Nessun binario nativo, nessun vector store — l'interfaccia è un seam per un futuro backend semantico.
- **Mission classifier + brief** (`classifyMission`, `buildMissionBrief` in `@zelari/core/council`): euristiche pure (IT/EN) per intent `greenfield|extend|fix|redesign`, inferenza stack e slice MVP con budget task.
- **Budget tool dedicato al chairman.** Nuovo `maxToolCallsChairman` in `PureCouncilConfig`: in zelari-mode Lucifero riceve un budget più alto (default 30, `ZELARI_MODE_MAX_TOOLS_LUCIFER`) mentre specialisti e oracle restano sul default condiviso.
- Nuove variabili d'ambiente: `ZELARI_MEMORY`, `ZELARI_MISSION_AUTO`, `ZELARI_MISSION_MAX_ITER`, `ZELARI_MODE_MAX_TOOLS_LUCIFER`.
- ~40 nuovi test unitari (keyword IT, memoria file, mission/brief, loop zelari, parsing `/zelari`).

### Changed
- **`resolveCouncilRunMode` riconosce l'italiano.** `DESIGN_KEYWORDS` include ora `costruisci|crea|progetta|sviluppa|realizza|vetrina|pannello|gestionale|nuovo progetto|da zero|…`; `IMPLEMENTATION_KEYWORDS` include i verbi di fix IT (`correggi|rifattorizza|implementa|…`) e `PLAN_CONTINUE` i termini IT di continuazione. Il sostantivo `sistema` è **volutamente escluso** dai fix per non declassare i greenfield tipo "costruisci un sistema gestionale".
- `dispatchCouncilPromptImpl` restituisce l'esito dello slice (`completionOk`/`ran`/`synthesisText`) e accetta override per-slice (`ragContext`, `runMode`, `maxToolCallsChairman`); nessun cambiamento per il percorso `/council` normale.

### Security
- Risolte le 5 vulnerabilità Dependabot (1 critical, 1 high, 3 moderate) nella catena di **devDependencies** di test/build (`vitest`/`vite`/`vite-node`/`@vitest/mocker`/`esbuild`): bump `vitest` `^2.1.9 → ^4.1.9` ed `esbuild` `^0.24.0 → ^0.25.0`. `npm audit` ora riporta 0 vulnerabilità. Nota: queste dipendenze non venivano comunque pubblicate (il campo `files` include solo `bin`/`dist`/docs), quindi non esponevano gli utenti finali; l'aggiornamento pulisce l'ambiente di sviluppo/CI. Suite invariata: 1127 test verdi su vitest 4.

## [0.7.12] - 2026-07-04

### Fixed
- **Council/agent tool calls falliscono su MiniMax e GLM (`tool result's tool id ... not found (2013)`, HTTP 400).** L'`AgentHarness` accodava il messaggio `role:'tool'` (risultato) al transcript **durante** il delta `tool_call`, ma il messaggio `role:'assistant'` che dichiara quella `tool_calls` solo al `finish` successivo → ordine invalido `[tool, assistant]`. xAI/grok tolleravano l'ordine invertito (match per id a prescindere dalla posizione); MiniMax e GLM validano in modo stretto e rifiutano la richiesta perché il tool result non ha un assistant tool_calls **precedente**. Ora i risultati dei tool vengono bufferizzati durante il turno e scaricati **dopo** il messaggio assistant, dando l'ordine richiesto dallo schema OpenAI: `assistant(tool_calls)` → `tool(result)`. Vale per il percorso normale, la cache anti-duplicati e lo skip di `maxToolCallsPerTurn`. Il fix sblocca ogni provider OpenAI-compatible con validazione stretta, non solo MiniMax/GLM.

### Added
- Test di regressione `core-agentHarness-toolResultOrder` — verifica che l'assistant che dichiara le `tool_calls` preceda sempre i relativi `tool` result (caso singolo e multi-tool nello stesso turno).

## [0.7.11] - 2026-07-04

### Fixed
- **Il model discovery ora rispetta l'endpoint custom.** `discoverModelsForProvider` risolveva il base URL dalla mappa statica `PROVIDER_BASE_URLS`, ignorando l'endpoint impostato con `/provider custom <url>`: dopo aver puntato `openai-compatible` a un gateway di terze parti, `/model refresh`, `/discover`, il picker `/model` e il refresh automatico all'avvio interrogavano comunque l'host di default (di norma con esito 401 → "discovery failed"). Ora la discovery risolve il base URL con la stessa priorità della chat (`resolveBaseUrl`): `options.baseUrl` (test) → endpoint custom persistito (`getCustomEndpoint`) → `OPENAI_BASE_URL` (per `openai-compatible`) → default statico.
- **Default di discovery per `openai-compatible` allineato alla chat.** La discovery usava `https://api.openai.com/v1` mentre la chat (`PROVIDER_ENDPOINTS`) usa `https://api.x.ai/v1`: discovery e chat sondavano host diversi. Ora entrambi partono da `https://api.x.ai/v1`.
- **Endpoint MiniMax corretto** → `https://api.minimax.io/v1` (endpoint internazionale, OpenAI-compatible con `/chat/completions` e `/models`). Prima chat e discovery usavano due host diversi ed entrambi sbagliati (`https://api.MiniMax.chat/v1` e `https://api.minimaxi.chat/v1`), da cui il 401 "invalid api key" sui prompt.
- **Endpoint GLM / Z.AI corretto** → default sul GLM Coding Plan `https://api.z.ai/api/coding/paas/v4` (chat + discovery). Prima la chat puntava a `https://api.z.ai/v1` (404) e la discovery a `https://api.z.ai/api/paas/v4`: host incoerenti. Chi usa l'API pay-per-token può fare `/provider custom https://api.z.ai/api/paas/v4`.
- **Coerenza chat ↔ discovery ↔ keyStore.** I tre punti che definivano i base URL per provider (`PROVIDER_ENDPOINTS`, `PROVIDER_BASE_URLS`, `PROVIDERS[].baseUrl`) erano andati fuori sync per glm/minimax; ora concordano.

### Changed
- Test `v3-U-modelDiscovery` isolati anche rispetto a `provider.json` (`ANATHEMA_PROVIDER_CONFIG_FILE`) e `OPENAI_BASE_URL`, dato che la discovery ora legge l'endpoint custom; nuovi casi per endpoint custom persistito, override `OPENAI_BASE_URL` e precedenza di `options.baseUrl`.
- `docs/GUIDA.md`: nuova sezione "Endpoint OpenAI-compatible custom" con il flusso consigliato; chiarito che non esiste un provider selezionabile `custom` (l'endpoint custom si imposta sul provider attivo).

## [0.7.10] - 2026-07-04

### Highlights
- **Status bar a tutta larghezza**: due gruppi giustificati agli estremi del terminale — identità a sinistra (modalità, provider, modello, cwd), stato del run a destra (timer, coda, sessione). Entrambi i gruppi troncano invece di andare a capo (`wrap="truncate"` + `flexShrink` differenziato), quindi la barra è sempre esattamente una riga: prima su terminali stretti wrappava schiacciando la regione dinamica.
- **Indicatore di lavoro animato**: nuovo `<WorkingIndicator>` (spinner Braille + verbi rotanti thinking/working/reasoning/assembling + puntini animati + tempo trascorso, es. `⠹ thinking... (12s)`). Sostituisce lo statico `⋯ working…` che era **codice morto**: l'early-return della LiveRegion ignorava `busy`, quindi tra il dispatch e il primo token non appariva nulla. Lo spinner compare anche nella status bar accanto al timer durante il run.
- **Picker interattivi per provider e modelli**: `/provider` e `/model` senza argomenti aprono una lista navigabile (`<SelectList>`: ↑/↓ con wrap-around, invio seleziona, esc annulla, ✓ sull'attivo, finestra scorrevole per liste lunghe). La selezione rientra nella pipeline slash normale (`/provider <id>` / `/model <id>`), quindi persistenza e messaggi sono identici al comando digitato. `/model show` e `/provider list` conservano i vecchi output testuali.
- **Discovery modelli cablata davvero**: refresh in background all'avvio quando la cache ha più di 6h (il trigger era documentato ma mai collegato), auto-discovery all'apertura del picker `/model` (con fallback a cache/default se fallisce), nuovo alias `/discover` per `/models refresh`.
- **Fix aggiornamento status bar dopo switch**: `handleProviderSet` passava un `ProviderSpec` invece del `ProviderConfig` allo stato dell'App (il modello mostrato non si aggiornava mai) e `handleModelSet` non aggiornava affatto lo stato.

### Added
- `src/cli/components/Spinner.tsx` (`Spinner` + `WorkingIndicator`, ticker condiviso a 100ms), `src/cli/components/SelectList.tsx` (`windowStart` esportato e testato), `handleProviderPicker`/`handleModelPicker` + `buildModelPickerItems` (pure, testata) in `slashHandlers/provider.ts`.
- Kind parser `provider_picker`/`model_picker`, comandi `/discover`, `/model show`, `/provider list`; `openPicker` in `useSlashDispatch`.
- Test: `cli-picker.test.ts` (10 — item builder + windowing), caso busy della LiveRegion, parser picker/discover.

### Changed
- `StatusBar`: layout space-between a piena larghezza; spinner al posto di `⏱` durante il run; sessione spostata nel gruppo destro.
- `LiveRegion`: prop `elapsedMs` inoltrata dall'App (timer nell'indicatore di lavoro).
- `docs/GUIDA.md`: tabella provider/modello aggiornata (picker, `/discover`, `/model show`, `/provider list`).

### Fixed
- Early-return della `LiveRegion` che rendeva irraggiungibile l'indicatore "working" (ora include `busy`).
- Refresh del `ProviderConfig` nello stato dell'App dopo `/provider <id>` e `/model <nome>`.

## [0.7.9] - 2026-07-04

### Highlights
- **Switch agente/council con `shift+tab`**: i prompt liberi (non-slash) vengono instradati all'agente singolo o alla pipeline council a 6 membri in base alla modalità attiva, mostrata nella status line (`⏵ agent` / `⛬ council`). Stesso percorso di `/council <testo>`.
- **Sidebar destra**: emblema N-THEM in Braille art (griglia punti 2×4 per cella — ~4× più denso dell'ASCII), wordmark + versione + branch, e i file modificati del working tree con `+aggiunte`/`-rimosse` per file (nuovo hook `useGitChanges`: `git status --porcelain` + `diff --numstat` unstaged+staged, polling 4s, re-render solo su snapshot cambiato). Vive nella regione dinamica accanto al blocco input (una colonna full-height non può coesistere con lo scrollback nativo di `<Static>`); auto-nascosta sotto 96 colonne.
- **Status line ridisegnata e spostata SOTTO l'input box**: via token e costo, dentro modalità, provider, modello, sessione, cwd (con `~` per la home) e il **timer di esecuzione** (`⏱ 12s` durante il run, `last 34s` a run concluso — nuovo hook `useExecutionTimer`).
- **Fix banner duplicato**: `<Static>` veniva rimontato quando il `sessionId` arrivava dal bootstrap (key change) e ristampava il banner nello scrollback. Ora la Static non riceve item finché la sessione non esiste → banner stampato esattamente una volta. Rimossa anche la lista skill dal banner (doppione di `/help`).
- **Fix DEP0190 (Node 24)**: tre call-site usavano `spawn(cmd, argsArray, { shell: true })` (args concatenati SENZA escaping). `mcpClient` (spawn MCP server al primo prompt) e `updater` (`npm install -g`) ora costruiscono la command line win32 con quoting esplicito via nuovo helper `utils/cmdline.ts` e passano una stringa singola; `shellResolver` esegue `where bash` senza shell (è un .exe reale).
- **Council run-mode detection** (`implementation` vs `design-phase`): euristiche su keyword + presenza piano (`planDetect.hasWorkspacePlan`), override `ZELARI_COUNCIL_MODE`; banner di modalità nei prompt dei membri (emissioni workspace obbligatorie solo in design-phase) e skip del post-processor complete-design nei run di implementazione. Tier council esplicito lite(3)/full(6) via `ZELARI_COUNCIL_TIER`/`ZELARI_COUNCIL_SIZE` (`councilConfig.ts`).

### Added
- `src/cli/hooks/useGitChanges.ts` (parser numstat/porcelain/rename esportati e testati), `src/cli/hooks/useExecutionTimer.ts`, `src/cli/components/Sidebar.tsx`, `src/cli/utils/paths.ts` (`shortenCwd`), `src/cli/utils/cmdline.ts` (`quoteCmdArg`/`buildCmdLine`), `src/cli/councilConfig.ts`, `src/cli/workspace/planDetect.ts`, `packages/core/src/council/runMode.ts` + `modeBanners.ts`.
- Test: `cli-git-changes` (16), `cli-useExecutionTimer` (4), `cli-cmdline` (6), `cli-councilConfig`, `core-councilRunMode`.
- README: logo ASCII + feature v0.7.9.

### Changed
- `StatusBar`: prop `mode`/`cwd`/`elapsedMs`/`lastMs`; rimossi token e costo dalla UI (il tracking interno resta).
- Banner di avvio: 3 righe (wordmark+versione+provider/model, cwd, hint comandi + shift+tab).
- `tests/unit/cli-updater.test.ts`: asserzione spawn platform-agnostica (stringa win32 / array POSIX).
- `.gitignore`: esclusa `mcps/` (cloni locali di server MCP).

## [0.7.5] - 2026-07-03

### Highlights
- **Fix radice allucinazioni tool nel council**: `getAllTools()` non conteneva NESSUN tool harness (read_file, bash, list_files…) — i membri leggevano "operi su una codebase reale" con zero file tool in AVAILABLE TOOLS e allucinavano `Read`/`Glob`/`list_dir`. Nuovo `harnessToolBridge` nel core: i builtin harness entrano nel catalogo agents con gli schemi JSON derivati dagli zod reali. In più: filtro executable esteso al testo del prompt (v0.7.5 in `buildAgentMessages`), prosa dei prompt module e delle skill resa tool-agnostica, alias "Did you mean" nel ToolRegistry (`Read`→`read_file`, `searchRAG`→`searchDocuments`, ecc.).
- **Tool web**: `fetch_url` (http(s)-only, HTML→testo, timeout 15s, cap 40k char) e `web_search` (DuckDuckGo HTML senza chiave; `TAVILY_API_KEY` per Tavily). Registrati nella CLI (10 builtin) e richiesti dalla skill `research-analyst`.
- **Client MCP stdio minimale**: initialize/tools/list/tools/call via JSON-RPC newline-delimited, zero dipendenze. Config Claude-Desktop-compatibile in `.zelari/mcp.json` o `~/.zelari-code/mcp.json`; tool registrati come `mcp_<server>_<tool>` in entrambi i path (schema JSON del server inoltrato al provider via nuovo campo `ToolDefinition.jsonSchema`). Lazy singleton, warning una-tantum per server rotti, `ZELARI_MCP=0` per disattivare.
- **Loader SKILL.md** (formato condiviso opencode/Hermes/Claude Code): discovery da `.zelari/skills/`, `.claude/skills/`, `.opencode/skills/`, `~/.zelari-code/skills/` — qualunque skill di quegli ecosistemi funziona con `/skill <name>`.
- **`/skill` requiredTools wiring**: dispatchPrompt registra gli stub workspace che la skill dichiara (con mapping `searchRAG`→`searchDocuments`) — prima le skill di planning chiedevano al modello di usare tool assenti dal registry.
- Mappa completa tool/skill/MCP in `docs/TOOLS.md`. +38 test (875 totali).

## [0.7.4] - 2026-07-03

### Highlights
- **Loop council→agente chiuso**: l'agente singolo ora registra lo stub workspace `updateTask` quando esiste un piano (`.zelari/plan.json`), così può marcare i task `in_progress`/`done` passando dal mutex e dalla scrittura atomica invece di editare il JSON a mano. Guideline dedicata nel system prompt (solo quando c'è un piano — zero costo su progetti freschi).
- **`buildZelariReadHint` + "Next task to work on"**: il plan summary ora indica UN task concreto da cui partire (primo `in_progress`, altrimenti per priorità critical>high>medium>low) e il system prompt dell'agente singolo include workspace summary + hint di lettura `.zelari/`.
- **Fix popup browser durante i test**: `runGrokOAuthFlow` apriva SEMPRE il browser reale (`cmd /c start`) — il test "fully mocked" del device flow apriva una tab su auth.x.ai con lo user_code fittizio a ogni `npm test`. Aggiunta `openBrowserImpl` (stessa DI di `fetchImpl`/`sleepImpl`); produzione invariata.
- **Riparato edit automatico corrotto in `useChatTurn.ts`**: il blocco "system prompt + harness + event loop" era duplicato (~218 righe, try/catch rotto, variabili indefinite) da un changeset v0.7.4 applicato a metà. Rimosso il duplicato e ricablato l'intento correttamente.

### Added
- `src/cli/workspace/workspaceSummary.ts`: `buildZelariReadHint()` + blocco "**Next task to work on:**" in `buildPlanSummary()` con `pickNextTask()` (in_progress prima, poi priorità).
- `src/cli/hooks/useChatTurn.ts`: registrazione best-effort di `updateTask` nel tool registry dell'agente singolo quando `buildPlanSummary` trova un piano; `toolList` calcolato dopo la registrazione così il tool compare in "# Available Tools".
- `src/cli/grokOAuth.ts`: opzione `GrokOAuthOptions.openBrowserImpl` per iniettare il browser-launcher.
- `tests/unit/cli-useChatTurn.test.ts`: +2 test (updateTask registrato con piano; workspace registry NON creato senza piano) + mock di `workspaceSummary.js` (i test non scansionano più il cwd reale del repo).

### Fixed
- `tests/unit/cli-workspaceSummary.test.ts`: `describe` di `buildPlanSummary` chiuso troppo presto — i test v0.7.4 erano fuori scope (errore di sintassi esbuild).
- `tests/unit/cli-grokOAuth.test.ts`: il device-flow test ora stubba il browser e verifica che venga aperto `verification_uri_complete` (URL con codice pre-compilato).
- `tests/unit/core-shellTool.test.ts`: timeout vitest dedicato (30s) ai 2 test che spawnano la shell reale — su Windows lo spawn di Git Bash impiega ~12s contro i 5s di default.

## [0.6.2] - 2026-07-02

### Highlights
- **TUI flicker eliminato**: stima dell'altezza delle chat messages corretta per il wrap reale (Box paddingX + message marginLeft = `width-4`), `chatWidth` ricalcolato (`columns - 40` invece di `- 44`), `overflow="hidden"` aggiunto su root/row. `pickVisibleMessages` non lascia più che il transcript cresca oltre il terminale, causa del full-screen repaint che provocava flicker visibile.
- **Tool/agent rendering come CollapsibleToolOutput**: ogni tool invocation ora è un singolo messaggio `role: 'tool'` aggiornato in place (status glyph `⋯`/`✓`/`✗`, summary + expandable body), non più 2-4 loose system lines.
- **Cross-message text duplication fix**: `streamContent` separato da `assistantContent`, bubble finalizzato su `message_end` / `tool start`. Prima il bubble post-tool ridisegnava l'intero turn text.
- **Session resume replay tool come `role: 'tool'`**: non più `[tool_result] undefined → ok`, `tool_execution_end` aggiorna in place via `toolCallId`.
- **CI publish workflow hardened** (v0.6.2 audit): build order, `npm publish` from root, tag/package.json match check, sequential core→CLI publish, smoke test post-bundle, OIDC-only.
- **`@zelari/core` publishability fix** (v0.6.2 audit CRITICAL-1): `moduleResolution: Bundler` → `NodeNext`, 26 import relativi estesi con `.js` (più 2 inline `import()`). Risolto conflitto `ToolContext` re-export tra `agents/tools.ts` e `core/tools/toolTypes.ts`. Senza questo, il package npm pubblicato avrebbe rotto ogni consumer Node.js ESM con `ERR_MODULE_NOT_FOUND`.
- **+9 nuovi test** in `tests/unit/cli-toolDisplay.test.ts` (270 LOC): messageHelpers, dispatchPrompt dup, eventsToMessages replay, pickVisibleMessages wrap.

### Added
- `src/cli/hooks/messageHelpers.ts`: `finalizeStreamingAssistant()` per sigillare il trailing streaming bubble; `TOOL_RESULT_PREVIEW_CHARS=600` + `TOOL_ARGS_PREVIEW_CHARS=120` costanti; `appendToolStart`/`updateToolMessageEnd` con `toolCallId` + result separato.
- `src/cli/components/CollapsibleToolOutput.tsx`: status glyph `⋯`/`✓`/`✗` nella summary.
- `src/cli/app.tsx`: `overflow="hidden"` su root/row.
- `tests/unit/cli-toolDisplay.test.ts`: 9 test unit per il nuovo rendering.
- `package-lock.json`: version sync 0.5.0 → 0.6.2.

### Fixed (post-release audit, agy Gemini 3.5 Flash)
7 finding agy (1 CRITICAL, 3 HIGH, 2 MEDIUM, 1 LOW) tutti verificati e fixati:

- **CRITICAL-1** — `@zelari/core` import relativi SENZA estensione `.js` + `moduleResolution: Bundler` → package npm pubblicato non funzionante per consumer Node.js ESM (`ERR_MODULE_NOT_FOUND`). Fix: switch a `NodeNext`, 26 import `.js`-estesi, risolto conflitto re-export `ToolContext` (rinominato explicit `export type` in `harness/tools/index.ts`).
- **HIGH-2** — `workflow_dispatch` ignorava `tag` input, faceva checkout di `main`. Fix: `ref: ${{ github.event.inputs.tag || github.ref }}` su entrambi i job.
- **HIGH-3** — `publish-cli` e `publish-core` paralleli → CLI pubblicato prima di core. Fix: `needs: publish-core` su `publish-cli`.
- **HIGH-4** — `@zelari/core: "^0.6.2"` permissivo (accetta 0.6.x futuri) per coupled release. Fix: pin esatto `"0.6.2"`.
- **MEDIUM-5** (defer): test suite duplicati (`prepublish` rifà typecheck+build+test). Fuori scope fix attuale.
- **MEDIUM-6** — `package.json` version non validata contro tag. Fix: step `Verify tag matches package.json version` su entrambi i job.
- **LOW-7** — Smoke test post-bundle mancante. Fix: `npm run smoke` step su `publish-cli`.
- **LOW-3 (v0.6.2 tool fix)** — `CompactMessage` interface non estesa con `toolResult`/`toolCallId`/`memberName`/`memberId`. Fix: aggiunti.
- **LOW-4 (v0.6.2 tool fix)** — Status glyph `ok=undefined && durationMs=defined` → `✓` invece di `⋯`. Fix: check diretto.
- **LOW-5 (v0.6.2 tool fix)** — Session resume `tool_execution_end` troncava a 600 char senza `…`. Fix: append `…`.
- **MEDIUM-2 (v0.6.2 tool, false positive scartato)**: agy segnalava rimozione backward compat `toolCall`/`toolResult` event. Verificato: `BrainEvent` type include solo `tool_execution_start`/`tool_execution_end`, non i nomi legacy.

### Changed
- `packages/core/tsconfig.json`: `module: ESNext + moduleResolution: Bundler` → `module: NodeNext + moduleResolution: NodeNext`.
- `packages/core/src/**`: 26 import relativi `.js`-estesi (script automatico).
- `packages/core/src/harness/tools/index.ts`: `export *` rimosso per `toolTypes.js` (conflitto `ToolContext` re-export); ora `export type` esplicito.
- `package.json`: `@zelari/core: "*"` → `"0.6.2"` (pin esatto per coupled release).
- `.github/workflows/publish.yml`: build order, sequential core→CLI, version check, smoke test, dispatch tag handling.

Test: 771 → 771 (0 nuovi, ma 1 regression per HIGH-1 transcript blank in toolDisplay.test.ts).

## [0.6.0] - 2026-07-02

### Highlights
- **Lucifero chairman reale**: il chairman della council (Lucifero) ora genera una sintesi effettiva basata sugli output dei 5 specialisti + Minosse, con streaming typewriter, tool calls abilitate e fallback robusto in caso di errore LLM. Sostituisce lo stub che produceva solo `[Chairman synthesis for: ...]`. **No more 5 loose threads — the council now has a single, reasoned final answer.**
- **Visible reasoning per Lucifero**: gratis via il pattern `memberId`/`memberName` propagato in v0.5.0. La CLI mostra `· Lucifero` (in viola) nell'header del messaggio chairman, allineato agli altri 5 specialisti.
- **7 nuovi test E2E** in `tests/unit/council-chairman.test.ts` che coprono: presenza di `memberId="lucifer"`, almeno 1 `message_delta` con chairman ID, `member_cost.errored=false` su successo, backward compat con `councilSize: 3` (no chairman), gestione errore LLM chairman.
- **ADR-0006** documenta la decisione di rendere Lucifero reale in v0.6.0 invece di v0.5.0 (scope creep evitato) e le alternative valutate (graceful fallback vs hard fail).

### Added
- `packages/core/src/agents/councilApi.ts`: loop chairman reale (~110 righe) basato su `AgentHarness`, con `buildAgentMessages(chairman, userMessage, agentOutputs, ...)`, streaming `message_delta` via `onSynthesisChunk`, error detection su `event.severity !== 'cancelled'`, fallback stringa `[Chairman synthesis failed: <reason>]` se LLM chairman fallisce.
- `tests/unit/council-chairman.test.ts`: 7 test E2E con mock provider.
- `docs/plans/2026-07-02-v0-6-0-roadmap.md`: piano v0.6.0 (Fase 0 = chairman reale, Fase 1+ = slice future).
- `docs/decisions/0006-lucifero-chairman-real.md`: ADR con contesto, decisione, alternative, conseguenze.
- `package.json`: `pretest` script che rebuilda `@zelari/core` prima dei test (previene dist vecchio).

### Fixed (post-release audit, agy Gemini 3.5 Flash)
4 bug runtime trovati dal workflow gate agy audit, tutti fixati con regression test:

- **HIGH-1** — Il `catch` del chairman loop sovrascriveva `fullText` con `"Error: ..."`, impedendo alla fallback string `[Chairman synthesis failed: ...]` di renderizzare mai (perché `fullText.length > 0` rendeva falso il check). Fix: `catch` ora salva l'errore in `lastErrorMessage` separato, lasciando `fullText` intatto.
- **HIGH-2** — `openaiCompatibleProvider` usava `config.signal` (chiuso nello scope del factory, tipicamente `undefined`) invece di `params.signal` (segnale per-call dell'AgentHarness). Risultato: `cancel()` non abortiva l'HTTP request. Fix: `signal: params.signal`.
- **HIGH-3** — `openaiCompatibleProvider` usava `config.model` invece di `params.model`, rompendo silenziosamente la config `agentModels` (tutti i council member finivano sul modello di default). Fix: `body.model: params.model`.
- **HIGH-4** — I loop specialist e oracle NON controllavano `event.type === 'error'`, quindi se AgentHarness convertiva un errore di rete in un BrainErrorEvent (severity='recoverable'), `errored` restava `false` e il fallimento veniva loggato come successo nel `member_cost`. Fix: aggiunto check su entrambi i loop.

Test: 759 → 761 (+2 regression: fallback esatto chairman, errored specialist su error event).

### Changed
- Version bump `0.5.0` → `0.6.0` in `package.json` (root), `packages/core/package.json`, `src/cli/main.ts`, `src/cli/wizard/index.tsx`, `README.md`.

### Deferred to v0.6.1
- **Grounding helper**: aggiungerebbe 1 chiamata LLM extra + scoring fonti. Rimandato per non bloware lo scope di v0.6.0 (rilascio atomico chairman).
- Flag `--no-chairman` per opt-out: non necessario finché utenti non lo chiedono.

## [0.5.0] - 2026-07-02

Fase 4 of the v0.5.0 roadmap: stable release. The CLI, the
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