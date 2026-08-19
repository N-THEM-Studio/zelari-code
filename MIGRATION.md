# Migration guide — `@zelari/core` import paths

> Current product line: **zelari-code / `@zelari/core` 2.0.0-alpha.7**.  
> This file is **only** for library consumers who imported internal
> `src/...` paths before v0.5.0. CLI users can ignore it.

This guide covers the breaking change in v0.5.0: the move
from internal `src/...` paths to the published **`@zelari/core`**
package. Later minors (through 1.x and the 2.0 alphas) are additive on the public
`exports` map — see `packages/core/package.json`.

If you only use `zelari-code` as a CLI (no `import` statements in your
own code), nothing changes for you — just run `zelari-code` as before.

## TL;DR

- If you imported core code from internal paths, change the path.
- There is **no compatibility shim**. Old paths will not work.
- Curated subpath exports are listed below; the live map is
  `packages/core/package.json` → `exports` (grows over minor releases).

## v1.0.0 — additive, non-breaking

v1.0.0 adds one new **`@zelari/core/memory`** subpath export that ships the
`MemoryBackend` interface and its types (`MemoryChunk`, `MemoryResult`,
`MemorySearchOptions`, `MemoryAddGraph`). The same types are also re-exported
from the main `@zelari/core` barrel. Nothing was removed or renamed, so no
migration is required — this is purely additive. The concrete file-based
implementation lives in the CLI, so `@zelari/core` stays dependency-free
(only `zod`).

## Why

Pre-v0.5.0, `@zelari/core` lived at `src/main/core/`, `src/agents/`,
`src/shared/`, `src/types/` — paths that were only ever intended as
in-repo locations. Publishing them as-is would have leaked internal
file structure to npm consumers, which is the wrong abstraction.

v0.5.0 extracts the core into a real npm workspace package
(`packages/core/`) and exposes **curated subpath exports** (originally 9;
later releases added e.g. `@zelari/core/memory` and fine-grained
`harness/tools/*` paths). The rationale lives in
[`docs/decisions/0001-monorepo-for-zelari-core.md`](docs/decisions/0001-monorepo-for-zelari-core.md)
and
[`docs/decisions/0004-public-api-stability-policy.md`](docs/decisions/0004-public-api-stability-policy.md).

## Old → new import paths

| Old path (≤ 0.4.x)                    | New subpath                          | What's in it                                   |
|---------------------------------------|--------------------------------------|------------------------------------------------|
| `src/main/core/AgentHarness`          | `@zelari/core/harness`               | `AgentHarness` class, `ProviderStreamFn` type  |
| `src/main/core/providerStream`        | `@zelari/core/harness`               | provider stream helpers                        |
| `src/main/core/sessionJsonl`          | `@zelari/core/harness`               | `SessionJsonlWriter`                           |
| `src/main/core/tools`                 | `@zelari/core/harness/tools`         | `ToolRegistry`, schema types                   |
| `src/main/core/tools/builtin/*`       | `@zelari/core/harness/tools/builtin/*` | built-in tool implementations                |
| `src/agents/councilApi`               | `@zelari/core/council`               | `dispatchCouncil`, `runCouncilPure`            |
| `src/agents/roles`                    | `@zelari/core/council`               | the 6-member council role definitions          |
| `src/agents/promoteMember`            | `@zelari/core/council`               | `promoteMember` helper                         |
| `src/agents/skills`                   | `@zelari/core/skills`                | `SkillRegistry` and friends                    |
| `src/agents/skills/builtin/*`         | `@zelari/core/skills/builtin/*`      | built-in skill implementations                 |
| `src/agents/systemPromptBuilder`      | `@zelari/core/council` (use carefully — internal) | system prompt composition logic     |
| `src/agents/toolSchemas`              | `@zelari/core/harness/tools`         | JSON Schema helpers for tool definitions       |
| `src/agents/tools`                    | `@zelari/core/harness/tools`         | tool execution helpers                         |
| `src/shared/eventBus`                 | `@zelari/core/events`                | event bus primitives                           |
| `src/shared/events`                   | `@zelari/core/events`                | event type definitions                         |
| `src/types/context`                   | `@zelari/core/types`                 | session/context types                          |
| `src/types/knowledge`                 | `@zelari/core/types`                 | (was internal — surface area may change)       |
| `src/types/systemTypes`               | `@zelari/core/types`                 | system message types                           |

> ℹ️  Subpaths not on this table are **not part of the public API**.
> They may move, rename, or disappear in any minor release. If a
> symbol you need isn't on this table, open a feature request.

## Before / after examples

### A. Building a custom agent loop

