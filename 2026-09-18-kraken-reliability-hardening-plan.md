# Piano Hardening Kraken — affidabilità totale e indipendenza dal modello

> **Stato**: IN ESECUZIONE — W1 ✅ (8/8 slice, K1.6 defer assorbito) · W2 ✅ (5 slice + K2.6 defer formale) · W3 ✅ salvo ricognizione K3.7 · W4–W5 in corso.
> **Consegna**: W1+W2 pushate su `origin/kraken/reliability-hardening-w1-w2` (`4bff628`+`ae33378`, `[skip ci]`, 45 file); il contenuto risulta poi nel main tree (audit 2026-09-23: `essentialBashConfig.ts`, evento `worktree.fallback_shared_tree` presenti, albero pulito a v2.62.0 / HEAD `0751315`).
> **Allineamento 2026-09-23**: più slice del piano erano già atterrate senza marker di stato (es. K3.2 fail-closed del ROI gate verificata in `executor.ts` `roiGate`/`roiGateErrorRadio`) — prima di implementare una slice, verificarla sul tree reale; le sezioni sotto sono lo spec, non la proof.
> **Igiene albero**: 2026-09-19 risolte le 3 voci `DU` residue del merge parallelo automations (indice unmerged orfano, `MERGE_HEAD` assente) via `git add` — worktree hash = stage 3, zero perdite; il main tree è di nuovo commit-abile. Fix moduli browser mancanti su `origin/fix/automations-browser-selectors` (`4303852`).
> **Baseline**: 2026-09-18, main @ `7bc3620` (v2.46.2).
> **Fonte**: audit on-disk (4 esplorazioni parallele, ogni affermazione con evidenza file:line verificata sul tree).
> **Mandato**: chiudere TUTTE le falle residue di Kraken — super affidabilità + output di qualità altissima, indipendentemente dal modello sottostante.

---

## 0. Cosa è GIÀ chiuso (non duplicare — lezione dell'audit)

L'audit ha trovato **documentazione stale che promette lavoro già fatto**. Un piano che partisse dai documenti rifarebbe cose già atterrate:

- **Perf plan v1/v2** (`2026-09-10-kraken-lead-performance-plan{,-v2}.md`): tutti i 12 interventi atterrati nella 2.38.0 (routing tentacoli, engine parallelo opt-in, radio fd-cache, replay cache incrementale, requestSnapshot, failover opt-in…). Gli header dicono ancora "proposta" — **stale**.
- **ADR-0033 (edit ancorato)**: COMPLETO (t72–t79 + addendum 2026-09-12), non "in progress". Residui dichiarati out-of-scope: diagnostics LSP su apply, prefix/fan-out cache, desktop spine-projection, per-line hashing.
- **ADR-0035 Phase A** (trace view): implementata (`src/cli/traceStore.ts`). Phase B (fan-out parallelo council) **deferred per design** — resta fuori da questo piano.
- **Verdi strutturali confermati**: `unknown ≠ pass` in tutto il motore (`packages/core/src/verification/completionPolicy.ts:106-137`), repair loop con budget (headless 1 pass, gauntlet maxRounds, missione `passByBudget:false` + pivot dopo 3 gap identici — `budgetContinuation.ts:39-45`), watchdog stream, anti-doom-loop (`AgentHarness.ts:1511-1545, 1846-1870`), DAG con verify strutturale per ogni general (`planner.ts:854-872`).

**Task aperti preesistenti non toccati da questo piano**: t57 (flip explore quick, gated dai dati), t52 (dogfooding), t31/t51 (bench competitivo + CI eval snapshot). Sinergia con t52 in W5.

---

## 1. Definizione operativa di "super affidabile" (invarianti del piano)

- **I1 — Nessun falso verde.** Un turno Kraken può terminare solo in: `PASS` verificata con evidenza deterministica, `BLOCKED` con debito **visibile e persistente**, oppure `waiver` esplicito dell'utente **con evento spine**. Nessun'altra via d'uscita.
- **I2 — Nessun lavoro silenzioso.** Ogni scrittura su disco passa dall'edit ancorato OPPURE viene rilevata e registrata sulla spine con origine dichiarata.
- **I3 — I freni degradano bloccando.** Ogni gate di sicurezza (ROI, admission, verify) in errore interno → veto/defer + evento loud, mai passaggio.
- **I4 — Nessuna degradazione muta del canale modello.** Ogni caduta di qualità del LLM (JSON rotto, call troncata, schema violato N volte) produce un segnale conteggiato (guard code / evento / metrica), mai un silenzio.
- **I5 — Misurabilità dello swap.** Ogni cambio di modello (lead o tentacolo) ha un gate eval automatico che deve restare verde prima di considerare la configurazione valida.

