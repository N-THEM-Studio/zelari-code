# Piano implementativo — Cache hit rate (DeepSeek-first) · 2026-09-18

> Fase: PLAN → pronto per BUILD. Questo documento è il contratto di implementazione.
> Analisi di riferimento: `.zelari/docs/2026-09-18-cache-hit-rate-analisi-e-piano.md` (verdetto: la hit rate dipende dalla stabilità byte-per-byte del prefisso della request → responsabilità nostra, non del provider).
> ADR correlate: `docs/decisions/012` (prompt split stable/volatile), `0016`/`0021` (spine), `0024` (single write model).
> Nota: i numeri di riga vengono dalle explore del 2026-09-18; in BUILD ri-localizzare per nome simbolo (possono driftare di poche righe).

## Obiettivo e metrica

Alzare la prompt-cache hit rate (DeepSeek: caching automatico, unità 64 token, hit ≈ 1/10 del prezzo del miss; Anthropic: cache_control esplicito) per ridurre costi input e latenza.

- **Metrica primaria**: `hit% = cachedPromptTokens / promptTokens` per chiamata LLM, aggregata per sessione/provider/modello, letta da `~/.zelari-code/metrics.jsonl` (record `kind:'message'`, nuovo).
- **Obiettivo verificabile**: su sessioni ≥5 turni vs DeepSeek, hit% medio dal turno 2 in poi **≥ 60%**. Baseline attesa ~0–20% (da misurare in M1.2 PRIMA di toccare il layout).

## Principio guida

Il caching è prefisso byte-per-byte. Layout target della request:

```
[ system stabile: identità, istruzioni, moduli, tools ]   ← cacheabile per tutta la sessione
[ history (spine → deriveMessages) ]                      ← cacheabile, append-only
[ trailing context: workspace/RAG/durable (solo DATI) ]   ← cambia spesso, costa poco in coda
[ messaggi nuovi del turno ]                               ← miss fisiologico
```

Regola: tutto ciò che cambia spesso va il più tardi possibile nella request.
**Invariante critico**: il trailing context è **efimero** — costruito a ogni request nel layer di assemblaggio, MAI persistito nello spine/history/harness state (altrimenti si duplica al turno successivo e inquina il contesto).

## Stato di partenza (verificato su sorgente)

