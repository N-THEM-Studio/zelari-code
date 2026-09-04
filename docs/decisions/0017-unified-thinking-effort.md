# ADR-0017 — Selezione unificata del "thinking effort" per tutti i provider

**Status:** Proposto — **parcheggiato** (triage 2026-09-04, vedi "Esito triage" in fondo)
**Date:** proposta 2026-08-14 (git)

## Contesto

zelari-code supporta 8 provider (`grok`, `glm`, `minimax`, `deepseek`, `openai-compatible`, `chatgpt`,
`anthropic`, `custom`) con modelli default per ciascuno (`grok-4.5`, `glm-4.6`, `MiniMax-M2.5`,
`deepseek-v4-pro`, `gpt-5.2-codex`, `claude-sonnet-4-5`).

Molti di questi modelli sono *reasoning-capable*, ma espongono **controlli diversi** sul ragionamento:

- OpenAI / xAI → **enum** `reasoning_effort` (`low`/`medium`/`high`).
- Anthropic → **budget token** `thinking: { type: "enabled", budget_tokens: N }`.
- DeepSeek / GLM / MiniMax → toggle/budget **provider-specifici**.

Oggi **non esiste alcun controllo utente** sull'effort: vale il default del provider (es. `providerConfig.ts`
documenta che `grok-4.5` ha `reasoning_effort` default `high`). Il harness già **streamma** il thinking
(`kind: 'thinking'` in `chatgpt.ts` e `anthropic.ts`; scrub di `<think>`/`<thinking>` in `useChatTurn.ts`),
ma l'utente non può scegliere l'effort. Impatto reale: effort alto = più token di reasoning = più lento e più
caro; effort basso = più veloce ed economico. L'utente dovrebbe poterlo regolare per modello e per fase
(plan → alto, build → basso).

## Decisione

Introdurre un'astrazione unica **`ThinkingSpec`** e un **adattatore per provider** che la traduce nei parametri
di richiesta specifici:

```ts
type ThinkingSpec =
  | 'auto'                                   // default: nessun parametro inviato (default del provider)
  | { kind: 'off' }                          // niente extended thinking (veloce/economico)
  | { kind: 'effort'; effort: 'low' | 'medium' | 'high' }   // enum (OpenAI/xAI)
  | { kind: 'budget'; budgetTokens: number }                 // budget token (Anthropic/GLM/DeepSeek)
```

Regole operative:

1. **Tabella di capability per modello** (`{ effort?: boolean; budget?: boolean }`): la UI offre solo le scelte
   valide per il modello attivo. Inviare un `kind` non supportato **degrada a `'auto'`** con warning, mai errore.
2. **Adattatori per provider** nei tre punti di costruzione richiesta: `openai-compatible.ts`
   (chat.completions), `chatgpt.ts` (Responses → `reasoning`), `anthropic.ts` (Messages → `thinking`).
3. **Superficie di controllo**: persistenza per-provider in `provider.json` (`providerConfig.ts`), comando slash
   `/effort` (o `/thinking`) e flag CLI `--effort`. Default globale `'auto'`.
4. **Default per modalità**: plan/council → effort alto, build/agent → effort basso, con override utente.

### Mappatura attuale (DA VERIFICARE a runtime contro ogni API — cambia spesso)

| Provider | Kind | Parametro richiesta (da confermare) |
|---|---|---|
| `openai-compatible` / `grok` (xAI) | effort | `reasoning_effort`: `low`/`high` |
| `chatgpt` (OpenAI) | effort | Responses: `reasoning.effort`; Chat: `reasoning_effort` |
| `anthropic` | budget | `thinking: { type: "enabled", budget_tokens: N }` |
| `glm` (Z.AI) | budget | `thinking: { type: "enabled", budget_tokens: N }` |
| `deepseek` | toggle/budget | `thinking` / variante `-reasoner` (da verificare) |
| `minimax` | effort/budget | provider-specific (da verificare) |

## Alternative considerate

1. **Passthrough `extraBody` libero per provider** — rifiutata: nessuna semantica cross-provider, nessuna
   validazione, nessuna UI coerente.
2. **Solo enum `low/medium/high` per tutti** — rifiutata: Anthropic/GLM/DeepSeek usano budget token; forzare un
   enum fittizio perde fedeltà.
3. **Solo budget token** — rifiutata: OpenAI/xAI non accettano budget grezzi, accettano enum di effort.

## Conseguenze

**Positive**

- Controllo uniforme costi/latenza su tutti i provider da un'unica superficie.
- Default consapevoli per modalità (plan alto, build basso).
- La tabella di capability mantiene la UI onesta (niente scelte invalide).

**Negative / residuali**

- La mappatura per provider deve inseguire API che cambiano in fretta; una mappatura ignota degrada a `'auto'`
  in modo silenzioso — mitigare con una "versione di mappatura nota" + log di warning.

## TODO

- [ ] Definire `ThinkingSpec` + tabella capability (`canThinking: { effort?, budget? }`) per modello.
- [ ] Implementare gli adattatori nei tre provider (`openai-compatible`, `chatgpt`, `anthropic`).
- [ ] Aggiungere campo config in `provider.json`, comando `/effort`, flag `--effort`.
- [ ] Verificare i nomi parametro live (`reasoning_effort`, `reasoning`, `thinking.budget_tokens`) per provider
      prima di finalizzare la mappatura.

## Esito triage (2026-09-04, task t37/S6)

**Verdetto: parcheggiato** — né accettato né ritirato. Evidenza su disco:

- `ThinkingSpec`, `reasoningEffort`, `reasoning_effort`: **zero occorrenze** in `src/` e
  `packages/core/src/` (grep 2026-09-04); nessun flag `--effort`, nessun comando `/effort`.
- La superficie descritta (tabella capability, adattatori per provider, persistenza in
  `provider.json`) non è mai stata implementata dalla proposta (2026-08-14).

**Condizioni di riapertura:** il benchmark competitivo (t31, `bench:competitive` in
`tools/eval/`) ora misura token/costo per run. Se i dati mostrano che l'effort di
reasoning è una leva di costo/latenza significativa cross-provider, riprendere questo
ADR aggiornando la mappatura provider. Fino ad allora restano validi i default per
provider già documentati in `providerConfig.ts`.
