Sì. Riformulerei le due modifiche come **un unico intervento architetturale**, perché Live Tasks e multi-chat concorrente hanno lo stesso requisito di fondo: lo stato non può più essere globale in `App.tsx`, ma deve essere associato a una precisa coppia **conversation + workspace**, e ogni run deve essere identificabile indipendentemente.

Sul codice attuale ci sono tre vincoli importanti:

- `Conversation` non possiede ancora `cwd` né task propri, mentre `RunTaskArgs` supporta già `cwd`, `history` e `todos`: quindi il backend è già predisposto a ricevere una cartella diversa per ogni invocazione. 
- Desktop mantiene ancora `workdir` e `running` come stato globale; inoltre impedisce cambio chat/nuova chat mentre un run è attivo. 
- soprattutto, Rust dichiara ancora esplicitamente il run state come **single-flight**, `cancel_run` è globale e gli `agent-event` normali non portano il `runId`. 

Quindi farei così.

# Architettura target

Il concetto centrale deve diventare:

```ts
Conversation
   │
   ├── cwd
   ├── sessionTasks
   ├── messages
   ├── provider/model/mode
   │
   └── runtime ──────► runId
                         │
                         ├── process
                         ├── status
                         ├── tool activity
                         └── events
```

Mentre i task di progetto devono vivere per workspace:

```text
cwd A
 └─ .zelari/plan.json
       └─ project tasks

cwd B
 └─ .zelari/plan.json
       └─ project tasks
```

Quindi:

```text
session task = appartiene alla chat
project task = appartiene alla cartella
run          = appartiene alla chat + cartella
```

Questo è il punto fondamentale.

---

# FASE 1 — rendere Conversation workspace-aware

## 1. Estendere `Conversation`

In:

```text
apps/desktop/src/types.ts
```

porterei `Conversation` verso:

```ts
export interface Conversation {
  id: string;
  title: string;
  messages: ChatMessage[];

  createdAt: number;
  updatedAt: number;

  mode: AgentMode;
  phase: AgentPhase;

  provider?: string;
  model?: string;

  archived?: boolean;
  history?: AgentMessage[];

  /**
   * Workspace this conversation belongs to.
   *
   * Never derive this from the currently selected folder.
   */
  cwd?: string;

  /**
   * Ephemeral/checklist tasks owned by this conversation.
   */
  sessionTasks?: LiveTask[];

  /**
   * Optional association with a persistent plan.
   */
  planId?: string | null;
}
```

Non salverei:

```ts
running: true
runId: ...
```

come stato persistente della Conversation.

Il run è runtime state.

---

# FASE 2 — eliminare il `workdir` globale come source of truth

Oggi Desktop ha ancora il concetto esplicito:

```text
one window = one folder
```

nel relativo state di `App.tsx`. 

Deve diventare:

```ts
const activeConversation = conversations.find(
  c => c.id === activeConversationId
);

const activeCwd = activeConversation?.cwd;
```

Da quel momento:

```text
Files panel
Git panel
readProjectText
mentions
skills
project settings
MCP project config
runTask
Live Tasks
```

devono utilizzare `activeConversation.cwd`.

### UX di Open Folder

Propongo questa semantica:

**Chat vuota e idle**

```text
Open Folder
    ↓
assegna cwd alla chat corrente
```

**Chat che contiene già messaggi**

```text
Open Folder
    ↓
crea nuova chat associata alla nuova cartella
```

Non cambierei silenziosamente cwd a una conversazione esistente: rischieresti di avere metà contesto relativo a repo A e metà relativo a repo B.

### New Chat

`New Chat` dovrebbe normalmente ereditare il workspace corrente:

```ts
createConversation({
  cwd: activeConversation?.cwd,
});
```

Ma permettere anche:

```text
+ New Chat
+ New Workspace Chat…
```

---

# FASE 3 — modello canonico Live Tasks

Creerei:

```text
apps/desktop/src/liveTasks/
├── types.ts
├── normalize.ts
├── workspacePlan.ts
├── reducer.ts
└── useLiveTasks.ts
```

### `types.ts`