---

## 2. Census delle falle (con evidenza)

Gravità: 🔴 = viola un invariante oggi; 🟠 = degradazione silenziosa; 🟡 = igiene/robustezza.

### 2.1 Verità di completamento — falsi verdi (viola I1)

| ID | Falla | Evidenza |
|---|---|---|
| F1 | **Debt single-slot**: general #1 verify FAIL, poi general #2 verify PASS ⇒ debt pulito, turno chiuso "verified" con lavoro #1 non verificato ("Single slot: the newest unresolved general wins") | `src/cli/tools/taskTool.ts:239-243`, clear a `:567` |
| F2 | **`unresolved` del grafo non entra nello strict gate**: writer FAIL dopo rework budget → `unresolved[]`, ma il gate (`evaluateStrictBuildGate`) compone solo selection+pack+contract ⇒ il lead può narrare "done" senza exit 4 | `src/cli/kraken/executor.ts:2055-2092` vs `src/cli/kraken/verificationBridge.ts:462-587` |
| F3 | **Auto-verify puramente narrativa**: il PASS vale se il trailer `VERDICT:` è parseabile (ultimo vince) — una verify che non esegue nulla e scrive PASS soddisfa l'obbligazione. Il livello deterministico gira solo nell'altro ramo | `packages/core/src/kraken/verdict.ts:73-76`, `taskTool.ts:514-521,567` |
| F4 | **Regex memory più permissiva del parser**: `status:\s*pass` ovunque nel body (tabelle, quote) scrive outcome PASS in memoria anche con trailer FAIL finale | `taskTool.ts:1396` |
| F5 | **Debt TUI che evapora**: reset a inizio turno (`useChatTurn.ts:222`), fine turno = solo system message, nessun exit code, mai più risollevato | `src/cli/hooks/useChatTurn.ts:222,1017-1027` |
| F6 | **Waiver senza traccia**: `--allow-unverified` / `ZELARI_STRICT_DONE=0` non scrivono evento spine ⇒ indistinguibile a posteriori da un turno verificato | `verificationBridge.ts:634-654` |
| F7 | **Rappresentazione PASS fittizia**: payload spine `verdict:'PASS'` di default sui turni non-strict; replay da sessione senza snapshot ⇒ `blocked:false` summary "open" | `verificationBridge.ts:~686`, `completionProof.ts:74`, `verificationBridge.ts:756-776` |
| F8 | **Mission claim gate: basta UN evento evidence** qualunque (anche comando irrilevante) per claim "event-backed"; spine illeggibile ⇒ exit 0 by design | `verificationBridge.ts:667-675`, `runHeadless.ts:1613-1617` |

### 2.2 Superficie di scrittura — bypass dell'ancoraggio (viola I2)

| ID | Falla | Evidenza |
|---|---|---|
| F9 | **bash/exec_process scrivono senza ancoraggio e senza eventi**: heredoc/`sed -i`/`>` bypassano snapshotId, WriteReject e l'intero canale `file.*` della spine (`FILE_TOOLS = {'read_file','write_file','edit'}`) | `src/cli/toolRegistry.ts:408-427`, `src/cli/spineFileEvents.ts:25` |
| F10 | **`write_file overwrite:true` = clobber whole-file non ancorato** (senza verifica che il modello abbia letto la versione corrente) | `packages/core/src/core/tools/builtin/filesystem.ts:122-127,170-190` |
| F11 | **Merge fallito lascia il parent sporco**: squash staged ma commit fallito ⇒ `ok:false` con indice/working tree modificati, nessun rollback; caso "no parent commit" ambiguo | `src/cli/kraken/krakenWorktree.ts:344-352,373-377` |
| F12 | **Fallback worktree silenzioso**: creazione fallita → `catch { worktree = null }`, il writer gira nell'albero padre condiviso SENZA radio/event, invalidando l'assunzione di safety di admission+scheduling | `taskTool.ts:1009-1013` |
| F13 | **Nessuna transazionalità multi-file sul path non-graph** (worktree opzionale, checkpoint solo per i writer del graph executor) | `taskTool.ts:170-179` vs `executor.ts:~578-580` |

