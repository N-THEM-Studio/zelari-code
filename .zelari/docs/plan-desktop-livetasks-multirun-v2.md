# Piano Desktop v2 — Live Tasks + Multi-run (revisione critica di `taskLISTupdate.md`)

> Stato: **proposto** (design hypothesis — nessun codice toccato).
> Fonte di verità: source tree verificato il giorno dell'audit. Tutti i riferimenti a file/riga sono stati controllati.

## 0. Verdetto sulla proposta originale

**Architettura target: VALIDA.** Il nucleo — `Conversation` workspace-aware, `RunRegistry` Rust al posto del single-flight, envelope `runId + conversationId + cwd` su ogni evento, `RunCoordinator` frontend — è corretto e coerente col codice reale.

**Premesse sul codice attuale: tutte verificate TRUE** (audit 2026-07):

| Premessa del doc | Verifica |
|---|---|
| `Conversation` senza `cwd`/task propri | ✅ `apps/desktop/src/types.ts:48-64` |
| `RunTaskArgs` già supporta `cwd`/`history`/`todos` | ✅ `apps/desktop/src/types.ts:103-136`, `lib.rs:2222+` |
| `workdir`+`running` globali, cambio chat bloccato durante run | ✅ `App.tsx:398`, `App.tsx:410-411` (localStorage `zelari-desktop-workdir`), guard a `App.tsx:1348` (new chat), `App.tsx:2019` (`if (!running)` su select), `App.tsx:2136` (Open Folder disabled), `App.tsx:1612` (drop), `App.tsx:2230` (clarification) |
| Rust single-flight, `cancel_run` globale, `agent-event` senza identità | ✅ `lib.rs:26-30` (`RunState` "single-flight for v0.1"), `lib.rs:2176-78` ("A task is already running"), `lib.rs:1140` (`cancel_run(state)`), `lib.rs:2437/2441/2452/2471` (`agent-event` bare), `lib.rs:2397` (`agent-stderr` bare) |
| Routing eventi via `activeIdRef.current` | ✅ `App.tsx:717`, `1213`, `1263`, `1693`, `1804`, `1818` |
| Optimistic `todo_write` al tool start | ✅ `App.tsx:1090-1096` (+ mirror da result a `1127-1135`) |

**ERRORE FATALE nelle FASI 3-6 del doc:** presuppongono che esista un "task system persistente" con tool `createPlan`/`createPhase`/`createTask`/`updateTask` che scrive `.zelari/plan.json` con status `pending|in_progress|done|blocked`.

**FALSO.** Verificato:
- `packages/core/src/core/tools/builtin/` contiene solo: `diff`, `filesystem`, `listFiles`, `search`, `shell`, `web`.
- `src/cli/toolRegistry.ts:34,268-276` registra solo `todo_write`/`todo_read` (da `src/cli/tools/todoTools.ts`).
- Nessun codice nel monorepo scrive `.zelari/plan.json` dai run. Quel file è un **artifact del council/planning interno del prodotto** (cfr. `AGENTS.MD`: "Auto-curated by Zelari Code council") — il commento in `src/cli/sessionTodos.ts:3-4` ("Not the same as `.zelari/plan.json` workspace tasks — those are multi-session durable plans") è **aspirazionale**, non implementato.
- Status reali dei session todo: `pending | in_progress | completed | cancelled` (`src/cli/sessionTodos.ts:10-15`). **`blocked` e `done` non esistono da nessuna parte.**

**Conseguenza sul piano:** le "workspace tasks" non sono un refactor ma una **feature backend nuova** (CLI/core). Il multirun, invece, dipende solo da codice esistente → si può spedire prima. Il doc originale ordinava il contrario.

## 1. Correzioni e miglioramenti rispetto al doc

1. **Riordino milestone**: M1 conversazioni workspace-aware → M2 multirun → M3 workspace tasks (gate decisionale). M3 non blocca M1/M2.
2. **Policy concorrenza enforcement in Rust**, non solo UI: `RunRegistry` rifiuta il secondo run sulla stessa cwd con `Err` tipizzato; `MAX_PARALLEL_RUNS = 4` globale. Il doc la lasciava vaga ("rifiutato/queued secondo la policy scelta").
3. **Nessuna compatibilità envelope necessaria**: Rust shell e webview viaggiano nello stesso bundle Tauri → si cambia payload in breaking interno, senza versionamento. (Companion Android usa `zelari-code serve` HTTP, non Tauri events: non impattato. Nessun altro listener di `agent-event` oltre `agentClient.ts:503`.)
4. **Normalizzazione status completa**: mappa `completed→done`, tieni `cancelled`, aggiungi `blocked` SOLO se arriva M3 (altrimenti tipo morto).
5. **Chiave cwd case-insensitive su Windows**: normalizzare (lowercase + slash uniformi) prima di usarla come key di `WorkspaceTasksState` e per il check "stessa cwd" in Rust.
6. **`send()` e history**: con run concorrenti, la derivazione history (`App.tsx:1693`) e gli append messaggi devono leggere la conversation per `envelope.conversationId` da una ref-map, non da `activeIdRef`.
7. **Leak-guard registry**: rimozione run da `run-finished`/errore/cancel + sweep dei run orfani (> timeout) per non accumulare entry se un thread muore.
8. **Scope test**: il doc chiede 30 acceptance ma non dice come verificarli: il desktop non ha test runner (nessuno script `test` in `apps/desktop/package.json`). I moduli puri nuovi (normalize/reducer/selectors/plan-parse) vanno coperti con vitest a livello root (già presente nel monorepo con jsdom + testing-library); Rust con `cargo test` (già usato in `lib.rs`).

