# Zelari Code

```
             -#%=
           .*%%%@#:
          =%%%%%%%@*
         +%%%%%%%%%%#.
        +%%%@@@@@@@%@#.
      .*%@@@@@@@@@@@@@%-
     .#%@@@@@@@@@@@@@@@@-
     *%@@@@@@@@@@@@@@@@@%.
    :@%%@@@@@@%:+%@@@@@%@=
     =@%%@@@@@%.=-+%@%%@*
     .=@@%@@@@%.*@*-+@@*.
   -*%@@@@@@@@%.*@@@+:#@@#=.
  *%%%%%%@@@@@@.*#%#=-:+@@@%
 :@%%%%%%@@@@@@.:=.*:*@@@@@@=
 *@%%@%%@@@@@@@*%@*:-:%@@@@@%.
:@@@%@@@@@@@@@@@@@@#%@@@@@@@@=
*%%%%%%%%%%%%%%%%%%%%%%%%%%%%#

     Z E L A R I   C O D E
          N-THEM Studio
```

> AI Council coding agent CLI — multi-agent orchestration with slash commands, provider-agnostic LLM streaming, and self-update.

![Version](https://img.shields.io/npm/v/zelari-code)
![License](https://img.shields.io/badge/license-Proprietary-red)
![Node](https://img.shields.io/node/v/zelari-code)

📖 **[Guida completa all'uso (IT)](./docs/GUIDA.md)** — installazione, TUI, comandi slash, council, skills, workspace, headless, MCP.

**Zelari Code** is a standalone CLI extracted from [AnathemaBrain](https://github.com/N-THEM-Studio/AnathemaBrain). It brings the multi-agent council (Caronte, Nettuno, Gerione, Plutone, Minosse, Lucifero) directly into your terminal with a rich TUI (Ink + React), slash command system, and provider-agnostic LLM streaming (OpenAI-compatible, xAI Grok with OAuth, GLM/Z.AI).

> **Upgrading from ≤ 0.4.x?** See [MIGRATION.md](./MIGRATION.md) — the internal
> `src/main/core/`, `src/agents/`, `src/shared/`, `src/types/` paths no longer
> exist. The published core package is `@zelari/core` (MIT). 9 subpath exports.

## Install

```bash
npm install -g zelari-code
zelari-code
```

Requires **Node.js ≥ 20**.

### `zelari-code: command not found` (Windows)

After `npm install -g`, the `zelari-code` command may not be on your `PATH`. Fix:

**PowerShell** (run as admin, then restart your terminal):
```powershell
$npmPrefix = npm config get prefix
[Environment]::SetEnvironmentVariable("Path", $env:Path + ";$npmPrefix", "User")
```

**Git Bash / WSL:**
```bash
echo 'export PATH="$(npm config get prefix):$PATH"' >> ~/.bashrc
source ~/.bashrc
```

Verify the fix: `where zelari-code` (CMD) or `which zelari-code` (Bash) should print a path.

## First Run

The first time you run `zelari-code` (or whenever your provider config
is missing), the CLI launches a 5-step onboarding wizard instead of
the regular TUI:

```
╭─────────────────────────────────────────────────╮
│ zelari-code v0.6.0 — first-time setup    │
│ 1/welcome  2/provider  3/model  4/apikey  5/...│
│                                                 │
│ Welcome! Let's get you coding in under 2 min.   │
│ Press [Enter] to continue, [Q] to quit.         │
╰─────────────────────────────────────────────────╯
```

The wizard walks you through:

1. **Welcome** — overview + how to quit.
2. **Provider** — pick from `grok`, `minimax`, `glm`, `deepseek`, `openai-compatible` (↑/↓ + Enter).
3. **Model** — type a model name or accept the default (Enter).
4. **API key** — choose `env` (use `GROK_API_KEY` etc.), `keystore` (save locally), or `skip` (set later via `/login`).
5. **Confirm** — review + Enter to commit.

When you press Enter on confirm, the wizard writes `~/.tmp/zelari-code/provider.json` (and `keys.json` if you chose keystore), shows a brief "✓ Setup complete!" banner, **then transparently transitions into the regular TUI** — no need to re-launch.

### Skipping / re-running

```bash
zelari-code --no-wizard            # skip wizard even on first run
zelari-code --reset-config         # force re-run wizard (clears provider.json)
ZELARI_NO_WIZARD=1 zelari-code     # env equivalent of --no-wizard
zelari-code --version              # print version + exit (no TUI)
zelari-code --help                 # print help + exit (no TUI)
```

The wizard re-runs automatically if `provider.json` is missing on the next launch.

## Quick Start

```bash
# Set your OpenAI-compatible API key (OpenAI, Together, Groq, custom endpoint, etc.)
export OPENAI_API_KEY=sk-...

# Or use Grok via OAuth (Device Authorization Grant — RFC 8628)
zelari-code
# Inside the TUI: /login grok
# → A code + verification URL appears; open the URL, enter the code, authorize.

# Or use GLM/Z.AI
export GLM_API_KEY=...

# Run zelari-code from any directory
zelari-code
```

## Slash Commands

Full reference: **[docs/GUIDA.md](./docs/GUIDA.md#comandi-slash)** (all flags, examples, skill IDs).

| Command | Description |
|---|---|
| `/help` | List all commands + loaded skills |
| `/exit` | Exit the CLI |
| `/login <provider> [key]` | Set API key; `/login grok` starts OAuth |
| `/provider`, `/provider <id>` | Show / switch LLM provider |
| `/provider custom <url>` | Self-hosted endpoint (Ollama, LM Studio, …) |
| `/model <name>`, `/models` | Set model / list discovered models |
| `/skill <id> [input]` | Invoke a coding skill (23 built-in + SKILL.md) |
| `/skill-stats [id]` | Skill invocation stats |
| `/skill-compare <id1> <id2>` | Compare two skills' stats |
| `/council <input>` | Run the 6-member council pipeline |
| `/zelari <input>` | Run an autonomous mission — multi-run council until the MVP slice is complete |
| `/council-feedback <id> <1-5>` | Rate a council member |
| `/promote-member <id>` | Promote a council member to a skill |
| `/sessions`, `/resume <id>`, `/new` | Session management |
| `/branch <name>`, `/branches`, `/checkout <name>` | Session branches |
| `/compact`, `/clear` | Compact / clear transcript |
| `/diff [--staged]`, `/undo --yes` | Git diff / revert (destructive) |
| `/steer <text>`, `/steer --interrupt <text>` | Queue follow-up during a run |
| `/workspace …` | `.zelari/` artifacts + `AGENTS.MD` |
| `/update`, `/update --yes` | Check / install CLI updates |
| `/mode [agent\|council\|zelari]` | Switch dispatch mode (shift+tab fallback) |

**TUI:** `shift+tab` cycles **agent** → **council** → **zelari** mode for free-form prompts (with terminal-fallback hardening since v1.3.0). The equivalent command `/mode [agent|council|zelari]` works in any terminal.

## Headless Mode

Run a single task without the TUI (CI/scripts):

```bash
zelari-code --headless --task "Explain src/cli/main.ts" --output plain
zelari-code --headless --task "Design a REST API" --council --output json
```

See **[docs/GUIDA.md](./docs/GUIDA.md#modalità-headless-ciscript)** for exit codes and all flags.

## Self-Update

Zelari Code includes a built-in update mechanism:

```bash
# Inside the TUI:
/update          # check for updates (prints current vs latest)
/update --yes    # apply update (runs npm install -g zelari-code@latest)
```

On startup, the CLI silently checks the npm registry. If a newer version is available, it prints a one-line hint to stderr.

Disable auto-check: `ANATHEMA_DEV=1 zelari-code`

## Features

- 🤖 **Multi-agent council** — 6 roles (Caronte, Nettuno, Gerione, Plutone, Minosse, Lucifero) with feedback loops and member promotion
- ⚡ **Zelari-mode** — autonomous multi-run missions: a free-form prompt is turned into a structured mission brief, then the council loops (design → implementation) until the MVP slice's `completion.ok` is green or the iteration budget runs out
- 🧠 **Project memory** — zero-dependency file-based recall (`.zelari/memory/`), fed into the council as RAG context between mission slices (opt-out with `ZELARI_MEMORY=0`)
- ⇧⇥ **Agent/council/zelari mode switch** — `shift+tab` cycles free-form prompts between the single agent, the full council pipeline, and an autonomous mission (mode shown in the status line)
- 🎨 **Rich TUI** — Ink + React: native-scrollback chat stream, input bar with status line below it (mode · provider · model · session · cwd · execution timer)
- 🗂️ **Live git sidebar** — right-hand panel with the N-THEM emblem and the working-tree changes (`+added`/`-removed` per file, refreshed every 4s; auto-hidden on narrow terminals)
- ⏱️ **Execution timer** — elapsed time of the in-flight turn in the status line (`⏱ 12s`), frozen as `last 34s` when the run completes
- 🧠 **Provider-agnostic** — OpenAI-compatible APIs (OpenAI, Together, Groq, custom), xAI Grok with OAuth refresh, GLM/Z.AI
- 🛠️ **Built-in tools** — filesystem (read/write/edit), shell (bash), search (grep), web fetch/search
- 🧠 **LSP code intelligence** (`lsp_*` tools) — go-to-definition, find references, hover type, document symbols, rename symbol via real language servers (tsserver, pyright, …)
- 🌲 **AST structural tools** (`ast_*` tools) — symbol outline + find-by-name via the TypeScript compiler API, no language server needed
- 🔎 **Semantic search** (`semantic_search` + `/index`) — concept-level code search via embeddings, local-first
- 🌐 **Browser verification** (`browser_check`) — headless browser with click/fill/goto/wait actions, console + network + screenshot capture for visual verification of web work
- 📚 **23 coding skills** (+ user `SKILL.md` from `.zelari/skills/`, `.claude/skills/`, …)
- 🔄 **Cross-provider failover** — automatic retry with provider swap on transient errors
- 📊 **Metrics + skill history** — fire-and-forget logging to `~/.tmp/zelari-code/`
- 🗜️ **Session management** — JSONL transcripts, resume across restarts, compaction
- 🌿 **Branch isolation** — session snapshots per branch
- 🔌 **MCP** — external MCP servers via `.zelari/mcp.json`
- 🆕 **Self-update** — `/update` slash command + silent registry check on startup

## Architecture

```
zelari-code (CLI, proprietary)
├── src/cli/                  # Ink TUI, provider config, workspace, wizard, MCP
│   ├── components/           # ChatStream, InputBar, Sidebar, StatusBar, …
│   ├── slashHandlers/        # /provider, /workspace, /update, …
│   └── workspace/            # .zelari/ persistence + AGENTS.MD curation
└── packages/core/            # @zelari/core (MIT, npm)
    ├── core/                 # AgentHarness — provider-neutral agent loop
    ├── agents/               # Council API, roles, 23 skills, tool schemas
    ├── harness/tools/        # Tool registry + filesystem/shell/search/web
    ├── events/               # BrainEvent contract
    └── council/              # Run mode, tier banners
```

`AgentHarness` takes (model, provider, messages, tools) + a streaming function and yields `AsyncIterable<BrainEvent>`. The CLI subscribes and renders via `eventsToMessages()`. See [MIGRATION.md](./MIGRATION.md) for the v0.5+ package boundary.

## Environment Variables

| Variable | Description |
|---|---|
| `OPENAI_API_KEY` | OpenAI API key |
| `OPENAI_MODEL` | Default model (default: `grok-4`) |
| `OPENAI_BASE_URL` | Custom OpenAI-compatible endpoint |
| `GLM_API_KEY` | GLM/Z.AI API key |
| `GROK_API_KEY` | xAI Grok API key (alternative to OAuth) |
| `DEEPSEEK_API_KEY` | DeepSeek API key (models auto-discovered; default `deepseek-v4-pro`) |
| `MINIMAX_API_KEY` | MiniMax API key |
| `ANATHEMA_DEV=1` | Disable silent update check on startup |
| `ZELARI_NO_WIZARD=1` | Skip first-run wizard |
| `ZELARI_NO_SHIM_REPAIR=1` | Disable auto-repair of a missing Windows bin shim on install |
| `ZELARI_COUNCIL_TIER=lite` | Council with 3 members instead of 6 |
| `ZELARI_MCP=0` | Disable MCP servers |
| `ANATHEMA_FAILOVER=0` | Disable cross-provider failover |
| `ZELARI_MEMORY=0` | Disable the file-based project memory (`.zelari/memory/`) |
| `ZELARI_MISSION_AUTO=1` | Auto-start Zelari missions (skip the brief confirmation) |
| `ZELARI_MISSION_MAX_ITER` | Max Zelari mission iterations (default 10) |
| `ZELARI_MODE_MAX_TOOLS_LUCIFER` | Chairman (Lucifero) tool budget in zelari-mode (default 30) |

See **[docs/GUIDA.md](./docs/GUIDA.md#variabili-dambiente)** for the full list.

## Council Workspace

The CLI persists council output (decisions, risks, docs, plan, reviews) into a **project-local** `.zelari/` directory and auto-curates an `AGENTS.MD` at the project root.

### Layout

```
.zelari/                      # auto-gitignored, per-project
├── plan.md                   # phases / tasks / milestones (Markdown + YAML frontmatter)
├── risks.md                  # risk register (live, ordered by severity)
├── decisions/                # ADRs (Architecture Decision Records) — 001-<slug>.md
├── reviews/                  # Minosse verdict per council run
└── docs/                     # doc drafts produced by the council
AGENTS.MD                     # committed at project root, auto-curated from .zelari/
```

### Slash commands

| Command | Effect |
| --- | --- |
| `/workspace` | List all artifacts + usage hint |
| `/workspace show plan` | Render `.zelari/plan.md` |
| `/workspace show decisions` | List all ADRs (id, status, title) |
| `/workspace show risks` | Render `.zelari/risks.md` |
| `/workspace show agents` | Render `AGENTS.MD` (project root) |
| `/workspace show docs` | List `.zelari/docs/` drafts |
| `/workspace sync` | Re-run AGENTS.MD auto-curation (idempotent — no-op if unchanged) |
| `/workspace reset --yes` | Delete `.zelari/` (destructive — requires confirmation) |

### AGENTS.MD format

`AGENTS.MD` is partitioned into:

1. **Manual blocks** (free-form, preserved verbatim across updates) — write anything you want here.
2. **Auto-managed sections** delimited by `<!-- zelari:auto:start section="..." -->` / `<!-- zelari:auto:end -->` markers — overwritten each sync.

Auto-managed sections:
- `tech-stack` — languages, frameworks, build tools (derived from `package.json`)
- `decisions` — accepted ADRs (newest first, capped)
- `conventions` — code conventions observed in source tree
- `build` — build/test/lint commands
- `open-questions` — info-level risks + unsolved questions

Set `ZELARI_AGENTS_MD=0` to disable AGENTS.MD auto-curation.

### Storage layout internals

- Frontmatter: subset YAML (scalars, flow/sequence/block-sequence arrays, flow/block maps) — no external deps.
- Concurrency: per-key mutex (filesystem writes are serialized per artifact).
- Idempotency: hash comparison — AGENTS.MD write is skipped when no section changed (clean git diff).

See [`docs/plans/2026-07-01-council-workspace-cli-stubs.md`](./docs/plans/2026-07-01-council-workspace-cli-stubs.md) for the full schema.

## Documentation

| Doc | Description |
|---|---|
| [docs/GUIDA.md](./docs/GUIDA.md) | **Guida utente completa** (IT) |
| [docs/TOOLS.md](./docs/TOOLS.md) | Tool builtin, workspace, MCP |
| [MIGRATION.md](./MIGRATION.md) | Upgrade from ≤ 0.4.x |
| [docs/decisions/](./docs/decisions/) | ADRs (monorepo, npm publish, API policy) |

## Development

```bash
git clone https://github.com/N-THEM-Studio/zelari-code.git
cd zelari-code
npm install
npm run build:cli
npm link
zelari-code
```

### Run tests

```bash
npm test
```

### Typecheck

```bash
npm run typecheck
```

## Related Projects

- [AnathemaBrain](https://github.com/N-THEM-Studio/AnathemaBrain) — the Electron desktop GUI that shares the agent runtime + council system with this CLI
- Zelari Coder originated as the `npm run coder` script inside AnathemaBrain
- [@zelari/core on npm](https://www.npmjs.com/package/@zelari/core) — reusable agent runtime (MIT)

## License

Proprietary © 2026 [N-THEM Studio](https://github.com/N-THEM-Studio). See [LICENSE](./LICENSE).