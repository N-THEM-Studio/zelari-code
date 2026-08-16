# ADR-0018 — Contratto workspace task store su `.zelari/plan.json`

**Status**: Accettato — slice 3a implementata (v1.43.0)
**Relazionato a**: `.zelari/docs/plan-desktop-livetasks-multirun-v2.md` (M3), ADR-0016 (event-sourced session log)

## Contesto

Il Desktop ha bisogno di task di progetto **durable e multi-sessione**, distinti dai session todo (volatili, per-conversation, cap 40 — `src/cli/sessionTodos.ts`). Il commento in testa a quel modulo dichiara già l'intento: *"Not the same as `.zelari/plan.json` workspace tasks (those are multi-session durable plans)"* — ma **nessun tool oggi scrive quel file**: i builtin core sono filesystem/shell/search/web, il registry CLI registra solo `todo_write`/`todo_read` (`src/cli/toolRegistry.ts:268-276`). Il vault `.zelari/plan.json` usato dal council è quindi un formato interno non contrattuale, in evoluzione.

M2 ha già pagato il trasporto (envelope `runId+conversationId+cwd` su `agent-event`), M1 la UI unificata (`LiveTasksPanel`, `source` già nel modello `liveTasks/types.ts`). Senza writer, gli acceptance test 5-8 del piano (update ottimistico, riconciliazione, refresh a fine run) restano inevasi.

Forze in gioco: coesistenza col vault council sullo stesso file; policy zero-deps pesanti (P2); concorrenza cross-process (i run Desktop sono processi CLI separati); necessità di stabilità del formato una volta esposto alla UI.

## Decisione

`.zelari/plan.json` diventa lo **store canonico e versionato** dei workspace task, scritto **solo** da tre nuovi tool CLI (`task_create`, `task_update`, `task_list`) con write atomica e permessi in classe `write`.

**Envelope schema v1** (root — i tool toccano SOLO `tasks` e `counter`; ogni altro campo root, es. metadati council, è preservato intatto in pass-through):

```json
{
  "schemaVersion": 1,
  "counter": 7,
  "tasks": [
    {
      "id": "t7",
      "title": "Extract RunCoordinator from App.tsx",
      "status": "in_progress",
      "priority": "high",
      "phaseId": "p1",
      "notes": "optional",
      "agent": "kraken",
      "createdAt": "2026-07-10T09:12:00.000Z",
      "updatedAt": "2026-07-10T09:40:00.000Z"
    }
  ]
}
```

- **Status canonici**: `pending | in_progress | completed | cancelled | blocked`. `blocked` esiste SOLO qui (i session todo restano senza, come oggi). Nessuna FSM rigida sulle transizioni: il modello può correggere (es. `completed → in_progress`).
- **Id**: `t<N>` sequenziali via `counter` persistito (leggibili in UI/CLI, niente uuid). `title` ≤ 200 char, `notes` ≤ 2000, `agent`/`phaseId` ≤ 64, `priority` ∈ `low|medium|high|critical`, max 100 task. Campi sconosciuti su un task sono preservati da `task_update` se non toccati.
- **Tool contract** (`src/cli/tools/planTaskTools.ts`, naming snake_case come `todo_write`):
  - `task_create({ title, priority?, phaseId?, notes? })` → task `pending`, ritorna `{ id }`;
  - `task_update({ id, status?, title?, priority?, phaseId?, notes?, appendNote? })` → errore tipizzato `PLAN_TASK_NOT_FOUND` se id assente;
  - `task_list({ status?, phaseId? }?)` → snapshot filtrato + conteggio `done/total`.
- **Scrittura**: store in `src/cli/workspace/planStore.ts` — read-modify-write singola, tmp + rename nella stessa dir, backup `.plan.json.bak` prima di riscrivere un file esistente, file corrotto → errore chiaro (mai sovrascrittura silenziosa). Path confinato sotto `{root}/.zelari` via sandboxPath, audit via AuditLogger, permessi via `wrapWithPermissions` (classe `write`).
- **Registrazione**: opzione `enablePlanTasks` in `CreateRegistryOptions` — default attiva per `profile === 'full'` **e** in `planMode` (il piano è il dominio della fase plan; il campo `planMode` a `toolRegistry.ts:128-131` già lo anticipa); mai per readOnly/explore/verify/general nel primo rilascio.
- **Concorrenza**: atomic write + read-modify-write per chiamata. Nel Desktop la race è già neutralizzata da M2 (`RunRegistry`: max 1 run attivo per cwd). Per CLI multiple concorrenti sulla stessa cwd, hardening futuro: lock file `.zelari/.plan.lock` (fuori scope 3a).

**Fuori scope di 3a**: eventi first-class `task_update`/`task_snapshot` (slice 3b, canale envelope M2) e consumo Desktop (slice 3c).

## Alternative considerate

1. **M3-quick read-only** (desktop parsifica `plan.json` senza writer) — rifiutata: lascia inevasi gli acceptance 5-8 e accoppia la UI a un formato non contrattuale.
2. **File separato `.zelari/tasks.json`** — rifiutato: due fonti di verità; codice e council già puntano a `plan.json` come store dei plan durevoli.
3. **Estendere `todo_write` con `scope: 'project'`** — rifiutato: semantica opposta (volatile in-process vs persistente condiviso) e permessi diversi nello stesso tool.
4. **SQLite** — rifiutato: viola P2 (zero deps pesanti) e perde diff-ability/git-friendliness di JSON.

## Conseguenze

**Positive**: unica fonte di verità per task condivisi CLI/desktop/council; sblocca M3c (pannello PROJECT con optimistic + reconciliation); formato leggibile e diff-able; base naturale per scheduler/queue futuri.

**Negative**: `plan.json` diventa API pubblica di fatto — ogni breaking change richiede bump di `schemaVersion` + migrazione; il council interno deve rispettare il contratto (vincolo sul prodotto); un'altra famiglia di tool da mantenere e documentare; race cross-process residua per CLI parallele sulla stessa cwd (mitigata, non eliminata, dalla write atomica).

## TODO (slice 3a — da spuntare a implementazione)

- [x] `src/cli/workspace/planStore.ts` — load/validate/save atomica, caps, pass-through campi root e campi task sconosciuti, backup `.bak`.
- [x] `src/cli/tools/planTaskTools.ts` — `task_create`/`task_update`/`task_list` con Zod, errori tipizzati.
- [x] Registrazione in `src/cli/toolRegistry.ts` con `enablePlanTasks` (full + planMode), avvolta in `withPerm`.
- [x] Unit test vitest: store (happy path, caps, file corrotto, pass-through) + tool (CRUD, `PLAN_TASK_NOT_FOUND`).
- [x] Documentazione in `docs/TOOLS.md` sezione `task_*`.
- [x] Slice 3b: `task_update`/`task_snapshot` BrainEvents su envelope M2 (`packages/core/src/shared/events.ts`).
- [x] Slice 3c: desktop `liveTasks/workspacePlan.ts` + merge nel reducer + reconciliation su `run-finished`.