```ts
export type LiveTaskStatus =
  | "pending"
  | "in_progress"
  | "done"
  | "blocked"
  | "cancelled";

export type LiveTaskSource =
  | "session_todo"
  | "workspace_plan";

export interface LiveTask {
  id: string;
  title: string;

  status: LiveTaskStatus;
  source: LiveTaskSource;

  conversationId?: string;
  cwd?: string;

  phaseId?: string;
  priority?: string;

  optimistic?: boolean;
  updatedAt: number;
}
```

Serve la normalizzazione perché i vecchi todo usano `completed`, mentre i workspace task usano `done` e supportano anche `blocked`. Il task system persistente modifica già `.zelari/plan.json` e usa gli status `pending`, `in_progress`, `done`, `blocked`. 

```ts
function normalizeTodoStatus(status: DesktopTodoStatus): LiveTaskStatus {
  switch (status) {
    case "completed":
      return "done";
    default:
      return status;
  }
}
```

---

# FASE 4 — distinguere correttamente task di chat e task di progetto

Non cercherei di unificare le due sorgenti fisicamente.

## Session tasks

Source of truth:

```text
Conversation.sessionTasks
```

Aggiornati da:

```text
todo_write
todo_read
```

Il codice attuale fa già l'update optimistic di `todo_write` al `tool_execution_start`; quella caratteristica va mantenuta. 

## Workspace tasks

Source of truth:

```text
{cwd}/.zelari/plan.json
```

Il sistema workspace considera già `plan.json` la rappresentazione machine-readable del piano e `createPlan/createTask/updateTask` modificano quel file. 

Quindi:

```ts
type WorkspaceTasksState = Record<string, LiveTask[]>;
// key = normalized cwd
```

E:

```ts
const visibleTasks = [
  ...(activeConversation.sessionTasks ?? []),
  ...(workspaceTasksByCwd[activeConversation.cwd ?? ""] ?? []),
];
```

Questo produce automaticamente la semantica corretta:

```text
Chat A / repo Zelari
  Session tasks A
  Project tasks Zelari

Chat B / repo Zelari
  Session tasks B
  Project tasks Zelari

Chat C / repo Altro
  Session tasks C
  Project tasks Altro
```

Esattamente quello che vuoi per lavorare contemporaneamente.

---

# FASE 5 — leggere direttamente `.zelari/plan.json`

`workspacePlan.ts`:

```ts
export async function readWorkspaceTasks(
  cwd: string,
): Promise<LiveTask[]> {
  try {
    const raw = await readProjectText({
      cwd,
      path: ".zelari/plan.json",
    });

    const plan = JSON.parse(raw);

    return (plan.tasks ?? []).map((task: any) => ({
      id: task.id,
      title: task.name ?? task.title ?? task.id,
      status: normalizeWorkspaceTaskStatus(task.status),

      source: "workspace_plan",
      cwd,

      phaseId: task.phaseId,
      priority: task.priority,

      optimistic: false,
      updatedAt: Date.now(),
    }));
  } catch {
    return [];
  }
}
```

Non parserei i messaggi di testo restituiti da `createTask`.

Il tool event serve per la **reattività**, `plan.json` serve per la **verità**.

---

# FASE 6 — Live Tasks optimistic + reconciliation

Questa è la UX che implementerei.

### `createTask` start

```text
tool_execution_start
createTask({
   name: "Implement RequestMeter"
})
```

Desktop inserisce subito:

```text
○ Implement RequestMeter     creating…
```

con:

```ts
optimistic: true
```

### `updateTask` start

```text
updateTask({
  taskId: "T4",
  status: "in_progress"
})
```

Desktop aggiorna immediatamente:

```text
▶ Implement RequestMeter
```

### Tool end

Su:

```text
createPlan
createPhase
createTask
updateTask
```

eseguire sempre:

```ts
await refreshWorkspaceTasks(cwd);
```

ottenendo:

```text
optimistic state
      ↓
actual plan.json
      ↓
canonical state
```

Se il tool fallisce, la stessa rilettura elimina automaticamente lo stato optimistic errato.

Non serve polling.

Fare refresh anche quando:

```text
apro una cartella
seleziono una chat
termina un run
Desktop torna in foreground (opzionale)
```

---

# FASE 7 — `LiveTasksPanel`

