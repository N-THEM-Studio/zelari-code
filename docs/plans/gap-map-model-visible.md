# Gap map — input model-visible → eventi spine (2.0 Fase 0)

> Regola target (P1 / ADR-0016): **model-visible ⟺ logged**.
> Ogni riga: sorgente di input del modello, file odierno, stato di logging, evento
> spine assegnato. Owner di default: la migrazione Fase 1 (headless first).

| # | Sorgente input modello | File | Oggi loggata? | Evento spine | Owner/fase |
|---|---|---|---|---|---|
| 1 | User prompt / steer / inject | `src/cli/hooks/useChatTurn.ts`, `hooks/steer.ts` | parziale (BrainEvent live) | `user.message` (data.kind: prompt\|inject\|steer) | F1.7 |
| 2 | System prompt builder (frammenti, policy) | `packages/core/src/agents/systemPromptBuilder.ts`, `promptModules.ts` | ❌ | `context.injected` (surface, con hash frammenti) | F1.4 |
| 3 | Conversazione history (compaction-aware) | `hooks/conversationContext.ts`, `historyCompaction.ts`, `compaction.ts` | ❌ | `assistant.message` + `session.compacted` | F1.5 |
| 4 | Tool call/result | BrainEvent `tool_execution_start/end` → sidecar best-effort | ✅ sidecar | `tool.call` / `tool.result` (pairing per callId, seq) | F1.6 |
| 5 | Durable context (verified layer) | `state/loadDurableContext.ts`, `fileStateStore.ts` | ❌ | `context.injected` (state) + ref commit | F1.10 |
| 6 | RAG/memory hits | `memory/fileBackend.ts`, `formatMemoryHits` | ❌ | `context.injected` (surface) + ref | F1.10 |
| 7 | Lessons / weakness / playbook | `council/lessons/*`, `kraken/weaknessMeter.ts` | ❌ | `context.injected` (surface, pack version) | F1.10 |
| 8 | Headless `--history` / `--todos` replay | `headless.ts` | ❌ (input CLI non loggato) | eliminato da resume nativo (`session.resumed`) | F1.8 |
| 9 | Kraken tentacle results / selection | `tools/taskTool.ts`, `krakenSelectTool.ts` | parziale (`kraken_progress`) | `kraken.task` + `verification.run` | F1.9/3A |
| 10 | Council member runs | `councilDispatcher.ts` | parziale | `council.member` | F1.10 |
| 11 | Todo/plan task updates | `sessionTodos.ts`, `planTaskTools.ts` (ADR-0018) | ✅ file proprio | `task.created` / `task.updated` (state; plan.json resta indice cross-session) | F1.9 |
| 12 | Ask-user / permission outcomes | `askUserTimeout.ts`, `usePermissionBroker.ts` | ❌ | `user.message` (inject) o state-event | F1.7 |
| 13 | Request snapshots / prompt-cache stats | `core/requestSnapshot.ts`, `budget/*` | ❌ | `context.injected` (state) | F1.10 |

Vocabolario dei kind: `packages/core/src/session/types.ts` (`SESSION_EVENT_KINDS`).
L'assert dev/CI "model-visible ⟺ logged" va cablato nel punto di assemblaggio
messaggi quando `deriveMessages` diventa l'unico path (post F1.5).
