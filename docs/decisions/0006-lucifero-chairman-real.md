# ADR-0006: Lucifero chairman synthesis reale

- **Stato:** ✅ Accettato
- **Data proposta:** 2026-07-02
- **Data accettazione:** 2026-07-02 (auto-accettata con il rilascio v0.6.0;
  il chairman era già definito in `roles.ts:175-` e i callback
  `onSynthesisStart`/`onSynthesisChunk`/`onSynthesisDone` erano già
  presenti in `councilApi.ts:115-117`, quindi lo stub era l'unica
  parte mancante)
- **Autore:** MiniMax-M3
- **Dipende da:** [ADR-0005](0005-deprecate-legacy-src-paths.md) (per i
  subpath stabili usati da Slice 3 dei test)

## Contesto

`Lucifero` (il "Final Synthesizer", nono cerchio dell'Inferno dantesco)
era dichiarato in `packages/core/src/agents/roles.ts:175-203` con un
systemPrompt dettagliato, ma in `councilApi.ts:528-557` la sua esecuzione
era uno **stub**:

```ts
// Lucifero synthesis (Phase 13 will add full chairman integration)
if (chairman && !completedIds.has(chairman.id)) {
  callbacks.onSynthesisStart?.();
  callbacks.onSynthesisDone?.('Lucifero synthesis: see agent outputs above.');
  emitMemberCost({ memberId: chairman.id, name: chairman.name,
    usage: null, durationMs: 0, toolCalls: 0, errored: false });
  yield createBrainEvent('member_cost', ...);
}
```

Conseguenze operative prima di v0.6.0:

1. Il council restituiva solo i 5 specialisti (e Minosse se
   `debateMode: true`). Nessuna sintesi finale reale.
2. Il callback `onSynthesisChunk` non veniva mai chiamato, quindi
   l'effetto typewriter sulla TUI non esisteva.
3. `durationMs: 0` e `usage: null` ingannavano `councilCost.ts` che
   non conteggiava il chairman.
4. L'header "· Lucifero" non appariva mai in ChatStream perché non
   venivano emessi eventi con `memberId='lucifer'`.

## Decisione

Promuovere il chairman a un'invocazione reale di `AgentHarness`,
identica al pattern dei 5 specialisti (riga 322-389 di
`councilApi.ts`):

1. **Costruzione del contesto.** `buildAgentMessages(chairman,
   userMessage, ..., agentOutputs, ...)` viene chiamato con
   `agentOutputs` (output dei 5 specialisti e di Minosse) come
   `priorOutputs`. Il chairman riceve quindi un prompt che contiene
   la sintesi di tutti i membri precedenti — esattamente come gli
   specialisti ricevevano i loro predecessori.

2. **Tool calls.** `computeAgentTools(chairman, aiConfig)` +
   `getProviderTools(...)` come per gli specialisti. Il chairman può
   quindi creare workspace artifacts (phase/task/idea/risk/document)
   quando il suo systemPrompt lo richiede.

3. **Streaming.** Per ogni `event` emesso dal chairman:
   - `tool_execution_start` → incrementa `toolCalls`.
   - `message_end` con `usage` → cattura il token breakdown.
   - `message_delta` → accumula `fullText` + chiama
     `callbacks.onSynthesisChunk(delta)` per il typewriter effect.
   - `error` con `severity !== 'cancelled'` → marca `errored = true`
     (l'AgentHarness cattura internamente gli errori del provider e
     li re-emette come BrainErrorEvent; non dobbiamo perdere questo
     segnale).

4. **Robustness.** Se l'LLM del chairman fallisce, il council run NON
   abortisce. I 5 output dei specialisti restano disponibili come
   fallback synthesis. Il membro `lucifer` viene marcato
   `errored: true` nel `member_cost` e il `onSynthesisDone` riceve
   un marker testuale: `[Chairman synthesis failed: <reason>]`.

5. **Visible reasoning.** `memberId: 'lucifer'` e
   `memberName: 'Lucifero'` vengono passati a `AgentHarness` (via
   `memberFields()` di v0.5.0) → ChatStream renderizza `· Lucifero`
   in viola (#8b5cf6) automaticamente, senza cambi al rendering.

6. **Backward compat.** `councilSize: 3` (default) **esclude**
   ancora Lucifero (è il 6° membro in `getCouncilAgents(6)`). I test
   esistenti con `councilSize: 3` non subiscono regressioni. Per
   attivare il chairman serve `councilSize: 6` (o, in futuro, un
   nuovo flag dedicated).

## Alternative considerate

- **Lasciare lo stub e documentarlo come "by design"**: scartato
  perché l'utente paga per una sintesi che non esiste, e
  `onSynthesisChunk` vuoto è un'API bugiarda.
- **Chairman come LLM separato (non AgentHarness)**: scartato per
  coerenza con gli specialisti e per riusare tool execution
  automatica.
- **Chairman come merge deterministico dei 5 output (no LLM)**:
  scartato perché il systemPrompt di Lucifero richiede esplicitamente
  reasoning su conflitti, priorità, e applicazione del feedback di
  Minosse — non è una semplice concatenazione.

## Conseguenze

**Positive**
- L'utente riceve una sintesi reale (5 specialisti + Minosse +
  Lucifero = 6 voices).
- Il council run è ora coerente con la documentazione e con i
  systemPrompt definiti in `roles.ts`.
- La `councilCost` può includere il chairman nei totali (durationMs
  e token usage reali).
- La TUI può mostrare un effetto typewriter durante la sintesi.

**Negative / rischi**
- +1 invocazione LLM per ogni `dispatchCouncil` con `councilSize:
  6` → costo e latenza aumentano. Mitigation: gli utenti che vogliono
  velocità possono usare `councilSize: 3` (no chairman) o, in futuro,
  un flag `--no-chairman`.
- Se il chairman LLM è configurato diversamente dagli specialisti
  (modello più pesante), il tempo di council cresce. Lo stesso
  `config.model` viene usato, quindi non c'è differenza per default.

## TODO

- [x] Slice 1: chairman reale con harness.run + streaming.
- [x] Slice 2: visible reasoning (memberId/memberName → ChatStream).
      Implementato gratis dal pattern v0.5 già esistente.
- [x] Slice 3: 7 test unit + E2E (`council-chairman.test.ts`).
- [ ] Slice 4 (grounding helper `groundCouncil()`): spostato a v0.6.1.
      Era descritto nel piano v0.6 ma è scope aggiuntivo; meglio
      una release atomica del chairman.
- [ ] Flag CLI `--no-chairman` per saltare Lucifero senza dover
      scendere a `councilSize: 3` (Low Ego: serve davvero? vediamo
      se gli utenti lo chiedono).