Rinominerei/evolverei `SessionTodosPanel`:

```text
SessionTodosPanel
        ↓
LiveTasksPanel
```

Non butterei via il componente corrente.

UI proposta:

```text
┌─────────────────────────────────┐
│ TASKS                     ● LIVE│
│ 4 / 7 done        1 running     │
│                                 │
│ THIS CHAT                       │
│ ▶ Check provider adapter        │
│ ○ Run integration tests         │
│                                 │
│ PROJECT · zelari-code           │
│ Phase 2 · Desktop               │
│ ✓ Add RequestSnapshot           │
│ ▶ Live task routing             │
│ ○ Multi-session runner          │
│ ! Windows regression     blocked│
│                                 │
│ ▸ 4 completed                   │
└─────────────────────────────────┘
```

`RunActivity` deve rimanere separato:

```text
LiveTasks:
▶ Implement multi-session runner

RunActivity:
grep_content      ✓
read_file         ✓
edit_file         running
```

Uno descrive **l'obiettivo**; l'altro descrive **quello che sta facendo il modello in questo istante**.

---

# FASE 8 — prima condizione necessaria per il multi-chat: multiplexare i run

Qui c'è il refactor più importante.

Il backend Rust oggi usa ancora:

```rust
struct RunState {
    cancel: AtomicBool,
    running: AtomicBool,
}
```

e rifiuta un secondo task quando il primo è in corso. 

Sostituirei con:

```rust
struct RunControl {
    cancel: AtomicBool,
    conversation_id: String,
    cwd: Option<String>,
    started_at: u64,
}

struct RunRegistry {
    runs: Mutex<HashMap<String, Arc<RunControl>>>,
}
```

Quindi:

```text
RunRegistry

run-0187
 ├─ conversation = chat-A
 ├─ cwd = /dev/zelari
 └─ cancel flag

run-0188
 ├─ conversation = chat-B
 ├─ cwd = /dev/api
 └─ cancel flag
```

Non più:

```text
there is a run
```

ma:

```text
there are N runs
```

---

# FASE 9 — aggiungere `conversationId` a `run_task`

Oggi `run_task` crea già un `run_id` e lo restituisce. 

Aggiungerei però al comando:

```ts
interface RunTaskArgs {
  conversationId: string;

  cwd?: string;
  history?: AgentMessage[];
  todos?: DesktopTodo[];

  // existing fields...
}
```

Rust:

```rust
#[derive(Deserialize)]
struct RunTaskArgs {
    conversation_id: String,
    cwd: Option<String>,
    // ...
}
```

Return:

```ts
interface RunStarted {
  runId: string;
  conversationId: string;
  cwd?: string;
}
```

anziché solo:

```ts
Promise<string>
```

---

# FASE 10 — ogni evento deve essere correlato al run

Questo è **obbligatorio**.

Oggi gli `agent-event` normali sono emessi globalmente e il frontend li associa alla `activeIdRef.current`; quindi questa architettura funzionava solo perché Desktop impediva di cambiare chat durante un run. 

Con due run diventerebbe immediatamente:

```text
run A event
→ active chat B
→ messaggio scritto nella chat sbagliata
```

### Nuova envelope

Rust:

```rust
#[derive(Serialize)]
struct RunEventEnvelope<T> {
    run_id: String,
    conversation_id: String,
    cwd: Option<String>,
    event: T,
}
```

Evento:

```json
{
  "runId": "run-0187",
  "conversationId": "chat-A",
  "cwd": "/dev/zelari",
  "event": {
    "type": "message_delta"
  }
}
```

Tutti devono avere envelope:

```text
agent-event
agent-stderr
run-started
run-finished
run-error
```

---

# FASE 11 — modificare `agentClient.ts`

Da:

```ts
onAgentEvent(handler: (event: AgentEvent) => void)
```

a:

```ts
export interface AgentEventEnvelope {
  runId: string;
  conversationId: string;
  cwd?: string;
  event: AgentEvent;
}

onAgentEvent(
  handler: (envelope: AgentEventEnvelope) => void
)
```

E:

```ts
cancelRun(runId: string)
```

non più:

```ts
cancelRun()
```

Il comando Rust corrispondente:

