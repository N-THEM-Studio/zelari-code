# Gap map - model-visible input -> spine events (2.0 Phase 0)

> Target rule (P1 / ADR-0016): **model-visible implies logged**.
> Each row: model input source, current file, logging state today, assigned spine
> event. Default owner: the Phase 1 migration (headless first).

| # | Model input source | File | Logged today? | Spine event | Owner/phase |
|---|---|---|---|---|---|
| 1 | User prompt / steer / inject | `src/cli/hooks/useChatTurn.ts`, `hooks/steer.ts` | partial (live BrainEvent) | `user.message` (data.kind: prompt\|inject\|steer) | F1.7 |
| 2 | System prompt builder (fragments, policy) | `packages/core/src/agents/systemPromptBuilder.ts`, `promptModules.ts` | no | `context.injected` (surface, with fragment hashes) | F1.4 |
| 3 | Conversation history (compaction-aware) | `hooks/conversationContext.ts`, `historyCompaction.ts`, `compaction.ts` | no | `assistant.message` + `session.compacted` | F1.5 |
| 4 | Tool call/result | BrainEvent `tool_execution_start/end` -> best-effort sidecar | sidecar only | `tool.call` / `tool.result` (paired by callId, seq) | F1.6 |
| 5 | Durable context (verified layer) | `state/loadDurableContext.ts`, `fileStateStore.ts` | no | `context.injected` (state) + commit ref | F1.10 |
| 6 | RAG/memory hits | `memory/fileBackend.ts`, `formatMemoryHits` | no | `context.injected` (surface) + ref | F1.10 |
| 7 | Lessons / weakness / playbook | `council/lessons/*`, `kraken/weaknessMeter.ts` | no | `context.injected` (surface, pack version) | F1.10 |
| 8 | Headless `--history` / `--todos` replay | `headless.ts` | no (CLI input not logged) | removed by native resume (`session.resumed`) | F1.8 |
| 9 | Kraken tentacle results / selection | `tools/taskTool.ts`, `krakenSelectTool.ts` | partial (`kraken_progress`) | `kraken.task` + `verification.run` | F1.9/3A |
| 10 | Council member runs | `councilDispatcher.ts` | partial | `council.member` | F1.10 |
| 11 | Todo/plan task updates | `sessionTodos.ts`, `planTaskTools.ts` (ADR-0018) | separate file only | `task.created` / `task.updated` (state; plan.json stays the cross-session index) | F1.9 |
| 12 | Ask-user / permission outcomes | `askUserTimeout.ts`, `usePermissionBroker.ts` | no | `user.message` (inject) or state-event | F1.7 |
| 13 | Request snapshots / prompt-cache stats | `core/requestSnapshot.ts`, `budget/*` | no | `context.injected` (state) | F1.10 |

Kind vocabulary: `packages/core/src/session/types.ts` (`SESSION_EVENT_KINDS`).
The dev/CI "model-visible implies logged" assert must be wired at the message
assembly point once `deriveMessages` becomes the only path (post F1.5).