# Zelari Desktop

Optional **Tauri 2** installable shell for [zelari-code](https://github.com/N-THEM-Studio/zelari-code).

The **CLI stays the product of record** (`npm i -g zelari-code`). This app is a modern chat UI that spawns:

> **Installer ≠ CLI.** Downloading a Desktop release from GitHub does **not** install or upgrade the global `zelari-code` package. The app is a UI shell that spawns the CLI headless.

```bash
node bin/zelari-code.js --headless --task "…" --output json
```

and streams NDJSON BrainEvents into the window.

### First launch (end users)

If Node or the CLI is missing, Desktop shows a **Setup** overlay:

1. **Node.js ≥ 20** on PATH ([nodejs.org](https://nodejs.org/) LTS)
2. **Install CLI** — one-click `npm install -g zelari-code` (when Node is present), or run the command manually
3. **API key** — Settings → Provider

You can also use Settings → **Updates** → **Update CLI** later. Monorepo developers can point at a local build with `ZELARI_CLI_PATH`.

## Requirements

- Node.js ≥ 20
- Rust toolchain (for Tauri)
- On Windows: MSVC build tools / WebView2 (usually preinstalled on Win10/11)
- A working Zelari CLI (monorepo build **or** global install)
- For SSH targets: OpenSSH client (`ssh`) on PATH

## Develop

From repo root:

```bash
# build CLI so headless works
npm run build

# install desktop deps + run Tauri dev
cd apps/desktop
npm install
npm run tauri:dev
```

Or from root (after desktop `npm install`):

```bash
npm run desktop:dev
```

### CLI resolution

Order used by the Rust host:

1. `ZELARI_CLI_PATH` — path to `bin/zelari-code.js` or monorepo root
2. Walk up from cwd / exe for `bin/zelari-code.js`
3. `zelari-code` on `PATH`

## Build installers

```bash
cd apps/desktop
npm run tauri:build
```

Artifacts land under `apps/desktop/src-tauri/target/release/bundle/` (msi/nsis on Windows, dmg on macOS, deb/AppImage on Linux).

### App icon & NSIS branding

OS / installer icons are **independent** of the in-app logo (`src/assets/zelari-logo.png`).

| Asset | Path |
|-------|------|
| Master PNG (1024×1024) | `src-tauri/app-icon-source.png` |
| Generated icon set | `src-tauri/icons/` (`icon.ico`, `icon.icns`, PNG sizes) |
| Source photos | `src-tauri/installer/source/logonsis.jpg`, `lateralnsis.jpg` |
| NSIS header / sidebar | `src-tauri/installer/nsis-header.bmp` (150×57), `nsis-sidebar.bmp` (164×314) |

Regenerate after changing artwork:

```bash
cd apps/desktop
# App / taskbar / shortcut icon = in-app logo + brand-mark contour (rounded + cyan ring)
python scripts/gen-app-icon-from-ui.py
npx tauri icon src-tauri/app-icon-source.png
# optional: NSIS sidebar/header BMP from installer/source/*.jpg
python scripts/gen-installer-assets.py
npm run tauri:build
```

The in-app image `src/assets/zelari-logo.png` is never overwritten by these scripts.

NSIS options live in `src-tauri/tauri.conf.json` → `bundle.windows.nsis` (`installerIcon`, `headerImage`, `sidebarImage`, languages).

## Floating overlay bar (HUD)

Detachable always-on-top bar that stays usable when the main window is minimized:

- **Open:** title bar button **◉** (or recreate via the same control)
- **Compact + glass:** thin bar at rest; stronger transparency + blur
- **Auto-resize:** window grows with the final answer; text sits in a max-height scrollable panel
- **Voice:** browser/WebView speech recognition → prompt (type as fallback)
- **Output:** only assistant `message_delta` text (no thinking / tools)
- **States:** mic off · listening · processing · agent working
- Uses the same headless `run_task` as the main chat (mode/phase/workdir from local defaults + Open Folder)

```bash
# multi-page Vite entry: index.html + overlay.html
npm run build
```

## Modes & phases

| Control | Values | CLI flag |
|---------|--------|----------|
| **Mode** | Agent · Council · Zelari | `--mode agent\|council\|zelari` |
| **Phase** | Plan · Build | `--phase plan\|build` |
| **Provider / model** | from Settings / bar | `--provider` / `--model` |
| **Open Folder** | workdir for this window | CLI `current_dir` |

Settings (⚙) reads `zelari-code --print-config` and writes via `--set-config`.

Also supported from Settings / CLI:

| Action | CLI |
|--------|-----|
| Custom OpenAI base URL | `--set-config --provider openai-compatible --endpoint <url>` |
| Store API key | `--set-key --provider <id> --key <secret>` |
| Refresh models | `--discover-models --provider <id>` (also on model select open) |
| MCP list / install | `--print-mcp` / `--set-mcp` / `--remove-mcp` |
| SSH targets | `--print-ssh-targets` / `--set-ssh-target` / `--test-ssh-target` |

Chats: Active / Archived filters, archive ⬇, delete × (localStorage); multi-turn history via `--history-file`.

Replies: light structured view (headings, lists, tables, code); tool calls as **ToolCallCard**; thinking animation; run stats.

## Project panel

**Files | Git** beside the chat — lazy directory tree under the open folder (Tauri `list_dir`).

## MCP Extensions

Settings → **MCP Extensions**: curated catalog of common MCP servers. Install writes Claude-compatible entries to project or user `mcp.json` (`npx -y …` on demand). Full guide: [docs/GUIDA.md](../../docs/GUIDA.md#mcp-model-context-protocol).

## SSH Connections

Settings → **Connections**: register hosts for agent tools `ssh_status` / `ssh_run`.

| Auth | Fields |
|------|--------|
| **Password** (default) | Host/IP, username, password, port |
| **ssh-agent** | Host/IP, user — keys already in agent |
| **File key pair** | Private key path + optional `.pub` (Load / Copy public key) |

- Targets: `~/.zelari-code/ssh-targets.json`
- Passwords only: `~/.zelari-code/ssh-secrets.json` (not sent to the model)
- Remote commands must match the target **allowlist**
- Kill switch: `ZELARI_SSH=0`

Guide: [docs/GUIDA.md — SSH](../../docs/GUIDA.md#ssh-deploy--monitor).

## Auto-update (two channels)

| Channel | What | Where |
|---------|------|--------|
| **App** | Desktop binary | Tauri updater → GitHub Releases `latest.json` |
| **CLI** | `zelari-code` on npm | Settings → Update CLI / topbar when outdated |

### Signing (maintainers)

```bash
cd apps/desktop
npx tauri signer generate -w keys/zelari.key --ci   # once; never commit the private key
```

GitHub Actions secrets:

| Secret | Value |
|--------|--------|
| `TAURI_SIGNING_PRIVATE_KEY` | Full contents of `keys/zelari.key` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Password if set (optional) |

Public key is embedded in `src-tauri/tauri.conf.json` → `plugins.updater.pubkey`.  
`bundle.createUpdaterArtifacts: true` produces `.sig` + `latest.json` on release builds.

## Non-goals

- Full rewrite of `@zelari/core` in Rust
- Computer-use / OS input injection (planned as opt-in later)
- Replacing the Ink TUI CLI
- Interactive full SSH terminal (OpenSSH tools + config only)

## Architecture

```
apps/desktop/          React + Vite UI (TitleBar, ProjectPanel, Settings, MCP, SSH)
apps/desktop/src-tauri Rust host (spawn CLI, emit events, list_dir, IPC)
bin/zelari-code.js     Existing CLI entry
packages/core          Coding brain
src/cli/ssh/           SSH targets + tools
src/cli/mcp/           mcp.json I/O helpers
```