```rust
#[tauri::command]
fn cancel_run(
    run_id: String,
    registry: State<RunRegistry>,
) -> Result<(), String>
```

Così:

```text
Cancel chat A
```

non tocca:

```text
chat B
chat C
```

---

# FASE 12 — `RunCoordinator` frontend

Estrarrei tutta la logica runtime da `App.tsx`.

```text
apps/desktop/src/runs/
├── types.ts
├── reducer.ts
├── useRunCoordinator.ts
└── runSelectors.ts
```

Tipo:

```ts
export interface RunRuntime {
  runId: string;
  conversationId: string;
  cwd?: string;

  status:
    | "starting"
    | "running"
    | "cancelling"
    | "finished"
    | "error";

  startedAt: number;
  finishedAt?: number;

  liveSteps: LiveToolStep[];

  memberName?: string;
  statusText?: string;

  promptTokens?: number;
  completionTokens?: number;
}
```

State:

```ts
interface RunCoordinatorState {
  runsById: Record<string, RunRuntime>;
  runIdByConversation: Record<string, string>;
}
```

Quindi:

```ts
const activeRun =
  runCoordinator.getRunForConversation(activeConversationId);
```

e non più:

```ts
const [running, setRunning] = useState(false);
```

---

# FASE 13 — routing corretto degli eventi

Questa riga concettualmente deve sparire:

```ts
const convId = activeIdRef.current;
```

Per eventi del runner.

Sostituire con:

```ts
const convId = envelope.conversationId;
```

Quindi anche se sto guardando Chat B:

```text
Chat A running...
         ↓
delta A
         ↓
Conversation A.messages

Chat B active
         ↓
UI resta Chat B
```

Quando Chat A finisce:

```text
Chat A         ● done
```

e magari appare un badge:

```text
Zelari repo
  Chat A       ✓ 1
  Chat B       ● running
```

---

# FASE 14 — permettere veramente di cambiare chat durante un run

Rimuovere i guard globali del tipo:

```ts
if (running) return;
```

da:

```text
new chat
select conversation
select folder
```

Il composer deve essere disabilitato solo se:

```ts
const activeConversationRunning =
  Boolean(runIdByConversation[activeConversation.id]);
```

Quindi:

```text
Chat A running
→ composer A disabled / shows Stop

switch Chat B
→ composer B enabled
→ puoi avviare un secondo task
```

---

# FASE 15 — policy di concorrenza

Qui farei una scelta prudente.

## V1

Permettere liberamente:

```text
repo A / Chat A    BUILD ─────┐
                              ├ concurrent
repo B / Chat B    BUILD ─────┘
```

Ma **non permetterei due agenti write-capable contemporaneamente sulla stessa cwd**.

Per esempio:

```text
/zelari Chat A   build running
/zelari Chat B   build requested
                 ↓
"Another build run is already modifying this workspace."
```

Motivo: `plan.json` usa già protezioni/atomic write nel processo workspace, ma i run Desktop sono processi CLI separati; un mutex in-process non coordina automaticamente due processi distinti. Questa è quindi una potenziale race non solo sul piano ma, soprattutto, sui file sorgente. 

Permetterei invece eventualmente:

```text
same cwd:
plan/read-only + build
```

ma per il primo rilascio puoi essere ancora più conservativo:

```text
max 1 active run per cwd
max N active runs globali
```

con:

```ts
MAX_PARALLEL_RUNS = 4
```

configurabile successivamente.

È molto più sicuro.

---

# FASE 16 — sidebar multi-workspace

A questo punto cambierei anche la navigazione:

```text
WORKSPACES

▾ zelari-code                    ● 2
   Chat · Live tasks             ●
   Chat · Cache tuning           ●
   Chat · Release v1.43

▾ client-api                     ● 1
   Chat · Fix authentication     ●

▾ website
   Chat · Landing page
```

Dove `● 2` significa due run attivi.

Non serve necessariamente introdurre un'entità persistente `Workspace`: puoi inizialmente derivare i gruppi da:

```ts
groupBy(conversations, c => c.cwd)
```

e aggiungere un vero `Workspace` model solo se in futuro vuoi proprietà workspace-specifiche.

---

