
# Implementation guide: Zelari-mode + Memory (LanceDB / SQLite)

> **Status:** working plan (not yet implemented)
> **Target version:** zelari-code v0.8.x | v0.9.x
> **Author:** N-THEM Studio / derived from 2026-07 design sessions
> **Repo:** [N-THEM-Studio/zelari-code](https://github.com/N-THEM-Studio/zelari-code)

---

## Index

1. [Vision and goals](#1-vision-and-goals)
2. [Three CLI modes](#2-three-cli-modes)
3. [Zelari-mode - architecture](#3-zelari-mode--architecture)
4. [Mission brief and orchestrator prompt](#4-mission-brief-and-orchestrator-prompt)
5. [Skill router and N-THEM builtins](#5-skill-router-and-n-them-builtins)
6. [Memory: LanceDB + SQLite (graph light)](#6-memory-lancedb--sqlite-graph-light)
7. [MemPalace (optional)](#7-mempalace-optional)
8. [Council and agent integration](#8-council-and-agent-integration)
9. [Context limits and compaction](#9-context-limits-and-compaction)
10. [Configuration and environment variables](#10-configuration-and-environment-variables)
11. [Phased implementation plan](#11-phased-implementation-plan)
12. [Tests and acceptance criteria](#12-tests-and-acceptance-criteria)
13. [Risks and mitigations](#13-risks-and-mitigations)
14. [Appendix: data schema and tool API](#14-appendice-data-schema-and-tool-api)

---

## 1. Vision and goals

### Current problem

- **Council** = one run (6 specialists + Lucifero), then stop. Not suited to whole products from a single prompt.
- **Skills** = manual invocation (`/skill`); separate catalogs (council vs coding); no automatic router.
- **Context** = JSONL + `/compact` (drops messages), not semantic memory. Multi-run loops explode tokens or lose decisions.
- **Italian greenfield** (`costruisci`, `crea`) does not trigger design-phase without explicit EN keywords.
- **User prompt** can be vague; a layer that structures intent, scope and assumptions is missing.

### Goal

The user writes **one free-form prompt** (any domain - e.g. BnB management app, games, SaaS, refactor on an existing repo). The system:

1. **Improves / structures** the request (mission brief, optional user confirmation).
2. Runs **Zelari-mode**: a loop of councils (and agents if needed) until **completion of the current slice** per `CouncilCompletion.ok` and the plan in `.zelari/`.
3. **Selects skills automatically** (Taste + glasspetrae for UI, planning, handoff, etc.).
4. **Persists and retrieves memory** (hybrid search + graph light) across slices and sessions.
5. Raises the **tool budget** on Lucifero in long runs.

### Non-goals (v1)

- A "100% finished" product in an infinite loop with no slice definition.
- Heavy Graph RAG / native Ruvector.
- Replacing `.zelari/plan.json` with the vector store (the plan stays the structured SSOT).

---

## 2. Three CLI modes

| Mode | `ChatMode` | Use |
|----------|------------|-----|
| **agent** | `'agent'` | Quick questions, patches, exploration |
| **council** | `'council'` | One deliberated run (design **or** implementation) |
| **zelari** | `'zelari'` | Autonomous multi-run mission up to the completion gate |

### UX

- **Shift+Tab:** cycle `agent` | `council` | `zelari` (extend `StatusBar.tsx`, `InputBar`, `useChatTurn`).
- **Status bar:** `zelari - slice 2/5 - impl - completion: FAIL(motion)` (example).
- **Slash:** `/zelari <prompt>` equivalent to zelari mode + dispatch.
- **Stop:** `/stop`, Ctrl+C with `HANDOFF.md` save + `memory_add` + `.zelari/mission-state.json`.

### Headless (later phase)

- `zelari-code --zelari --task "..." --yes` for CI / nightly runs.

---

## 3. Zelari-mode - architecture

```
                    +----------------------+
                    |  User prompt         |
                    +----------------------+
                               |
                    +----------------------+
                    | Mission classifier   |
                    | + Mission brief      |
                    | + Skill router       |
                    +----------------------+
                               |
              +----------------------------------+
              | Greenfield / no plan?            |
              |  |-> Council design-phase (opt.)  |
              +----------------------------------+
                               |
         +----------------------------------------------+
         | LOOP until stop                               |
         |  1. memory_search(brief + query)              |
         |  2. pick slice from plan.json                 |
         |  3. Council implementation (scope=slice)      |
         |  4. postCouncilHook | completion.json         |
         |  5. memory_add(handoff slice)                 |
         |  6. if ok | next slice; else fix-turn         |
         +----------------------------------------------+
                               |
                    +----------------------+
                    | mission-state.json   |
                    | HANDOFF (opt.)       |
                    +----------------------+
```

### Stop conditions

| Condition | Behavior |
|------------|---------------|
| All **high** tasks of the plan completed (configurable) | Success |
| `maxMissionIterations` reached | Stop + handoff |
| Token / wall-clock budget | Stop + handoff |
| User `/stop` | Graceful stop |
| `completion.ok === true` for the MVP slice defined in the brief | MVP Success |

**"Completion"** = `CouncilCompletion.ok` for **the current slice** + `plan.json` update, not "the entire world backlog".

### New files (indicative)

| Path | Role |
|------|--------|
| `packages/core/src/council/mission.ts` | Greenfield / extend / fix classifier |
| `packages/core/src/council/missionBrief.ts` | Structured brief generation |
| `src/cli/skillRouter.ts` | Prompt | skillIds match per role |
| `src/cli/zelariMission.ts` | Loop state machine |
| `.zelari/mission-state.json` | Iteration, current slice, budget |

---

## 4. Mission brief and orchestrator prompt

### Brief output (schema)

```typescript
interface MissionBrief {
  intent: 'greenfield' | 'extend' | 'fix' | 'redesign';
  runModeHint: 'design-phase' | 'implementation' | 'hybrid';
  stackInferred: string[];           // e.g. react, laravel
  deliverableThisMission: string;    // 1-2 sentences
  assumptions: string[];             // e.g. payments = Stripe stub
  outOfScope: string[];
  skillPack: string[];               // skill ids from the router
  phases: Array<{ name: string; mode: CouncilRunMode }>;
  slices: Array<{ id: string; title: string; taskIds?: string[] }>;
  userPromptOriginal: string;
}
```

### Two levels

| Level | When | Action |
|---------|--------|--------|
| **A - Structured brief** | Almost always | Rules + heuristics + (opt.) 1 light LLM call |
| **B - Polish / ask confirmation** | Ambiguous brief | `clarify` or "Proceed with this brief?" message |

**Recommended default (to be confirmed with Andrea):**

- Brief shown in chat; **auto-start** with flag `--yes` or env `ZELARI_MISSION_AUTO=1`.
- MVP: the brief defines **max N tasks** in slice 1 (e.g. 8).

### `resolveCouncilRunMode` extension

Add **IT/EN** keywords:

- IT: `costruisci`, `crea`, `nuovo progetto`, `da zero`, `sviluppa`, `realizza`, `vetrina`, `pannello`
- EN: existing + `build`, `scaffold`, `landing`, `frontend`, `fullstack`
- UI: `glasspetrae`, `redesign`, `ui`, `tailwind`

**Hybrid** logic: empty repo or no `plan.json` + greenfield intent | design-phase then chained implementation (Zelari-mode).

---

## 5. Skill router and N-THEM builtins

### Two catalogs today

| Catalog | Current use |
|----------|-------------|
| `SKILL_CATALOG` | Council via `roles.ts` | `computeAgentSkills` |
| `CODING_SKILL_CATALOG` | `/skill` via `registerCodingSkill` |

**Goal:** a unified router that populates **both** channels and `perRunSkillIds` for council.

### Built-in skills to ship

| ID | Source | Council | `/skill` |
|----|--------|---------|----------|
| `design-taste-glasspetrae` | Taste Skill MIT + glasspetrae appendix | Short overlay (~4-8 KB) in design-phase / UI |
| `zelari-agents-md-scoped` | Adapt. davidondrej `folder-specific-claude-and-agents-md` | Nettuno, Lucifero |
| `zelari-read-decisions` | Adapt. `read-all-adrs` | `.zelari/decisions/` | Nettuno, Minosse |
| `zelari-session-handoff` | Adapt. davidondrej `handoff` (N-THEM tone) | Opt. end of slice |

**Not built-in:** cmux, deepapi, codex-goal-loop, delegating-to-agents (David-specific stack).

### Router (v1 heuristic)

Input: `userMessage`, `MissionBrief`, `cwd`, `hasPlan`, `runMode`.

Output: `Record<AgentId, string[]>` skill ids.

Example matches:

- `landing`, `vetrina`, `ui`, `glasspetrae` | `design-taste-glasspetrae` on geryon, minos, lucifer
- `architettura`, `laravel`, `react`, `api` | `architect-feature` / planning skills on charont, nettun
- `refactor`, `bug` | debug/refactor catalog

Implementation: `packages/core/src/council/skillRouter.ts` + tests with a generic BnB prompt.

### Conditional council injection

Extend `buildSystemPrompt` / `computeAgentSkills` with:

```typescript
options?: {
  councilRunMode?: CouncilRunMode;
  routedSkillIds?: string[];
}
```

Rules:

- Design skills (`design-taste-glasspetrae`) **only** if `design-phase` or UI keywords in the brief.
- In pure implementation "fix auth" | no full Taste overlay.

### Asset files

```
packages/core/src/agents/skills/assets/
  design-taste-glasspetrae-full.md      # vendored, pin upstream SHA
  design-taste-glasspetrae-council.md   # condensed
  glasspetrae-appendix.md               # petra/aqua tokens, glyphs, glass utilities
packages/core/src/agents/skills/builtin/
  frontend-design.ts                    # registerSkill + registerCodingSkill
  workspace-docs.ts                     # zelari-* handoff/decisions/agents-md
```

`src/cli/app.tsx`: `import '@zelari/core/skills/builtin/frontend-design'` (and workspace-docs).

### THIRD_PARTY_NOTICES

- Taste Skill (MIT, Leon Lin / MemPalace team for parts derived from davidondrej MIT).

---

## 6. Memory: LanceDB + SQLite (graph light)

### Why this choice (vs MemPalace in core)

- **npm shippable:** all Node, no mandatory Python.
- **Hybrid search:** vector + FTS in LanceDB.
- **Metadata control** for council slice / session / project.

### Per-project path (mandatory)

```
<projectRoot>/.zelari/memory/
  zelari.lance/     # LanceDB
  zelari.db         # SQLite facts + graph
```

Do not use only a global `~/.zelari/memory` (mixes projects).

### `MemoryBackend` interface

```typescript
// packages/core/src/memory/types.ts

export interface MemoryChunk {
  id: string;
  text: string;
  metadata: Record<string, unknown>;
}

export interface MemorySearchOptions {
  limit?: number;
  useGraph?: boolean;
  metadataFilter?: Record<string, unknown>;
}

export interface MemoryBackend {
  init(projectRoot: string): Promise<void>;
  add(
    content: string,
    metadata?: Record<string, unknown>,
    graph?: {
      entities?: Array<{ name: string; type?: string }>;
      relations?: Array<{ from: string; to: string; type: string; weight?: number }>;
    },
  ): Promise<string>; // fact id
  search(query: string, options?: MemorySearchOptions): Promise<MemoryResult[]>;
  close(): Promise<void>;
}
```

### SQLite schema (corrected - fix over the initial snippet)

```sql
CREATE TABLE facts (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  metadata TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE entities (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT,
  metadata TEXT
);

CREATE TABLE fact_entities (
  fact_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  PRIMARY KEY (fact_id, entity_id),
  FOREIGN KEY (fact_id) REFERENCES facts(id),
  FOREIGN KEY (entity_id) REFERENCES entities(id)
);

CREATE TABLE relations (
  id TEXT PRIMARY KEY,
  from_entity TEXT NOT NULL,
  to_entity TEXT NOT NULL,
  relation_type TEXT NOT NULL,
  weight REAL DEFAULT 1.0,
  metadata TEXT,
  FOREIGN KEY (from_entity) REFERENCES entities(id),
  FOREIGN KEY (to_entity) REFERENCES entities(id)
);
```

**Graph expansion:** from matched entity | `relations` | `fact_entities` | `facts` / Lance for text. **Never** `facts.id = entity_id`.

### LanceDB

- Table `memories` columns: `id`, `text`, `vector` (float32[384] for MiniLM), `metadata` (JSON string).
- After create: FTS index on `text`; wait for index ready before hybrid (see LanceDB JS docs).
- Verify the current JS API for `queryType: 'hybrid'` (mandatory integration test).

### Embeddings

- `@huggingface/transformers` + `Xenova/all-MiniLM-L6-v2` (or an equivalent 384-dim).
- **Lazy load** on first `memory.init`; TUI message: `[memory] loading embeddings.`.
- **Dynamic import** to avoid bloating the CLI bundle if memory is disabled.

### npm dependencies

Recommended package: `packages/memory` workspace `@zelari/memory` or under `packages/core/src/memory`.

```json
{
  "dependencies": {
    "@lancedb/lancedb": "^0.31.0",
    "@huggingface/transformers": "^3.0.0",
    "better-sqlite3": "^11.0.0"
  },
  "optionalDependencies": {
    "better-sqlite3": "^11.0.0"
  }
}
```

If `better-sqlite3` fails: `ZELARI_MEMORY=0` and graceful degradation (only `.zelari/` + plan).

**Avoid** a `postinstall` that creates directories in the homedir.

### Harness tools

| Tool | Description |
|------|-------------|
| `memory_add` | Saves chunk + metadata + optional graph |
| `memory_search` | Hybrid + optional 1-hop graph |

Recommended metadata on every `add`:

- `projectRoot`, `sessionId`, `missionId`, `sliceId`, `runMode`, `source`: `council` | `agent` | `handoff` | `verify`

### Phase 2 (not v1)

- LLM entity extraction in `memory_add`.
- `memory_reflect()` periodic summary.
- Alternative MemPalace MCP backend.

---

## 7. MemPalace (optional)

For users who prefer palace / conversation mining:

- MCP in `.zelari/mcp.json`: `mempalace-mcp` via `uv tool run`.
- Implementation `McpMemPalaceBackend implements MemoryBackend`.
- Env: `ZELARI_MEMORY_BACKEND=lancedb` (default) | `mempalace`.

Do not block v1 on MemPalace.

---

## 8. Council and agent integration

### `dispatchCouncil` / `councilApi`

Before `runCouncilPure`:

```typescript
const brief = await buildMissionBrief(userMessage, projectRoot);
const routed = routeSkills(brief, agents);
const memoryHits = await memory.search(brief.deliverableThisMission + ' ' + userMessage, {
  limit: 8,
  useGraph: true,
  metadataFilter: { projectRoot },
});
const ragContext = formatMemoryHits(memoryHits) + existingRag;
```

Pass to `PureCouncilConfig`:

- `runMode` from brief / classifier
- elevated `maxToolCallsPerTurn` for Lucifero in zelari-mode (e.g. 30, env `ZELARI_MODE_MAX_TOOLS_LUCIFER`)
- `aiConfig` or extension with `routedSkillIds`

### `useChatTurn` - Zelari-mode

New branch: if `mode === 'zelari'` | `runZelariMission()` instead of a single `dispatchCouncil` / agent.

`runZelariMission`:

1. `buildMissionBrief`
2. Opt. user confirmation
3. Loop with `maxMissionIterations`
4. Between iterations: do **not** re-inject the entire JSONL - only brief + plan summary + memory hits + last `completion.json`

### Post-slice

After `postCouncilHook`:

```typescript
await memory.add(
  JSON.stringify({ completion, slice, filesTouched }),
  { sliceId, sessionId, source: 'council' },
  entitiesFromBrief(brief),
);
```

---

## 9. Context limits and compaction

| Layer | Role in Zelari-mode |
|-------|----------------------|
| **Hot (prompt)** | Mission brief, last 2-3 messages, plan summary, top-8 memory |
| **Warm** | `.zelari/plan.json`, `completion.json`, `AGENTS.MD`, decisions |
| **Cold** | Session JSONL, Lance drawers, git |

`/compact` remains for TUI scrollback; it does **not** replace `memory_search`.

### Large skills (Taste ~87 KB)

- Council: only `design-taste-glasspetrae-council.md`
- Full: `/skill` or memory drawer after the first design run

---

## 10. Configuration and environment variables

| Variable | Default | Description |
|-----------|---------|-------------|
| `ZELARI_MEMORY` | `1` | `0` disables the Lance backend |
| `ZELARI_MEMORY_BACKEND` | `lancedb` | future `mempalace` |
| `ZELARI_MISSION_AUTO` | `0` | `1` skips brief confirmation |
| `ZELARI_MISSION_MAX_ITER` | `6` | Max implementations (design-phase outside the budget) |
| `ZELARI_MODE_MAX_TOOLS_LUCIFER` | `30` | Implementer tool cap |
| `ZELARI_COUNCIL_MODE` | (auto) | `design` / `impl` override |
| `ZELARI_VERIFY_AUTOFIX` | `0` | Already documented in the verify roadmap |

---

## 11. Phased implementation plan

### Phase 0 - Product decisions (gate)

- [ ] Brief: auto-start vs confirmation
- [ ] Stop: all high tasks vs MVP slice in the brief
- [ ] Headless zelari in v0.8 or v0.9

### Phase 1 - Memory (foundation)

- [ ] `MemoryBackend` + `LanceSqliteBackend`
- [ ] `fact_entities` schema fix
- [ ] Lance hybrid integration test (tmp dir)
- [ ] `memory_add` / `memory_search` tools in the CLI registry
- [ ] Wire `ragContext` into council dispatch (read-only)

### Phase 2 - Mission + router

- [ ] `mission.ts` classifier + IT keywords
- [ ] `missionBrief.ts` (heuristic + optional LLM)
- [ ] `skillRouter.ts` + tests with generic prompts
- [ ] Built-in skill files (Taste+glasspetrae, zelari-*)

### Phase 3 - Zelari-mode TUI

- [ ] `ChatMode: 'zelari'`
- [ ] `zelariMission.ts` state machine
- [ ] Lucifero tool limits
- [ ] `mission-state.json` + handoff

### Phase 4 - Council integration

- [ ] `computeAgentSkills` + runMode + routed ids
- [ ] Auto-chain design | impl in greenfield
- [ ] Post-slice `memory_add`

### Phase 5 - Docs and release

- [ ] `docs/GUIDA.md` Zelari-mode + memory sections
- [ ] `THIRD_PARTY_NOTICES`
- [ ] `scripts/sync-vendored-skills.mjs` (pin Taste upstream)

---

## 12. Tests and acceptance criteria

### Memory

- [ ] `memory.add` + `memory.search` roundtrip on the same projectRoot
- [ ] Hybrid query finds an exact FTS term and a semantic paraphrase
- [ ] Graph: entity | relation | correct fact (no entity id as fact id)
- [ ] Projects A and B isolated (distinct `.zelari/memory` paths)

### Skill router

- [ ] A generic BnB prompt assigns planning + design skills to the expected roles
- [ ] A "fix login" prompt does not assign the Taste overlay

### Zelari-mode (smoke)

- [ ] Greenfield prompt in an empty folder: generates brief, at least 1 council run, writes `mission-state.json`
- [ ] After 2 iterations, `memory_search` retrieves the slice 1 decision without the full JSONL in the prompt

### Regression

- [ ] `npm test` green
- [ ] Single council run (`mode council`) unchanged with `ZELARI_MEMORY=0`

---

## 13. Risks and mitigations

| Risk | Mitigation |
|---------|-------------|
| `better-sqlite3` fails on global install | optionalDep + `ZELARI_MEMORY=0` |
| Slow first start (embeddings) | Lazy load + TUI message |
| Infinite loop / API cost | `maxMissionIterations`, budget, handoff |
| Stale memory | "verify on disk" prompt; plan/completion SSOT |
| Lance JS API differs from the snippet | Real integration test, pinned version |
| Automatic scope creep | Brief `outOfScope` + explicit slices in the plan |

---

## 14. Appendix: data schema and tool API

### `mission-state.json` (example)

```json
{
  "missionId": "m_abc123",
  "userPrompt": "costruisci gestionale BnB...",
  "brief": { "intent": "greenfield", "skillPack": ["design-taste-glasspetrae"] },
  "iteration": 2,
  "currentSliceId": "slice-2",
  "status": "running",
  "lastCompletionOk": false,
  "startedAt": "2026-07-05T12:00:00Z",
  "updatedAt": "2026-07-05T12:45:00Z"
}
```

### `memory_search` tool (indicative Zod schema)

```typescript
{
  query: string;
  limit?: number;      // default 8
  useGraph?: boolean;  // default true
}
```

### `memory_add` tool

```typescript
{
  content: string;
  metadata?: Record<string, unknown>;
  entities?: { name: string; type?: string }[];
  relations?: { from: string; to: string; type: string; weight?: number }[];
}
```

### Existing code references

| Area | Path |
|------|------|
| Council dispatch | `src/cli/councilDispatcher.ts` |
| Run mode | `packages/core/src/council/runMode.ts` |
| Completion | `packages/core/src/council/completion/` |
| Post hook | `src/cli/workspace/postCouncilHook.ts` |
| Skills MD | `src/cli/skillsMd.ts` |
| Compaction | `src/cli/compaction.ts` |
| MCP client | `src/cli/mcp/mcpClient.ts` |
| Delivery roadmap | `docs/plans/2026-07-05-council-complete-delivery-roadmap.md` |

---

## Document changelog

| Date | Note |
|------|------|
| 2026-07-05 | First unified draft: Zelari-mode + Lance/SQLite memory + built-in skills |

---

*End of guide - implement only after Phase 0 confirmation and plan review.*