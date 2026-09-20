# Zelari Code - Tool & Skill Map (>= 1.34)

Map of tools, skills and extension sources. Aligned with the CLI registry
(`src/cli/toolRegistry.ts`) and the workspace stubs.

Product: [Anathema Studio](https://anathema-studio.com/) - CLI Apache-2.0.

## Built-in (harness) tools - available everywhere

| Tool | Permissions | Notes |
|------|----------|------|
| `read_file` / `write_file` / `edit_file` | read/write | sandboxed on the project root |
| `bash` | execute | shell blocklist; Git Bash on Windows |
| `exec_process` | execute | P0.C2: structured execution **without a shell** - direct spawn of `program`+`args[]`; cwd sandboxed to the workspace, timeout, closed stdin; returns `{exitCode, stdout, stderr, durationMs}` and records `program+argv+exitCode` in the audit |
| `grep_content` | read | recursive regex with include/exclude globs |
| `list_files` | read | recursive listing with depth |
| `show_diff` / `apply_diff` | read/write | diff preview + patch |
| `fetch_url` | network | http(s) only, HTML->text, timeout + char cap |
| `web_search` | network | DuckDuckGo HTML; `TAVILY_API_KEY` for Tavily |
| `task` | read / write (`general`) | isolated tentacle: `explore` (RO), `general` (bounded write), `verify`; no recursion |
| `ask_user` | - | one structured question (choices) when a fact is missing |
| `update_world_hypothesis` | write | `.zelari/world/hypothesis.md` (Schema-style notes) |
| `set_world_checks` | write | `.zelari/world/checks.json` |
| `run_backtest` | execute | certifies the checks; no claim-done while red |
| `record_world_observation` | write | append-only timeline |

World-model tools: kill switch `ZELARI_SCHEMA_LOOP=0`. Skill: `schema-loop`.

**P0.D sandbox - symlink-safe:** every path argument of the filesystem tools
goes through the centralized gate `resolveSandboxedPath`
(`src/cli/safety/sandboxPath.ts`), now two-tier: textual normalization (`..`,
prefixes) **+ realpath of the deepest existing ancestor** against the real
root. Links/junctions resolving outside the workspace (including `a->b->out`
chains and cross-drive links on Windows) are rejected with
`SandboxViolationError`; internal links stay valid and the comparison ignores
case only on win32/darwin. Resolution and write are adjacent in the registry
wrap (guaranteed once); the anti-TOCTOU re-check is exported as
`verifyContainment()`.

## Advanced capabilities (opt-in)

| Tool | Permissions | Prereq | Notes |
|------|----------|--------|------|
| `lsp_definition` / `lsp_references` / `lsp_hover` / `lsp_symbols` / `lsp_rename` | read / write (`rename`) | language server on PATH | kill switch `ZELARI_LSP=0` |
| `ast_outline` / `ast_find_symbol` | read | none (TS Compiler API) | `ZELARI_AST=0` |
| `semantic_search` | read | embeddings on first use; `/index` | `ZELARI_SEMANTIC=0` |
| `browser_check` | sandboxed network | Playwright + chromium | `ZELARI_BROWSER=0`. Actions: `click` / `fill` / `wait` / `goto` / **`evaluate`** / **`press`** / **`waitForText`**. Prefer DOM asserts over `window.*` (ES modules hide symbols). No selector/text/evaluate -> result `smokeStrength: "weak"`. |

**Diagnostics loop** (not a separate tool): after `write_file` / `edit_file` /
`apply_diff` the harness can run `eslint`/`ruff` and append errors to the
result. `ZELARI_DIAGNOSTICS=0`.

## SSH (deploy / monitor)

| Tool | Notes |
|------|------|
| `ssh_status` | Health check on a configured target |
| `ssh_run` | Remote command **allowlist-only** |

Config: `~/.zelari-code/ssh-targets.json` (+ separate secrets). Kill switch:
`ZELARI_SSH=0`.
Desktop: Settings -> Connections.

## Workspace tools (`.zelari/`)

Used mostly by the **council** (always registered there). Single agent: on
skill `requiredTools` or when a plan exists.

| Tool | Notes |
|------|------|
| **`createPlan`** | Preferred batch: phases + tasks + milestones in **one** call |
| `createPhase` / `createTask` / `updateTask` / `createMilestone` | Itemized (legacy / partial) |
| `createNfrSpec` | NFR spec (motion/perf/a11y) when needed |
| `createDocument` / `searchDocuments` / `linkDocuments` / `getDocumentBacklinks` | Project knowledge vault |
| `addIdea` | Ideation |

Alias: `searchRAG` -> `searchDocuments` (via registry "Did you mean").

## Native cognitive memory

Memory is neither an LLM tool nor an internal MCP server: AgentHarness,
Council, Kraken and missions call `MemoryService` directly. With
`ZELARI_MEMORY_V2=1`, the CLI uses SQLite in a worker and shares recall and
writes across tentacles and sessions. `/memory` exposes search, provenance,
relations, history, retraction, consolidation, doctor and export. See
[`MEMORY.md`](./MEMORY.md).

Semantic recall stays optional (`ZELARI_MEMORY_SEMANTIC=1`) and degrades to
FTS; `/memory index` rebuilds the versioned index. The external server
`--memory-mcp` requires folder trust and `ZELARI_MEMORY_MCP=1`, while native
integrations and the Desktop Memory tab keep using `MemoryService` directly.


### Workspace plan tasks (ADR-0018, v1.43.0)

Durable store of project tasks in `.zelari/plan.json` (`schemaVersion`/
`counter`/`tasks` envelope), shared across single agent, council and Desktop
Live Tasks. Distinct from session todos (`todo_write`/`todo_read`,
per-session volatile).

| Tool | Perm | Notes |
|------|------|------|
| **`task_create`** | write | Creates a `pending` task with sequential id `t<N>`; `title`, `priority?`, `phaseId?`, `notes?` |
| **`task_update`** | write | Update by `id`: `status?` (`pending|in_progress|completed|cancelled|blocked`), `title?`, `priority?`, `phaseId?`, `notes?`, `appendNote?`. `PLAN_TASK_NOT_FOUND` error on missing id. Also accepts council ids |
| **`task_list`** | read | Filterable snapshot (`status?`, `phaseId?`) + done/total count. Includes council tasks and `t<N>` |

Coexistence with the council: `done` is normalized on read to `completed`
(and the council writer accepts both on input); `t<N>` ids do not collide with
`<phaseId>-<slug>-<N>` ids; root fields outside the contract (`phases`,
`milestones`, metadata) are preserved in pass-through; atomic tmp+rename write
with `plan.json.bak` backup.

Registration: `full` and `planMode` profiles (never readOnly/explore/verify/
general). Future hardening: cross-process lock file.

## Plan phase vs build phase

Orthogonal to mode `kraken` | `council` | `zelari` (`/plan`, `/build`,
`--phase`; `agent` = alias).

| Phase | Registry behavior |
|-------|------------------------|
| **plan** | Blocked: `write_file`, `edit_file`, `apply_diff`, `bash` (and often `task`). `inspect_command` available (v0.10.0, read-only allowlisted inspector). Workspace plan/docs tools **allowed** |
| **build** | Full tools (sandbox + blocklist remain) |

## ACP front door (v2.50) — editor integration

`zelari-code acp` starts an **Agent Client Protocol** server on stdio — the
third front door after the TUI and headless. Speaks JSON-RPC 2.0 with
LSP-style framing (`Content-Length: <bytes>\r\n\r\n<json>`), implemented
in-tree (`src/cli/acp/`) with **zero new dependencies**.

- Methods v1: `initialize`, `session/new`, `session/prompt` (streaming
  `agent_message_chunk` + `tool_call` / `tool_call_update` notifications),
  `session/cancel`.
- Flags: `--cwd`, `--model`, `--provider`; `--help` prints the protocol summary.
- Fail-soft: any transport/parse error is reported as a JSON-RPC error and the
  server keeps running; EOF exits cleanly with code 0.
- Kill switch: `ZELARI_ACP=0` disables the subcommand.

Smoke test: `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}`
(framed) piped to `zelari-code acp` answers with `protocolVersion: 1`.

## inspect_command (v0.10.0)

**Read-only, allowlisted, shell-less** command inspector - registered exactly
where `bash` is absent: `plan` sessions, read-only sub-agents and `explore`
(full/verify keep `bash`).

- **Menu API, not a pseudo-shell**: input = discriminated union on
  `operation` - `git_status`, `git_log` (`limit`, `oneline`), `git_diff`
  (`staged`, `path`), `git_show` (`ref`), `git_branch_current`,
  `git_ls_files`, `typecheck` (`project`), `node_version`, `npm_ls`,
  `npm_outdated`, `npm_view` (`package`).
- The tool **builds argv internally** and uses `spawn(..., { shell: false })`:
  no tokenizer, metacharacters or quoting injection by construction. Forced
  flags on `git diff/show`: `--no-ext-diff --no-textconv`.
- `inspectionClass` in every result: `git-inspection` |
  `project-code-execution` (typecheck runs the project toolchain) |
  `env-info`.
- **typecheck (S3.5 artifact safety)**: `tsc --noEmit` with
  `--tsBuildInfoFile` redirected into `<tmp>/zelari-inspect/<hash>` (the
  redirect wins over tsconfig, works on `composite`/`incremental` projects
  too), pre/post guards (`git status --porcelain` + scan `**/*.tsbuildinfo`):
  any delta -> `status: "degraded"` + `artifactsWritten` + cleanup.
  Compiler-level rejection on unsupported shapes ->
  `status: "unsupported_project_shape"`, never a fake empty.
- Output cap 8 KB, timeout 85 s internal / 90 s tool-level.
- Windows: `typecheck` launches `node <root>/node_modules/typescript/bin/tsc`
  (loud `TYPESCRIPT_UNAVAILABLE` if missing); `npm_*` use `npm-cli.js` via
  node.
- Kill switch: `ZELARI_INSPECT_COMMAND=0`.
## Parallel tool batch (harness)

On a multi-`tool_call` finish, `AgentHarness` segments in emission order:

- **contiguous** runs of read-only tools -> `Promise.all` (chunk
  `ZELARI_MAX_PARALLEL_TOOLS`, default 6)
- tools with **write** or **execute** permission -> serial **barrier**
- result order = emission order (no reorder)

Opt-out: `ZELARI_PARALLEL_TOOLS=0`.

## MCP tools

Config (Claude-Desktop-compatible format; the project wins on conflicts):

- `<project>/.zelari/mcp.json`
- `~/.zelari-code/mcp.json`

Discovered tools are `mcp_<server>_<tool>`. Kill switch: `ZELARI_MCP=0`.
Hermetic / CI: `ZELARI_MCP_USER=0` ignores `~/.zelari-code/mcp.json`
(project config only).

### Cua Driver (desktop computer-use)

[Cua Driver](https://cua.ai/cua-driver) (trycua) drives **native apps** in the
background via MCP (click, type, window snapshot without stealing focus). It
is **not** vendored: you install the binary separately.

```bash
# 1) Install binary - https://cua.ai/docs/how-to-guides/driver/install
# 2) Register MCP preset (user scope):
zelari-code --set-mcp-preset cua

# Unreal Engine 5.8+ editor (MCP Streamable HTTP on loopback):
#   1) Editor: enable the "Model Context Protocol" plugin (Experimental)
#   2) Edit -> Project Settings -> Plugins -> MCP Server (default 127.0.0.1:8000/mcp)
#   3) Register the preset (endpoint overridable via UNREAL_MCP_URL):
zelari-code --set-mcp-preset unreal-mcp

# Manual equivalent:
# zelari-code --set-mcp --name cua-driver --command cua-driver --args '["mcp"]'
```

| Env | Effect |
|-----|---------|
| `ZELARI_CUA=0` | Does not start Cua MCP servers (`cua-driver`, `cua-*`) |
| `ZELARI_CUA_COUNCIL=1` | Exposes Cua tools to council turns too (default: **agent only**, to avoid saturating the 6 members) |
| `ZELARI_MCP=0` | Disables all MCP (including Cua) |

Prefer `browser_check` (Playwright) for the **web**; Cua for **native
desktop**.
Skill: `computer-use-cua` (`/skill computer-use-cua`). Doctor:
`zelari-code --doctor` reports if `cua-driver` is missing from PATH.

## Per-command/per-path policy (`.zelari/policy.json`)

The policy engine (P0.A) loads `<root>/.zelari/policy.json` (project) and
`~/.zelari/policy.json` (global = user floor) and intersects the rules with
category decisions: restrict-only, `deny > ask > allow`.

Policy file loading modes (**P0.B**, `ZELARI_POLICY_LOAD_MODE`):

| Mode | Existing but broken file (JSON/schema) |
|----------|----------------------------------------|
| `permissive` | warning + file ignored, never throws (v1 behavior; interactive TUI default) |
| `strict` | the run **blocks**: exit code 2, machine reason `policy-load-failed` |

Default: `strict` for **headless** runs, in **CI** (`CI=1`) and for **zelari**
missions; `permissive` in the interactive TUI. The explicit env always wins
over the defaults.

| Env | Effect |
|-----|---------|
| `ZELARI_POLICY_LOAD_MODE=strict\|permissive` | Forces the loading mode (invalid values ignored) |
| `ZELARI_POLICY_PRECEDENCE=legacy` | Restores the v1 project-first override (default: restrict-only) |
| `ZELARI_POLICY=0` | Turns the policy engine off (always empty set) |

In headless/mission mode an invalid file produces an NDJSON `error` event
(`code: "policy-load-failed"`), a note in the session spine (on-disk evidence)
and exit 2 - runtime/harness error: no execution without valid rules. The
machine error is `PolicyLoadError` with `code: 'policy_invalid'`, the file
path and, when available, the parse error line.

**Resource claims (P0.C1, `version: 2` schema):** every agent can declare an
optional `claims` section with per-resource rules - e.g.
`{ kind: 'path', operation: 'write', pattern: 'src/auth/**', effect: 'deny',
reason?: string }` (kinds: `path` | `process` | `network` | `mcp` | `ssh`;
`ui`/`agent` are parsed but not yet emitted). Every resource a call touches is
evaluated INDEPENDENTLY on the global/project layers and the decisions
intersect restrict-only (`deny > ask > allow`): ONE denied resource is enough
to block the whole call (e.g. an `apply_diff` whose diff touches a denied path
fails even if the primary argument is allowed). Read-only claims match only
`claims` rules; v1 `shell`/`edit` rules keep applying unchanged to
write/process. `version: 1` files stay valid without migration. Tool->claims
table details: `src/cli/safety/resourceClaims.ts`.

### exec_process (P0.C2, v2.1)

**Structured** process execution: no shell string, no interpolation (pipes,
globs, `$VAR`, quoting are just arguments).

| Arg | Type | Notes |
|-----|------|------|
| `program` | string | binary on PATH or absolute path (direct spawn, `shell:false`) |
| `args`? | string[] | argv passed verbatim to the OS |
| `cwd`? | string | resolved **inside the workspace sandbox** (`resolveSandboxedPath`) |
| `timeoutMs`? | number | default 30s, max 600s; kill + explicit error |

Result: `{ exitCode, stdout, stderr, durationMs }`; stdin closed
(non-interactive), stream cap 1 MB. Every invocation goes through the
permission wrapper (`withPerm`) and is evaluated by the resource claims table
as a `{ kind: 'process', executable, argv }` claim: the rule matches on
program (basename, Windows extension excluded) + argv prefix.

Why structured > raw shell: what the policy evaluates (argv) is what the OS
executes; with `bash` instead the classification is best-effort - the claims
table normalizes common wrappers (`env FOO=x git push`, `command git push`,
`exec git push`, `bash -lc 'git push'`, `cmd.exe /c git push`, extra spaces)
so that a raw-shell command points to the program that actually runs (it is
not a parser: ambiguity ? keeps the original).

Example policy rule (`.zelari/policy.json`, `version: 2`):

```json
{
  "version": 2,
  "agents": {
    "general": {
      "claims": [
        { "kind": "process", "pattern": "npm publish*", "effect": "ask" },
        { "kind": "process", "pattern": "git push*", "effect": "deny", "reason": "no direct pushes" }
      ]
    }
  }
}
```

The same rule also covers `bash "git push"` thanks to the normalization.

## Folder trust (v1.32.0)

The project can auto-execute code only if the folder is **trusted**. Trust
decides whether **project-scoped** MCP and lifecycle hooks are loaded
(`<project>/.zelari/mcp.json`, `<project>/.zelari/hooks/`). The user-global
config (`~/.zelari-code/.`) is **always** active.

| Command | Effect |
|---------|---------|
| `/trust` | Shows the trust status for the cwd |
| `/trust <path>` | Trusts the folder (default: cwd) |
| `/trust remove <path>` | Revokes trust |
| `zelari-code --trust [path]` | Same operation from the CLI (headless/CI) |

Persistence: `~/.zelari-code/trust.json`. Env override:

| Env | Effect |
|-----|---------|
| `ZELARI_FOLDER_TRUST=1` | Trusts every folder (CI / headless) |
| `ZELARI_FOLDER_TRUST=<path>` | Trusts exactly that folder |
| `ZELARI_FOLDER_TRUST=0` | Trust disabled (lockdown) |

When a folder is not trusted, `.zelari/mcp.json` and `.zelari/hooks/` are
**ignored** with a warning (`[mcp] project . ignored - folder not
trusted`).

## Lifecycle hooks (v1.32.0, observer events v2.57)

External hooks (process or HTTP) on tool/session events. **Fail-open**: a
hook that crashes, times out or returns invalid JSON **never blocks** a tool -
the only way to block is an explicit JSON decision.

```json
// ~/.zelari-code/hooks/deny-rm.json  (or <project>/.zelari/hooks/.)
{
  "name": "deny-rm",
  "match": { "tools": ["bash"], "events": ["PreToolUse"] },
  "command": "node deny-rm.mjs",
  "timeoutMs": 5000
}
```

- `match.tools`: Claude-style globs (`*` = any tool); `Bash` and `bash`
  both match `bash` (alias-aware: `Read`->`read_file`, `shell`->`bash`, ...).
- `command` **or** `url` (HTTP POST). The JSON payload goes to stdin / body;
  the decision arrives on stdout / body: `{ "decision": "allow" }` or
  `{ "decision": "deny", "reason": "..." }`.
- Events: `PreToolUse`, `PostToolUse`, `SessionStart`, `SessionEnd`.
- Directories: `~/.zelari-code/hooks/` (global, always active) +
  `<project>/.zelari/hooks/` (only if the folder is trusted).

### Observer events (v2.57) - hook = subscriber of the spine

A hook can also subscribe to four lifecycle events. These are observations, not
gates: the `decision` a hook replies with is **discarded**, so a crashing, slow
or non-2xx subscriber can neither block the caller nor corrupt the spine. The
timeout is still honored (a slow hook is abandoned at `timeoutMs`) and the
failure is logged (`[hooks] hook "x" failed (fail-open): ...`).

| Event | Fires when | Payload block |
|-------|------------|---------------|
| `PermissionRequest` | the gate resolved a dispatch to `ask` or `deny` - i.e. you are being prompted or the call was blocked (WS1 `.zelari/permissions.json`) | `permission: { tool, categories[], effect: "ask"\|"deny", matchedRuleId?, source?, reason?, argsSummary? }` |
| `SubagentStart` | a Kraken tentacle run begins (after worktree resolution, before the sub-agent harness) | `subagent: { agent, description, thoroughness?, worktree (bool), worktreeMode?, worktreePath?, nodeId?, graphId?, cwd? }` |
| `SubagentEnd` | every terminal path of a tentacle run | same, plus `ok?`, `durationMs?`, `error?` (an absent `ok` is never a success claim) |
| `Notification` | the WS2 inbox gains an item ("waiting on YOU") | `notification: { source: "question"\|"tentacle-finished"\|"needs-input", kind?, summary, seq?, taskId?, tool? }` |

Matching: `PermissionRequest` is **tool-scoped** (`match.tools`, like
PreToolUse). The subagent events accept an optional
`match.agents: ["general", "explore", ...]` filter (`*` = any kind, absent =
every kind); `match.tools` is not consulted for them. `Notification` carries no
subject - the event decides, exactly like the session events.

```json
// ~/.zelari-code/hooks/audit-permissions.json  (observe, never block)
{
  "name": "audit-permissions",
  "match": { "tools": ["*"], "events": ["PermissionRequest", "Notification"] },
  "url": "http://127.0.0.1:8710/zelari-hooks",
  "timeoutMs": 1000
}
```

`ZELARI_HOOKS_FAILURE=fail-open|fail-closed` (see folder trust / policy load
mode) changes what an unreliable hook means for the **gate** events only:
fail-closed turns a crash/timeout/garbage reply of `PreToolUse` / `SessionStart`
/ `SessionEnd` into a deny with reason `hook-failed`. Observer events have no
deny channel at all in either mode.

## inspect (v1.32.0)

`zelari-code --inspect [--json]` - unified report of the project environment:
version, cwd, platform, phase/mode, config sources, skills, MCP (with trust
state), lifecycle hooks, plugins, AGENTS.md, trust. `--json` emits a
machine-readable report with a stable `schemaVersion` for Desktop/scripts.

## Prompt <-> execution coherence

1. **`harnessToolBridge`**: harness built-ins in the `getAllTools()` catalog
   with schemas from the real zod ones.
2. **Executable filter**: AVAILABLE TOOLS and provider schemas filtered on
   the current registry.
3. **Aliases**: `Read`->`read_file`, `Glob`/`list_dir`->`list_files`,
   `searchRAG`->`searchDocuments`, `shell`->`bash`, ...

## Skills

- Catalog: **26** built-in skills in `@zelari/core` (`systemPromptFragment` +
  `requiredTools`)
- Extra over the original set: `schema-loop`, `computer-use-cua`,
  `qwen-mm-plugins-install-setup`
- User skills: `SKILL.md` under `.zelari/skills/`, `.claude/skills/`, ...
- Invocation: `/skill <id>`; master switch via config `enabledSkills` /
  `enabledTools`

### `skills:check` (v2.53.0) — static validator

`zelari-code skills:check` validates user `SKILL.md` files **without ever
executing anything** (pure static analysis, mirrors the real loader rules):

- Output: `{ok, lines:[{level, what}]}` — one line per finding (`error` /
  `warning` / `info`)
- Exit code `0` when `ok`, `1` otherwise — CI-friendly (`npm run skills:check
  -- --path .zelari/skills` or plain `zelari-code skills:check`)
- What it checks: frontmatter presence/shape, heading structure, guard test
  compatibility (the no-exec rule is itself lock-tested)

## Plugin bundles (v2.58.0, WS6) - `zelari-code plugin`

A **bundle** is a directory carrying one `zelari-plugin.json` manifest plus the
files it declares. Validation is static: nothing is installed, executed or
fetched.

```bash
zelari-code plugin validate <dir>      # exit 0/1, one line per problem
zelari-code plugin list [dir...]       # discovered bundles + enabled/disabled
zelari-code plugin enable <dir|name>   # persist enabled=true (validates first)
zelari-code plugin disable <dir|name>  # persist enabled=false
```

- Manifest (format v1): `{ name, version, description?, skills[], hooks[],
  mcp[], agents? }` - `$comment` accepted and stripped (as in the permission
  policy), every other unknown key fatal, and every error names the FILE and
  the FIELD. Declared paths must stay inside the bundle directory.
- `skills[]`: `{ id, path }` - `id` must equal the SKILL.md frontmatter `name`;
  the file is parsed by the real `SKILL.md` loader.
- `hooks[]`: `{ event, path, config? }` - `event` must be one of the events the
  hook FILE subscribes to (a mismatch would load and never fire). `config` may
  override only `timeoutMs`/`cwd`: `command`/`url`/`match` stay owned by the
  file. The four v2.57 OBSERVER events are accepted (decision discarded).
- `mcp[]`: `{ name, preset | command, args? }` - exactly one of `preset` (a repo
  preset id, resolved by the real registry) or `command` (stdio server). No
  `env`: secrets never travel inside a bundle; a preset factory reads its key
  from the environment at APPLY time.
- `agents[]`: `{ id, path, description? }` - validated and surfaced, **not
  executed** (no agent loader yet, reported as a warning).
- Enablement lives in the project file `.zelari/plugins.json`
  (`{ enabled: { "<bundle>": true }, paths: [...] }`). **A bundle that is
  present but not listed is DISABLED** (fail-closed), a malformed state file
  enables NOTHING, and `enable` refuses to overwrite it. `enable` validates the
  bundle first; `disable` needs only the manifest name.
- The loader returns a **contribution list** and executes nothing. Applying
  contributions, and any plugin EVAL, is blocked until the eval baseline is
  seeded - no numbers are reported here on purpose.
- Example: `examples/extensions/zelari-plugin-example` (1 skill, 1 observer
  hook, 1 real stdio MCP server).

See also [GUIDA.md](./GUIDA.md) and [README](../README.md).