# Zelari Code — VS Code extension (ACP PoC)

A proof-of-concept VS Code extension that talks to the **existing** headless
front door of the CLI: `zelari-code acp`, the Agent Client Protocol server
already smoke-tested in CI (`scripts/smoke-acp.mjs`). Start a session, watch
the tool-call stream, shut down clean — no new protocol, no new dependency,
no bundler.

Status: **PoC, not published.** No Marketplace release, no `vsce` packaging,
no custom LSP. Packaging/publishing are explicitly out of scope.

## What it does

| Command (Command Palette) | Behaviour |
|---|---|
| `Zelari: Start ACP Session` | Spawns the agent, runs `initialize` + `session/new` (cwd = first workspace folder), streams everything into the **Zelari ACP** Output Channel and shows the state in the status bar. |
| `Zelari: Send Prompt to ACP Session` | `showInputBox` → `session/prompt`, one turn at a time; tool calls and assistant text stream in live while the turn runs. |
| `Zelari: Cancel Current Turn` | `session/cancel` on the in-flight turn; the running prompt then settles with `stopReason: cancelled`. |
| `Zelari: Stop ACP Session` | Graceful stop: closes the agent's stdin (EOF — the CLI's documented clean exit), then kills the process only if it is still alive after 2 s. |

The status bar item (`$(pulse) Zelari ACP: running — 3f2a1b7c…`) is clickable
and runs *Stop*. `deactivate()` awaits the same stop path, so closing VS Code
does not leave an orphan agent.

## Requirements

- Node.js **>= 20.17.0** (the CLI's runtime floor).
- A `zelari-code` installation — either on `PATH`, or a checkout of this repo
  with `npm install && npm run build` (the ACP front door is served by
  `bin/zelari-code.js acp`, which needs `dist/`).

## Run it (Extension Development Host)

```text
# 1. from the repo root, once — the CLI the extension will drive
npm install
npm run build

# 2. compile the extension
npm run vscode:build          # or: npm run build --prefix apps/vscode

# 3. open the extension folder in VS Code and press F5
code apps/vscode              # then Run -> Start Debugging (F5)
```

A second VS Code window (the Extension Development Host) opens on
`apps/vscode`. There, open your Zelari checkout as a folder, then run
**Zelari: Start ACP Session** and **Zelari: Send Prompt to ACP Session**.
The "Zelari ACP" Output Channel (View → Output) shows the stream:

```text
[19:04:11] launching: node Z:\EasyPeasy\zelari-code\bin\zelari-code.js acp
[19:04:12] initialize: protocolVersion 1 (this extension speaks v1), loadSession false
[19:04:12] session ready: 9d1c… (cwd: Z:\EasyPeasy\zelari-code)
[19:04:20] user> add a smoke test for the parser
[19:04:21] tool> read_file [pending] (call-7)
[19:04:21] tool> call-7 -> completed
[19:04:22] text> I'll start by reading the parser…
[19:04:44] turn> end_turn
[19:04:47] stopping (command): closing the agent's stdin (EOF)
[19:04:47] session closed: shutdown
```

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `zelari.cliPath` | `""` | Absolute path to `<checkout>/bin/zelari-code.js`. When set, the agent runs as `zelari.nodePath <cliPath> <args>` with **no shell** — the recommended, Windows-safe form. |
| `zelari.nodePath` | `"node"` | Node runtime for the `cliPath` form (useful when `node` is not on the Extension Host's `PATH`). |
| `zelari.command` | `"zelari-code"` | Command on `PATH` (default: `zelari-code acp`). Ignored when `cliPath` is set. |
| `zelari.args` | `["acp"]` | Arguments for the command above. |

On Windows a bare command is spawned **through a shell**, because
`zelari-code` resolves to the `zelari-code.cmd` shim and Node refuses to
spawn `.cmd` files without one. That is the only reason the command and args
are validated against shell metacharacters (`& | < > ^ " ' ...`): a rejected
metacharacter is reported in the Output Channel with the fix (`zelari.cliPath`)
instead of being handed to `cmd.exe`. Setting `zelari.cliPath` avoids the
shell entirely.

## Protocol surface used (nothing invented)

Transcribed 1:1 from the server (`src/cli/acp/protocol.ts`), which advertises
`protocolVersion: 1`, `loadSession: false`, `authMethods: []`:

- **client → agent**: `initialize`, `session/new { cwd }`,
  `session/prompt { sessionId, prompt: [{type:'text',text}] }`,
  `session/cancel { sessionId }`, plus the `initialized` notification.
- **agent → client**: `session/update` notifications carrying
  `agent_message_chunk`, `tool_call` and `tool_call_update` (statuses
  `pending | in_progress | completed | failed`).
- **errors**: JSON-RPC numeric codes *and* the server's stable string code in
  `error.data.code` — both are preserved (`AcpResponseError`).

Not used, because the server does not implement them (see its non-goals):
reverse requests (`session/request_permission`, `fs/*`, `terminal/*`), so the
CLI never prompts from the editor and the extension has no file/terminal
access; `session/load`/`resume`; session modes/models; auth flows;
client-supplied MCP servers; non-text content blocks.

## Architecture — two layers

```text
apps/vscode/src/
  acpTransport.ts   seam: transport interface + stable error codes   (no vscode)
  ndjson.ts         NDJSON framing: encode + incremental decode      (no vscode)
  protocol.ts       the served subset + line formatter for the UI    (no vscode)
  acpClient.ts      id correlation, fan-out, shutdown semantics      (no vscode)
  childTransport.ts real child process: spawn, stdio, EOF/kill       (no vscode)
  vscode.d.ts       minimal ambient API declarations (5 APIs used)
  sessionView.ts    OutputChannel + status bar                       (adapter)
  extension.ts      commands + lifecycle                             (adapter)
```

Everything above `sessionView.ts` is pure Node: the protocol client is
unit-tested with an in-memory duplex (no child, no host, no network) and the
transport is tested against a real child process (a fixture agent that mirrors
the real server, and the real bundled CLI when `dist/` is present).

## Tests

```text
npx vitest run apps/vscode/src        # from the repo root (root vitest picks
                                      # these files up in `npm test` anyway)
npm run typecheck:tests --prefix apps/vscode   # type-check the test files too
```

The suite covers: NDJSON framing (partial lines, several messages per chunk,
CRLF, blank lines, garbage lines, EOF salvage, runaway guard), request-id
correlation and out-of-order responses, error mapping (both codes),
notification fan-out with a throwing listener, shutdown semantics (EOF first,
kill idempotent, pending requests rejected, exactly ONE terminal event) and
the launch resolution rules (including the Windows metacharacter refusal).

## Known limits (PoC)

- One session at a time, and `session/prompt` resolves only when the turn
  ends; **Zelari: Cancel Current Turn** sends `session/cancel` and the turn
  settles with `stopReason: cancelled` (no mid-turn stream editing and no
  partial-diff UI — those stay out of this PoC's scope).
- No permission UI: the CLI runs its own permission/policy stack for its own
  tools, and the ACP subset has no reverse requests.
- `zelari.stopSession` force-kills the direct child only. When the agent was
  started through a shell (Windows default), the shell is what gets killed —
  prefer `zelari.cliPath`, which spawns Node directly.
- The extension version is intentionally NOT in the repo's lockstep version
  gate (`scripts/verify-versions.mjs` covers the root, `@zelari/core` and
  Desktop): it is a PoC artifact, not a released product.