### 2.3 Orchestrazione — gate fail-open e stati orfani (viola I3)

| ID | Falla | Evidenza |
|---|---|---|
| F14 | **`maxIterations` superato → break senza drenare `inFlight`**: tentacoli orfani in corsa mentre il summary viene calcolato; nodi "running" non convergenti | `executor.ts:768-775` |
| F15 | **ROI gate fail-open**: qualunque errore interno al gate fa partire il batch ⇒ il freno anti-esplosione smette di frenare senza segnale | `executor.ts:1134-1138`, `roiGate:1211-1259` |
| F16 | **Stato spawn/debt su `globalThis`** non per-sessione: run concorrenti nello stesso processo (companion serve) si contaminano | `taskTool.ts:233-256` |
| F17 | **Planner failure = run failure**: outage del modello planner ⇒ exit 2, nessuna degradazione al percorso single-agent che esiste nello stesso processo | `planner.ts:940-943`, `runHeadless.ts:676-684` |
| F18 | **Radio fd-cache orfana**: file `.jsonl` rimosso/ruotato ⇒ write su inode orfano, trail sparisce in silenzio (bus fail-open per contratto) | `krakenRadio.ts:155-189,222-225` |
| F19 | **Admissione semantica "plain" senza isolamento**: same-file different-symbol in parallelo NELL'ALBERO PADRE quando worktree ≠ auto — rischio merge ammesso nel testo stesso della telemetria | `executor.ts:1091-1101` |
| F20 | **Routing general sorprendente**: con solo `ZELARI_KRAKEN_SUB_MODEL`, general torna silenziosamente al parent (serve `GENERAL_USES_SUB=1`); retry 404 mascherato come fase testuale | `krakenModel.ts:204-210`, `taskTool.ts:1224-1260` |
| F21 | **Protected-mode nega i verify command non-JS**: `ESSENTIAL_BASH` solo npm/tsc/vitest/git ⇒ cargo/pytest negati nella zona riservata → BLOCKED forzato | `budgetRuntime.ts:70-81` |

### 2.4 Indipendenza dal modello — degradazioni mute (viola I4)

| ID | Falla | Evidenza |
|---|---|---|
| F22 | **JSON tool-call malformato → `args = {}` silenzioso** (Anthropic/ChatGPT): tool eseguito con default, zero segnali | `anthropic.ts:205-221`, `chatgpt.ts:137-149` |
| F23 | **Call OpenAI-compat con JSON incompleto droppata in silenzio**; la guardia `tool_call_truncated` scatta solo se ZERO call nel turno ⇒ con ≥1 call valida la mancante svanisce e il modello crede di averla fatta | `openai-compatible.ts:889-906` vs `AgentHarness.ts:1846-1870` |
| F24 | **contextWindow 400k assunto per modello sconosciuto** (profilo per-provider via regex): modello small-context → compaction mai innescata fino all'errore provider; `modelDiscovery` esiste ma non alimenta il budget | `capabilities.ts:77-86` |
| F25 | **Verificatore cieco**: tentacoli con policy summary-only vedono SOLO la prima riga del risultato tool (`summarizeToolResult` first-line-only) — il dettaglio dell'errore non arriva proprio a chi deve giudicare | `ContextProjector.ts:36-38,128-131` |
| F26 | **Repair Zod delegato al modello senza cap né escalation**: modello debole itera errori fino a `maxToolCallsPerTurn` con contatori normali | `packages/core/src/core/tools/registry.ts:240-257` |
| F27 | **Failover solo su errore, mai su qualità**: reputation/weaknessMeter esistono ma sono informativi, non escalativi | `kraken/modelReputation.ts`, `kraken/weaknessMeter.ts` |
| F28 | **Model swap test non esiste come misura**: `--model` è per-esperimento non per-arm; i guard code (`tool_call_truncated`, `text_tools_parse_failed`, `assistant_text_loop`…) non compaiono nelle metriche arms ⇒ il degrado è invisibile al confronto | `tools/eval/arms/{runner.ts:167-170, experiments.ts:53-59, metrics.ts}` |