---

## 2. Milestone M1 — Conversations workspace-aware (solo frontend, zero Rust)

**Obiettivo**: `cwd` e session tasks appartengono alla conversazione. Rilasciabile autonomamente.

### Commit 1 — `feat(desktop): bind cwd to conversations + legacy workdir migration`
- `apps/desktop/src/types.ts`: `Conversation.cwd?: string`.
- `apps/desktop/src/chatStorage.ts` (`normalizeConv`): one-time migration — ogni conversation senza `cwd` riceve `localStorage["zelari-desktop-workdir"]` se presente; la key degrada a "last opened workspace" (default per New Chat).
- `App.tsx`:
  - `activeCwd = active?.cwd ?? null` (sostituisce `workdir` come source of truth per: mentions/`readProjectText` `App.tsx:1519`, `runTask` cwd `:1719`, `ProjectPanel` `:2539`, `SkillPicker` `:2532`, `MentionPopup` `:2372`, plugin status/install `:1294/:1321`).
  - `pickFolder`: chat vuota+idle → assegna `cwd` alla chat corrente; chat con messaggi → nuova chat con il nuovo `cwd`.
  - `startNewChat` eredita `cwd` dalla chat attiva.
- Acceptance: scenari 24-25, 29, 31 (nuovo: migrazione legacy).

### Commit 2 — `feat(desktop): per-conversation session tasks + LiveTasksPanel`
- `types.ts`: `Conversation.sessionTasks?: DesktopTodo[]`.
- Nuovo modulo `apps/desktop/src/liveTasks/` (`types.ts`, `normalize.ts`, `reducer.ts`, `useLiveTasks.ts`):
  - `LiveTaskStatus = pending | in_progress | done | cancelled` (+ `blocked` riservato a M3);
  - `normalizeTodoStatus`: `completed → done`;
  - API già shape-per-il-futuro: `handleTodoEvent({ conversationId, event })` — in M1 l'implementazione interno usa ancora la chat attiva (single-run), ma il contratto è già envelope-ready così M2 non riscrive i call-site.
- `App.tsx`: lo stato `sessionTodos` globale (`:436`) e il reset in `startNewChat` (`:1354`) diventano campo della conversation; il chip topbar (`:2107-2111`) e `SessionTodosPanel` (`:2148-2152`) leggono da `active.sessionTasks`.
- `SessionTodosPanel.tsx` → evoluto in `LiveTasksPanel.tsx` (sezione "THIS CHAT"; la sezione "PROJECT" arriva in M3).
- Persistenza in `chatStorage` (cap 40 task, allineato al limite CLI `sessionTodos.ts:59`).
- Acceptance: scenari 3, 4, 10 + unit test vitest su `normalize`/`reducer`.

**Verifica M1**: `cd apps/desktop && npm run build` (tsc+vite); unit test moduli puri.

---

## 3. Milestone M2 — Run multiplexing (Rust + frontend)

**Obiettivo**: N run concorrenti, eventi correlati, cancel per-run. Il blocco vero (catena `RunState` single-flight → eventi globali → routing `activeIdRef`) si spezza qui.

### Commit 3 — `refactor(tauri): RunRegistry replaces single-flight RunState`
`apps/desktop/src-tauri/src/lib.rs`:
```rust
struct RunControl {
    cancel: AtomicBool,
    conversation_id: String,
    cwd: Option<String>,      // normalizzato
    started_at: u64,
}
struct RunRegistry { runs: Mutex<HashMap<String, Arc<RunControl>>> }
```
- `run_task(args: RunTaskArgs)` con `conversation_id: String` obbligatorio; ritorna `RunStarted { runId, conversationId, cwd }` (non più `String` nuda).
- Policy in Rust: `MAX_PARALLEL_RUNS = 4`; **max 1 run attivo per cwd** → `Err("workspace busy: another run is modifying <cwd>")`; run con cwd `None` (process cwd) trattati come stessa cwd virtuale.
- `cancel_run(run_id, registry)`; rimozione da registry a fine run + sweep orfani.
- `spawn_headless` riceve `Arc<RunControl>` del run specifico.
- `cargo test`: registry insert/remove, doppio run stessa cwd → Err, cancel A non tocca B.

### Commit 4 — `refactor(tauri): envelope every event with runId+conversationId+cwd`
```rust
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RunEventEnvelope<T> { run_id: String, conversation_id: String, cwd: Option<String>, event: T }
```
- Applicato a: `agent-event` (`:2437,2441,2452,2471`), `agent-stderr` (`:2397`), `run-started` (`:2210`), `run-finished` (`:2266`). Anche i `log`/`error` di fallback vanno nell'envelope.
- Breaking interno accettato (stesso bundle Tauri).

