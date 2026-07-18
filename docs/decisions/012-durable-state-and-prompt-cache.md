# 012 — Durable State Layer + Prompt Cache Efficiency

**Status:** accepted  
**Date:** 2026-07-18

## Context

Two 2026 papers motivate complementary upgrades:

1. **Palmer — *State, Not Tokens***: repository-scale reliability is bound by *state architecture* (verified accumulation), not context length. Stateless RAG re-derives; durable commits enable resume and conflict-free inheritance.
2. **AGNT Labs — *The Cache Wars***: harness cost is dominated by client-side cache TTL, static marker placement, and **byte-stable prefixes**. Mixing plan/memory into the system prefix every turn busts cache.

Zelari already had fragmented persistence (memory JSONL, mission-state, git checkpoints, session events) and *accounted* for cached tokens, but not engineered accumulation or prefix stability.

## Decision

1. Introduce `DurableStateStore` types in `@zelari/core` and a file backend under `.zelari/state/` (JSON commits + artifacts; no SQLite in v1).
2. **Commit gate:** auto-commit only after verification PASS (Zelari success path); manual `/state commit` may force soft commits.
3. Split system prompts into **stable** (identity, tools, role, project instructions) and **volatile** (workspace, RAG, durable materialize, phase banners) via `buildSystemPromptSplit`.
4. Instrument session cache hit rate, premium tokens, and stable busts; surface in StatusBar and `/cache stats`.
5. Do **not** require Anthropic `cache_control` for OpenAI-compatible providers (automatic prefix caching); keep TTL config for a future Anthropic path.

## Consequences

- Successor mission slices receive `materializeContext(HEAD)` as verified context (zero LLM re-query).
- Plan/memory updates no longer rewrite the stable prompt string (better hit rate).
- Memory remains soft RAG; durable state is the authoritative post-verification chain.
- Linked git checkpoints remain the working-tree safety net; state commits may reference them.
