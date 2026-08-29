# echo-tool — example Zelari extension (t30, Pilastro C)

A minimal, **read-only** extension demonstrating the ExtensionAPI seam
(`ZelariExtension.register(ExtensionHost)`): one tool (`echo_tool`), the same
zod validation builtin tools use, and an explicit minimal permission
declaration (`read` only).

This is a **seam, not a plugin framework** (ADR-0022): code is loaded from
disk only — never from a prompt — and every registered tool is pushed through
the same `wrapWithPermissions` path as builtin tools (category policy → agent
rules → resource claims → TaskContract capability layer, intersect LAST).
An extension can declare anything; it can never **widen** the parent policy.

## Install

```text
~/.zelari-code/extensions/extension.js   # user-global: ALWAYS active
<project>/.zelari/extensions/extension.js  # project: only if the folder is trusted
```

## Optional integrity lock (`extensions.lock`)

Place a JSON file next to the extension mapping FILE name → sha256:

```json
{ "extension.js": "<sha256 hex of the file>" }
```

- strict surfaces (headless / mission / CI): a missing or mismatched hash
  FAILS the whole extension load with a typed `ExtensionLockError`.
- interactive TUI: the file is skipped with a warning, the rest still loads.

## API surface (all an extension ever gets)

| Member | Meaning |
|---|---|
| `host.registerTool(spec)` | declare a tool: `{ name, description, inputSchema (zod), permissions, execute }` |
| `host.onPreToolUse(matcher, handler)` | observe tool calls (`'*'` or exact name); return `{ deny: true, reason }` to block |
| `host.fs` | sandboxed filesystem ONLY: `readFile` / `writeFile` / `listFiles`, root-constrained (no process, no network, no raw fs) |

Crashing `onPreToolUse` handlers follow the t22 hook failure semantics:
fail-open (TUI, log + allow) or fail-closed (strict, deny with
`extension-hook-failed`).
