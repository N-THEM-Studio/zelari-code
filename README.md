# Zelari Code

> AI Council coding agent CLI — multi-agent orchestration with slash commands, provider-agnostic LLM streaming, and self-update.

![Version](https://img.shields.io/npm/v/zelari-code)
![License](https://img.shields.io/badge/license-Proprietary-red)
![Node](https://img.shields.io/node/v/zelari-code)

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
│ zelari-code v0.5.0 — first-time setup    │
│ 1/welcome  2/provider  3/model  4/apikey  5/...│
│                                                 │
│ Welcome! Let's get you coding in under 2 min.   │
│ Press [Enter] to continue, [Q] to quit.         │
╰─────────────────────────────────────────────────╯
```

The wizard walks you through:

1. **Welcome** — overview + how to quit.
2. **Provider** — pick from `grok`, `minimax`, `glm`, `openai-compatible` (↑/↓ + Enter).
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

| Command | Description |
|---|---|
| `/help` | List all available commands |
| `/skill <name>` | Invoke a coding skill (refactoring, testing, debugging, review, planning, docs, git-ops) |
| `/skills` | List available skills |
| `/skill-suggest <query>` | Get skill suggestions for a coding task |
| `/skill-history` | Show skill invocation history |
| `/skill-compare <id1> <id2>` | Compare two skills' stats |
| `/provider` | Show/set active LLM provider |
| `/model <model>` | Set model for current provider |
| `/key <provider>` | Set API key (or start device OAuth flow for Grok) |
| `/cost` | Show session cost breakdown |
| `/compact` | Compact the chat transcript |
| `/session` | Show session info |
| `/sessions` | List past sessions |
| `/resume [id]` | Resume a past session |
| `/branch [name]` | Create/list/switch git branches |
| `/diff` | Show working diff |
| `/undo` | Undo working changes |
| `/update` | Check for CLI updates |
| `/update --yes` | Apply update |
| `/update force` | Reinstall latest version |
| `/steer <text>` | Queue follow-up prompt during active run |
| `/steer --interrupt <text>` | Cancel current run + enqueue prompt |
| `/promote-member <role>` | Promote a council member (role depth system) |
| `/council` | Dispatch council task |
| `/quit` / `/exit` | Exit the CLI |

## Self-Update

Zelari Code includes a built-in update mechanism:

```bash
# Inside the TUI:
/update          # check for updates (prints current vs latest)
/update --yes    # apply update (runs npm install -g zelari-code@latest)
/update force    # reinstall latest (even if already on latest)
```

On startup, the CLI silently checks the npm registry. If a newer version is available, it prints a one-line hint to stderr.

Disable auto-check: `ZELARI_DEV=1 zelari-code`

## Features

- 🤖 **Multi-agent council** — 6 roles (Caronte, Nettuno, Gerione, Plutone, Minosse, Lucifero) with feedback loops and member promotion
- 🎨 **Rich TUI** — Ink + React multi-panel interface (header, chat stream, sidebar, input bar)
- 🧠 **Provider-agnostic** — OpenAI-compatible APIs (OpenAI, Together, Groq, custom), xAI Grok with OAuth refresh, GLM/Z.AI
- 🛠️ **Built-in tools** — filesystem (read/write/edit), shell (bash), search (grep), git operations
- 📚 **7 coding skills** — refactoring, testing, debugging, review, planning, docs, git-ops
- 🔄 **Cross-provider failover** — automatic retry with provider swap on transient errors
- 💰 **Cost tracking** — per-turn + cumulative USD cost via model pricing registry
- 📊 **Metrics + skill history** — fire-and-forget logging to `~/.tmp/zelari-code/`
- 🗜️ **Session management** — JSONL transcripts, resume across restarts, compaction
- 🌿 **Branch isolation** — worktree-per-session mode for safe experimentation
- 🔌 **Slash command system** — 30+ commands for skill invocation, provider config, cost, sessions, etc.
- 🆕 **Self-update** — `/update` slash command + silent registry check on startup

## Architecture

```
zelari-code (CLI)
├── src/cli/                  # Ink UI (app.tsx, slashCommands.ts, updater.ts, …)
│   ├── components/           # Header, ChatStream, InputBar, Sidebar, …
│   ├── provider/             # OpenAI-compatible adapter
│   └── …
├── src/agents/               # Council (councilApi), skills registry, promoteMember
├── src/main/core/            # AgentHarness (provider-neutral agent loop)
│   └── tools/                # Tool registry + filesystem/shell/search builtins
├── src/shared/               # BrainEvent types (provider-neutral event contract)
└── src/types/                # Workspace, context, knowledge types
```

`AgentHarness` is the core: it takes (model, provider, messages, tools) + a streaming function and yields an `AsyncIterable<BrainEvent>`. The CLI subscribes to the event stream and updates the chat transcript via `eventsToMessages()`.

## Environment Variables

| Variable | Description |
|---|---|
| `OPENAI_API_KEY` | OpenAI API key |
| `OPENAI_MODEL` | Default model (default: `grok-4`) |
| `OPENAI_BASE_URL` | Custom OpenAI-compatible endpoint |
| `GLM_API_KEY` | GLM/Z.AI API key |
| `GROK_API_KEY` | xAI Grok API key (alternative to OAuth) |
| `ZELARI_DEV=1` | Disable silent update check on startup |
| `ANATHEMA_FAILOVER=0` | Disable cross-provider failover |

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

## License

Proprietary © 2026 [N-THEM Studio](https://github.com/N-THEM-Studio). See [LICENSE](./LICENSE).