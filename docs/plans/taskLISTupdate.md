Yes. I would reformulate the two changes as **a single architectural intervention**, because Live Tasks and concurrent multi-chat have the same underlying requirement: state can no longer be global in `App.tsx`, it must be associated with a precise **conversation + workspace** pair, and every run must be independently identifiable.

On the current code there are three important constraints:

- `Conversation` does not yet own `cwd` or its own tasks, while `RunTaskArgs` already supports `cwd`, `history` and `todos`: so the backend is already prepared to receive a different folder per invocation.
- Desktop still keeps `workdir` and `running` as global state; moreover it prevents switching chat / new chat while a run is active.
- above all, Rust still explicitly declares run state as **single-flight**, `cancel_run` is global, and normal `agent-event`s do not carry the `runId`.

So I would do the following.

# Target architecture

The central concept must become:

```ts
Conversation
   |
   +- cwd
   +- sessionTasks
   +- messages
   +- provider/model/mode
   |
   +- runtime ------ runId
                     |
                     +- process
                     +- status
                     +- tool activity
                     +- events
```

While project tasks must live per workspace:

```text
cwd A
 +-- .zelari/plan.json
       +-- project tasks

cwd B
 +-- .zelari/plan.json
       +-- project tasks
```

So:

```text
session task = belongs to the chat
project task = belongs to the folder
run          = belongs to chat + folder
```

This is the fundamental point.

---

# PHASE 1 - make Conversation workspace-aware

## 1. Extend `Conversation`

In:

```text
apps/desktop/src/types.ts
```

I would move `Conversation` toward:

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

I would NOT save:

```ts
running: true
runId: ...
```

as persistent Conversation state.

The run is runtime state.

---

# PHASE 2 - eliminate global `workdir` as source of truth

Today Desktop still has the explicit concept:

```text
one window = one folder
```

in the relative `App.tsx` state.

It must become:

```ts
const activeConversation = conversations.find(
  c => c.id === activeConversationId
);

const activeCwd = activeConversation?.cwd;
```

From that moment on:

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

must use `activeConversation.cwd`.

### Open Folder UX

I propose this semantics:

**Empty and idle chat**

```text
Open Folder
    |
assigns cwd to the current chat
```

**Chat that already contains messages**

```text
Open Folder
    |
creates a new chat associated with the new folder
```

I would not silently change the cwd of an existing conversation: you would risk having half the context related to repo A and half to repo B.

### New Chat

`New Chat` should normally inherit the current workspace:

```ts
createConversation({
  cwd: activeConversation?.cwd,
});
```

But also allow:

```text
+ New Chat
+ New Workspace Chat
```

---

# PHASE 3 - canonical Live Tasks model

I would create:

```text
apps/desktop/src/liveTasks/
+- types.ts
+- normalize.ts
+- workspacePlan.ts
+- reducer.ts
+- useLiveTasks.ts
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

Normalization is needed because the old todos use `completed`, while workspace tasks use `done` and also support `blocked`. The persistent task system already modifies `.zelari/plan.json` and uses the statuses `pending`, `in_progress`, `done`, `blocked`.

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

# PHASE 4 - correctly distinguish chat tasks from project tasks

I would not try to physically unify the two sources.

## Session tasks

Source of truth:

```text
Conversation.sessionTasks
```

Updated by:

```text
todo_write
todo_read
```

The current code already does the optimistic update of `todo_write` at `tool_execution_start`; that characteristic must be kept.

## Workspace tasks

Source of truth:

```text
{cwd}/.zelari/plan.json
```

The workspace system already considers `plan.json` the machine-readable representation of the plan and `createPlan/createTask/updateTask` modify that file.

So:

```ts
type WorkspaceTasksState = Record<string, LiveTask[]>;
// key = normalized cwd
```

And:

```ts
const visibleTasks = [
  ...(activeConversation.sessionTasks ?? []),
  ...(workspaceTasksByCwd[activeConversation.cwd ?? ""] ?? []),
];
```

This automatically produces the correct semantics:

```text
Chat A / Zelari repo
  Session tasks A
  Project tasks Zelari

Chat B / Zelari repo
  Session tasks B
  Project tasks Zelari

Chat C / Other repo
  Session tasks C
  Project tasks Other
