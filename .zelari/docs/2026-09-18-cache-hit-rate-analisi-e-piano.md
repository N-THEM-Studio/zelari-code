# Cache hit rate in zelari-code — analisi e piano (2026-09-18)

> Stato: ipotesi di design verificata sul sorgente (file:line sotto). Nessuna modifica al prodotto ancora applicata.

## Verdetto

Il caching DeepSeek è **automatico lato server** (disk cache, unità di prefisso da 64 token,
hit ≈ $0.014/MTok vs miss ≈ $0.14/MTok, eviction best-effort in ore/giorni). La **hit rate
dipende dalla stabilità byte-per-byte del prefisso della richiesta → responsabilità del client → nostra**.

Fonti: https://api-docs.deepseek.com/guides/kv_cache/ · https://platform.claude.com/docs/en/build-with-claude/prompt-caching

## Cosa già facciamo bene (non toccare)

- Split system prompt **stabile/volatile**: `packages/core/src/agents/systemPromptBuilder.ts:163` (`buildSystemPromptSplit`), emesso come `[stable, volatile]` multi-system (`:295-300`). ADR: `docs/decisions/012-durable-state-and-prompt-cache.md`.
- Tools **sortati lessicograficamente** a ogni request: `src/cli/provider/openai-compatible.ts:707` (connect order MCP/skill non busta).
- `messageMappingCache` WeakMap per mapping wire stabile: `openai-compatible.ts:644-654`.
- Anthropic: 2 breakpoint `cache_control` (blocco stabile + ultimo messaggio), TTL via `ZELARI_PROMPT_CACHE_TTL`: `src/cli/provider/anthropic.ts:88-130`.
- Parsing hit normalizzato per provider (`prompt_cache_hit_tokens` DeepSeek, `cached_tokens` OpenAI/xAI/GLM, `cache_read_input_tokens` Anthropic) → `UsageBreakdown.cachedPromptTokens`: `openai-compatible.ts:407-435`, `anthropic.ts:278-312`.
- Telemetria in-app: `/cache stats` (hitRate, premiumTokens, stableBustCount) — `src/cli/state/promptCacheStats.ts`, `src/cli/hooks/chatStats.ts:88-100`; costi cache-aware `src/cli/modelPricing.ts:113-145`.
- Compaction **cache-aware implementata** (v1.36.0): replay del prefisso originale in `src/cli/budget/llmCompact.ts`; pipeline prune 80% / compact 85% / trim 95% in `src/cli/budget/tokenBudget.ts:159-300`; shadowing range `[fromSeq,toSeq]` via `session.compacted` (append, non rewrite della spine).

## Dove perdiamo hit oggi (gap, in ordine di impatto)

1. **Il segmento volatile sta PRIMA della history** (`systemMessagesFromSplit` → `[stable, volatile]` entrambi prima dei messaggi; council: 4 system message in `packages/core/src/agents/council/memberMessages.ts:88-99`). Su DeepSeek il caching è lineare sul prefisso: ogni cambio a workspace snapshot / RAG / durable state busta **tutta** la history. Su Anthropic il breakpoint sul blocco stabile mitiga, ma volatile+history si ribustiscono comunque.
2. **Nessun dato osservato su disco**: 188+ sessioni in `.zelari/sessions/` ma 0 `metrics.jsonl` con `cacheHitTokens` e 0 `usage.cachedPromptTokens` negli `events.jsonl` (spine ADR-0016 senza usage; sidecar BrainEvent non persistito in modo aggregato). Il wiring di capturing esiste ma non ha mai prodotto dati → oggi ottimizziamo alla cieca.
3. **Env DeepSeek riletti per-call**: `resolveDeepSeekThinking()` legge `ZELARI_DEEPSEEK_THINKING`/`ZELARI_DEEPSEEK_REASONING_EFFORT` a ogni request (`openai-compatible.ts:653-665`) — rischio bust se cambiano mid-session.
4. **`tool_choice` toggle su Grok recovery**: `openai-compatible.ts:716-721` (forza `required` al primo recovery turn) — bust body-level su Grok.
5. **Registry changes mid-session**: add/remove tool o skill cambia l'array `tools` → bust completo (inevitabile per contratto, ma va quantizzato).

## Cosa NON dipende da noi

- Eviction best-effort e granularità 64 token (DeepSeek); isolamento per-utente; nessuna garanzia 100%.
- Anthropic: min cacheable tokens 512–4096 per modello, max 4 breakpoint, TTL 5m/1h, write 1.25x/2x (read 0.1x).
- TTL/eviction orari di inattività tra sessioni.

## Piano proposto

- **M1 — Misurare (prerequisito)**: completare il wiring persistenza usage→`metrics.jsonl` (o sidecar per-session con `cachedPromptTokens`) e raccogliere baseline hit-rate per provider su sessioni reali. Accettazione: ≥1 sessione DeepSeek con hit-rate calcolabile da disco.
- **M2 — Strutturale (massimo impatto)**: spostare il volatile **dopo** la history come trailing context message (o quantizzarlo: refresh solo a fine turno, mai mid-turn). Su DeepSeek trasforma "ogni cambio workspace = full miss" in "miss solo dell'ultimo segmento". Da valutare impatto qualità (contesto visto dopo la conversazione); alternativa conservativa: freeze del volatile a session start + delta in coda.
- **M3 — Igiene body**: risolvere env thinking una volta per sessione; stabilizzare `tool_choice` su Grok (o accettare il bust documentandolo).
- **M4 — Opzionale**: council fan-out — garantire che i membri condividano prefisso identico fino al banner personale (già quasi così in `memberMessages.ts`) per hit sul blocco comune in parallelo.

## Nota su "DeepSeek harness"

Il confronto in `.zelari/docs/comparazione-harness-grok-build-vs-zelari-code.md` NON tratta caching. I riferimenti in-repo utili: ADR-012 (cache-aware prompt split, ispirato a "Cache Wars"), ADR-0016 (ispirazione deepseek-harness/Cordis per la spine append-only), `docs/plans/ContextUPGRADE.md` (RequestSnapshot/RequestMeter/cache-aware compaction).
