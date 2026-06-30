# Zelari Code

> AI Council coding agent CLI — multi-agent orchestration with slash commands, provider-agnostic LLM streaming, and self-update.

![Version](https://img.shields.io/npm/v/zelari-code)
![License](https://img.shields.io/npm/l/zelari-code)
![Node](https://img.shields.io/node/v/zelari-code)

**Zelari Code** is a standalone CLI extracted from [AnathemaBrain](https://github.com/N-THEM-Studio/AnathemaBrain). It brings the multi-agent council (Sisyphus, Prometheus, Hephaestus, Atlas, Oracle, Chairman) directly into your terminal with a rich TUI (Ink + React), slash command system, and provider-agnostic LLM streaming (OpenAI-compatible, xAI Grok with OAuth, GLM/Z.AI).

## Install

```bash
npm install -g zelari-code
zelari-code
```

Requires **Node.js ≥ 20**.

## Quick Start

```bash
# Set your OpenAI-compatible API key (OpenAI, Together, Groq, custom endpoint, etc.)
export OPENAI_API_KEY=sk-...

# Or use Grok via OAuth
zelari-code
# Inside the TUI: /key grok (then follow the OAuth flow)

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
| `/key <provider>` | Set API key (or start OAuth flow for Grok) |
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

- 🤖 **Multi-agent council** — 6 roles (Sisyphus, Prometheus, Hephaestus, Atlas, Oracle, Chairman) with feedback loops and member promotion
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

MIT © 2026 [N-THEM Studio](https://github.com/N-THEM-Studio)