# FASE 17 — stato globalmente visibile dei run

La topbar della chat corrente:

```text
zelari-code
● Running · 1m 42s       Tasks 3/7       Stop
```

Sidebar per background job:

```text
client-api
  Fix auth refresh    ●
```

Al completamento:

```text
client-api
  Fix auth refresh    ✓ 1
```

`1` = completion non ancora vista.

Quando seleziono la chat:

```ts
markRunResultSeen(conversationId);
```

---

# FASE 18 — Live Tasks devono usare il run envelope

Una volta fatto il multiplexing, anche gli aggiornamenti optimistic diventano finalmente corretti.

Non:

```ts
updateWorkspaceTasks(currentWorkdir)
```

ma:

```ts
handleToolEvent({
  conversationId: envelope.conversationId,
  cwd: envelope.cwd,
  event: envelope.event,
});
```

Esempio:

```text
run A / repo Zelari
updateTask T3 → done
       ↓
workspaceTasks["/zelari"]

run B / repo API
updateTask T8 → in_progress
       ↓
workspaceTasks["/api"]
```

Non ci può più essere contaminazione.

---

# FASE 19 — opzionale ma consigliato: eventi task di prima classe

Dopo che tutto funziona farei un ultimo cleanup.

Invece di far sapere al Desktop:

```text
createTask
updateTask
todo_write
todo_read
```

aggiungere BrainEvents:

```ts
interface TaskUpdateEvent {
  type: "task_update";

  source:
    | "session_todo"
    | "workspace_plan";

  task: {
    id: string;
    title: string;
    status: LiveTaskStatus;
    phaseId?: string;
    priority?: string;
  };
}

interface TaskSnapshotEvent {
  type: "task_snapshot";

  source:
    | "session_todo"
    | "workspace_plan";

  tasks: TaskPayload[];
}
```

Così Desktop non conosce più l'implementazione interna dei tool.

Ma **non lo renderei requisito per la prima release**: tool event + rilettura canonica di `plan.json` è sufficiente.

---

# File che mi aspetterei modificati

Il coding LLM dovrebbe toccare principalmente:

```text
apps/desktop/src/
├── App.tsx
├── types.ts
├── agentClient.ts
├── chatStorage.ts
│
├── liveTasks/
│   ├── types.ts
│   ├── normalize.ts
│   ├── workspacePlan.ts
│   ├── reducer.ts
│   └── useLiveTasks.ts
│
├── runs/
│   ├── types.ts
│   ├── reducer.ts
│   ├── selectors.ts
│   └── useRunCoordinator.ts
│
└── components/
    └── LiveTasksPanel.tsx

apps/desktop/src-tauri/src/
└── lib.rs
```

Eventualmente:

```text
packages/core/src/shared/events.ts
```

solo per la fase `task_update/task_snapshot`.

---

# Sequenza di implementazione che darei al coding LLM

Farei questi commit separati:

```text
1. refactor(desktop): bind cwd and session tasks to conversations

2. feat(desktop): mirror workspace plan tasks into unified live task model

3. feat(desktop): add optimistic project task updates and reconciliation

4. refactor(desktop): envelope all run events with run and conversation ids

5. refactor(desktop): replace single-flight RunState with RunRegistry

6. feat(desktop): support concurrent background runs across conversations

7. feat(desktop): add multi-workspace conversation navigation and run badges

8. refactor(desktop): extract LiveTasksPanel and RunCoordinator from App

9. feat(events): add first-class task snapshot/update events
   // optional follow-up
```

Io **non farei 4–7 nello stesso commit**. Il transport multiplex è il punto più delicato.

---

# Acceptance tests Live Tasks

Il coding LLM non dovrebbe considerare finito il lavoro finché non passano almeno questi scenari:

```text
1. Apro repo A con .zelari/plan.json:
   → task mostrati immediatamente.

2. Chat A e Chat B sono entrambe su repo A:
   → vedono gli stessi project tasks.

3. todo_write in Chat A:
   → compare soltanto nei session tasks di A.

4. Passo a Chat B:
   → i session todos di A non compaiono.

5. createTask parte:
   → task compare optimisticamente.

6. createTask termina:
   → plan.json viene riletto.

7. updateTask pending → in_progress:
   → UI cambia immediatamente.

8. updateTask fallisce:
   → refresh da plan.json ripristina lo stato vero.

9. blocked:
   → viene visualizzato correttamente.

10. riavvio Desktop:
    → session tasks vengono dalla Conversation;
    → project tasks vengono nuovamente da plan.json.
```

