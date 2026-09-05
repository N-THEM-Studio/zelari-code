# ADR-0029: Native-first shared cognitive memory

- **Status**: accepted
- **Date**: 2026-08-23
- **Deciders**: Zelari Code council, maintainer

## Context

Zelari's JSONL memory keeps simple chunks and allows lexical recall across slices, but does not represent type, structured provenance, relations, supersessions or revisions. Council, Kraken and missions need the same local substrate without depending on a daemon or MCP.

Memory must not be confused with:

- `.zelari/state/`, verified and restorable execution state;
- `.zelari/sessions/`, event-sourced log and source of history;
- `AGENTS.MD`, a stable, curated, human-readable guide.

## Decision

1. `@zelari/core/memory` exposes two additive levels: `MemoryService` holds policy and retrieval; `CognitiveMemoryBackend` holds persistence and queries. The `MemoryBackend` V1 contract remains available via an adapter.
2. The first V2 backend lives in the CLI and uses SQLite under `.zelari/memory/memory.db`. `node:sqlite` runs exclusively in a worker; WAL, busy timeout, short transactions and bounded retries allow multiple processes without blocking the agent's event loop.
3. The v1 domain envelope contains typed nodes, closed-vocabulary edges and append-only versions. The SQLite schema is migrated forward-only; v2 adds visibility/access and an embedding index. A backup is created under lock before migration. A runtime never opens a future schema for writing and never silently downgrades.
4. Recall is local and deterministic: FTS/lexical, structured filters, configurable ranking, graph expansion, dedupe and a hard character budget. Semantic recall is an injected, optional extension: model ID and content hash prevent stale vectors, while every error falls back to FTS.
5. Every write through `MemoryService` goes through normalization, scope validation, payload limits and a secret scanner. By default memory is isolated to the project's canonical path.
6. Council, AgentHarness, Kraken, headless and missions consume the same API. Verifications create `validated_by`/`invalidated_by` relations; a `supersedes` relation makes the previous node obsolete while preserving its history.
7. Rollout is explicit (`ZELARI_MEMORY_V2=1` or the `sqlite` backend). The JSONL backend remains the compatible default; the V2 import is idempotent and does not delete `log.jsonl`.
8. The MCP adapter calls `MemoryService`, not SQL. It stays external, opt-in, subject to folder trust, exact scope, ownership, secret scan and rate limit.
9. Desktop uses a read-only JSON CLI bridge and presents search, detail, provenance, relations and history without duplicating semantics or persistence.

## Alternatives considered

- **MCP as internal transport**: rejected; it would add availability, transport and trust concerns to every native turn.
- **Extended JSONL only**: rejected for transactions, FTS, relations, revisions and multi-process concurrency.
- **Mandatory embeddings**: rejected; memory must stay readable and useful offline even without a semantic index.
- **Destructive overwrites**: rejected; decisions and confidence must be temporally reconstructible.

## Consequences

- Node 24 is the runtime requirement of the native SQLite backend.
- The database is a local project artifact and can be inspected, exported, retracted or explicitly deleted via `/memory`.
- Recall/write failures are fail-open except with `ZELARI_MEMORY_STRICT=1`; they never change the outcome of a turn or a graph.
- Semantic retrieval, the MCP adapter and the Desktop explorer are optional post-MVP extensions and do not condition the contract or native availability.