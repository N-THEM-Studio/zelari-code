# Piano — Cross-talk tra due conversazioni nella stessa finestra Desktop

> Sintomo riportato: la seconda chat mostra transcript, reasoning e tentacoli (`t7`, `2/2 done`, `Lead 4m 3s`) della prima.
> Scenario confermato dall'utente: **due conversazioni nella stessa finestra Desktop**.
> Stato: DRAFT (design hypotheses con evidenze file:line verificate sul disco; righe approssimative — ricontrollare in BUILD).

## Catena causale (verificata)

```
App.send() → runTask() → Tauri invoke("run_task")
  → host Rust (src-tauri, NON ancora ispezionato) spawna CLI headless per messaggio
  → CLI: spine (resumeSessionId ?? UUID nuovo) + emitEvent NDJSON su stdout
       ⚠ NESSUN conversationId negli eventi CLI
  → Rust dovrebbe aggiungere l'envelope {conversationId} (i tipi dicono "echoed by the host")
  → canale Tauri UNICO "agent-event" (condiviso da tutte le conversazioni della finestra)
  → App onAgentEvent + useRunActivity → smistamento, con fallback cieco alla chat attiva
```

## Root cause ordinate (file:line)

| Pri | Root cause | Evidenza |
|---|---|---|
| P0 | Evento senza envelope → `conversationId ?? activeIdRef.current`: finisce nella chat selezionata | `apps/desktop/src/App.tsx:1418-1421` |
| P0b | `session_started` senza envelope scrive `c.sessionId` della spine A sulla chat B → il send successivo di B passa `sessionId` = spine di A → **condivisione reale della sessione** | `apps/desktop/src/App.tsx:1718-1723` + `App.tsx:3028-3036` (`sessionId: live?.sessionId`) |
| P1 | `KrakenActivity` si dichiara sempre chat attiva (`activeConversationId: conversationId`) → accetta sempre eventi non-enveloped → "t7 2/2 done" di A dipinge il pannello di B | `apps/desktop/src/components/KrakenActivity.tsx:128-132`; stesso pattern `App.tsx:971-974` |
| P2 | CLI NDJSON crudo senza `conversationId` (tutti gli eventi: `session_started`, `log`, tentacle `agent_*`, `thinking_delta`, `message_delta`) | `src/cli/headless.ts:685-687`; `src/cli/headless/runOneTurn.ts:303`; `src/cli/tools/taskTool.ts:969-971` |
| P3 | Radio per cwd, non per chat: `sessionId || 'default'` collassa su `default.jsonl`; `findLatestTail` prende il file lessicograficamente più recente senza filtro sessione | `src/cli/tools/krakenRadio.ts:99-101`; `apps/desktop/src/components/WorkbenchLiveTail.tsx:71-94` |

**Falso positivo escluso**: `getCurrentSessionId()` / `~/.zelari-code/current.txt` è SOLO su path TUI (`src/cli/hooks/useSession.ts`); l'headless Desktop usa `opts.resumeSessionId ?? crypto.randomUUID()` (`src/cli/headless/runOneTurn.ts:195,345-346`). Nota: il Kraken graph engine ignora il resume e genera sempre UUID nuovo (`src/cli/runHeadless.ts:464-469`).

**Incognita da chiudere in BUILD (step 0)**: l'host Rust (`apps/desktop/src-tauri`, es. `harness_sidecar.rs`) aggiunge l'envelope `conversationId` a TUTTI gli eventi o solo ad alcuni? Il `conversationId` dei RunTaskArgs arriva fino al processo CLI?

## Slice di fix (in ordine)

### Step 0 — Verifica envelope Rust (read-only)
- Ispezionare `apps/desktop/src-tauri/**` (spawn sidecar, forwarding `agent-event`): l'envelope è applicato a tutti gli eventi? `conversationId` è passato al CLI (arg/env)?
- Esito decide: se envelope Rust totale → le slice TS sono solo difensive; se parcente → Slice 4 diventa obbligatoria.

### Slice 1 (P0) — Routing eventi: niente più fallback cieco alla chat attiva
- `App.tsx:1418-1421`: evento senza `conversationId` verificabile → NON attribuire ad `activeId`. Policy: drop + log diagnostico (o bucket "orphan" visibile solo in debug). Fallback ammesso SOLO quando esiste esattamente UNA run attiva nella finestra.
- Acceptance: test con run A (enveloped) e run B (un-enveloped) simultanee → nessun evento di A finisce nel transcript di B.

### Slice 2 (P0b) — Binding `sessionId` solo su envelope certo
- `App.tsx:1718-1723`: scrivere `c.sessionId` solo se `convId` deriva da envelope (o dal fallback di Slice 1 con run unica). Mai dal fallback quando ci sono ≥2 run attive.
- Acceptance: test `session_started` senza envelope con 2 conversazioni attive → nessun bind su activeId.

### Slice 3 (P1) — KrakenActivity/smarrito il "sempre attivo"
- `KrakenActivity.tsx:128-132` e `App.tsx:971-974`: passare l'`activeConversationId` reale dallo store (non `conversationId`), allineando la policy di drop a Slice 1.
- Acceptance: pannello di B ignorano spawn/status di A mentre A gira.

### Slice 4 (P2) — Envelope `conversationId` end-to-end dal CLI
- Wrapper `emitEvent` nel path headless Desktop: se riceve `conversationId` (flag/env/arg, da definire allo step 0) → wrap `{ conversationId, ...event }` per OGNI evento, tentacoli inclusi (`runOneTurn.ts:303`, `taskTool.ts:969-971`).
- Acceptance: ogni riga NDJSON del path Desktop porta `conversationId`; test snapshot sugli emitters.

### Slice 5 (P3) — Radio e tail con namespace
- `krakenRadio.ts`: se `sessionId` vuota → file `orphan-<pid>.jsonl` + warn (mai `default.jsonl` condiviso).
- `WorkbenchLiveTail.tsx:71-94`: filtrare per `sessionId` della conversazione (pattern già usato da `TentacleTracePanel.tsx:86-88` + `App.tsx:3397`); fallback latest solo se sessionId sconosciuto, con hint visivo.
- Acceptance: due run nello stesso cwd → tail di B non mostra la radio di A.

## Verifica finale
- `npx vitest run apps/desktop` verde (nuovi test per Slice 1-3 inclusi).
- Manuale: 2 chat, prompt con tentacoli in A, poi prompt in B → B pulita; chiudere/riaprire B → nessuna idratazione dalla spine di A.
- Rigressione: conversazione singola invariata (fallback "run unica" deve preservare il comportamento attuale).

## Fuori scope (scenario a, piano separato)
- Marker globale `current.txt` per il TUI/CLI interattivo (`useSession.ts:92-144`) — idle cross-talk quando due TUI girano da terminali diversi nella stessa cwd/utente.