---

# Acceptance tests multi-chat / multi-folder

Questi sono ancora più importanti:

```text
11. Avvio Chat A in repo A.

12. Mentre A lavora posso selezionare Chat B.

13. Avvio Chat B in repo B.
    → entrambi continuano contemporaneamente.

14. Un delta del run A arriva mentre sto guardando B.
    → viene scritto SOLO nella Conversation A.

15. Tool activity A non compare in B.

16. LiveTask update A non modifica i task di repo B.

17. Termina A mentre sto guardando B.
    → B non cambia.
    → A riceve badge completion.

18. Cancel A.
    → B continua.

19. Cancel B.
    → A non viene toccato.

20. Due run hanno runId differenti.

21. Ogni agent-event contiene runId + conversationId.

22. Ogni stderr/error contiene runId + conversationId.

23. RunRegistry elimina correttamente run success/error/cancel.

24. New Chat rimane utilizzabile mentre altri run sono attivi.

25. Open Folder rimane utilizzabile mentre altri workspace lavorano.

26. Il composer è bloccato solo quando la CHAT CORRENTE ha un run.

27. repo A build + repo B build:
    → consentito.

28. repo A build + repo A secondo build:
    → rifiutato/queued secondo la policy scelta.

29. Files/Git/mentions seguono sempre cwd della chat selezionata.

30. Nessun uso di activeIdRef.current per decidere a quale chat
    appartiene un AgentEvent.
```

**Il test 30 lo considererei un'invariante architetturale.**

---

# Migrazione delle chat esistenti

Hai ancora il vecchio `zelari-desktop-workdir`.

Dato che la vecchia applicazione aveva un'unica folder globale, al primo caricamento puoi fare:

```ts
const legacyCwd = localStorage.getItem(
  "zelari-desktop-workdir"
);

for (const conversation of conversations) {
  if (!conversation.cwd && legacyCwd) {
    conversation.cwd = legacyCwd;
  }
}
```

Poi mantenere la vecchia key solo come:

```text
last opened workspace
```

oppure eliminarla dopo la migrazione.

`chatStorage.ts` normalizza già le conversation caricate da localStorage, quindi questo è il posto naturale in cui introdurre la compatibilità. 

---

# La modifica più importante da non sbagliare

Non partirei dal fare:

```ts
setRunningByConversation(...)
```

lasciando invariato il backend.

Sarebbe una falsa implementazione del parallelismo.

Il vero blocco è:

```text
Rust RunState single-flight
+
global agent-event
+
activeIdRef routing
```

Solo dopo aver trasformato questa catena in:

```text
RunRegistry
     ↓
runId + conversationId + cwd
     ↓
event envelope
     ↓
RunCoordinator
     ↓
specific Conversation
```

puoi togliere in sicurezza i blocchi che oggi impediscono di cambiare chat mentre il modello lavora. Il backend genera già un `runId`, quindi una parte importante della base esiste; manca soprattutto far viaggiare quell'identità con **ogni** evento. 

### La forma finale che punterei ad avere

```text
ZELARI DESKTOP
│
├── Workspace: zelari-code
│   ├── Chat A
│   │   ├── run-101 ●
│   │   └── session tasks
│   │
│   ├── Chat B
│   │   └── idle
│   │
│   └── shared .zelari/plan.json tasks
│
├── Workspace: api-server
│   └── Chat C
│       ├── run-102 ●
│       └── session tasks
│
└── RunRegistry
    ├── run-101 → Chat A → /zelari-code
    └── run-102 → Chat C → /api-server
```

Questa architettura ti dà contemporaneamente **Live Tasks corretti, multi-chat, multi-folder e background agents**, senza doverli implementare come quattro feature scollegate. Ed è anche una base molto migliore se in seguito vorrai introdurre queue, pause/resume, scheduler o perfino più finestre native del Desktop.
