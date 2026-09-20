# zelari-plugin-example — WS6 plugin bundle (format v1)

A minimal but **real** bundle: one `SKILL.md`, one observer hook and one stdio
MCP server. Nothing here is a stub — the hook is spawned by the same
`LifecycleHookRunner` as any other hook, and `mcp/echo-mcp.mjs` is a working
MCP server you can drive by hand:

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' | node mcp/echo-mcp.mjs
```

## Layout

```text
zelari-plugin.json                  the manifest (format v1)
skills/repo-hygiene/SKILL.md        a real skill (frontmatter + instructions)
hooks/permission-observer.json      a HookDefinition file (observer event)
hooks/permission-observer.mjs       the hook process (JSON on stdin, JSON out)
mcp/echo-mcp.mjs                    a real MCP stdio server, zero deps
```

## Validate it

```bash
node bin/zelari-code.js plugin validate examples/extensions/zelari-plugin-example
```

Exit `0` when valid, `1` with one line per problem (always naming the file and
the field). Validation is **static**: no install, no execution, no network.

## Manage it

```bash
node bin/zelari-code.js plugin list
node bin/zelari-code.js plugin enable  examples/extensions/zelari-plugin-example
node bin/zelari-code.js plugin disable examples/extensions/zelari-plugin-example
```

State lives in `.zelari/plugins.json` of the project root (`--cwd <path>` to
target another project). **A bundle that is present but not listed is
DISABLED** — `enable` is the only thing that turns contributions on, and it
validates the bundle first (a broken bundle cannot be switched on. `disable`
reads only the manifest name, so a bundle whose declared files are broken can
always be switched off). Enabling records the directory **containing** the
bundle in `paths`, which is what `plugin list` scans — that is why a disabled
bundle stays visible instead of silently disappearing.

## Manifest fields

| Field | Required | Notes |
|---|---|---|
| `formatVersion` | no | defaults to `1`; any other value is rejected |
| `name` | yes | slug (`a-z 0-9 -`), also the key in `.zelari/plugins.json` |
| `version` | yes | free-form string |
| `description` | no | shown nowhere yet, reserved for the future marketplace |
| `skills[]` | no | `{ id, path }` — `id` must equal the `name:` in the SKILL.md |
| `hooks[]` | no | `{ event, path, config? }` — see the two traps below |
| `mcp[]` | no | `{ name, preset \| command, args? }` — exactly one of the two |
| `agents[]` | no | `{ id, path, description? }` — validated, **not executed** |

Every path is relative to the bundle directory. Absolute paths and `..` are
rejected: a bundle can only ship files it actually contains. `$comment` is
accepted anywhere and stripped — documentation never reaches a consumer.

### Trap 1 — the hook must subscribe to the event it declares

`hooks[].event` is checked against the `match.events` **inside the hook file**.
A bundle hook whose file subscribes to `PreToolUse` while the manifest claims
`PermissionRequest` would load and never fire, so validation rejects it.

`hooks[].config` may override **only** `timeoutMs` and `cwd`. `command`, `url`,
`match` and `name` stay owned by the hook file, so a manifest can never smuggle
in an executable the file does not already declare.

The observer event's reply is **discarded** (`@zelari/core/harness`): an
observer cannot block a tool, which is why the example always answers
`{"decision":"allow"}`. Set `ZELARI_EXAMPLE_HOOK_LOG=<file>` to get one JSONL
record per permission event.

### Trap 2 — hook and MCP commands resolve against the process CWD

Hook commands are spawned as an explicit argv with `shell: false`, and MCP
`args` are passed through verbatim. Both therefore resolve **relative paths
against the working directory of the zelari-code process**, not against the
bundle directory. From this repo root you can start the MCP server directly:

```bash
node examples/extensions/zelari-plugin-example/mcp/echo-mcp.mjs
```

To register the bundle's relative paths regardless of where the agent runs,
give the hook an absolute `cwd` in `hooks[].config` (or use absolute command
paths). This example keeps them relative on purpose: it is meant to be read.

### The `preset` form

`mcp[]` also accepts a repo preset id instead of a command:

```json
{ "name": "my-unreal", "preset": "unreal-mcp" }
```

Presets come from `src/cli/mcp/mcpPresets.ts` (`cua`, `composio`,
`qwen-mm-plugins`, `unreal-mcp`); an unknown id fails validation and the error
lists the known ones. Presets are factories: an API key is read from the
environment at APPLY time, never stored in a bundle — which is exactly why the
manifest schema has no `env` field.

## Enablement is not installation

`plugin enable` records intent. This release ships no marketplace, no
`/plugin:cmd` namespace and no synchronization step: a loaded bundle produces a
**contribution list** (`src/cli/plugins/bundleLoad.ts`), and applying those
contributions to the running agent is the next workstream. The `agents[]` field
is declared and validated today but has no loader, and is reported as a warning
rather than silently ignored.