```diff
- import { AgentHarness } from '../../src/main/core/AgentHarness.js';
- import type { ProviderStreamFn } from '../../src/main/core/providerStream.js';
+ import { AgentHarness, type ProviderStreamFn } from '@zelari/core/harness';
```

### B. Reading council events

```diff
- import { dispatchCouncil } from '../../src/agents/councilApi.js';
- import type { CouncilMember } from '../../src/agents/roles.js';
+ import { dispatchCouncil, type CouncilMember } from '@zelari/core/council';
```

### C. Registering a custom tool

```diff
- import { ToolRegistry } from '../../src/main/core/tools.js';
+ import { ToolRegistry } from '@zelari/core/harness/tools';
```

## Behaviour changes you should know about

- **Visible reasoning (council)**: every `agent_start`, `agent_end`,
  `message_start`, `message_delta`, `message_end` event now carries
  optional `memberId` + `memberName`. Consumers that strictly type
  their event handlers will need to mark these fields as optional, or
  type the union more loosely.
- **Headless mode**: new top-level CLI flag `--headless` for scripted
  use. If you wrap `zelari-code` and parse its `stderr` for diagnostics,
  be aware that `--headless` no longer mounts Ink and writes
  NDJSON to `stdout` instead.

## Tooling

- The CLI's own `package.json` now lists `@zelari/core` as a workspace
  dep. Running `npm install` at the repo root will symlink it.
- For downstream projects, install with `npm install @zelari/core@^0.5.0`.
- TypeScript: the package ships `dist/index.d.ts` and per-subpath
  declaration files. No `@types/zelari-core` needed.

## Found a path we missed?

If you find a `src/main/core/`, `src/agents/`, `src/shared/`, or
`src/types/` reference in the wild that should be on this table,
open an issue with the label `migration`. We will:
1. Add a row to this table.
2. If the import is from our own codebase (e.g. a tutorial repo), fix it.

## What we will NOT do

- **No `src/legacy-compat/` shim.** The package `exports` map is the
  one and only public entry point. The reasoning is in
  [ADR-0005](docs/decisions/0005-deprecate-legacy-src-paths.md).
- **No git tag on pre-0.5.0 paths.** `git log --follow` works as
  expected and gives you the history of any moved file.
- **No esbuild alias plugin.** We don't ship tooling that rewrites
  imports at build time.

## Need help?