### 2.5 Diagnostica muta (viola I4/I5)

| ID | Falla | Evidenza |
|---|---|---|
| F29 | Crash del pack nativo → `catch(():null)` senza log: un motore rotto sistematicamente è indistinguibile da un albero "unbound" | `verificationBridge.ts:521-535` |
| F30 | Evidence non ancorata se la spine cade ⇒ falsi BLOCKED su lavoro reale (fail-closed ma rumoroso e senza diagnosi) | `engine.ts:142-157,238-248` |
| F31 | Run records scritti (`.zelari/runs/`) ma **nessun reader** esiste; Recording opt-in | `RunRecorder` (0 match reader in `src/cli`) |
| F32 | Nessun hook utente sull'evento di verifica fallita (HookEvent fermo a Pre/PostToolUse/Session*) | `packages/core/src/core/hooks/` |
| F33 | Doc stale che causano duplicazione: v1 plan senza marker superseded, `traceStore.ts:2` cita ADR-0015, note t52 stale, `scriptPlanner` libreria dead-path (`ZELARI_KRAKEN_PLAN_FORMAT` solo in un commento, modalità "auto" dichiarata future) | `scriptPlanner.ts:9-11`, `traceStore.ts:2` |

---

## 3. Workstream

Ogni task: **Gap → Meccanismo → Accettazione**. Convenzioni repo: file ≤300 LOC, no nuove dip-heavy, test di regressione che falliscono prima e passano dopo (skill `reproduce-bug`/`regression-test`).

### W1 — Verità di completamento (critico — spegne i falsi verdi)

> **Stato W1 (2026-09-19, verify su disco): COMPLETA — K1.1–K1.8 tutte atterrate.** K1.1–K1.6 + K1.8 verificati il 2026-09-18 (suite: `taskTool.verifyDebt`, `verifyDebtSpine`, `verificationBridge.*`, `claimGate`; sweep 1521/1523 con 2 flake win32 pre-esistenti provati su HEAD). **K1.7 atterrata il 2026-09-19** (`verifyHonestVerdict.ts` 3/3: payload `verdict:null`+`status:'UNEVALUATED'` su fine turno non-strict, `lastVerificationRun.summary === 'unverified-open'`, harness_state R4 `verification-not-strict`; wiring su `runOneTurn.ts` in 3 siti; scoped tsc 0 errori nuovi).

- [x] **K1.1 Debt multi-slot** (F1). `taskTool.ts` — da slot singolo a coda keyed per spawn-id; la verify PASS pulisce SOLO il debito del proprio general; a fine turno la coda intera alimenta il gate. *Accettazione*: test con general#1 FAIL + general#2 PASS ⇒ exit 4.
- **K1.2 Bridge `unresolved` → strict gate** (F2). Esponiamo `unresolvedFindings` del graph runtime come sorgente del composition block in `verificationBridge` (`runOneTurn` exit 4 se non-vuoto a fine turno). *Accettazione*: grafo con writer unresolved e nessun debt task-tool ⇒ exit 4.
- **K1.3 Floor deterministico per l'auto-verify** (F3). L'auto-verify post-general conta come PASS solo se ha eseguito ≥1 strumentale (i required-checks esistono già via `withKrakenRequiredChecks`, ADR-0020): trailer PASS senza evidenza strumentale ⇒ `unknown` ⇒ debt. *Accettazione*: verify narrativa senza esecuzioni ⇒ turno non verified.
- **K1.4 Parser verdict unico** (F4). `taskTool.ts:1396` riusa il parser canonico di `verdict.ts` (last-trailer-wins) — mai regex libere sul body.
- **K1.5 Debt persistente su spine** (F5). Eventi `verify.debt_open/debt_cleared` sull'envelope; il turno TUI successivo li ricarica; footer TUI + surface exit coerente con headless.
- **K1.6 Waiver event** (F6). Evento spine `strict.waived` (motivo, env/flag, timestamp) su ogni opt-out.
- [x] **K1.7 Rappresentazione onesta** (F7). Payload `verdict: null` (o `UNEVALUATED`) sui turni non-strict; summary replay `unverified-open`.
- **K1.8 Mission claim gate per-claim** (F8). La claim è event-backed solo se esiste evidence riferita ai criterion della claim stessa (match claim→criterion id), non un evento qualunque.

