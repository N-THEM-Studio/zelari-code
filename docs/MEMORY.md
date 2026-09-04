# Native cognitive memory

Zelari Code can share project knowledge across AgentHarness, Council, Kraken
tentacles, missions and subsequent sessions. V2 is local, requires no MCP and
no external service, and preserves the provenance of every piece of
information.

## Activation

The historical JSONL behavior remains the default. To activate SQLite V2:

```powershell
$env:ZELARI_MEMORY_V2 = '1'
zelari-code
```

Setting `ZELARI_MEMORY_BACKEND=sqlite` is equivalent. When V2 is active,
automatic writes are enabled; `ZELARI_MEMORY_AUTO_WRITE=0` keeps recall but
disables new memories produced by agents.

| Variable | Effect |
|---|---|
| `ZELARI_MEMORY=0` | Disables every memory backend |
| `ZELARI_MEMORY_V2=1` | Activates the native SQLite service |
| `ZELARI_MEMORY_BACKEND=sqlite` | Explicitly selects SQLite V2 |
| `ZELARI_MEMORY_BACKEND=file` | Forces the compatible JSONL backend |
| `ZELARI_MEMORY_AUTO_WRITE=0` | Recall active, auto-write disabled |
| `ZELARI_MEMORY_SEMANTIC=1` | Enables the hybrid semantic index and recall |
| `ZELARI_EMBED_MODEL=<id>` | Embedding model (default `text-embedding-3-small`) |
| `ZELARI_EMBED_TIMEOUT_MS=<ms>` | Embedding timeout, clamped to 1–120 seconds |
| `ZELARI_MEMORY_SEMANTIC_MIN_SCORE=<0..1>` | Semantic threshold (default `0.15`) |
| `ZELARI_MEMORY_MCP=1` | Enables the optional external MCP server |
| `ZELARI_MEMORY_MCP_ADMIN=1` | Allows non-owner MCP mutations (not recommended) |
| `ZELARI_MEMORY_STRICT=1` | Makes a V2 initialization error fatal |

An explicit use of `/memory` initializes the SQLite backend for inspection
even without flags, unless `ZELARI_MEMORY=0` is set.

## Persistence and model

The database lives in `.zelari/memory/memory.db`. SQLite uses WAL and a
dedicated worker, so queries and writes never block the agent's event loop.
Every project gets a scope derived from the real canonical path: recall does
not automatically cross repository boundaries.

The database uses forward-only migrations with `PRAGMA user_version`. A
migration from an existing database acquires a lock, runs a WAL checkpoint and
first creates a `memory.db.v<origin>.bak` backup. An older runtime refuses a
future schema; a failed migration is rolled back.

A memory contains:

- a controlled kind (`fact`, `decision`, `finding`, `failure`, `verification`,
  `outcome`, etc.);
- importance, confidence and lifecycle state;
- `project` or `private` visibility (external owner);
- structured provenance (agent, session, mission, slice, tentacle, file,
  symbol, commit and verification);
- bounded tags and metadata;
- immutable revisions for update, retraction and supersession;
- typed edges such as `supports`, `derived_from`, `validated_by`,
  `invalidated_by` and `supersedes`.

The old `.zelari/memory/log.jsonl` is imported once idempotently, keeping
timestamps and legacy references. The source file is not deleted.

## Recall and security

Recall combines lexical FTS, filters, importance, confidence, recency and
graph proximity. If no semantic index exists, its weight is redistributed:
embeddings are not required. `buildContext()` produces a `[ZELARI MEMORY]`
block with a strict character budget and visible provenance; retracted,
archived or superseded nodes are never injected as current knowledge.

Content, source and metadata pass through a secret scanner. Private keys are
rejected; known tokens, credential assignments and high-entropy strings are
redacted. Telemetry contains only identifiers and measures, never the text of
memories.

### Optional semantic index

With `ZELARI_MEMORY_SEMANTIC=1`, Zelari reuses the configured embedding
provider but keeps an independent memory index. Every vector stores the model
ID, dimensions and SHA-256 of the content: an update invalidates the previous
vector and prevents the use of stale data. Recall lazily indexes a small
batch; an explicit, interruptible rebuild is available with:

```text
/memory index
/memory index --force
```

Provider errors, corrupted vectors or a missing model always degrade to the
deterministic FTS/lexical recall.
Vector scanning, index validation and hashing happen in the SQLite worker;
only the best candidates return to the agent process, avoiding blocking the
event loop or transferring the whole index.
Activation is explicit also because the configured provider may be remote: the
already-sanitized content of memories is sent to its embedding endpoint. For
data that must not leave the machine, use a local provider or keep semantic
recall disabled.

## Commands

```text
/memory
/memory stats
/memory search <query>
/memory show <id>
/memory related <id>
/memory history <id>
/memory retract <id> [reason]
/memory forget <id> --yes
/memory consolidate [query]
/memory index [--force]
/memory promote <id>
/memory doctor
/memory export [path-relative-to-project]
```

`retract` keeps revisions and provenance and is the normal choice. `forget`
performs a physical deletion (node, edges and history) and requires `--yes`.
Export cannot write outside the project.
`promote` accepts only durable, active knowledge (`fact`, `decision`,
`constraint`, `preference`, `procedure`) and inserts it into a managed,
idempotent block of `AGENTS.md`; consolidation never modifies that file on its
own.

## External MCP (optional)

MCP is not used by AgentHarness, Council, Kraken, missions, headless or
Desktop. To expose the same service to an external client:

```powershell
$env:ZELARI_MEMORY_V2 = '1'
$env:ZELARI_MEMORY_MCP = '1'
zelari-code --trust .
zelari-code --memory-mcp --cwd . --client-id cursor-local
```

The stdio server exposes `zelari_memory_search`, `get`, `add`, `link`,
`history` and `retract`, plus the `zelari://memory/...` resources. Writes
require the exact `project_id`, always receive `source.client`, pass through
the same secret scanner and are rate-limited per minute. MCP memories are
`private` by default; another client sees only `project` memories and its own
private ones. Retraction and relations with lifecycle effects are owner-only,
unless an explicit administrative opt-in is given.
`--client-id` (or `ZELARI_MEMORY_MCP_CLIENT_ID`) makes ownership stable across
restarts. It is a local boundary between clients of the same user, not a
remote authentication system; folder trust and filesystem permissions remain
the primary security boundary.

## Desktop

The Desktop project panel includes the **Memory** tab: search and filters by
type, importance/confidence indicators, current state, visibility, provenance,
relations and revision timeline. Desktop uses the CLI's read-only JSON bridge
and never accesses the database directly.

## Separation from the other layers

- `.zelari/state/` remains the verified, restorable state.
- `.zelari/sessions/` remains the event-sourced history.
- `AGENTS.MD` remains the curated, stable layer for humans and agents.
- MCP is optional and, when available, must adapt to `MemoryService`; it is
  not the transport used internally by Zelari.

On error, the default is a warning and continuing without memory. Run
`/memory doctor` for integrity, foreign keys, schema version and FTS
availability; use `ZELARI_MEMORY_STRICT=1` only in environments that require
memory as a precondition.

For the targeted gate: `npm run test:memory`. The suite covers restart,
supersession, migration/rollback, corrupted semantic index, MCP privacy,
MCP↔native round-trip and Recall@K/precision/stale/duplicate/p95 metrics.
