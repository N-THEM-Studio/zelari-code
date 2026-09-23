# Ricerca: potenziamento/ottimizzazione dei tentacoli Kraken — v2.59.0 (2026-09-21)

> IPOTESI DI DESIGN a fini di pianificazione (vault `.zelari/`). Ogni claim di codice è ancorato a file:line verificati sul tree in data odierna. Le priorità in fondo sono proposte, non lavoro approvato.

## 1. Anatomia attuale (evidenza)

Executor: tutto nel tool `task` — `src/cli/tools/taskTool.ts` (2251 righe); `src/cli/kraken/tentacle.ts` è solo re-export (27 righe). Entry: `createTaskTool` (:2032), `runTentacle` (:1479), `runAutoVerifyAfterGeneral` (:750), factory contesto per-kind `createKrakenSubAgentContextFactory` (`src/cli/toolRegistry.ts:1117`).

| Kind | Prompt (righe) | ~chars | Tool | Budget quick/med/deep | Modello default | Thinking default |
|---|---|---|---|---|---|---|
| explore | taskTool.ts:238-249 (10 righe) | ~627 | 10-12 (RO + inspect_command + ast + semantic + fetch/web) | 4/6/12 | parentModel | provider |
| general | taskTool.ts:251-258 (6 righe) | ~432 | ~24 (tutto: write, bash, skill, ask_user, browser, ssh, world_model) | 8/12/20 | parentModel | provider |
| verify | taskTool.ts:260-282 (21 righe) | ~1345 | 11-13 (RO + bash, **network incluso**) | 6/10/14 | parentModel → cross/auto-pick se abilitati | provider |

- Routing (`krakenModel.ts:245-304`): env per-kind (`ZELARI_KRAKEN_<KIND>_MODEL`) → `SUB_MODEL` (general solo con `GENERAL_USES_SUB=1`, warn K3.6) → cross-family verify → auto-pick → **default: parentModel** (:302).
- Thinking per-kind: `ZELARI_KRAKEN_<KIND>_THINKING` → default: nessun override (`toolRegistry.ts:1071-1107`).
- Limiti: spawn cap default 6/sessione (`maxTaskSpawnsPerTurn` :599-604, env, clamp 32); nesting ban (`enableTask:false`, toolRegistry.ts:1235); worktree per `general` default ON; scheduling overlap bands 0.75/0.5 (`worktreeScheduling.ts:46-57`).
- Ritorno al parent (:2208): testo libero `[sub-agent:kind/thoroughness model=X] + result + footer`; footer = solo worktree/merge (:1887+). Auto-verify appesa in coda al risultato.
- Telemetria: `runSubAgentLoop` cattura usage provider-reported sommato sui turni (prompt/completion/total/cached, :1215-1232) e toolTrace con durationMs. **Nessun consumatore**: non nel footer, non al parent, non su spine/metrics/`--doctor` (messageUsage.ts è del main turn). Misurato e buttato.

## 2. Debolezze (file:line)

1. **GENERAL_PROMPT stub** — 6 righe/~432 chars per l'unico kind che muta il repo; zero disciplina read-before-write, zero formato di ritorno (:251-258).
2. **Auto-verify hardcoda `thoroughness:'medium'`** ignorando l'argomento utente (:834, :872).
3. **Auto-verify bypassa lo spawn cap**: chiama `runTentacle` direttamente, fuori da `bumpTaskSpawnCount` (:760-879 vs gate :2112-2118) → verify + rework non contati nel budget.
4. **Doppio contratto verify**: VERIFY_PROMPT richiede `<verify-report>` XML (:270-280); `buildTaskAutoVerifyPrompt` richiede `VERDICT:` trailer (:622-664). `setKrakenCheckResults` parsa solo l'XML → sul path auto-verify (quello che gira dopo OGNI general) i check strict restano `unknown`.
5. **Routing default = parentModel per tutti** (:302): installazione pulita senza env → explore/verify sul modello del lead (costoso), salvo auto-pick esplicito.
6. **Budget piatti e bassi** (:1042-1060): deep=12/20/14; nessuna scala per scope, nessuna escalation, nessun marking "partial" al parent quando il budget finisce.
7. **Verify ha `network`** (`permissionsForTaskAgent` :153-160): fetch_url/web_search disponibili al verificatore → può leggere riassunti altrui e violare la cecità che il proprio prompt promette (:262-268).
8. **Tool schema mente**: `permissions: ['read','network','write','execute']` statiche sul tool task (:2067-2074) mentre il runtime restringe per kind.
9. **Loop degenere senza guard**: un tentacolo explore reale (oggi, MiniMax-M3 medium) ha iterato la stessa frase ~30 volte fino al budget. Nessun detection anti-repetition, cut muto.
10. CHANGELOG 2.40.0 assente (salto 2.39→2.41); header piani perf v1/v2 ancora "proposta" ma tutto già in 2.38.0 (drift K5.5).

## 3. Stato piani pregressi (non riproporre)