- File: [github.com/N-THEM-Studio/zelari-code/issues](https://github.com/N-THEM-Studio/zelari-code/issues)
- Product: [anathema-studio.com](https://anathema-studio.com/)
- Read the [CHANGELOG](CHANGELOG.md) (start at the v0.5.0 section) for
  the full list of what changed in the monorepo extraction release.
  Monorepo license is **Apache-2.0** since [ADR-0009](docs/decisions/0009-apache-2-0-license.md)
  (originally MIT per [ADR-0008](docs/decisions/0008-monorepo-mit-oss.md), superseded).

## v2.0.0-alpha — Zelari 2.0: from reconstructed history to the session spine

The 2.0 pre-release line (alpha.0 → alpha.7) adds four new `@zelari/core`
subpath exports and keeps every 1.x import path working unchanged:

- `@zelari/core/session` — event-sourced session log (ADR-0016/0021). Default
  location `<workspaceRoot>/.zelari/sessions/<id>/events.jsonl`, override
  `ZELARI_SESSIONS_DIR`. Envelope `{"schemaVersion":1,...}`.
- `@zelari/core/runtime` — execution seams + versioned profiles (ADR-0022):
  `minimal/v1`, `kraken/v1`, `council/v1`, `mission/v1`.
- `@zelari/core/verification` — Criterion/EvidenceRef/VerificationResult,
  deterministic engine, CompletionPolicy, criteria pack v1, VerifierService
  (advisory-only).
- `@zelari/core/mission` — `deriveMissionState` + continuation policy.

### The fundamental shift: who owns the history

**Before (1.x)** — the consumer reconstructs and provides the transcript.
`AgentHarnessConfig.messages` is yours to build, order and persist:

```ts
import { AgentHarness } from '@zelari/core/harness';

// You own storage, ordering and replay semantics.
const harness = new AgentHarness({
  model: 'grok-4',
  provider: 'grok',
  messages: rebuildFromYourOwnStorage(),   // ← hand-built history
  tools: [],
  providerStream,
});
harness.userMessage('Fix the bug');
```

**After (2.0)** — you append Session events; the spine is the single source
of truth and the model context is **derived, never hand-built** (ADR-0021,
"single write path into model context" per ADR-0024):

```ts
import { AgentHarness } from '@zelari/core/harness';
import {
  SessionStore,
  deriveMessages,
  derivedToAgentMessages,
} from '@zelari/core/session';

const store = new SessionStore({ workspaceRoot: process.cwd() });

// 1. create a session — create() appends session.started with profile metadata.
const { sessionId, writer } = await store.create({ profile: 'kraken/v1' });
await writer.append({
  kind: 'user_message',
  actor: 'user',
  data: { text: 'Fix the bug' },
});

// 2. later — same or fresh process: replay is the reader.
const { writer: resumed, report } = await store.open(sessionId);

// 3. canonical model context — the ONLY path (ADR-0016).
const derived = deriveMessages(report.events);
const harness = new AgentHarness({
  model: 'grok-4',
  provider: 'grok',
  messages: derivedToAgentMessages(derived),
  tools: [],
  providerStream,
});
```

Invariant: **model-visible ⟺ logged**. If an event is not in the log it
cannot reach the model; everything the model saw is replayable
(`readSessionLog` reports `schema-mismatch` issues instead of crashing).

### Resume and fork (lineage)

- `store.open(sessionId)` — replays the log, returns
  `{ writer, report, projection }` and keeps `seq` monotonic. This is what
  CLI `--resume <id>` uses.
- `resumeSession(store, sessionId)` — appends an explicit resume marker.
- `forkSession(store, sessionId, { reason })` — copies the log under a new
  session id and appends a lineage event; `lineageOf(store, id)` walks the
  parents. Fork is a **core API** in alpha (no CLI flag yet).

### Profile metadata

`session.started` carries `profile` (e.g. `kraken/v1`) and the
`toolManifestHash` of the declared tool set (ADR-0022). The profile is the
declarative **upper bound**; the phase (`plan`/`build`) is the **runtime
restriction** — council/v1 declares `write_file` while council+plan strips
it. Consumers comparing sessions should compare both fields.

### Verification contract

- **Criterion → check → EvidenceRef.** Deterministic checks produce
  `VerificationResult`s whose evidence carries a tier (`tool-output`,
  `command-output`, `fs-observation`, `grep`, `claimed`,
  `verifier-llm`) and, for deterministic tiers, the `seq` of a
  `verification.evidence` session event holding the raw observation
  (command, exit code, sha256 digest, output tail). An LLM note is never
  confused with a tool output.
- **CompletionPolicy is the only completion authority**: `PASS` /
  `REPAIR_REQUIRED` / `BLOCKED`. Strict defaults are frozen in
  [ADR-0025](docs/decisions/0025-strict-done-defaults.md): Kraken opt-in
  (`ZELARI_STRICT_DONE=1` / `--strict-done`), Mission ON by default
  (`ZELARI_MISSION_STRICT=0` / `--no-strict-done` to opt out).
- **Verifier LLM is advisory-only** (`inherit | fixed`): it can add risk,
  never flip a deterministic verdict (locked by regression tests since
  alpha.7).
- **CLI surface**: a blocked strict gate exits with code **4**; the criteria
  pack is opt-in via `ZELARI_VERIFY_PACK=1`.

### Mission

`@zelari/core/mission` projects the spine into mission state
(`deriveMissionState`) and evaluates an **advisory** continuation policy
(`evaluateMissionContinuation`): progress/score never rewrite goals, never
produce done, and never early-stop while required criteria are incomplete.
`mission.progress` events are state-only (not model-visible).

### Legacy adapters (compatibility only)

The 1.x `sessionManager` / `history_snapshot` mechanism survives as a
**mirror** (`.zelari/session/<id>.jsonl`) kept for UI/export compatibility
during the alpha line and **removed at rc** (ADR-0024, single write path).
It is not a source of truth — the spine is canonical. Do not build new
integrations on the mirror.

### Breaking changes in the alpha line

Library consumers: nothing removed or renamed — additive only. CLI behaviour
changes to know about:

1. **Mission strict gate default ON** (alpha.7, ADR-0025): a mission that
   ends blocked now exits `4` (`mission-strict-blocked`) where 1.x exited
   `0`. Opt back out with `ZELARI_MISSION_STRICT=0` or `--no-strict-done`.
2. **New exit code 4** for strict-gate blocked runs (1.x used only 0/1).
3. **Headless resume is spine-based**: `--resume <id>` replays the spine;
   the 1.x history snapshot is a fallback, not the driver.

### Session schema migrations (future)

When `SESSION_SCHEMA_VERSION` bumps, replay of older logs still works —
readers are schema-aware and report `schema-mismatch` issues instead of
crashing. Unknown event kinds (e.g. an older reader meeting
`verification.evidence` or `mission.progress`) are preserved and flagged,
not dropped.

See `docs/SESSION-FORMAT-2.0.md` for the on-disk format and verifier
config, and `docs/GUIDA.md` §17a–17c for the user-facing story.