### Commit 5 — `refactor(desktop): RunCoordinator + envelope client` (il più delicato)
- `apps/desktop/src/agentClient.ts`: `AgentEventEnvelope`, `onAgentEvent(handler(envelope))`, `cancelRun(runId)`, `runTask() → RunStarted`.
- Nuovo `apps/desktop/src/runs/` (`types.ts`, `reducer.ts`, `selectors.ts`, `useRunCoordinator.ts`): `runsById`, `runIdByConversation`, `RunRuntime` (status/liveSteps/memberName/tokens…).
- `App.tsx`:
  - routing: `envelope.conversationId` ovunque nel path eventi runner (**invariante architettonica: zero `activeIdRef` in quel path** — scenario 30);
  - `running` (`:398`) → `const activeRun = getRunForConversation(activeId)`;
  - rimozione guard: new chat `:1348`, select chat `:2019`, Open Folder `:2136`, drop `:1612`, clarification `:2230`;
  - composer disabled solo se `activeRun` attivo; Stop → `cancelRun(activeRun.runId)`;
  - append messaggi/streaming/history per conversationId (ref-map `conversationsRef` già esiste);
  - `liveSteps` per-run → `RunActivity` filtra per run della chat visibile;
  - `liveTasks.handleTodoEvent(envelope)` ora realmente envelope-driven.
- Slice suggerita: prima coordinator + routing, poi rimozione guard (due PR piccole se serve).

### Commit 6 — `feat(desktop): sidebar multi-workspace + run badges`
- Sidebar raggruppata per `groupBy(conversations, c => c.cwd)` con badge `● n running` / `✓ unseen`; `markRunResultSeen(conversationId)`; topbar con `● Running · <durata>` + Stop. Nessuna entità `Workspace` persistente (derivata).

**Verifica M2**: `cargo test` in `src-tauri`; `npm run build` desktop; scenari 11-23, 26-27, 30, 32-34 manuali.

---

## 4. Milestone M3 — Workspace project tasks (GATE: backend nuovo, decidere)

Il doc originale la dava per esistente; **non lo è**. Due opzioni:

- **M3-quick (read-only)**: il desktop legge `{cwd}/.zelari/plan.json` (se presente, es. scritto dal council Zelari) e lo mostra in sezione "PROJECT" del `LiveTasksPanel`, refresh a open-folder/select-chat/fine-run. Costo basso, zero backend. Nessun optimistic.
- **M3-full (task system)**: nuovi tool CLI (`plan_create`/`task_create`/`task_update` o equivalente) con store atomico su `{cwd}/.zelari/plan.json` + eventi first-class `task_update`/`task_snapshot` in `packages/core/src/shared/events.ts`. Solo allora hanno senso optimistic + reconciliation (FASE 6 del doc) e lo status `blocked`. Epic separato: tocca `src/cli/tools/` + `packages/core` + desktop.

**Raccomandazione**: M3-full dopo M2, come epic proprio con ADR; M3-quick opzionale dopo M1 se si vuole subito il pannello PROJECT.

> **Esito**: scelta **M3-full**. Contratto di slice 3a formalizzato in `docs/decisions/0018-workspace-task-store-plan-json.md` (status: Proposto — revisione prima dell'implementazione). Ordine: 3a store+tool → 3b eventi first-class → 3c consumo desktop.

---

## 5. Accettazione consolidata

Gli scenari 1-30 del doc restano validi dove applicabili, con questa mappatura: 3,4,10,24,25,29,31 → M1; 11-23, 26, 27, 30, 32-34 → M2; 1, 2, 5-9, 28 → M3. Nuovi:

- **31** — Migrazione legacy: chat esistenti senza `cwd` ricevono `zelari-desktop-workdir` al primo load.
- **32** — `cargo test`: cancel del run A lascia il run B attivo nel registry.
- **33** — `cargo test`: secondo run stessa cwd → `Err` "workspace busy".
- **34** — envelope con `runId`+`conversationId` presente anche su stderr e log di fallback.

Comandi di verifica per milestone: `npm run build --prefix apps/desktop` (o `cd apps/desktop && npm run build`), `cargo test` + `cargo check` in `apps/desktop/src-tauri`, vitest root per i moduli puri nuovi.

## 6. Rischi aperti

- `App.tsx` ~2600 righe: il commit 5 tocca `send()`, history derive, streaming append — slicearlo in due se il diff supera ~400 righe.
- Quota localStorage: `sessionTasks` aggiunge payload (cap 40/conversation, messaggi già cappati a 200).
- Normalizzazione cwd Windows (case, slash) — both sides (TS key map e Rust check).
- Flusso `krakenGraph`/`planOnly`/`runPlan` (`RunTaskArgs`) passa da `run_task`: verificare che l'envelope non rompa la UX plan-only (test scenario aggiuntivo).