- **Fatto**: tutti gli interventi perf 2026-09-10 (2.38.0); K1.1-K1.8, K2.1-K2.5, K3.1-K3.6 (2.47.0/2.48.0); cache-hit M1.x/M2.x/M3.1 (2.54.0); worktree auto-merge ON (2.56.0); routing warn.
- **Aperti (hardening plan W4-W5)**: K4.1-K4.6 (quality floor, repair cap escalation, `runModelSwap` test I5), K5.1 `runs list/show`, K5.2 hook `VerificationFailed`, **K5.3 flip data-gated** (`WORKTREE=auto` CLI, `SPINE_REPLAY_CACHE=1`, `VERIFY_PARALLEL`) — bloccati dalla mancanza di dati, **baseline cache hit% numerica ancora debito**, backlog §15 (6 voci: reputationStore race, registry ricostruito/turno in useChatTurn, tokenBudget 3 sweep stringify, env per-persona, Desktop env wiring).
- **Ritirati formalmente**: K2.6 (transazionalità multi-file non-graph), K3.7 (plain-admission gating).

## 4. Competitor (solo docs ufficiali fetchate)

**Claude Code** (`code.claude.com/docs/en/sub-agents`, agent-teams): sub-agent = file MD con frontmatter: `model` (alias/ID/inherit; risoluzione per-invocazione → frontmatter → `CLAUDE_CODE_SUBAGENT_MODEL` → main), `effort` low→max, `maxTurns` con output marcato **"partial"** e resume, `tools`/`disallowedTools` (anche pattern MCP), `permissionMode`, `isolation: worktree`, `memory` persistente per agente, `mcpServers` inline, hooks per sub-agent. Nesting 3 livelli (`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`), 20 sub-agent concorrenti, resume via SendMessage + agent ID, background con notifica a fine turno, auto-compaction nel sub-agent, description-driven delegation (warn >15k token di description), output scanning anti-injection. Thinking: ereditato, non configurabile per sub-agent.
**OpenCode** (`opencode.ai/docs/agents`, permissions): agent JSON/frontmatter con `model provider/id`, `temperature`, `top_p`, `additional` (es. `reasoningEffort`), `permission` allow|ask|deny con glob **per tool** (incluso `task`: quali subagent un agente può invocare), `steps` con summarization forzata al limite, subagent `scout` per docs esterne, `hidden`. Subagent senza `model` → eredita dal primary che lo invoca.
**Non documentato da entrambi**: il protocollo/forma del risultato che torna al parent.

## 5. Proposte (priorità, non approvate)

**P1 — coerenza + qualità, costo basso, nessun default toccato**
- P1a Prompt `general` serio (~20 righe): read-before-write, rispetto scope, formato di ritorno strutturato (file toccati / verifiche fatte / rischi), no retry-loop.
- P1b Un solo contratto verify: `VERDICT:` trailer E `<verify-report>` (o uno solo dei due) su entrambi i path; parser unico; `setKrakenCheckResults` popolato anche dall'auto-verify. È un bug, non una feature.
- P1c Auto-verify onesta: eredita la thoroughness del general (o mappa esplicita), conta nel cap spawn (o cap dedicato e loggato), radio event dedicato.

**P2 — misura + robustezza (sblocca K5.3)**
- P2a Consumare l'usage già catturato: una riga nel footer (tokens/cached/latenza/modello per spawn), evento spine per tentacolo, aggregato in `--doctor` accanto a `checkPromptCache`. È la baseline numerica che manca a K5.3 e al debito cache-hit.
- P2b Budget scalati per scope + marking "partial" quando il budget finisce (stile maxTurns/steps dei competitor).
- P2c Guard anti-loop nel sub-agent loop: ripetizione degenere (n-gram identici su N eventi) → abort con errore esplicito. L'incidente di oggi è la prova.

**P3 — allineamento sicurezza (piccolo)**
- P3a Verify senza `network` (o filtrato a whitelist), allineando i permessi alla promessa "blind" del prompt.
- P3b Permissions advertise per-kind nel tool schema del task.

**Non fare**: nesting tentacoli (il DAG flat è una scelta, non un debito), memory per sub-agent, flip default routing senza i dati di P2a, riaprire K2.6/K3.7.

## 6. Decimali (giudizio su evidenza, non benchmark)

| Dimensione | Ora | +P1 | +P2 | Riferimento competitor (config subagent) |
|---|---:|---:|---:|---:|
| Qualità prompt per kind | 6.5 | 7.5 | 7.8 | Claude 9.0 / OpenCode 7.5 |
| Coerenza dei contratti | 5.5 | 8.0 | 8.0 | — |
| Enforcement budget | 6.0 | 6.8 | 7.8 | Claude 8.5 / OpenCode 7.5 |
| Telemetria per tentacolo | 4.5 | 4.5 | 8.0 | Claude n.d. / OpenCode n.d. |
| Routing/flessibilità | 7.0 | 7.0 | 7.6 | Claude 8.0 / OpenCode 8.5 |
| Robustezza del loop | 6.0 | 6.5 | 7.7 | — |
| **Media** | **5.9** | **6.9** | **7.8** | |

P1+P2 portano la configurazione tentacoli al livello OpenCode; il gap residuo verso Claude è nesting/resume/memory per sub-agent — deliberatamente fuori.