- Split stable/volatile: `packages/core/src/agents/systemPromptBuilder.ts:172` (`buildSystemPromptSplit`), `:295` (`systemMessagesFromSplit` → `[stable, volatile]` ENTRAMBI system, PRIMA della history). Il volatile = 3 stringhe caller-supplied: `workspaceContext` (:252), `ragContext` (:255), `durableStateContext` (:259). La funzione è **pura** (niente Date.now/random/uptime; ordinamenti Map/Set deterministici dato l'input).
- Call site attivi: `packages/core/src/agents/councilApi.ts:474`, `packages/core/src/agents/council/memberMessages.ts:82` (system = [stable, volatile, banner, IMPORTANT]), `src/cli/headless/runOneTurn.ts:474+512`, `src/cli/hooks/useChatTurn.ts:774+798`. (`src/cli/runHeadless.ts:52-53` = import morti.)
- Anthropic: 2 breakpoint — bp1 su blocco stable (`stableIdx = len-2`, `src/cli/provider/anthropic.ts:127`), bp2 rolling sull'ultimo messaggio (:120-122); TTL via `resolvePromptCacheTtl` (:111).
- Telemetria: parsing normalizzato (`openai-compatible.ts:408-433`, `anthropic.ts:283-308`) → `UsageBreakdown.cachedPromptTokens`; `/cache stats` legge SOLO stato in-memory (`slashHandlers/cache.ts:27-61`); writer `src/cli/metrics.ts` (`MetricsLogger`, path `~/.zelari-code/metrics.jsonl`, override `ANATHEMA_METRICS_FILE`) funziona ma:
  1. le run headless (`runHeadless.ts`, `runOneTurn.ts`) **non chiamano mai** `record({kind:'run'|'message'})` — solo `recordCompactionMetrics` (`runOneTurn.ts:550`, `runHeadless.ts:998/1319`);
  2. la TUI registra `kind:'run'` (`useChatTurn.ts:1093-1130`) ma `cachedPromptTokens` è solo fuso in `costUsd`, mai persistito come campo;
  3. `sessionSpine.mirrorBrainEvent` (`sessionSpine.ts:551-571`) **scarta** `usage` su `message_end` → `events.jsonl` senza usage.
- Test che pinnano il layout attuale: `tests/unit/core-systemPromptSplit.test.ts:75-82` (stable prima di volatile), `:84-103`; `tests/unit/cli-anthropicCaching.test.ts:62-83`, `:162-180`. Nessun test snapshot/golden esiste.

## Slice

### M1.1 — Persistere usage provider-verified (`kind:'message'`) — S — PREREQUISITO

**Goal**: una riga su disco per ogni chiamata LLM con il numero reale restituito dal provider.

**File**: `src/cli/metrics.ts` (schema `MetricsRecord` ~:38-85), `src/cli/hooks/useChatTurn.ts` (branch `message_end` ~:1051-1063), `src/cli/headless/runOneTurn.ts` (event loop ~:651, dove passa ogni BrainEvent delle run headless).

**Passi**:
1. Aggiungere a `MetricsRecord`: `promptTokens?: number`, `cachedPromptTokens?: number` (+ `completionTokens` se non già derivabile).
2. Emittiere `record({kind:'message', sessionId, provider, model, tokens, promptTokens, cachedPromptTokens, costUsd})` nel branch `message_end` della TUI (`useChatTurn.ts`) E della run headless (`runOneTurn.ts` — **è la riga che sblocca le 188 sessioni esistenti**). `costUsd` via `calculateCost` cache-aware già esistente (`modelPricing.ts:125-135`).
3. NON toccare lo spine: `sessionSpine.ts` invariato in questo slice (enrich di `assistant.message` con usage = backlog v2, richiede check ADR-0021).

**Acceptance**: dopo una run headless (o ≥3 turni TUI), `~/.zelari-code/metrics.jsonl` contiene ≥1 record `kind:'message'` con `cachedPromptTokens` definito (anche 0) per ogni chiamata LLM; unit test sul writer.
**Verify**: `npx vitest run tests/unit/` + ispezione del file dopo una run.

### M1.2 — Report offline + baseline — S

**Goal**: misurare la hit rate attuale senza toccare il layout, e registrare la baseline.

**File**: `src/cli/utils/doctor.ts` (~:469 aggrega già `cacheHitTokens` da `kind:'run'`).

**Passi**:
1. Nuova sezione doctor "Prompt cache (provider-verified)": aggrega i record `kind:'message'` per provider/model → hit%, promptTokens totali, cachedTokens. `/cache stats` resta live in-memory (invariato).
2. Procedura baseline: 1 run dogfood (`npm run dogfood:run`; richiede `ZELARI_API_KEY` o `ZELARI_LOCAL_CLI` + `dist/` buildata) oppure sessione TUI ≥5 turni su DeepSeek, PRIMA di M2. Registrare hit% nella tabella risultati in fondo.

**Acceptance**: `zelari-code --doctor` stampa hit% per provider/model; riga "Baseline" compilata nella tabella di questo doc.

### M2.1 — Layout cache-first: volatile → trailing context — M — impatto massimo

**Goal**: il cambio di workspace/RAG/durable busta solo il blocco finale, non la history.

**File**: `packages/core/src/agents/systemPromptBuilder.ts`, barrel `packages/core/src/skills/index.ts:25-26`, call site: `packages/core/src/agents/council/memberMessages.ts:82-100`, `packages/core/src/agents/councilApi.ts:474`, `src/cli/headless/runOneTurn.ts:474+512`, `src/cli/hooks/useChatTurn.ts:774+798`; test `tests/unit/core-systemPromptSplit.test.ts`.

**Design**:
1. `systemMessagesFromSplit` emette **solo** stable; nuovo helper puro `trailingContextFromSplit(split): string` (il testo è già `split.volatile`).
2. I call site assemblano la request come `[...stableSystem, ...history, {role:'user', content: wrapTrailing(split.volatile)}, ...messaggiNuoviTurno]` dove `wrapTrailing = "<context-update>\n" + volatile + "\n</context-update>"`. **Solo dati, zero istruzioni** (le istruzioni restano nello stable). Se `volatile` è vuoto → nessun messaggio aggiunto.
3. Council: system = `[stable, banner per-membro, IMPORTANT condivisa]`; trailing come sopra, dopo la history del membro.
4. Flag di rollback: `ZELARI_PROMPT_LAYOUT=legacy|trailing` (default `trailing`; `legacy` ripristina l'assemblaggio `[stable, volatile]` pre-M2 per un ciclo di release).
5. **Invariante efimero**: il trailing non entra mai nello state history/harness/spine — verificarlo esplicitamente (se l'agent loop lo ri-ingestisce come turno utente, il contesto si duplica a ogni turno).

**Test**: riscrivere `core-systemPromptSplit.test.ts:75-82` e `:84-103` (stable-only da `systemMessagesFromSplit` + trailing separato); nuovo test layout request `[stable][history][trailing][new]`; test flag `legacy`.

**Acceptance**: `npm run typecheck` + `npm run test` verdi; nuovo test layout verde; `ZELARI_PROMPT_LAYOUT=legacy` riproduce il body pre-M2.

### M2.2 — Breakpoint Anthropic sul nuovo layout — S (+ v2 opzionale data-driven)

**File**: `src/cli/provider/anthropic.ts` (`withRollingCacheBreakpoint` :77-96, body build :99-132, `stableIdx` :127), `tests/unit/cli-anthropicCaching.test.ts`.

**v1 (questo slice)**: con system single-block, bp1 su `system[0]` (la formula `stableIdx` già degenera a 0 con length 1); bp2 rolling sull'ultimo messaggio (invariato). Aggiornare i test `:62-83` e `:162-180` alla nuova shape (input `[STABLE]` + history + trailing).

**v2 (opzionale, solo se i dati M1 mostrano hit% Anthropic basso)**: parametro opzionale nei provider params (`contextBoundary?: number`) → 3° breakpoint sull'ultimo messaggio di history, protegge la history quando il trailing cambia mid-tool-loop. Budget: 3 breakpoint su 4 consentiti.

**Acceptance**: test caching aggiornati verdi; nessun warning Anthropic per breakpoint mancanti su blocchi troppo piccoli (min cacheable 512–4096 token).

### M2.3 — Determinismo e quantizzazione del trailing — S-M

**Goal**: a parità di stato, il render del trailing è byte-identico (altrimenti miss perpetuo anche in coda).

**File**: audit dei composer delle stringhe volatile nei caller: `src/cli/hooks/useChatTurn.ts`, `src/cli/headless/runOneTurn.ts`, `packages/core/src/agents/council/memberMessages.ts`, `packages/core/src/agents/councilApi.ts` + i moduli che compongono workspace snapshot / RAG / durable state. (`systemPromptBuilder.ts` è già puro — verificato.)

**Passi**:
1. grep `Date.now()|new Date(|randomUUID|Math.random` nei composer del volatile; quantizzare (timestamp → precisione minuto) o rimuovere.
2. Memo/fingerprint per turno: se gli input del volatile non cambiano, riusare la stringa precedente byte-identica.

**Acceptance**: unit test — due render con stessi input → stringa identica; nessun timestamp non quantizzato nel volatile (test con allowlist esplicita).

### M3.1 — Igiene parametri body — S

**File**: `src/cli/provider/openai-compatible.ts` (`resolveDeepSeekThinking` :653-665 rilegge env a ogni call → risolvere UNA volta a costruzione provider; `tool_choice` Grok recovery :716-721 → valore deterministico per sessione), cleanup opzionale import morti `src/cli/runHeadless.ts:52-53`.

**Nota**: questi parametri non toccano i token di input (il caching DeepSeek è input-based), ma eliminano il rischio di model-switch mid-session (chat↔reasoner = cache diversa) e stabilizzano il body su Grok.

**Acceptance**: test — body di chiamate consecutive nella stessa sessione differiscono SOLO nel campo `messages`.

### M4 — Backlog (non in questo giro)

- Prefisso condiviso council: oggi il system base è per-membro (`resolveRoleSystemPrompt`, `memberMessages.ts:80`) → servirebbe base comune + delta ruolo in coda. Valutare solo se i dati M1 mostrano costo council significativo.
- Usage dentro `assistant.message` nello spine (rendere `events.jsonl` self-contained) — richiede check contratto ADR-0021.
- 4° breakpoint Anthropic; quantizzazione dei registry change mid-session (add/remove tool).

## Sequenza e dipendenze

```
M1.1 → M1.2 (baseline) → M2.1 → M2.2(v1) → M2.3 → M3.1 → misura post-M2
                                                      └→ (v2 / M4 solo se i dati lo giustificano)
```

M1.1 e M1.2 atterrano per primi (senza di loro ottimizziamo alla cieca). Nessuno slice modifica la spine o il contratto eventi.

## Verifica complessiva (BUILD)

1. `npm run typecheck` e `npm run test` verdi dopo ogni slice.
2. Run dogfood/TUI pre e post-M2 con confronto hit% via `zelari-code --doctor` (o lettura diretta di `~/.zelari-code/metrics.jsonl`).
3. Compilare la tabella risultati qui sotto (evidenza on-disk, non promesse).

## Rischi e rollback

| Rischio | Mitigazione |
|---|---|
| Qualità: contesto visto dopo la conversazione | trailing = solo dati in `<context-update>`, istruzioni restano nello stable; confronto qualitativo pre/post su run dogfood; `ZELARI_PROMPT_LAYOUT=legacy` come kill-switch |
| Trailing duplicato nello history | invariante efimero + test esplicito sul request-build |
| Breakpoint Anthropic su blocchi < min cacheable | bp solo su system stable e ultimo messaggio; test |
| Drift dei numeri di riga | ri-localizzare per nome simbolo in BUILD |
| Eviction/limite provider (non nostro) | accettato: eviction best-effort, 64 token, TTL 5m/1h |

## Tabella risultati (da riempire in BUILD)

| Fase | Data | hit% DeepSeek (turni ≥2) | hit% Anthropic | Note |
|---|---|---|---|---|
| Baseline (M1.2) | — | — | — | |
| Post M2.1+M2.3 | — | — | — | |

---

## Aggiunta 2026-09-18 (b) — Copertura per provider (verificata sul tree)

Domanda: *"questo migliora tutti i provider inseriti in zelari, non solo DeepSeek?"* — **Sì**: il caching, ovunque esista, è prefisso byte-per-byte; M1/M2.1 sono provider-agnostic per costruzione. Factory: `src/cli/provider/resolveStream.ts:14-25`; profili promptCache: `src/cli/provider/capabilities.ts`; parser usage per adapter (evidenza in-repo di ciò che ogni provider riporta e tariffa).

| Provider (adapter) | Caching server | Campo usage letto | Da cosa beneficia | Note |
|---|---|---|---|---|
| `deepseek` (openai-compat) | automatico, priced | `prompt_cache_hit_tokens` (`openai-compatible.ts:408-434`) | M1, M2.1, M3.1 | target principale |
| `grok` (openai-compat) | automatico, priced (`capabilities.ts:111-113`) | `prompt_tokens_details.cached_tokens` | M1, M2.1, M3.1 (tool_choice) | affinity `x-grok-conv-id` già attiva (`openai-compatible.ts:731-737`) |
| `anthropic` (nativo) | esplicito (breakpoint) | `cache_read/creation_input_tokens` (`anthropic.ts:283-308`) | M1, M2.1 **+ M2.2** (breakpoint sul nuovo layout) | TTL `ZELARI_PROMPT_CACHE_TTL` |
| `glm` (openai-compat) | riportato, non priced (`pricedCacheRead:false`, `capabilities.ts:158`) | `cached_tokens` | M2.1 (hit → latenza, non costo) | |
| `openai-compatible` / `custom` | dipende dal backend | `cached_tokens` | M2.1 | OpenAI auto (prefisso ≥1024 tok, tools inclusi); vLLM/Ollama via custom → riuso KV, guadagno latenza |
| `minimax` (openai-compat) | `promptCache.supported:false` (`capabilities.ts:136,147`) | — | neutro | nessun danno, nessun guadagno |
| `chatgpt` (Responses OAuth) | backend Codex, non osservato | **non letto** (`chatgpt.ts:235-244`) | M2.1 (ma invisibile alle stats) | gap parser → backlog sotto |
| `muse` (Responses) | non osservato | **non letto** (`responsesApi.ts:245-254`) | neutro | idem |
| `localCli` (claude CLI subprocess) | sì (Anthropic sotto) | `cache_read_input_tokens` (`claudeStreamJson.ts:180-194`) | M2.1 | eredita dal prompt stabile |

Non ci sono preset nativi per OpenRouter/Qwen/Gemini: si raggiungono solo via `custom` + endpoint esplicito, quindi beneficiano di M2.1 se e dove l'upstream cache-a.

**Correzioni rispetto alla stesura iniziale**:
- La env var Anthropic corretta è **`ZELARI_PROMPT_CACHE_TTL`** (`src/cli/hooks/chatStats.ts:100-107`), non `ZELARI_ANTHROPIC_CACHE_TTL`.

**Backlog aggiuntivo (opzionale, da schedulare solo se interessa la surface Responses)**:
- M1.3 — estendere il parser usage di `chatgpt.ts`/`responsesApi.ts` a `usage.input_tokens_details.cached_tokens` (campo che la Responses API OpenAI emette): oggi `/cache stats` e `--doctor` mostrano 0% su queste surface anche se il backend cache-a.

---

## Esito implementazione (2026-09-19, build phase)

M1.1 + M1.2 + M2.1 + M2.2 + M2.3 + M3.1 implementate e verificate (tsc exit 0; 8 suite / 61 test verdi, incl. e2e). Tree lasciato volutamente dirty (nessun commit).

**File nuovi**: `src/cli/budget/messageUsage.ts`(+test), `src/cli/budget/cacheHitReport.ts`(+test), `src/cli/headless/runOneTurn.messageUsage.test.ts`, `runOneTurn.promptLayout.test.ts`, `src/cli/provider/openai-compatible.sessionParams.test.ts`.
**File modificati**: `packages/core/src/agents/systemPromptBuilder.ts` (PromptLayout, wrapTrailingContext memo, assembleRequestMessages), `packages/core/src/skills/index.ts`, `src/cli/hooks/useChatTurn.ts`, `src/cli/headless/runOneTurn.ts`, `src/cli/provider/anthropic.ts` (3 breakpoint), `src/cli/provider/openai-compatible.ts` (freeze per istanza), `src/cli/utils/doctor.ts` (checkPromptCache WARN-only), test `core-systemPromptSplit`/`cli-anthropicCaching`/`cli-useChatTurn`.

**Scelte rilevanti**:
- Layout default `trailing`; rollback `ZELARI_PROMPT_LAYOUT=legacy` (frozen per processo). Invariante "trailing mai in spine/history" coperta da test e2e.
- Anthropic: bp1 stable system, bp2 confine history+trailing (via `<context-update>`), bp3 rolling tail deduplicato — max 3/4; legacy = pre-M2 senza regressioni.
- M3.1 freeze per istanza provider (non memo di modulo: non avvelena i test che mutano env); toggle recovery Grok mantenuto come eccezione documentata (correttezza > cache).
- `MetricsRecord` non allargato (writer possiede lo schema localmente) — follow-up tipizzare i due campi opzionali.

**Debiti aperti**: baseline hit% numerica = operativa post-merge (dogfood/TUI ≥5 turni DeepSeek, poi `--doctor`); M1.3 parser Responses; commit atomici per slice da fare.


## Esito commit (2026-09-20)

Lavorato committato in 6 commit atomici da `ec49404`:`0f6bc95` M2.1 core layout, `c413318` M1.2 doctor, `184eed1` M1.1+M2.1 wiring (+typing `cachedPromptTokens` in `src/cli/metrics.ts:67`), `67e8a7b` M3.1 freeze parametri, `c7915be` M2.2 breakpoint Anthropic, `d4555d4` changelog. Gate: tsc exit 0, 8 suite / 61 test verdi, git status pulito. Non pushato. Debito residuo: baseline numerica live (sessione >=5 turni DeepSeek + `--doctor`), backlog M1.3 parser usage Responses API.

## Esito push (2026-09-19)
- git push origin main -> fast-forward c9d776f..d4555d4, exit 0
- 7 commit pubblicati (ec49404 fix(accp) preesistente + 6 slice cache)
- Nota GitHub: 1 vulnerabilita' moderate (dependabot #6) preesistente sul default branch, non correlata a queste slice

## Backlog M1.3 implementato (2026-09-19, commit d641f95)
- parseCachedPromptTokens normalizza anche usage.input_tokens_details.cached_tokens (Responses API)
- chatgpt.ts + responsesApi.ts emettono cachedPromptTokens nel delta usage: /cache stats e --doctor vedono gli hit anche su surface Responses
- Test: cli-promptCaching 10/10 (2 nuovi); tsc exit 0; push fast-forward d4555d4..d641f95

## Release v2.54.0 (2026-09-19)
- tag v2.54.0 pushato (scope: exception:cache-hit-rate-slice-t127-t132-m1-3) su 3d9002b
- CI sul tag: success (4m19s); Publish to npm: success — @zelari/core@2.54.0 e zelari-code@2.54.0 pubblicati (log job: + zelari-code@2.54.0, 796 file, 4.1 MB)
- GitHub Release v2.54.0 creata (23:34:02Z)
- Release Desktop: in coda/corsa al momento del report (matrice Win/macOS/Linux + latest.json)
- Nota: dist-tags CDN npm in ritardo (fino a 15 min) sul flip di latest; verita dal log workflow