```

Exactly what you want for working simultaneously.

---

# PHASE 5 - read `.zelari/plan.json` directly

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

I would not parse the text messages returned by `createTask`.

The tool event serves **reactivity**, `plan.json` serves **truth**.

---

# PHASE 6 - Live Tasks optimistic + reconciliation

This is the UX I would implement.

### `createTask` start

```text
tool_execution_start
createTask({
   name: "Implement RequestMeter"
})
```

Desktop immediately inserts:

```text
-> Implement RequestMeter     creating
```

with:

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

Desktop immediately updates:

```text
* Implement RequestMeter
```

### Tool end

On:

```text
createPlan
createPhase
createTask
updateTask
```

always run:

```ts
await refreshWorkspaceTasks(cwd);
```

obtaining:

```text
optimistic state
      |
actual plan.json
      |
canonical state
```

If the tool fails, the same re-read automatically removes the wrong optimistic state.

No polling needed.

Also refresh when:

```text
I open a folder
I select a chat
a run ends
Desktop returns to foreground (optional)
```

---

# PHASE 7 - `LiveTasksPanel`

I would rename/evolve `SessionTodosPanel`:

```text
SessionTodosPanel
        |
LiveTasksPanel
```

I would not throw away the current component.

Proposed UI:

```text
+-----------------------------------+
| TASKS                      * LIVE |
|  4 / 7 done       1 running       |
|                                   |
| THIS CHAT                         |
| * Check provider adapter          |
| -> Run integration tests          |
|                                   |
| PROJECT - zelari-code             |
| Phase 2 - Desktop                 |
| + Add RequestSnapshot             |
| * Live task routing               |
| -> Multi-session runner           |
| ! Windows regression      blocked |
|                                   |
| v 4 completed                     |
+-----------------------------------+
```

`RunActivity` must remain separate:

```text
LiveTasks:
* Implement multi-session runner

RunActivity:
grep_content      +
read_file         +
edit_file         running
```

One describes **the goal**; the other describes **what the model is doing at this instant**.

---

# PHASE 8 - first necessary condition for multi-chat: multiplex the runs

Here is the most important refactor.

The Rust backend today still uses:

```rust
struct RunState {
    cancel: AtomicBool,
    running: AtomicBool,
}
```

and refuses a second task while the first is in progress.

I would replace it with:

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

So:

```text
RunRegistry

run-0187
 +-- conversation = chat-A
 +-- cwd = /dev/zelari
 +-- cancel flag

run-0188
 +-- conversation = chat-B
 +-- cwd = /dev/api
 +-- cancel flag
```

No longer:

```text
there is a run
```

but:

```text
there are N runs
```

---

# PHASE 9 - add `conversationId` to `run_task`

Today `run_task` already creates a `run_id` and returns it.

However I would add to the command:

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

instead of just:

```ts
Promise<string>
```

---

# PHASE 10 - every event must be correlated to the run

This is **mandatory**.

Today normal `agent-event`s are emitted globally and the frontend associates them with `activeIdRef.current`; so this architecture only worked because Desktop prevented switching chat during a run.

With two runs it would immediately become:

```text
run A event
-> active chat B
-> message written in the wrong chat
```

### New envelope

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

Event:

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

All must have the envelope:

```text
agent-event
agent-stderr
run-started
run-finished
run-error
```

---

# PHASE 11 - modify `agentClient.ts`

From:

```ts
onAgentEvent(handler: (event: AgentEvent) => void)
```

to:

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

And:

```ts
cancelRun(runId: string)
```

no longer:

```ts
cancelRun()
```

The corresponding Rust command:

```rust
#[tauri::command]
fn cancel_run(
    run_id: String,
    registry: State<RunRegistry>,
) -> Result<(), String>
```

So that:

```text
Cancel chat A
```

does not touch:

```text
chat B
chat C
```

---

# PHASE 12 - frontend `RunCoordinator`

I would extract all the runtime logic from `App.tsx`.

```text
apps/desktop/src/runs/
+- types.ts
+- reducer.ts
+- useRunCoordinator.ts
+- runSelectors.ts
```

Type:

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

So:

```ts
const activeRun =
  runCoordinator.getRunForConversation(activeConversationId);
