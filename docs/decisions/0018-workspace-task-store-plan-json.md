# ADR-0018 - Workspace task store contract on `.zelari/plan.json`

**Status**: Accepted - slice 3a implemented (v1.43.0)
**Related to**: `.zelari/docs/plan-desktop-livetasks-multirun-v2.md` (M3), ADR-0016 (event-sourced session log)

## Context

The Desktop needs **durable, multi-session** project tasks, distinct from session todos (volatile, per-conversation, cap 40 - `src/cli/sessionTodos.ts`). The comment at the top of that module already declares the intent: *"Not the same as `.zelari/plan.json` workspace tasks (those are multi-session durable plans)"* - but **no tool writes that file today**: core builtins are filesystem/shell/search/web, and the CLI registry registers only `todo_write`/`todo_read` (`src/cli/toolRegistry.ts:268-276`). The `.zelari/plan.json` vault used by the council is therefore a non-contractual internal format, still evolving.

M2 already paid the transport (the `runId+conversationId+cwd` envelope on `agent-event`), M1 the unified UI (`LiveTasksPanel`, `source` already in the `liveTasks/types.ts` model). Without a writer, the plan's acceptance tests 5-8 (optimistic update, reconciliation, end-of-run refresh) remain unaddressed.

Forces at play: coexistence with the council vault on the same file; the zero-heavy-deps policy (P2); cross-process concurrency (Desktop runs are separate CLI processes); the need for format stability once exposed to the UI.

## Decision

`.zelari/plan.json` becomes the **canonical, versioned store** of workspace tasks, written **only** by three new CLI tools (`task_create`, `task_update`, `task_list`) with atomic writes and `write`-class permissions.

**Envelope schema v1** (root - the tools touch ONLY `tasks` and `counter`; every other root field, e.g. council metadata, is preserved intact in pass-through):

```json
{
  "schemaVersion": 1,
  "counter": 7,
  "tasks": [
    {
      "id": "t7",
      "title": "Extract RunCoordinator from App.tsx",
      "status": "in_progress",
      "priority": "high",
      "phaseId": "p1",
      "notes": "optional",
      "agent": "kraken",
      "createdAt": "2026-07-10T09:12:00.000Z",
      "updatedAt": "2026-07-10T09:40:00.000Z"
    }
  ]
}
```

- **Canonical statuses**: `pending | in_progress | completed | cancelled | blocked`. `blocked` exists ONLY here (session todos stay without it, as today). No rigid FSM on transitions: the model can correct (e.g. `completed -> in_progress`).
- **Ids**: sequential `t<N>` via a persisted `counter` (readable in UI/CLI, no uuids). `title` = 200 chars, `notes` = 2000, `agent`/`phaseId` = 64, `priority` in `low|medium|high|critical`, max 100 tasks. Unknown fields on a task are preserved by `task_update` if untouched.
- **Tool contract** (`src/cli/tools/planTaskTools.ts`, snake_case naming like `todo_write`):
  - `task_create({ title, priority?, phaseId?, notes? })` -> task `pending`, returns `{ id }`;
  - `task_update({ id, status?, title?, priority?, phaseId?, notes?, appendNote? })` -> typed error `PLAN_TASK_NOT_FOUND` if the id is missing;
  - `task_list({ status?, phaseId? }?)` -> filtered snapshot + `done/total` count.
- **Writing**: store in `src/cli/workspace/planStore.ts` - single read-modify-write, tmp + rename in the same dir, `.plan.json.bak` backup before rewriting an existing file, corrupt file -> clear error (never silent overwrite). Path confined under `{root}/.zelari` via sandboxPath, audit via AuditLogger, permissions via `wrapWithPermissions` (`write` class).
- **Registration**: `enablePlanTasks` option in `CreateRegistryOptions` - active by default for `profile === 'full'` **and** in `planMode` (the plan is the plan-phase domain; the `planMode` field at `toolRegistry.ts:128-131` already anticipates it); never for readOnly/explore/verify/general in the first release.
- **Concurrency**: atomic write + read-modify-write per call. In the Desktop the race is already neutralized by M2 (`RunRegistry`: max 1 active run per cwd). For multiple concurrent CLIs on the same cwd, future hardening: `.zelari/.plan.lock` lock file (out of scope for 3a).

**Out of scope for 3a**: first-class `task_update`/`task_snapshot` events (slice 3b, M2 envelope channel) and Desktop consumption (slice 3c).

## Alternatives considered

1. **M3-quick read-only** (Desktop parses `plan.json` without a writer) - rejected: leaves acceptance 5-8 unaddressed and couples the UI to a non-contractual format.
2. **Separate file `.zelari/tasks.json`** - rejected: two sources of truth; code and council already point to `plan.json` as the durable plan store.
3. **Extending `todo_write` with `scope: 'project'`** - rejected: opposite semantics (volatile in-process vs shared persistent) and different permissions in the same tool.
4. **SQLite** - rejected: violates P2 (zero heavy deps) and loses JSON's diff-ability/git-friendliness.

## Consequences

**Positive**: single source of truth for tasks shared by CLI/desktop/council; unblocks M3c (PROJECT panel with optimistic + reconciliation); readable and diff-able format; natural base for future schedulers/queues.

**Negative**: `plan.json` becomes a de facto public API - every breaking change requires a `schemaVersion` bump + migration; the internal council must respect the contract (a constraint on the product); another tool family to maintain and document; residual cross-process race for parallel CLIs on the same cwd (mitigated, not eliminated, by the atomic write).

## TODO (slice 3a - to be checked off at implementation)

- [x] `src/cli/workspace/planStore.ts` - atomic load/validate/save, caps, pass-through of root fields and unknown task fields, `.bak` backup.
- [x] `src/cli/tools/planTaskTools.ts` - `task_create`/`task_update`/`task_list` with Zod, typed errors.
- [x] Registration in `src/cli/toolRegistry.ts` with `enablePlanTasks` (full + planMode), wrapped in `withPerm`.
- [x] Vitest unit tests: store (happy path, caps, corrupt file, pass-through) + tools (CRUD, `PLAN_TASK_NOT_FOUND`).
- [x] Documentation in `docs/TOOLS.md`, `task_*` section.
- [x] Slice 3b: `task_update`/`task_snapshot` BrainEvents on the M2 envelope (`packages/core/src/shared/events.ts`).
- [x] Slice 3c: desktop `liveTasks/workspacePlan.ts` + merge in the reducer + reconciliation on `run-finished`.