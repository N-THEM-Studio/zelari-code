# Zelari Desktop

Optional **Tauri 2** installable shell for [zelari-code](https://github.com/N-THEM-Studio/zelari-code).

The **CLI stays the product of record** (`npm i -g zelari-code`). This app is a modern chat UI (Claude Desktop / Codex / Antigravity-inspired) that spawns:

```bash
node bin/zelari-code.js --headless --task "…" --output json
```

and streams NDJSON BrainEvents into the window.

## Requirements

- Node.js ≥ 20
- Rust toolchain (for Tauri)
- On Windows: MSVC build tools / WebView2 (usually preinstalled on Win10/11)
- A working Zelari CLI (monorepo build **or** global install)

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

## Modes & phases

| Control | Values | CLI flag |
|---------|--------|----------|
| **Mode** | Agent · Council · Zelari | `--mode agent\|council\|zelari` |
| **Phase** | Plan · Build | `--phase plan\|build` |
| **Provider / model** | from Settings / bar | `--provider` / `--model` |

Settings (⚙) reads `zelari-code --print-config` and writes via `--set-config`.

## Non-goals (v0.1 shell)

- Full rewrite of `@zelari/core` in Rust
- Computer-use / OS input injection (planned as opt-in later)
- Replacing the Ink TUI CLI

## Architecture

```
apps/desktop/          React + Vite UI
apps/desktop/src-tauri Rust host (spawn CLI, emit events)
bin/zelari-code.js     Existing CLI entry (unchanged)
packages/core          Coding brain (unchanged)
```