```

and no longer:

```ts
const [running, setRunning] = useState(false);
```

---

# PHASE 13 - correct event routing

This line must conceptually disappear:

```ts
const convId = activeIdRef.current;
```

For runner events.

Replace with:

```ts
const convId = envelope.conversationId;
```

So even while I am looking at Chat B:

```text
Chat A running...
         |
delta A
         |
Conversation A.messages

Chat B active
         |
UI stays on Chat B
```

When Chat A finishes:

```text
Chat A         + done
```

and maybe a badge appears:

```text
Zelari repo
  Chat A       + 1
  Chat B       * running
```

---

# PHASE 14 - really allow switching chat during a run

Remove the global guards of the type:

```ts
if (running) return;
```

from:

```text
new chat
select conversation
select folder
```

The composer must be disabled only if:

```ts
const activeConversationRunning =
  Boolean(runIdByConversation[activeConversation.id]);
```

So:

```text
Chat A running
-> composer A disabled / shows Stop

switch Chat B
-> composer B enabled
-> you can start a second task
```

---

# PHASE 15 - concurrency policy

Here I would make a prudent choice.

## V1

Freely allow:

```text
repo A / Chat A    BUILD ----+
                             |  concurrent
repo B / Chat B    BUILD ----+
```

But I would **not allow two write-capable agents simultaneously on the same cwd**.

For example:

```text
/zelari Chat A   build running
/zelari Chat B   build requested
                 |
"Another build run is already modifying this workspace."
```

Reason: `plan.json` already uses protections/atomic writes in the workspace process, but Desktop runs are separate CLI processes; an in-process mutex does not automatically coordinate two distinct processes. So this is a potential race not only on the plan but, above all, on the source files.

I would instead eventually allow:

```text
same cwd:
plan/read-only + build
```

but for the first release you can be even more conservative:

```text
max 1 active run per cwd
max N active global runs
```

with:

```ts
MAX_PARALLEL_RUNS = 4
```

configurable later.

It is much safer.

---

# PHASE 16 - multi-workspace sidebar

At this point I would also change the navigation:

```text
WORKSPACES

* zelari-code                    * 2
   Chat - Live tasks             +
   Chat - Cache tuning           +
   Chat - Release v1.43

* client-api                     * 1
   Chat - Fix authentication

* website
   Chat - Landing page
```

Where `* 2` means two active runs.

It is not strictly necessary to introduce a persistent `Workspace` entity: you can initially derive the groups from:

```ts
groupBy(conversations, c => c.cwd)
```

and add a real `Workspace` model only if in the future you want workspace-specific properties.

---

# PHASE 17 - globally visible run state

The topbar of the current chat:

```text
zelari-code
* Running - 1m 42s       Tasks 3/7       Stop
```

Sidebar for background jobs:

```text
client-api
  Fix auth refresh    *
```

On completion:

```text
client-api
  Fix auth refresh    + 1
```

`1` = completion not yet seen.

When I select the chat:

```ts
markRunResultSeen(conversationId);
```

---

# PHASE 18 - Live Tasks must use the run envelope

Once the multiplexing is done, optimistic updates also finally become correct.

Not:

```ts
updateWorkspaceTasks(currentWorkdir)
```

but:

```ts
handleToolEvent({
  conversationId: envelope.conversationId,
  cwd: envelope.cwd,
  event: envelope.event,
});
```

Example:

```text
run A / Zelari repo
updateTask T3 -> done
       |
workspaceTasks["/zelari"]

run B / API repo
updateTask T8 -> in_progress
       |
workspaceTasks["/api"]
```

There can no longer be any contamination.

---

# PHASE 19 - optional but recommended: first-class task events

After everything works I would do a final cleanup.

Instead of letting the Desktop know:

```text
createTask
updateTask
todo_write
todo_read
```

add BrainEvents:

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

So Desktop no longer knows the internal implementation of the tools.

But **I would not make it a requirement for the first release**: tool event + canonical re-read of `plan.json` is sufficient.

---

# Files I would expect to change

The coding LLM should mainly touch:

```text
apps/desktop/src/
+- App.tsx
+- types.ts
+- agentClient.ts
+- chatStorage.ts
|
+- liveTasks/
|   +- types.ts
|   +- normalize.ts
|   +- workspacePlan.ts
|   +- reducer.ts
|   +- useLiveTasks.ts
|
+- runs/
|   +- types.ts
|   +- reducer.ts
|   +- selectors.ts
|   +- useRunCoordinator.ts
|
+- components/
    +- LiveTasksPanel.tsx