### W2 — Superficie di scrittura integra (alto)

- [x] **K2.1 Bash-write detection** (F9). Post-exec di bash/exec_process: diff fs su cwd (stat/size/mtime dei path claimati + scan shallow) → eventi spine `file.applied` sintetici con `origin:'bash'` + audit radio. Detection fail-open ma **loud**; il canale spine smette di essere cieco.
  > **Stato (2026-09-18, verificato on-disk):** `src/cli/tools/bashWriteWatch.ts` (229 LOC) + suite 6/6; wrap innermost su `createBashTool`/`createExecProcessTool` (`toolRegistry.ts:126`); radio `bash.write_detected`/`bash.watch_failed`; cap 200 path; `origin` in `data` di `file.applied` (nessun bump di schema). Fail-before documentato (3 failed pre-fix). Limiti noti: depth 4, dir skippate, rewrite same-size.
- [x] **K2.2 `overwrite:true` ancorato** (F10). Richiede `expectedHash` (file letto di recente) o flag esplicito `force`; altrimenti WriteReject `stale_content` con next-action re-read.
  > **Stato (2026-09-18, verificato on-disk):** `filesystem.ts` +70 LOC (schema `expectedHash`/`force`, reject `stale_content` con `actualHash` + next re-read, marcatore `forcedOverwrite`); suite nuova 6/6 con fail-before 3-fail documentato; test CLI `anchoredEdit.test.ts` riconciliato (bare→reject, force→proceed); fix collaterale: rename `VerificationClaim`→`CriterionClaim` in `claimGate.ts` (TS2308 barrel collision con `council/verification/honesty.ts`, build core di nuovo exit 0).
- [x] **K2.3 Rollback merge fallito** (F11). Commit fallito ⇒ reset allo stato pre-squash del parent + evento `worktree.merge_aborted` (branch tenuto, già previsto).
  > **Stato (2026-09-19, on-disk):** `src/cli/kraken/worktreeMergeRollback.ts` (362 LOC) cablato in `mergeKrakenWorktree` (`tools/krakenWorktree.ts`): recovery point pre-squash (`captureParentPreMergeState`) e rollback su conflitto/commit-fallito (`reset --hard` se il parent era pulito, altrimenti restore degli snapshot dirty); evento radio `worktree.merge_aborted` su ogni abort (payload branch/nodeId/reason/phase/action); branch+worktree tenuti. Suite nuova `krakenWorktree.rollback.test.ts` 3/3 (fail-before: 3/3 rossi senza il wiring). Scoped `tsc` 0 errori nuovi (11 pre-esistenti, tutti in `src/cli/automations`).
- [x] **K2.4 Worktree fallback loud + degradazione sicura** (F12). Catch ⇒ radio `worktree.fallback_shared_tree` E il writer degrada a ammissione seriale (defer sugli overlap) — l'assunzione di safety non si rompe in silenzio.
  > **Stato (2026-09-19, on-disk):** il catch di `runTentacle` (`tools/taskTool.ts`) non è più silenzioso: emette l'evento radio `worktree.fallback_shared_tree` (payload `reason`/`mode`/`nodeId`) e invoca `deps.onWorktreeFallback` (nuovo opt su `TaskToolDeps`). Il graph executor (`kraken/executor.ts`) latcha un flag `worktreeFallbackSeen` per-run e, una volta visto un fallback, passa `sharedTreeDegraded: true` a `worktreeSchedulingDecision` (`kraken/worktreeScheduling.ts`, nuovo `WorktreeSchedulingOptions`, rationale `shared-tree-degraded`): la P2.C rescue smette di ammettere writer overlappanti in parallelo (defer seriale P2.A) fino alla fine del run — il flag NON viene mai resettato a metà run. Fail-open preservato (il tentacolo gira comunque, solo non isolato). Suite nuove: `kraken/worktreeFallbackLoud.test.ts` (2, con controllo positivo rescue) + `tools/taskTool.worktreeFallback.test.ts` (2); 3 casi puri/regression in `worktreeScheduling.test.ts`. Fail-before: 4 rossi (2 puri + 1 executor + 1 radio) senza il wiring. Scoped `tsc` 0 errori nuovi (11 pre-esistenti, tutti in `src/cli/automations`).
