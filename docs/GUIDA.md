# Zelari Code — User Guide

> **2.30.0**
> Multi-agent coding CLI with TUI (Ink + React), **Zelari Desktop** (Tauri 2), 6-role council, **kraken** super-agent, **zelari** missions, slash commands, MCP, SSH and provider-agnostic LLMs (Grok / ChatGPT / Anthropic OAuth).
> Product: **[Anathema Studio](https://anathema-studio.com/)** · license **Apache-2.0**.

---

## Table of contents

1. [What is Zelari Code](#what-is-zelari-code)
2. [Prerequisites](#prerequisites)
3. [Installation](#installation)
4. [First run and wizard](#first-run-and-wizard)
5. [TUI interface](#tui-interface)
6. [kraken, council and zelari modes](#kraken-council-and-zelari-modes)
7. [Terminal commands (flags)](#terminal-commands-flags)
8. [Headless mode (CI/scripts)](#headless-mode-ciscripts)
9. [Zelari Desktop](#zelari-desktop)
10. [Slash commands](#slash-commands)
11. [Providers and authentication](#providers-and-authentication)
12. [Skills](#skills)
13. [Council (multi-agent)](#council-multi-agent)
14. [Workspace `.zelari/`](#workspace-zelari)
15. [MCP (Model Context Protocol)](#mcp-model-context-protocol)
16. [SSH (deploy / monitor)](#ssh-deploy--monitor)
17. [Sessions and branches](#sessions-and-branches)
17a. [Host, Profile and Phase (2.0)](#host-profile-and-phase-20)
17b. [Session spine 2.0 (canonical)](#session-spine-20-canonical)
17c. [Deterministic verification, Strict Done and Verifier LLM (2.0)](#deterministic-verification-strict-done-and-verifier-llm-20)
18. [Available tools](#available-tools)
19. [Advanced capabilities and 1.26–1.34 news](#advanced-capabilities-and-126134-news)
19a. [What's new in 2.29–2.30 (after your first PASS)](#whats-new-in-229230-after-your-first-pass)
20. [Configuration files](#configuration-files)
21. [Environment variables](#environment-variables)
22. [Self-update](#self-update)
23. [Development](#development)
24. [Troubleshooting](#troubleshooting)

---

## What is Zelari Code

**Zelari Code** is an open-source (Apache-2.0) terminal coding agent by **[Anathema Studio](https://anathema-studio.com/)**. Product page: [anathema-studio.com/zelari-code](https://anathema-studio.com/zelari-code). It provides:

- A rich **TUI** with native scrollback, git sidebar and execution timer
- A **kraken** super-agent (default; alias `agent`/`single`) with `task` tentacles and **Kraken Graph**
- A 6-member **council** (Caronte, Nettuno, Gerione, Plutone, Minosse, Lucifero)
- Autonomous **zelari** missions (design@council → build@kraken)
- **26 built-in skills** + custom skills in `SKILL.md` format
- Project persistence in **`.zelari/`** and auto-curation of **`AGENTS.MD`**
- **MCP** support, **SSH targets**, **folder trust**, **lifecycle hooks**, **headless**, **Zelari Desktop**, **Companion Android** and **self-update**

The shared runtime is published as the npm package [`@zelari/core`](https://www.npmjs.com/package/@zelari/core) (Apache-2.0).

---

## Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| **Node.js** | **≥ 24 LTS** | CI only tests Node 24; Node 20 was dropped from the matrix (the dependency tree requires it). |
| **npm** | **≥ 11.7** | Needed to reproduce the workspace lockfile; use the version pinned by `packageManager`. |
| **OS** | Linux, macOS, Windows 10/11 | Windows requires Git Bash (auto-detected). |
| **Account + API key** | 1 of: xAI Grok, ChatGPT, Anthropic, OpenAI-compatible, GLM/Z.AI, MiniMax, DeepSeek | OAuth: `/login grok`, `/login chatgpt`, `/login anthropic`. |

### Optional dependencies (advanced capabilities)

The CLI works without these — a tool is skipped automatically when its dependency is missing. You only need them to use the specific tool group.

| Tool group | Dependency | Notes |
|---|---|---|
| `lsp_*` | Language server on PATH (`typescript-language-server`, `pyright-langserver`, …) | five tools: `lsp_definition`, `lsp_references`, `lsp_hover`, `lsp_symbols`, `lsp_rename` |
| `ast_*` | *(none)* | built-in TypeScript Compiler API — `ast_outline`, `ast_find_symbol` |
| `semantic_search` | local embedding model (default `Xenova/all-MiniLM-L6-v2` via `@xenova/transformers`) | downloaded on first use, ~25 MB |
| `browser_check` | Playwright + chromium (`npx playwright install chromium`) | ~150 MB one-time |
| diagnostics loop | `eslint` and/or `ruff` on PATH (project-local preferred) | post-edit compile/lint feedback |

Global disable: `ZELARI_LSP=0`, `ZELARI_AST=0`, `ZELARI_SEMANTIC=0`, `ZELARI_BROWSER=0`, `ZELARI_DIAGNOSTICS=0`.

## Installation

### Global install (CLI — main product)

```bash
npm install -g zelari-code
zelari-code --version
```

### Zelari Desktop (optional)

Installers from [GitHub Releases](https://github.com/N-THEM-Studio/zelari-code/releases) do **not** install the global CLI. After the installer (or in dev):

1. Node.js ≥ 24 on PATH
2. `npm install -g zelari-code` (or **Settings → Update CLI** in Desktop)
3. API key in Settings → Provider

See [Zelari Desktop](#zelari-desktop) and [`apps/desktop/README.md`](../apps/desktop/README.md).

### Windows: `zelari-code` not found

After `npm install -g`, add the npm prefix to `PATH`:

**PowerShell** (as admin, then restart the terminal):

```powershell
$npmPrefix = npm config get prefix
[Environment]::SetEnvironmentVariable("Path", $env:Path + ";$npmPrefix", "User")
```

Verify: `where zelari-code` (CMD) or `Get-Command zelari-code` (PowerShell).

### Install from source

```bash
git clone https://github.com/N-THEM-Studio/zelari-code.git
cd zelari-code
npm install
npm run build:cli
npm link
zelari-code
```

---

## First run and wizard

### Your first 15 minutes (walkthrough)

One tiny task, start to proof. No ADRs, no `/evolve`, no config files —
this page is the only map you need.

1. **Install & enter** — `npm i -g zelari-code`, then create a toy folder
   and start the TUI: `mkdir hello-zelari && cd hello-zelari && zelari-code`.
   Pick a provider with `/login` (grok / chatgpt / anthropic or an API key).
2. **Ask for one small thing** — type:
   `create hello.js that prints "hello" and hello.test.js, then make the test pass`.
   With no workspace plan yet, the first turn runs in **PLAN**: Zelari
   proposes, writes nothing. Read what it intends to do.
3. **Switch to build** — type `/build`, then `go`. The agent writes the two
   files and runs the test.
4. **Watch the Verifica chip** — the status bar shows the verify state:
   `RIPARA` (work present, proof missing) or `PASS` (every required
   criterion has evidence). If the gate stops the turn, its message ends
   with the **next command** (`/verify`, or fix the criterion it names).
5. **Done** — the chip flips to `PASS`. That is the whole contract.

Everything else in this guide — providers, MCP, SSH, missions, evolution —
is optional depth you can open **after your first PASS**.


On first launch (or when `provider.json` is missing), a 5-step **wizard** starts:

1. **Welcome** — overview
2. **Provider** — choose among `grok`, `minimax`, `glm`, `deepseek`, `openai-compatible` (ChatGPT / Anthropic via `/login` after the wizard)
3. **Model** — model name (Enter for default)
4. **API key** — `env` (environment variable), `keystore` (save locally) or `skip`
5. **Confirm** — summary and commit

At the end it writes the configuration to `~/.tmp/zelari-code/` and moves to the TUI automatically.

### Skip or repeat the wizard

```bash
zelari-code --no-wizard          # skip the wizard
zelari-code --reset-config       # force the wizard (deletes provider.json on commit)
ZELARI_NO_WIZARD=1 zelari-code   # env equivalent of --no-wizard
```

---

## TUI interface

### Layout

```
┌─────────────────────────────────────────────┬──────────┐
│  Chat (native scrollback — final messages)  │ Sidebar  │
│  ...                                        │ git diff │
│  [streaming in progress]                    │  +file   │
├─────────────────────────────────────────────┤  -file   │
│  > input bar                                │          │
├─────────────────────────────────────────────┴──────────┤
│  ● ⏵ kraken (shift+tab) · grok · grok-4.5 · sess · cwd  │
└────────────────────────────────────────────────────────┘
```

- **Chat**: completed messages stay in the terminal scrollback (they don't vanish on refresh)
- **Sidebar**: live git changes (`+added` / `-removed`), refreshed every ~4s; hidden on narrow terminals
- **Status bar** (below input): mode, provider, model, session, cwd, timer (`⏱ 12s` / `last 34s`)

### Shortcuts

| Key | Action |
|---|---|
| **Shift+Tab** | Cycle mode `kraken` → `council` → `zelari` (`agent` = alias) |
| **Ctrl+C** | Exit (metrics flush + MCP shutdown) |
| Any key | Skip the initial splash screen (~2s) |

### Splash screen

At startup the ASCII logo shows for ~2 seconds. Disable:

```bash
ZELARI_NO_SPLASH=1 zelari-code
```

Skipped automatically on non-TTY stdout (pipe, CI) or small terminals.

---

## kraken, council and zelari modes

Two independent axes:

| Axis | Values | How |
|------|--------|-----|
| **Mode** (dispatch) | `kraken` · `council` · `zelari` | Shift+Tab or `/mode` (`agent`/`single` = kraken aliases) |
| **Phase** (work) | `plan` · `build` | `/plan` · `/build` or `--phase` |

| Mode × Phase | Typical use |
|--------------|------------|
| kraken + plan | Explore/design without writing to the project |
| kraken + build | **Default implementer** — full tools + `task` tentacles |
| council + plan / design-phase | Plan and artifacts in `.zelari/` (multi-agent's main role) |
| council + build / implementation | Soft-gate: stays in design-phase by default; Lucifero implements only with `ZELARI_COUNCIL_CAN_BUILD=1` |
| zelari | Mission: **design@council → build@kraken** until completion |

> **Experiment (branch `experiment/plan-multiagent-build-agent`):** multi-agent = planning; single agent = build. See the variables below.

### Kraken (default)

Super-agent (legacy alias `agent` / `single`): a lead that uses the built-in tools and can spawn **tentacles** via `task` (`explore` read-only, `general` with writes, `verify` for tests). Ideal for implementation. See [Kraken](#kraken-super-agent--tentacles-and-env) at the end of the guide.

### Council

Sequential **6-member** pipeline collaborating on planning, ideation, knowledge mapping, review and synthesis. Ideal for design, architecture, complex plans.

| ID | Name | Role |
|---|---|---|
| `charont` | Caronte | Orchestrator — decomposes the problem |
| `nettun` | Nettuno | Planner — phases, tasks, milestones |
| `geryon` | Gerione | Ideator — ideas and design documents |
| `pluton` | Plutone | Knowledge Architect — knowledge map |
| `minos` | Minosse | Critic — quality and risk review |
| `lucifer` | Lucifero | Synthesizer — final output / implementation |

### How to activate the council

1. **Shift+Tab** → the status bar shows `⛬ council`
2. Type a free-form prompt and submit
3. Or explicitly use `/council <text>`

### Council tiers (lite vs full)

| Tier | Members | How to activate |
|---|---|---|
| **full** (default) | 6 | — |
| **lite** | 3 | `ZELARI_COUNCIL_TIER=lite` |
| custom | 1–6 | `ZELARI_COUNCIL_SIZE=4` |

### design-phase vs implementation mode

The council automatically detects whether the task is **design** (architecture, specs, greenfield project) or **implementation** (existing codebase). In design-phase members persist artifacts to `.zelari/` via workspace tools.

Manual override: `ZELARI_COUNCIL_MODE=design-phase` or `implementation`.

Keywords are **bilingual**: `costruisci`, `crea`, `vetrina`, `gestionale`, `da zero` (and their English equivalents) activate design-phase; `correggi`, `rifattorizza`, `implementa` keep implementation.

### Zelari (autonomous missions)

The third mode (`⚡ zelari`) turns **a free-form prompt** into a **multi-run mission**: instead of a single council round, the system iterates until an *MVP slice* is complete.

**How it works:**

1. **Shift+Tab** until the status bar shows `⚡ zelari` (or `/zelari <prompt>`).
2. Zelari builds a **mission brief** (intent, inferred stack, deliverables, assumptions, out-of-scope, MVP slice) and shows it in chat.
3. You confirm with `ok` (or set `ZELARI_MISSION_AUTO=1` for automatic start).
4. The loop runs: for greenfield projects first **design-phase**, then **implementation** repeatedly. Between iterations only a compact context is re-injected (brief + memory hits), never the whole transcript.
5. The mission ends with **success** when `completion.ok` is green on the MVP slice, or **stops** when the **implementation** budget is exhausted (`ZELARI_MISSION_MAX_ITER`, default 6). The initial **design-phase** (if planned by the brief) is **outside the budget** and does not consume iterations. **Experiment default:** **implementation** slices use the **single agent** (`build@kraken`); design-phase stays on the council. With `ZELARI_BUILD_VIA_AGENT=0` (legacy) the first implementation uses the full council and from **implementation 2+** the roster is reduced to **Minosse + Lucifero**. State saved in `.zelari/mission-state.json`.

**Variables:**

| Variable | Default | Effect |
|---|---|---|
| `ZELARI_MISSION_AUTO` | `0` | `1` = start the mission without asking for brief confirmation |
| `ZELARI_MISSION_MAX_ITER` | `6` | max **implementation** slices (design-phase is free) |
| `ZELARI_MISSION_MAX_STALL` | `2` | consecutive implementation slices with 0 writes before `stalled` (`0` = off) |
| `ZELARI_BUILD_VIA_AGENT` | on (≠`0`) | `0` = zelari impl goes back through the council (legacy) |
| `ZELARI_COUNCIL_CAN_BUILD` | off | `1` = free-form council can implement (Lucifero); also forces zelari onto the council path |
| `ZELARI_MODE_MAX_TOOLS_AGENT` | `40` | tool-call budget for the agent slice in a mission |
| `ZELARI_MODE_MAX_TOOLS_LUCIFER` | `30` | chairman tool-call budget (legacy council impl path only) |
| `ZELARI_TASK_CONTRACT` | `1` | `0` = disable the mission TaskContract (goal / constraints / acceptance from the brief; default on) |

**Budget-aware continuation (2.6.3):** after each implementation slice, a gate evaluates remaining budget and gap history: `repair` retries the slice, `pivot` changes approach after the same repeated GAP (reduced roster), `hold` stops the mission when the budget is exhausted **without** declaring done (the deterministic PASS remains the only authority; no `passByBudget`).

### Project memory

The compatibility backend saves outcomes to `.zelari/memory/log.jsonl`. With `ZELARI_MEMORY_V2=1` (or `ZELARI_MEMORY_BACKEND=sqlite`) the native cognitive memory in `.zelari/memory/memory.db` takes over: typed nodes and relations, provenance, immutable versions, FTS, ranking and a context budget. Council, Kraken, missions, headless mode and later sessions share the same project scope without MCP. The previous JSONL is imported idempotently and left intact.

Disable with `ZELARI_MEMORY=0` (degrades to a no-op, everything else keeps working). To keep only V2 recall set `ZELARI_MEMORY_AUTO_WRITE=0`. Details, security and diagnostics: [`docs/MEMORY.md`](./MEMORY.md).

---

## Terminal commands (flags)

```bash
zelari-code [options]
```

| Flag | Description |
|---|---|
| `--version`, `-v` | Print version and exit |
| `--help`, `-h` | Print help and exit |
| `--no-wizard` | Skip the first-run wizard |
| `--reset-config` | Force the wizard (config reset) |
| `--headless` | Non-interactive execution (see below) |
| `--doctor` | Environment diagnostics (PATH, node, git, agent bash) |
| `--fix-path` | Windows: repair the npm prefix in the user PATH |
| `--print-config` / `--set-config` / `--set-key` / `--discover-models` | Config helpers for Desktop / scripts |
| `--print-mcp` / `--set-mcp` / `--remove-mcp` | `mcp.json` management |
| `--print-skills` / `--set-skill` / `--remove-skill` | `SKILL.md` skills (user/project) |
| `--generate-skill-from-url --url <https…>` | Skill draft via the active model |
| `serve` | Companion host (Android/Tailscale) — see [Desktop](#zelari-desktop) |
| `--print-ssh-targets` / `--set-ssh-target` / `--remove-ssh-target` / `--test-ssh-target` | SSH targets |
| `--print-ssh-pubkey --path <…>` | Show `.pub` content (copy it to the server) |

---

## Headless mode (CI/scripts)

Runs a single task without mounting the TUI. Useful for CI pipelines, scripts and **Zelari Desktop**.

```bash
zelari-code --headless --task "Explain what src/cli/main.ts does" --output json
```

### Headless options

| Flag | Default | Description |
|---|---|---|
| `--task <text>` | *(required)* | Prompt to run |
| `--output json\|plain` | `json` | `json` = NDJSON (one BrainEvent per line); `plain` = assistant text only |
| `--mode kraken\|council\|zelari` | `kraken` | Dispatch mode (`agent`/`single` = aliases; `--council` stays legacy) |
| `--phase plan\|build` | `build` | In `plan` the project is not mutated (no write/edit/aggressive bash) |
| `--council` | off | Legacy alias → council mode |
| `--provider <id>` | active provider | Provider override |
| `--model <name>` | provider's model | Model override |
| `--history-file <path>` | — | Multi-turn history (JSON) used by Desktop |
| `--task-file <path>` | — | Like `--task` but from a file (avoids the Windows argv limit) |
| `--once` | off | Trigger mode: single cycle + lockfile (cron / git hook) |
| `--profile <id>` | per `--mode` | Capability profile: `minimal/v1` \| `kraken/v1` \| `council/v1` \| `mission/v1`. Recorded in the session spine header |
| `--resume <sessionId>` | — | Resume a spine 2.0 session (`seq` numbering continues) |
| `--export-session <path>` | — | Write a `zelari-session-export/1` JSON export at the end (`-` = stdout) |
| `--strict-done` | off (kraken) | Enables the ADR-0023 evidence gate. Missions have it **by default** (ADR-0025) |
| `--no-strict-done` | — | Opt out of the strict gate for missions (`ZELARI_MISSION_STRICT=0`) |

### Examples

```bash
# Single agent, text output
zelari-code --headless --task "List the files in src/cli" --output plain

# Council, JSON output for piping
zelari-code --headless --task "Design a REST API for todos" --council --output json \
  | jq 'select(.type=="message_delta") | .delta'

# Plan-only (no mutations)
zelari-code --headless --mode kraken --phase plan --task "Outline the refactor"

# Explicit provider (useful without wizard/config)
OPENAI_API_KEY=sk-... zelari-code --headless \
  --provider openai-compatible --model grok-4 \
  --task "Review package.json"

# Resume a spine session (context derives from events.jsonl, not from --history)
zelari-code --headless --resume <sessionId> --task "Continue with the refactor"

# Export the session for offline replay/analysis (zelari-session-export/1)
zelari-code --headless --task "..." --export-session session.json
```

### Headless exit codes

| Code | Meaning |
|---|---|
| `0` | Completed (`agent_end.reason === 'completed'`) |
| `1` | User error (missing flags, missing API key) |
| `2` | Runtime error (provider, council exception) |
| `3` | Agent run ended with an error |
| `4` | Strict evidence gate blocked (ADR-0023/0025): details in the `verification.run` event of the session spine |

---

## Host, Profile and Phase (2.0)

The 2.0 runtime's conceptual separation (ADR-0022): **who** runs, **with which capabilities**, **in which phase**.

### Host

| Host | How to activate | Notes |
|---|---|---|
| TUI | `zelari-code` (default) | Ink + React, native scrollback |
| headless | `--headless --task ...` | NDJSON or plain text; for CI/scripts/Desktop |
| Desktop | Tauri 2 app | driven via the headless channel + `serve` |
| serve | `/serve` | Local API for the Android Companion |

The host does **not** change the agent's capabilities: it only changes the I/O surface. The model context always derives from the session spine.

### Profile

The profile is a versioned **declarative capability manifest** (upper bound):

| Profile | Default for mode | Contents |
|---|---|---|
| `minimal/v1` | — | Essential harness (read-only + task) |
| `kraken/v1` | `kraken` | Harness + workspace write/edit/bash + tentacles |
| `council/v1` | `council` | Extended set for the council flow |
| `mission/v1` | `zelari` | Autonomous mission set |

The default depends on `--mode`; `--profile <id>` always wins. The session spine header records the profile and the `toolManifestHash` of the declared set: different runs on the same task/profile stay comparable (same manifest ⇒ same hash).

### Phase

| Phase | Runtime effect |
|---|---|
| `build` (default) | Full profile capabilities |
| `plan` | **Mutating** tools (`write_file`, `edit_file`, `apply_diff`, `bash`, …) are stripped from the registry; read-only task tools remain |

The profile declares the upper bound, the phase narrows it at execution time: that's why `council+plan` does not expose `write_file` even though `council/v1` declares it.

---

## Zelari Desktop

Optional **Tauri 2** shell (`apps/desktop/`): a modern chat that runs `zelari-code --headless` and streams NDJSON events.

| Control | Values | CLI flag |
|---|---|---|
| Mode | Kraken · Council · Zelari | `--mode` (`agent` = alias) |
| Phase | Plan · Build | `--phase` |
| Provider / model | bar + Settings | `--provider` / `--model` |
| Open Folder | working directory | CLI process cwd |
| Overlay HUD | detachable bar (voice + text) | **◉** title (no auto-open) |

### Multi-turn and history

The Desktop chat is the source of truth for the conversation: multi-turn history via `--history-file`. Short answers ("proceed", "yes", "1") are re-anchored to the previous context (even after a plan↔build switch).

### Settings

- **Provider** — API key, OpenAI-compatible endpoint, model discovery
- **Defaults → Verification & experiments** — persistent switches for Strict Kraken, Strict Mission, native criteria pack and Best-of-N; the advisory Verifier can be Automatic, always on or always off. **Gauntlet Loop** (toggle in top-bar and Settings) is a BUILD host loop: builder/critic tentacles with caps and wall-clock, not a prompt; mutually exclusive with Graph
- **Updates** — **app** update (Tauri / GitHub Releases) vs **CLI** (`npm install -g`)
- **Extensions** — MCP catalog + **Skills** (create/remove user/project `SKILL.md`; import from URL with the active model)
- **Connections** — **Mobile connection** (start `zelari-code serve`, Tailscale QR pairing) + SSH deploy/monitor

### Desktop chat

- **@file** — type `@` to tag project files/folders (Open Folder); also an `@` button in the file tree
- **Skills ★** — skill picker (builtin + user); expands to `/skill` on Send like in the TUI
- Full-width composer in the chat column

### Companion Android + `serve`

The agent stays on the PC; the phone is a thin client on the same Tailscale network (or LAN).

```bash
# Host (PC) — use the monorepo CLI or npm@1.34+
npm run build:cli
zelari-code serve --bind 0.0.0.0 --port 7421 --project /path/to/repo
# or Desktop → Settings → Connections → Mobile connection → Start
```

- Token: `~/.zelari-code/companion.token`
- Health: `GET http://<host>:7421/health`
- App: [`apps/companion-android/`](../apps/companion-android/README.md) — tap **Scan QR from Desktop**
- Do **not** use `127.0.0.1` on the phone (that's the device itself, not the PC). Use the Tailscale IP `100.x`

ADR: [`docs/decisions/0015-companion-host-serve.md`](./decisions/0015-companion-host-serve.md).

### First run

If Node or the CLI are missing, the **Setup guide** appears. The Desktop installer alone is not enough.
If you use the monorepo in dev, prefer `npm run desktop:dev` (it runs `build:cli`) or `ZELARI_CLI_PATH` pointing to `bin/zelari-code.js` — the global npm install may lag behind and **not** have `serve`.

### Development

```bash
npm run build
npm run desktop:install
npm run desktop:dev
# Android companion debug APK
npm run companion:android
```

Monorepo override: `ZELARI_CLI_PATH` → path to `bin/zelari-code.js`.

---

## Slash commands

All commands start with `/` and are typed in the TUI input bar.

### Quick reference (aligned with the README)

#### Help and exit

| Command | Description |
|---|---|
| `/help` | List available commands and skills |
| `/exit` | Exit the CLI |

#### Dispatch mode and phase

| Command | Description |
|---|---|
| `/mode [kraken\|council\|zelari]` | Force the dispatch mode (`agent`/`single` = kraken aliases). Portable equivalent of `shift+tab`. |
| `shift+tab` (TUI) | Cycle `kraken` → `council` → `zelari`. |
| `/kraken [sessionId]` | Tentacle radio (`.zelari/radio/`). |
| `/kraken graph <goal>` | Plan and run a DAG of tentacles in parallel. |
| `/plan [goal]` | Enter **plan** phase (no project write/edit/bash). Optional: send `goal` right away. |
| `/build [goal]` | Enter **build** phase (full tools). Optional: send `goal` right away. |
| `/trust [path]` | Show or trust a folder (MCP + project hooks). |
| `/trust remove [path]` | Revoke trust. |
| `/integrations` | List MCP presets (`composio`, `qwen-mm-plugins`, `cua`, `unreal-mcp`). |

#### Provider and model

| Command | Description |
|---|---|
| `/login <provider> [key]` | Authenticate a provider; without a key starts OAuth for `grok`, `chatgpt`, `anthropic` |
| `/provider` | Interactive provider picker (↑/↓ + Enter, Esc cancels) |
| `/provider <id>` | Switch provider (`openai-compatible`, `grok`, `chatgpt`, `anthropic`, `minimax`, `glm`, `deepseek`) |
| `/provider list` | Show active and available providers (text) |
| `/provider custom <url>` | Custom endpoint (Ollama, LM Studio, vLLM, DeepSeek, …) |
| `/provider custom clear` | Remove the endpoint override |
| `/provider <id> refresh` | Force an OAuth token refresh |
| `/provider <id> status` | Key status, expiry, source |
| `/model` | Interactive model picker (auto-discovery if cache missing or >6h) |
| `/model <name>` | Set the model for the active provider |
| `/model show` | Show the current model |
| `/model refresh` | Re-discover models from the provider |
| `/models` | List discovered models (cache) |
| `/models refresh` (or `/discover`) | Refresh the model cache |

#### Skills

| Command | Description |
|---|---|
| `/skill <id> [input]` | Invoke a skill with an optional prompt |
| `/skill-stats [id]` | Invocation stats (success rate, duration, tokens) |
| `/skill-compare <id1> <id2>` | Side-by-side comparison of two skills |

> `/help` lists all loaded skills (builtin + user `SKILL.md`).

#### Council

| Command | Description |
|---|---|
| `/council <input>` | Invoke the council on the given text |
| `/council-feedback <memberId> <1-5> [note]` | Rate a member (e.g. `/council-feedback geryon 4 great ideas`) |
| `/promote-member <memberId>` | Promote a council member to a standalone skill |

#### Memory

| Command | Description |
|---|---|
| `/memory` or `/memory stats` | Backend, schema, nodes, edges and candidates |
| `/memory search <query>` | Current recall with ranking and graph |
| `/memory show <id>` | Content, lifecycle, provenance and metadata |
| `/memory related <id>` | Typed relations in and out |
| `/memory history <id>` | Timeline of immutable revisions |
| `/memory retract <id> [reason]` | Retract without losing history |
| `/memory forget <id> --yes` | Physically delete after explicit confirmation |
| `/memory consolidate [query]` | Consolidate repeated candidates with `derived_from` |
| `/memory index [--force]` | Index or rebuild the optional embeddings |
| `/memory promote <id>` | Promote durable knowledge into the managed `AGENTS.md` block |
| `/memory doctor` | Schema, integrity, foreign keys and FTS |
| `/memory export [path]` | Export JSON within the project |

#### Sessions and transcript

| Command | Description |
|---|---|
| `/sessions` | List past sessions |
| `/resume <id>` | Resume a session (takes effect at next start) |
| `/new` | New session |
| `/clear` | Clear the visible transcript (session preserved) |
| `/compact [--threshold N] [--keep N]` | Compact the JSONL transcript |

#### Branches (session isolation)

| Command | Description |
|---|---|
| `/branch <name>` | Snapshot the current session into a new branch |
| `/branches` | List branches |
| `/checkout <name>` | Set the active branch (**takes effect at next start**) |

#### Git and files

| Command | Description |
|---|---|
| `/diff [--staged]` | Show working-tree diff (or staged with `--staged`) |
| `/undo [--yes]` | Revert uncommitted changes (**requires `--yes`**) |

#### Steering (queued prompts)

| Command | Description |
|---|---|
| `/steer <text>` | Queue a follow-up during an active run |
| `/steer --interrupt <text>` | Cancel the current run and queue the new prompt |

#### Workspace

| Command | Description |
|---|---|
| `/workspace` | List `.zelari/` artifacts |
| `/workspace show plan` | Render `plan.md` |
| `/workspace show decisions` | List ADRs |
| `/workspace show risks` | Render `risks.md` |
| `/workspace show agents` | Render `AGENTS.MD` |
| `/workspace show docs` | List drafts in `docs/` |
| `/workspace sync` | Re-curate `AGENTS.MD` now |
| `/workspace reset --yes` | Delete `.zelari/` (**destructive**) |

#### Checkpoint and rollback

| Command | Description |
|---|---|
| `/checkpoint [label]` | Working-tree snapshot (tracked + untracked) via git plumbing. Every zelari-mode mission takes one at start. |
| `/rollback [id\|latest]` | Atomic checkpoint restore: restores modified files, recreates deleted ones, removes those created after the snapshot. Without arguments lists available checkpoints. |
| `ZELARI_CHECKPOINT=0` | Disable automatic checkpoints in missions. |

#### Durable state + prompt cache

**Verified** accumulation of artifacts (Palmer *State, Not Tokens*) and **prefix cache** optimization (AGNT Labs *Cache Wars*). Different from memory RAG (soft) and git checkpoints (working tree only).

| Command | Description |
|---|---|
| `/state status` | Durable HEAD + latest commits under `.zelari/state/` |
| `/state commit [label]` | Manual soft commit (force; no verification required) |
| `/state show [id]` | Materialize discoveries (HEAD if omitted) |
| `/state restore [id] [--no-tree]` | Set HEAD and, if present, restore the linked git checkpoint |
| `/cache stats` | Session hit rate, premium vs cached, stable busts |

| Variable | Default | Effect |
|---|---|---|
| `ZELARI_STATE` | `1` | `0` disables the durable state store |
| `ZELARI_STATE_AUTO` | `0` (agent) | Auto-commit in agent mode (Zelari/council post-verify are on) |
| `ZELARI_PROMPT_CACHE_TTL` | `auto` | Preference documented in `/cache stats` (`1h`/`5m`/`auto`). On the OpenAI-compat path caching is automatic server-side: real efficiency comes from the **stable prefix** (identity+tools), not from this flag. Future Anthropic markers may use it. |
| `ZELARI_CTX_DURABLE_CHARS` | `3000` | Cap of the durable block injected into the volatile prompt |

**Memory vs state:** `.zelari/memory/` is recallable, versioned knowledge; `.zelari/state/` is a post-verification chain of commits. The session log stays the event-sourced history and `AGENTS.md` the curated layer. Recalled blocks are added to the turn's volatile context, not to the cacheable system prefix.

**Restore:** `/state restore [id]` re-points HEAD and, if present, restores the linked git checkpoint. Use `--no-tree` for the cognitive HEAD only.

#### Semantic search

| Command | Description |
|---|---|
| `/index` | Build / refresh the project vector index. Required before the first `semantic_search`. |
| `semantic_search "<query>"` (tool) | Conceptual semantic search via local embeddings. |

#### Update

| Command | Description |
|---|---|
| `/update` | Check npm for updates |
| `/update --yes` | Install `zelari-code@latest` globally |

---

## Providers and authentication

### Supported providers

| ID | Name | Env variable | Notes |
|---|---|---|---|
| `openai-compatible` | OpenAI-compatible | `OPENAI_API_KEY` | OpenAI, Together, Groq, custom endpoints |
| `grok` | xAI Grok | `GROK_API_KEY` | OAuth via `/login grok` (RFC 8628) |
| `chatgpt` | ChatGPT (subscription) | `CHATGPT_API_KEY` | OAuth magic-link / device: `/login chatgpt` |
| `anthropic` | Claude Pro/Max | `ANTHROPIC_API_KEY` | OAuth magic-link: `/login anthropic` then paste `CODE#STATE` |
| `minimax` | MiniMax | `MINIMAX_API_KEY` | Base URL: `https://api.minimax.io/v1` (international endpoint) |
| `glm` | GLM / Z.AI | `GLM_API_KEY` | Base URL: `https://api.z.ai/api/coding/paas/v4` (GLM Coding Plan). For the pay-per-token API: `/provider custom https://api.z.ai/api/paas/v4`. The provider id is `glm`, not `zai`. |

> A self-hosted/third-party endpoint doesn't need a dedicated provider: use
> `openai-compatible` + `/provider custom <url>` (see
> [Custom OpenAI-compatible endpoint](#custom-openai-compatible-endpoint)).

### Configure an API key

**Via environment variable:**

```bash
export OPENAI_API_KEY=sk-...
export OPENAI_BASE_URL=https://api.together.xyz/v1   # custom endpoint
export OPENAI_MODEL=grok-4
zelari-code
```

**Via TUI:**

```
/login openai-compatible sk-your-key-here
/login grok                    # starts OAuth device flow
/login chatgpt                 # ChatGPT subscription (device / magic link)
/login anthropic               # opens claude.ai; then /login anthropic CODE#STATE
/model grok-4
/provider grok
```

### Custom OpenAI-compatible endpoint

To point at a self-hosted or third-party gateway (Ollama, LM Studio, vLLM,
Together, a corporate proxy, …) use the `openai-compatible` provider with a
custom endpoint. In the TUI:

```
/login openai-compatible <your-api-key>
/provider custom https://forgeai.dotlabstudios.com/v1
/model refresh          # (or /discover) discovers models FROM the custom endpoint
/model <model-name>     # or open the picker with /model
```

The custom endpoint is saved in `provider.json` under the active provider and
always wins over the default. Model discovery (`/model refresh`, `/discover`,
the `/model` picker and the automatic refresh at startup) queries `<endpoint>/models`
using the same URL as chat, so discovered models really come from your
endpoint. If the endpoint doesn't expose `/v1/models`, discovery fails with an
inline message and you can still set the model manually with `/model <name>`.

Alternatively via env (equivalent, no persistence in `provider.json`):

```bash
export OPENAI_API_KEY=<your-api-key>
export OPENAI_BASE_URL=https://forgeai.dotlabstudios.com/v1
```

> Note: `/provider custom <url>` sets the endpoint on the **active provider**
> (usually `openai-compatible`); there is no selectable provider called `custom`.

### OAuth Grok / ChatGPT / Anthropic

**Grok** (RFC 8628 device flow):

1. `/login grok` (no key)
2. A code and a verification URL appear
3. Open the URL, enter the code, authorize
4. The token (access + refresh) is saved in `keys.json`

**ChatGPT** (subscription, not API key):

1. `/login chatgpt`
2. Open the URL, enter the user code, authorize
3. Token + `ChatGPT-Account-Id` saved; models are discovered from Codex

**Anthropic** (magic link / paste-code):

1. `/login anthropic` opens `claude.ai/oauth/authorize`
2. After login the page shows a code (`CODE#STATE`)
3. `/login anthropic <code>`

Forced refresh: `/provider grok refresh` (or `chatgpt` / `anthropic`).
From the Desktop app: Settings → Provider → **Refresh token**.

CLI / Desktop:

```
zelari-code --login-oauth --provider grok
zelari-code --login-oauth --provider chatgpt
zelari-code --login-oauth --provider anthropic
zelari-code --login-oauth --provider anthropic --code 'CODE#STATE'
zelari-code --refresh-oauth --provider grok
zelari-code --logout-oauth --provider chatgpt
```

### Cross-provider failover

On transient errors, the CLI can retry with an alternative provider.

```bash
ANATHEMA_FAILOVER_PROVIDER=grok zelari-code    # fallback provider
ANATHEMA_FAILOVER=0 zelari-code                # disable failover
```

---


## Skills

### Built-in skills (26)

Invokable with `/skill <id>`.

#### Planning (`planning`)

| ID | Name |
|---|---|
| `architect-feature` | End-to-end feature design |
| `architect-decision-record` | ADR writing |
| `scope-check` | Scope and constraint check |
| `migrate-stack` | Stack migration plan |

#### Refactoring (`refactor`)

| ID | Name |
|---|---|
| `extract-reusable` | Reusable module extraction |
| `simplify-conditionals` | Conditional simplification |
| `refactor-monolith` | Monolith split |

#### Debug (`debug`)

| ID | Name |
|---|---|
| `reproduce-bug` | Bug reproduction |
| `debug-with-rag` | Debug with documentary context |
| `root-cause-five-whys` | Root cause analysis (5 Whys) |

#### Review (`review`)

| ID | Name |
|---|---|
| `code-review` | Multi-role code review |
| `security-audit` | Security audit |
| `performance-review` | Performance review |
| `test-coverage-analysis` | Coverage analysis |

#### Test (`test`)

| ID | Name |
|---|---|
| `write-unit-tests` | Unit tests |
| `write-integration-tests` | Integration tests |
| `regression-test` | Regression tests |

#### Docs (`docs`)

| ID | Name |
|---|---|
| `write-readme` | README |
| `write-tsdoc` | TSDoc/JSDoc |
| `write-changelog` | Changelog |

#### Git-ops (`ops`)

| ID | Name |
|---|---|
| `commit-message` | Commit message |
| `pr-description` | PR description |
| `ci-pipeline` | CI pipeline |

#### Harness / multimodal (`ops` + MCP)

| ID | Name |
|---|---|
| `schema-loop` | Hypothesis + certifiable checks + `run_backtest` |
| `computer-use-cua` | Computer-use on native apps via Cua Driver MCP |
| `qwen-mm-plugins-install-setup` | Qwen-MM-Plugins setup (vision/video/audio) |

### Custom skills (`SKILL.md`)

Format compatible with opencode, Hermes and Claude Code. Discovery directories (first one wins):

1. `<project>/.zelari/skills/<name>/SKILL.md`
2. `<project>/.claude/skills/<name>/SKILL.md`
3. `<project>/.opencode/skills/<name>/SKILL.md`
4. `~/.zelari-code/skills/<name>/SKILL.md`

**Minimal frontmatter:**

```yaml
---
name: my-skill
description: What this skill does
category: review        # optional
tools: read_file,grep   # optional
cost: medium            # optional: low|medium|high
---
Markdown body = the skill's system prompt.
```

Invocation: `/skill my-skill optional argument`.

### Skill statistics

Invocations are logged to `~/.tmp/zelari-code/skill-history.jsonl`.

```
/skill-stats                  # all skills
/skill-stats code-review      # one skill
/skill-compare debug refactor # comparison
```

---

## Council (multi-agent)

### Typical flow

1. Activate council mode (**Shift+Tab** or `/council …`)
2. Describe the task: *"Design the architecture of a React app for a luxury marketplace"*
3. Members run in sequence; Nettuno persists the plan via `createPlan`
4. At the end: a post-hook updates `AGENTS.MD` and completes the design (`completeDesign`)
5. Artifacts in `.zelari/` browsable with `/workspace`

### Feedback and ranking

```
/council-feedback nettun 5 detailed actionable plan
/council-feedback minos 3 useful criticism but too generic
```

Feedback influences the ordering of specialist members in future runs.

### Promoting a member

```
/promote-member geryon
```

Creates a standalone skill based on the member's system prompt, saved in `~/.zelari-code/skills/`.

---

## Workspace `.zelari/`

**Per-project** directory (auto-gitignored) where the council persists structured artifacts.

```
.zelari/
├── plan.md / plan.json     # phases, tasks, milestones
├── risks.md                # risk register
├── decisions/              # ADRs (001-slug.md)
├── reviews/                # Minosse verdicts
├── docs/                   # document drafts (design tokens, IA, …)
├── memory/                 # zelari mission memory
├── radio/                  # Kraken tentacle bus
├── kraken/                 # last-graph.json (DAG resume)
├── world/                  # schema-loop (hypothesis / checks / timeline)
└── hooks/                  # project lifecycle hooks (trusted folders only)

AGENTS.MD                   # at the root — council-curated
```

### Workspace commands

See the [slash section](#workspace) above.

### AGENTS.MD

Partitioned into:

- **Manual blocks** — preserved verbatim
- **Auto sections** (`<!-- zelari:auto:start section="..." -->`) — overwritten on every sync

Auto sections: `tech-stack`, `decisions`, `conventions`, `build`, `open-questions`.

Disable: `ZELARI_AGENTS_MD=0`

---

## MCP (Model Context Protocol)

External MCP servers expose additional tools to the CLI and the council.

### Configuration

Claude Desktop-format files (project wins on conflicts):

- `<project>/.zelari/mcp.json`
- `~/.zelari-code/mcp.json`

```json
{
  "mcpServers": {
    "context7": {
      "command": "npx",
      "args": ["-y", "@upstash/context7-mcp"]
    }
  }
}
```

MCP tools appear as `mcp_<server>_<tool>` in the registry.

**Desktop:** Settings → **MCP Extensions** installs common entries (npx on demand) without manual editing.

CLI: `--print-mcp`, `--set-mcp`, `--remove-mcp`.

Disable everything: `ZELARI_MCP=0`

See also [TOOLS.md](./TOOLS.md).

---

## SSH (deploy / monitor)

Zelari is **not** an interactive SSH client: it registers **targets** and exposes OpenSSH tools (`ssh` on PATH) to the agent.

### Config

| File | Contents |
|---|---|
| `~/.zelari-code/ssh-targets.json` | Host, user, port, auth, command allowlist |
| `~/.zelari-code/ssh-secrets.json` | Password (auth=password only; never in chat/LLM) |

### Auth

| Mode | What's needed |
|---|---|
| **password** | IP/host + username + password (typical VPS case) |
| **agent** | Keys already loaded in `ssh-agent` |
| **keyPath** | Local private key path (+ optional `.pub` to copy to the server) |

### Desktop

Settings → **Connections** → Add target → Auth **Password** → Host/IP, User, Password → Save → **Test**.

### Agent tools

| Tool | Use |
|---|---|
| `ssh_status` | Health check on the target (`true` / status) |
| `ssh_run` | Remote command **only** if it matches `allowedCommands` (literal or `prefix*`) |

Example allowlist: `systemctl status *`, `journalctl *`, `docker ps*`, `df -h*`, `uptime`.

### CLI

```bash
zelari-code --print-ssh-targets
zelari-code --set-ssh-target --json '{"id":"vps1","name":"VPS","host":"1.2.3.4","user":"root","auth":"password","password":"…","allowedCommands":["uptime","df -h*"]}'
zelari-code --test-ssh-target --id vps1
zelari-code --print-ssh-pubkey --path %USERPROFILE%\.ssh\id_ed25519.pub
```

Kill switch: `ZELARI_SSH=0`.

---

## Sessions and branches

> **Legacy 1.x (compat).** These commands manage the 1.x compatibility surfaces. Since 2.0 the model context derives **only** from the [Session spine 2.0](#session-spine-20-canonical): headless `--resume` and the `--export-session` export replace the history snapshot for resuming a session.

### Sessions

Every conversation is persisted as JSONL in `~/.tmp/zelari-code/sessions/<id>.jsonl`.

```
/sessions          # list
/resume abc123     # set the session to resume
/new               # new session
/compact           # compact a long transcript
```

### Branches

Branches isolate session snapshots (they are not git branches):

```
/branch feature-x     # create a branch with the current snapshot
/branches             # list
/checkout feature-x   # active at the NEXT zelari-code start
```

> After `/checkout`, exit with `/exit` and relaunch `zelari-code`.

---

## Session spine 2.0 (canonical)

The **session spine** (ADR-0016/0021) is the event-sourced log that since 2.0 is the **single** source of truth of the model context, on every hot path (headless kraken/council/zelari + TUI):

```
Session log (append-only JSONL)
    ↓ deriveMessages()
derivedToAgentMessages()
    ↓
model context (AgentHarness)
```

- **Where:** `<workspace>/.zelari/sessions/<sessionId>/events.jsonl` (test override with `ZELARI_SESSIONS_DIR`)
- **Guarantees:** append-only with single-writer lock, monotonic `seq`, `SCHEMA_VERSION`, tolerant replay (an unknown event becomes an issue, not a crash)
- **Invariant:** what the model sees ⟺ what is logged — including user prompts, which the 1.x log never recorded
- **State events beyond the model:** `verification.run` / `verification.evidence`, `mission.progress`, lineage (`session.forked`), `session.started` with profile + manifest hash

- **Harness manifest (deep, 2.6.3):** the session manifest fingerprints the real tool surface (name + description + input schema) in addition to profile and resource policy — a change of tool/description/schema changes the hash, and resume reports the drift (`session.harness_drift`)

### Resume

```bash
zelari-code --headless --resume <sessionId> --task "second turn"
```

The `seq` numbering continues in the same log; no history snapshot to rebuild by hand.

### Export

```bash
zelari-code --headless --task "..." --export-session out.json   # or - for stdout
```

Produces a `zelari-session-export/1` document: full projection, trajectory, lineage and `forkParent`. A fresh reader can replay it and obtain the same semantic trajectory.

### Fork (core API)

Forking is a programmatic API of `@zelari/core/session` (`forkSession(store, id, { fromSeq })`): copies the trajectory up to `fromSeq` into a new sessionId and records the `session.forked` event with the lineage. It is not a CLI flag; the export exposes it as `forkParent`.

### Legacy mirror (transitional)

The 1.x BrainEvent sidecar and the in-process store remain **only** as a compat export/UI surface (ADR-0024, "COMPAT MIRROR"). They are not the source of truth: their removal is planned for a later 2.x, after the Desktop migration.

---

## Deterministic verification, Strict Done and Verifier LLM (2.0)

The 2.0 completion contract (ADR-0023/0025): **deterministic beats narrative**.

### VerificationEngine and event-backed evidence

A criterion produces a deterministic check (exit code, sha256 digest of the output, fs observations). Every observation emits a `verification.evidence` event in the spine and the `EvidenceRef` records its `seq`: evidence is **anchored to the real event**, not to an agent's sentence.

Deterministic (event-backed) tiers: `tool-output`, `command-output`, `fs-observation`. Narrative alone (`claimed`) never passes a gate.

### Criteria pack v1

Since P0.2 the criteria pack v1 is active **by default** and actually runs the project checks — typecheck, test, build — using the repo's real npm scripts (auto-unbind when a script is missing), and merges the results into the same gate; `ZELARI_VERIFY_PACK=0` disables it. Since 2.1 the pack is an **independent** gate: it doesn't require `--strict-done` or Kraken Selection — the flag alone is enough, even on a "plain" kraken turn:

```bash
zelari-code --headless --task "ship F3" --strict-done   # kraken, opt-in
ZELARI_VERIFY_PACK=1 zelari-code --headless --task "ship"   # standalone pack: implicit strict
```

### CompletionPolicy and Strict Done

`PASS | REPAIR_REQUIRED | BLOCKED` — `unknown ≠ pass`: a required criterion without evidence is **BLOCKED**, not success.

| Surface | Default | Flag |
|---|---|---|
| Kraken (TUI + headless) | **ON** (P0.1) | opt-out: `ZELARI_STRICT_DONE=0` |
| `zelari` mission | **ON** (ADR-0025) | opt-out: `--no-strict-done` / `ZELARI_MISSION_STRICT=0` |

When strict is active, a `pass` counts only if the evidence is **event-backed** (`EvidenceRef.seq` anchored to a `verification.evidence` event on the spine). A verify-tentacle note without a session emitter is **BLOCKED** (ADR-0026).

Blocked gate ⇒ exit code **`4`** and stopped session state, with the `verification.run` event carrying criteria, status and blocker.

### Verifier LLM (advisory)

The LLM verifier is **opt-in and advisory**: it adds information, never authority.

- **Test-locked guarantee:** a deterministic criterion UNKNOWN/FAIL with verifier CONFIRMED stays **BLOCKED**; a deterministic PASS with verifier REJECTED stays **PASS** (the review is visible as a risk, it doesn't rewrite the verdict)
- **Model:** "Same as current model" (inherit) or a dedicated provider+model — configured in **Desktop → Settings → Kraken** (persisted; the effective model is recorded in the `verification.run` event as `effectiveModel`)
- **Status (2.1):** the persisted selection is resolved by the runtime and the contract is locked; the advisory invocation is now active in the headless kraken lifecycle — opt-in: dedicated model configured (Desktop → Settings → Kraken) or `ZELARI_VERIFIER_REVIEW=1`; the result lands in the `verification.run` event (`verifier.advisory`) and never in the verdict

### Mission progress (advisory) and Best-of-N (experimental)

- Every mission slice emits `mission.progress` with a recommendation (`continue` / `wind-down` / `hold-for-user`): the loop does **not** execute it — never early-stop with required criteria incomplete, never done-by-score, never goal rewrite
- Best-of-N is an experimental surface (Desktop switch): not part of the completion contract

---

## Available tools

Summary; details in [TOOLS.md](./TOOLS.md).

### Harness (always available)

| Tool | Permissions |
|---|---|
| `read_file`, `write_file`, `edit_file` | filesystem (project-root sandbox) |
| `bash` | shell (security blocklist) |
| `grep_content` | recursive regex search |
| `list_files` | directory listing |
| `show_diff`, `apply_diff` | diff and patch |
| `fetch_url` | HTTP GET, HTML→text |
| `web_search` | DuckDuckGo (or Tavily with `TAVILY_API_KEY`) |

### Workspace (council / skills that require them)

`createPlan`, `createPhase`, `createTask`, `updateTask`, `addIdea`, `createMilestone`, `createDocument`, `searchDocuments`, `linkDocuments`, `getDocumentBacklinks`

### Advanced capabilities (opt-in, no-op when the dependency is missing)

| Tool | Permission | Prereq | Example |
|---|---|---|---|
| `lsp_definition` / `lsp_references` / `lsp_hover` / `lsp_symbols` / `lsp_rename` | read / write (`lsp_rename`) | language server on PATH | `use lsp_references on src/cli/app.tsx:42` |
| `ast_outline` / `ast_find_symbol` | read | none | `ast_outline on packages/core/src/agents/` |
| `semantic_search` | read | index (`/index`) | `semantic_search "provider retry"` |
| `browser_check` | sandboxed network | Playwright + chromium | `browser_check on http://localhost:3000` |
| `ssh_status` / `ssh_run` | network (SSH) | target in Settings / `~/.zelari-code` | allowlist on `ssh_run` |
| `task` | read (sub-agent) | — | isolated read-only research |

### Schema loop (lightweight world model)

Inspired by the [Schema harness](https://schema-harness.github.io/): explicit hypothesis + certifiable checks + `run_backtest` before declaring done.

| Tool | Role |
|---|---|
| `update_world_hypothesis` | Writes `.zelari/world/hypothesis.md` |
| `set_world_checks` | Defines `.zelari/world/checks.json` |
| `run_backtest` | Runs the checks and reports pass/fail |
| `record_world_observation` | Appends to `.zelari/world/timeline.jsonl` |

Skill: `/skill schema-loop`. Tool kill switch: `ZELARI_SCHEMA_LOOP=0`.

### Harness hooks

- **Diagnostics loop** — after an edit, `eslint`/`ruff` in the tool result. `ZELARI_DIAGNOSTICS=0`.
- **Parallel batch** — contiguous reads in parallel; writes/bash as barriers. `ZELARI_PARALLEL_TOOLS=0`.
- **Prompt-cache accounting** — hit rate in the status bar when the provider exposes it.

Full map: [TOOLS.md](./TOOLS.md).

---

## Advanced capabilities and 1.26–1.34 news

The "frontier" capabilities (LSP, AST, semantic, browser, diagnostics, `task`) remain. From **1.26** to **1.34** the additions were mostly:

| Area | What | Since |
|------|------|----|
| **Kraken** | Default super-agent, `task` tentacles, worktree + auto-merge, radio, **Kraken Graph** DAG | 1.26–1.28 |
| **Desktop Workbench** | Plan / Tasks tabs tied to `--plan-only` / `--run-plan` | 1.33 |
| **Security** | Folder trust (`/trust`), fail-open lifecycle hooks, `--inspect` | 1.32 |
| **Vision** | `@image.jpg` and Desktop drop → native `image_url` (same provider) | 1.31 |
| **MCP presets** | `composio`, `qwen-mm-plugins`, `cua`; slash `/integrations` | 1.31 |
| **Local CLI** | `ZELARI_LOCAL_CLI=claude` + MCP permission broker | 1.31 |
| **OAuth** | `/login chatgpt`, `/login anthropic` + Desktop Sign in/Refresh/Sign out | 1.34 |
| **Windows PATH** | npm prefix auto-repair (`--fix-path`, postinstall) | ADR-011 |

Official changelog: [CHANGELOG.md](../CHANGELOG.md).

### Usage examples

```text
# LSP
"use lsp_references on packages/core/src/core/AgentHarness.ts"

# Semantic
"/index
 semantic_search 'where do we handle provider retry'"

# Phase
"/plan outline the auth refactor
 /build implement the plan on disk"

# Mode
"/mode zelari
 design me a full-stack todo app"
```

### Disabling

```bash
ZELARI_LSP=0 ZELARI_AST=0 ZELARI_SEMANTIC=0 ZELARI_BROWSER=0
ZELARI_DIAGNOSTICS=0 ZELARI_SSH=0 ZELARI_PARALLEL_TOOLS=0
```

---

## What's new in 2.29–2.30 (hardening)

Features added between 2.29 and 2.30 (references: `HANDOFF-v2.30.md`, ADR-0036).

### `zelari.config.json` and `--print-settings`

- Layered config: builtin defaults → `~/.zelari-code/zelari.config.json` (user) → `<project>/.zelari/zelari.config.json`; last one wins.
- `zelari-code --print-settings` prints every value with its origin (default / user / project).
- Single root `~/.zelari-code/` with automatic migration on first launch.

### Safety: permissions, provenance, exfiltration

- `--permissions <strict|standard|yolo>` (or `ZELARI_PERMISSION_PRESET`) selects the tool permission preset.
- Hardened provenance: excerpts cited by the model are recorded (ring bounded) and verified; `ZELARI_PROVENANCE=0` disables recording and matching.
- SSH exfiltration guard: remote commands are checked against exfiltration patterns.

### Session budget with HOLD

- On the council turn the cumulative cost is compared against the budget (`src/cli/costBudget.ts`); on overrun the session goes into **HOLD** instead of failing silently.

### Evolution engine (ADR-0036, default OFF)

- Pipeline `npm run evolve:propose|validate|decide|seal`; the proposer never measures or promotes itself (proposer ≠ judge, `JUDGE_PATHS` untouchable).
- Sealed anchors with normalized LF/BOM hash: drift = red gate.
- Status from the CLI: `zelari-code --evolve-status`; in the TUI: `/evolve status|fitness|proposals`; `/memory audit` inspects memory and costs (W4).

## Configuration files

Everything under `~/.tmp/zelari-code/` (unless overridden by env):

| File | Contents |
|---|---|
| `provider.json` | Active provider, models, custom endpoint |
| `keys.json` | API keys and OAuth tokens |
| `models.json` | Discovered-model cache |
| `sessions/<id>.jsonl` | Session transcripts |
| `current.txt` | Current session id |
| `branches/<name>/` | Branch snapshots |
| `skill-history.jsonl` | Skill invocation history |
| `skill-cache.json` | Skill cache |
| `council-feedback.json` | Council member ratings |
| `metrics.jsonl` | Fire-and-forget metrics |

---

## Environment variables

### Zelari / wizard / UI

| Variable | Effect |
|---|---|
| `ZELARI_NO_WIZARD=1` | Skip wizard |
| `ZELARI_NO_SPLASH=1` | Skip splash screen |
| `ANATHEMA_DEV=1` | Disable background update check |

### Provider / API

| Variable | Effect |
|---|---|
| `OPENAI_API_KEY` | OpenAI-compatible key |
| `OPENAI_BASE_URL` | Custom endpoint |
| `OPENAI_MODEL` | Default model |
| `GROK_API_KEY` | Grok key (alternative to OAuth) |
| `CHATGPT_API_KEY` | ChatGPT key (alternative to OAuth) |
| `ANTHROPIC_API_KEY` | Anthropic key (alternative to OAuth) |
| `DEEPSEEK_API_KEY` | DeepSeek key |
| `GLM_API_KEY` | GLM/Z.AI key |
| `MINIMAX_API_KEY` | MiniMax key |
| `ZELARI_LOCAL_CLI` | Provider via external CLI (`claude`) |
| `TAVILY_API_KEY` | Web search via Tavily |
| `ANATHEMA_ACTIVE_PROVIDER` | Active provider override |
| `ANATHEMA_FAILOVER=0` | Disable failover |
| `ANATHEMA_FAILOVER_PROVIDER` | Fallback provider |

### Council

| Variable | Effect |
|---|---|
| `ZELARI_COUNCIL_TIER=lite` | 3-member council |
| `ZELARI_COUNCIL_SIZE=N` | Roster size (1–6) |
| `ZELARI_COUNCIL_MODE` | `design-phase` or `implementation` |
| `ZELARI_AGENTS_MD=0` | Disable AGENTS.MD sync |
| `ZELARI_COMPLETE_DESIGN=0` | Disable the design post-processor |

### Tools / MCP / shell / SSH / Desktop

| Variable | Effect |
|---|---|
| `ZELARI_MCP=0` | Disable MCP |
| `ZELARI_MCP_USER=0` | Don't read `~/.zelari-code/mcp.json` (project `.zelari/mcp.json` only; useful in tests) |
| `ZELARI_CUA=0` | Disable Cua Driver MCP (desktop computer-use) |
| `ZELARI_CUA_COUNCIL=1` | Expose Cua tools in council too (default off, anti-saturation) |
| `ZELARI_SCHEMA_LOOP=0` | Disable world-model tools (`run_backtest`, hypothesis, checks) |
| `ZELARI_SSH=0` | Disable SSH tools and targets |
| `ZELARI_CLI_PATH` | Desktop: path to local `bin/zelari-code.js` |
| `ZELARI_NO_PATH_REPAIR=1` | Windows: don't repair the npm PATH |
| `ZELARI_MAX_TOOL_CALLS` | Tool-call limit per turn |
| `ZELARI_TOOL_OUTPUT_LINES` | Tool output lines in the TUI (default 8) |
| `ZELARI_SHELL` | Explicit bash path (Windows) |
| `ZELARI_PROVIDER_TIMEOUT_MS` | Hard timeout on provider fetch (default 5 min) |
| `ZELARI_PARALLEL_TOOLS=0` | Disable read-only tool parallelism |
| `ZELARI_MAX_PARALLEL_TOOLS` | Max parallel tools per segment (default 6) |
| `ZELARI_MAX_TOOL_LOOP_ITERATIONS` | Soft tool-loop budget per run |
| `ZELARI_MAX_TOOL_LOOP_HARD` | Hard tool-loop ceiling |

`ZELARI_MAX_TOOL_CALLS` governs the current turn's execution: it restarts from zero on every new user message. The session ledger still keeps the cumulative total for resume, telemetry and evals; a resume without a new turn instead restores the interrupted execution's consumption.

### Advanced capabilities / harness

| Variable | Default | Effect |
|---|---|---|
| `ZELARI_LSP` | `1` | `0` disables the 5 LSP tools |
| `ZELARI_AST` | `1` | `0` disables AST tools |
| `ZELARI_SEMANTIC` | `1` | `0` disables semantic search + `/index` |
| `ZELARI_SEMANTIC_FILE` | `~/.tmp/zelari-code/semantic.json` | embeddings store path |
| `ZELARI_EMBED_MODEL` | `Xenova/all-MiniLM-L6-v2` | embedding model for semantic search |
| `ZELARI_BROWSER` | `1` | `0` disables `browser_check` |
| `ZELARI_DIAGNOSTICS` | `1` | `0` disables the post-edit diagnostics loop |
| `ZELARI_DIAGNOSTICS_TIMEOUT_MS` | `5000` | diagnostics loop timeout |
| `ZELARI_CHECKPOINT` | `1` | `0` disables automatic checkpoints in zelari-mode |
| `ZELARI_STATE` | `1` | `0` disables durable state (`.zelari/state/`) |
| `ZELARI_CTX_DURABLE_CHARS` | `3000` | max durable-state chars in the volatile prompt |

### Session spine and 2.0 verification

| Variable | Default | Effect |
|---|---|---|
| `ZELARI_STRICT_DONE` | `1` | `0` = opt-out of the kraken/TUI/headless strict gate (ON by default, P0.1) |
| `ZELARI_MISSION_STRICT` | `1` | `0` = opt-out of the mission strict gate (default ON) |
| `ZELARI_VERIFY_PACK` | `1` | `0` = opt-out of the native criteria pack v1 (ON by default, P0.2; auto-unbind without npm scripts) — independent gate: doesn't require strict-done or Kraken Selection |
| `ZELARI_VERIFIER_REVIEW` | `0` | `1` = advisory LLM verifier after the gate (headless kraken); `0` forces off even with a dedicated model |
| `ZELARI_SESSIONS_DIR` | `<workspace>/.zelari/sessions` | Override of the session spine directory (test/CI) |
| `ZELARI_EVAL_RESULTS_DIR` | `eval/results` | Override of the eval result-store directory — regression gate (test/CI) |

### Path overrides (test/CI)

| Variable | File |
|---|---|
| `ANATHEMA_PROVIDER_CONFIG_FILE` | provider.json |
| `ANATHEMA_KEYSTORE_FILE` | keys.json |
| `ANATHEMA_SESSIONS_DIR` | sessions directory |
| `ANATHEMA_BRANCHES_DIR` | branches directory |
| `ANATHEMA_METRICS_FILE` | metrics.jsonl |
| `ANATHEMA_SKILL_HISTORY_FILE` | skill-history.jsonl |

---

## Self-update

```bash
# In the TUI:
/update              # check version
/update --yes        # npm install -g zelari-code@latest

# At startup: hint on stderr if a newer version exists
ANATHEMA_DEV=1 zelari-code   # disable the silent check
```

After `/update --yes`, manually restart with `/exit` and `zelari-code`.

---

## Development

See also [CONTRIBUTING.md](../CONTRIBUTING.md).

```bash
npm install
npm run build:cli     # tsc + esbuild bundle
npm test              # Vitest suite (hundreds of files in tests/unit)
npm run typecheck
npm run smoke         # verify the bin
```

### Monorepo structure

```
zelari-code/
├── packages/core/            # @zelari/core — AgentHarness, council, 26 skills, tools
├── src/cli/                  # Ink TUI, providers, workspace, wizard, serve
├── apps/desktop/             # Zelari Desktop (Tauri 2)
├── apps/companion-android/   # thin client for `zelari-code serve`
├── tests/unit/               # Vitest tests
└── docs/                     # this documentation
```

---

## Troubleshooting

### `zelari-code: command not found` (Windows)

See [Windows installation](#windows-zelari-code-not-found).

### Wizard doesn't start / always starts

- Missing `~/.tmp/zelari-code/provider.json` → wizard on first launch
- `--reset-config` forces the wizard
- `--no-wizard` or `ZELARI_NO_WIZARD=1` suppresses it

### Missing API key

```
/login <provider> <key>
# or
export OPENAI_API_KEY=sk-...
```

In headless without config: pass `--provider` + env variable.

### Council doesn't persist the plan

- Check design-phase mode (keywords "design", "architecture", …)
- Check `.zelari/plan.json` after the run
- Nettuno must call `createPlan` (not just prose)

### MCP doesn't load tools

- Check the JSON in `.zelari/mcp.json`
- Check stderr for broken-server warnings
- `ZELARI_MCP=0` disables everything — remove it

### Shell on Windows

If `bash` fails, set Git Bash explicitly:

```bash
ZELARI_SHELL="C:\Program Files\Git\bin\bash.exe" zelari-code
```

### npm publish / CI

See [MIGRATION.md](../MIGRATION.md) and `docs/decisions/0002-publish-zelari-core-to-npm.md` for `@zelari/core` and Trusted Publishing.

---



## Kraken (super-agent) — tentacles and env

The default **kraken** mode (formerly `agent`) is a lead that spawns sub-agents via the `task` tool.

| Env / command | Effect |
|---------------|---------|
| `ZELARI_KRAKEN_MAX_TASK_SPAWNS` | Cap of `task` spawns per parent turn (default 6); reset on every user message |
| `ZELARI_KRAKEN_SUB_MODEL` | Cheap model for explore/verify tentacles. Accepts **qualified** `provider/model` refs (e.g. `glm/glm-4.7-air`) to use a provider other than the lead's |
| `ZELARI_KRAKEN_EXPLORE_MODEL` / `ZELARI_KRAKEN_VERIFY_MODEL` / `ZELARI_KRAKEN_GENERAL_MODEL` | Per-type overrides; accept **qualified** `provider/model` refs to send that tentacle to a provider other than the lead's |
| `ZELARI_KRAKEN_DELEGATION` | Lead delegation policy: `automatic` (default, unchanged behavior) · `prefer` (nudges the lead to use `task` tentacles) · `aggressive` · `lead-only` (the lead works alone). In Desktop: Settings → Kraken → Delegation policy |
| `ZELARI_KRAKEN_GENERAL_USES_SUB=1` | Makes general use SUB_MODEL too |
| `ZELARI_KRAKEN_WORKTREE=1` | Isolate `task` general in a git worktree under `.zelari/worktrees/` |
| `ZELARI_KRAKEN_WORKTREE_KEEP=1` | Don't delete worktree/branch when the tentacle ends (manual merge) |
| `ZELARI_KRAKEN_WORKTREE_AUTO_MERGE=0` | Disable the worktree squash-merge into the parent at the end of the tentacle (default on) |
| `/kraken [sessionId]` | Show the tentacle radio (`.zelari/radio/<session>.jsonl`) |

After a `task` general the result includes a **verify-hint**: the parent must verify (`bash` or `task` verify) before declaring done.

**Model routing (2.11):** a tentacle resolves its model in this order: specific override (`EXPLORE`/`GENERAL`/`VERIFY`) → `SUB_MODEL` → auto-pick → the lead's model. A qualified `provider/model` ref also selects the **provider** (credentials and stream) in addition to the model; if the provider isn't configured the value passes as-is to the lead's provider. The **Kraken Activity** panel in Desktop shows the actually resolved model for every tentacle (`agent_spawned`).

### Kraken Graph — DAG of parallel tentacles

`/kraken graph <goal>` (or `--kraken-graph <goal>` headless) has an LLM plan a DAG of tasks and runs it in parallel where scopes are disjoint.

| Env | Effect |
|-----|---------|
| `ZELARI_KRAKEN_GRAPH=0` | Kill-switch: disables the graph engine entirely |
| `ZELARI_KRAKEN_MAX_PARALLEL` | Max concurrent tentacles |
| `ZELARI_KRAKEN_FIX_BUDGET` | Number of `fix` nodes allowed before terminal failure |
| `ZELARI_KRAKEN_NODE_TIMEOUT_MS` | Wall-clock per node, **all types** (`0` = no limit). If unset the budget depends on type: 300000 for `explore`/`verify`, 2700000 for `general`/`fix` |
| `ZELARI_KRAKEN_WRITER_NODE_TIMEOUT_MS` | Wall-clock for write nodes only (`general`/`fix`), default 2700000 |
| `ZELARI_POLICY=0` | Disable the policy engine (`.zelari/policy.json` + `~/.zelari/policy.json`) |
| `ZELARI_POLICY_PRECEDENCE=legacy` | Restore v1 evaluation (project first-match can mask a global deny). Default **restrict-only**: global and project layers intersect, `deny > ask > allow` |
| `ZELARI_KRAKEN_CANCEL_GRACE_MS` | Wait for a cancelled tentacle to wind down before declaring it unstoppable (default 30000). A node that doesn't stop is **not** re-run: two tentacles on the same scope corrupt the work |
| `ZELARI_KRAKEN_PLANNER_MODEL` | Model used **only** for planning; **wins over the lead's model** and accepts qualified `provider/model` refs. Planning is a single structured completion without tool use: pointing it at a fast non-reasoning model avoids the timeouts typical of reasoning models |
| `ZELARI_KRAKEN_PLANNER_TIMEOUT_MS` | Wall-clock of the planning request (default 300000; `0` = no limit) |
| `ZELARI_KRAKEN_PLANNER_MAX_TOKENS` | Token budget of the planner response (default 8192) |

If the planner times out, the error says so explicitly and does **not** retry (the model didn't
answer: repeating would only double the wait). Raise `ZELARI_KRAKEN_PLANNER_TIMEOUT_MS` or set
`ZELARI_KRAKEN_PLANNER_MODEL`.

**Resume across runs.** At the end of an execution the graph's terminal state is saved in
`.zelari/kraken/last-graph.json`. If the previous run didn't finish, the next planning receives
a summary of what's done, what failed and what never started — so a "continue" plans the
**remaining** work instead of restarting from scratch. A plan that contains no `general` node
is rejected: it would be read-only and would converge without having changed anything.


## Useful links

- [Product page](https://anathema-studio.com/zelari-code)
- [Site documentation](https://anathema-studio.com/zelari-code/docs)
- [Anathema Studio](https://anathema-studio.com/) — home
- [GitHub repository](https://github.com/N-THEM-Studio/zelari-code) · [Releases](https://github.com/N-THEM-Studio/zelari-code/releases)
- [npm: zelari-code](https://www.npmjs.com/package/zelari-code) · [npm: @zelari/core](https://www.npmjs.com/package/@zelari/core)
- [CONTRIBUTING](../CONTRIBUTING.md) · [SECURITY](../SECURITY.md) · [LICENSE (Apache-2.0)](../LICENSE)