apps/desktop/src-tauri/src/
+- lib.rs
```

Optionally:

```text
packages/core/src/shared/events.ts
```

only for the `task_update/task_snapshot` phase.

---

# Implementation sequence I would give the coding LLM

I would make these separate commits:

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

I would **not do 4-7 in the same commit**. The multiplex transport is the most delicate point.

---

# Live Tasks acceptance tests

The coding LLM should not consider the work finished until at least these scenarios pass:

```text
1. I open repo A with .zelari/plan.json:
   -> tasks shown immediately.

2. Chat A and Chat B are both on repo A:
   -> they see the same project tasks.

3. todo_write in Chat A:
   -> appears only in A's session tasks.

4. I switch to Chat B:
   -> A's session todos do not appear.

5. createTask starts:
   -> task appears optimistically.

6. createTask ends:
   -> plan.json gets re-read.

7. updateTask pending -> in_progress:
   -> UI changes immediately.

8. updateTask fails:
   -> refresh from plan.json restores the true state.

9. blocked:
   -> displayed correctly.

10. Desktop restart:
    -> session tasks come from the Conversation;
    -> project tasks come again from plan.json.
```

---

# Multi-chat / multi-folder acceptance tests

These are even more important:

```text
11. I start Chat A in repo A.

12. While A works I can select Chat B.

13. I start Chat B in repo B.
    -> both continue simultaneously.

14. A delta of run A arrives while I am watching B.
    -> it is written ONLY in Conversation A.

15. Tool activity A does not appear in B.

16. LiveTask update A does not modify repo B's tasks.

17. A finishes while I am watching B.
    -> B does not change.
    -> A gets a completion badge.

18. Cancel A.
    -> B continues.

19. Cancel B.
    -> A is not touched.

20. Two runs have different runIds.

21. Every agent-event contains runId + conversationId.

22. Every stderr/error contains runId + conversationId.

23. RunRegistry correctly removes runs on success/error/cancel.

24. New Chat remains usable while other runs are active.

25. Open Folder remains usable while other workspaces work.

26. The composer is blocked only when the CURRENT CHAT has a run.

27. repo A build + repo B build:
    -> allowed.

28. repo A build + repo A second build:
    -> refused/queued according to the chosen policy.

29. Files/Git/mentions always follow the selected chat's cwd.

30. No use of activeIdRef.current to decide which chat
    an AgentEvent belongs to.
```

**I would consider test 30 an architectural invariant.**

---

# Migration of existing chats

You still have the old `zelari-desktop-workdir`.

Since the old application had a single global folder, at first load you can do:

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

Then keep the old key only as:

```text
last opened workspace
```

or remove it after the migration.

`chatStorage.ts` already normalizes conversations loaded from localStorage, so this is the natural place to introduce compatibility.

---

# The most important change not to get wrong

I would not start by doing:

```ts
setRunningByConversation(...)
```

leaving the backend unchanged.

That would be a fake implementation of parallelism.

The real blocker is:

```text
Rust single-flight RunState
+
global agent-event
+
activeIdRef routing
```

Only after transforming this chain into:

```text
RunRegistry
     |
runId + conversationId + cwd
     |
event envelope
     |
RunCoordinator
     |
specific Conversation
```

can you safely remove the blocks that today prevent switching chat while the model works. The backend already generates a `runId`, so an important part of the base exists; what is mainly missing is making that identity travel with **every** event.

### The final shape I would aim for

```text
ZELARI DESKTOP
|
+-- Workspace: zelari-code
|   +-- Chat A
|   |   +-- run-101 *
|   |   +-- session tasks
|   |
|   +-- Chat B
|   |   +-- idle
|   |
|   +-- shared .zelari/plan.json tasks
|
+-- Workspace: api-server
|   +-- Chat C
|       +-- run-102 *
|       +-- session tasks
|
+-- RunRegistry
    +-- run-101 -> Chat A -> /zelari-code
    +-- run-102 -> Chat C -> /api-server
```

This architecture gives you simultaneously **correct Live Tasks, multi-chat, multi-folder and background agents**, without having to implement them as four disconnected features. And it is also a much better base if later you want to introduce queues, pause/resume, a scheduler or even more native Desktop windows.