- [x] **K2.5 ESSENTIAL_BASH estensibile** (F21). Lista essential caricabile da config repo (`.zelari/` settings / voci `scripts` di package.json) — cargo/pytest/mvn non più negati in protected.
  > **Stato (2026-09-19, on-disk):** nuovo `src/cli/budget/essentialBashConfig.ts` (123 LOC): lista essential = built-in ∪ `<root>/.zelari/zelari.config.json` → `essentialBash` (array di RegExp source) ∪ script dichiarati in `package.json` (`<pm> run <script>`). Lettura lazy+memoizzata per root (`resetEssentialBashCache()` per i test); regex invalida ignorata con warn una-tantum (fail-open ai built-in). `isVerificationEssential` (`budgetRuntime.ts:103`) usa la lista fusa; firma stabile (4° param opzionale `root`). Suite nuova `essentialBashConfig.test.ts` 9/9 (fail-before documentato: 4 rossi pre-wiring); budget area 45/45. Scoped `tsc` 0 errori nuovi (11 pre-esistenti, tutti in `src/cli/automations`). Nota: chiave `essentialBash` letta direttamente dal modulo budget (non ancora in `UserSettingsSchema`).
- ~~**K2.6 Transazionalità multi-file non-graph** (F13, onere L).~~ **DEFERRED (2026-09-19):** il rischio residuo è assorbito da W1 completa (debito persistente su spine + strict gate su unresolved/waiver/narrativo/claim) + K2.1 (rilevazione scritture bash con eventi spine sintetici) + K2.2 (overwrite ancorato) + K2.4 (fallback worktree loud + degradazione seriale). Riaprire solo se il dogfooding (t52) mostra catene general senza worktree che lasciano tree sporchi su hard-FAIL.

### W3 — Robustezza orchestrazione (medio-alto)

- **K3.1 Drain di `inFlight`** (F14). Superato `maxIterations`: attesa con timeout + cancel eager; nodi non terminati marcati `abandoned` nel digest; mai summary con nodi "running".
- **K3.2 ROI gate fail-closed** (F15). Errore interno ⇒ veto/defer + evento radio `roi_gate_error`.
- **K3.3 Stato per-sessione** (F16). `__zelariGeneralVerifyDebt`/spawn-count da `globalThis` a mappa keyed sessionId (o spine-backed).
- **K3.4 Planner fallback esplicito** (F17). Planner fail ⇒ percorso single-agent con evento spine `kraken.planner_fallback` + digest (opt-in `ZELARI_KRAKEN_PLANNER_FALLBACK=1`, flip a default dopo dogfood). Mai exit 2 quando esiste un'alternativa nello stesso processo.
- **K3.5 Radio fd revalidation** (F18). Verifica inode/mtime del path ad ogni append (o su errore) con reopen.
- **K3.6 Avviso routing general** (F20). Warn radio+stderr quando `SUB_MODEL` è impostato e general usa il parent senza `GENERAL_USES_SUB`.
- **K3.7 Plain-admission gating** (F19). `semantic-disjoint-plain` ammesso solo se scheduling `auto` (isolation worktree disponibile); altrimenti defer.

### W4 — Indipendenza dal modello: quality floor (alto)

- **K4.1 Malformed tool-call → typedErr, mai silenzio** (F22+F23). Anthropic/ChatGPT: parse fallito ⇒ tool-result di errore con excerpt del JSON rotto (il modello si auto-corregge); OpenAI-compat: call incompleta ⇒ errore sintetico per quell'id invece del drop. Nuovo guard code `tool_args_parse_failed` conteggiato.
- **K4.2 Capabilities reali nel budget** (F24). `modelDiscovery` alimenta `capabilitiesFor`/budget; default per sconosciuto conservativo (es. 128k) + warn esplicito; occupancy già misurata fa il resto.
- **K4.3 Il verificatore vede gli errori** (F25). Policy contesto verify: risultato con exit≠0 o contenente errori ⇒ payload integro fino a cap (mai first-line-only).
- **K4.4 Repair cap con escalation** (F26). Dopo N violazioni schema sullo stesso tool: hint strutturato (schema + esempio) e escalation (thinking↑ / modello parent) o FAIL del nodo — non iterazione muta fino al cap.
- **K4.5 Escalation su qualità** (F27, opt-in). Soglie weaknessMeter/reputation ⇒ il tentacolo degradato viene ri-eseguito sul parent model. Default OFF, flip solo con dati (lezione t57).
- **K4.6 Model swap test automatico** (F28). Arm lead-model in `experiments.ts` + guard code in `GUARD_AB_REPORT_METRICS` + `tools/eval/runModelSwap.ts` (baseline vs candidate: pass-rate, guard-code delta, cost). Viola I5 finché non esiste.

### W5 — Misura, osservabilità, igiene (medio)

- **K5.1 `zelari-code runs list/show`** (F31) ✅ *atterrato* (`63d76ce`). Reader dei run records esistenti (`.zelari/runs/<id>/`); default recording ON nelle missioni. Sinergia diretta con t52 (dogfooding).
- **K5.2 Hook `VerificationFailed`** (F32) ✅ *atterrato* (`17a2ad5` "Osservabilità verifiche F29-F33"; label codice K5.3/F32; verificato 39/39 test). Nuovo HookEvent con payload criteri+reason (già in `completionPolicy`) — notifiche/snapshot esterni senza toccare il core loop.
- **K5.3 Flip data-gated dei default rinviati**: `ZELARI_KRAKEN_WORKTREE=auto` (dopo K2.4), `ZELARI_SPINE_REPLAY_CACHE=1` (dopo dogfood), `ZELARI_VERIFY_PARALLEL` (dopo evidenza per-repo — suite anti-interferenza esiste già).
- **K5.4 Diagnostica muta** (F29+F30) ✅ *atterrato* (`17a2ad5`; label codice K5.2(F29)/K5.3(F30) — `evidence.not_anchored` + `pack_error`, test dedicati). log della causa sul catch del pack; evento spine esplicito per evidence non ancorabile.
- **K5.5 Igiene doc/wiring** (F33) ✅ *atterrato* (`d7d81ad`): v1 plan → marker SUPERSEDED ✓, ref ADR-0015→0035 in `traceStore.ts` (+4 ricorrenze in `zelariMission.ts`) ✓, `scriptPlanner` → marcato EXPERIMENTAL ✓; nota t52 saltata (vault `.zelari`, non product).

---

## 4. Sequenza e dipendenze

```
Wave 1  W1 (K1.1–K1.8)           ← prima di tutto: nessun falso verde
Wave 2  W2 (K2.1–K2.5) ∥ W3      ← write integrity + robustezza (indipendenti)
Wave 3  W4 (K4.1–K4.6)           ← quality floor del canale modello
Wave 4  W5 (K5.1–K5.5)           ← misura, hook, flip data-gated, igenie
```

- K1.3 dipende da nulla (i required-checks esistono); K1.2 tocca `verificationBridge` — coordinare con K1.1 nello stesso file.
- K2.4 è prerequisito del flip WORKTREE=auto (K5.3).
- K4.6 è prerequisito perché K4.5 (escalation su qualità) sia misurabile.
- **Fuori scope dichiarato**: ADR-0035 Phase B, backlog v2 §15 non toccato dai task sopra, alias memoria (engine-wide, pianificato altrove).

## 5. Rischi e anti-obiettivi

- **Nessuna riscrittura dell'orchestratore**: interventi chirurgici su file esistenti; nessun drive-by refactor.
- **Nessun flip di default senza dati** (lezione t57: gate onesto INSUFFICIENT-DATA).
- Ogni task porta test che falliscono sul codice attuale e passano dopo; suite globale (`npx tsc --noEmit -p tsconfig.json`, `npx vitest run`) verde a ogni merge.
- Budget conservativo: K2.6 (transazionalità) deferrabile; K4.5 default OFF.

## 6. Definition of done del piano

1. Un fuzz dei percorsi di completamento (exit 0) non trova vie fuori da {verificato, waiver-event}: **I1**.
2. Sessione con scritture via bash produce eventi `file.applied origin:bash` nella spine: **I2**.
3. Iniezione di errore nei gate (ROI/pack/admission) produce veto+evento, mai passaggio: **I3**.
4. Traccia con JSON rotto/troncato produce guard code conteggiato nel report arms: **I4**.
5. `runModelSwap` confronta due configurazioni modello con delta guard-code e pass-rate: **I5**.
