# Verifica & Piano operativo — Zelari 2.6 (Harness Retention + Resource Budget)

> Fonte: `Zelari_2.5_Integrated_Harness_Retention_Resource_Budget_Plan.md` (root).
> Questo documento è il risultato del confronto piano↔codice reale (commit 183ad3c951ae, v2.5.0).
> Stato: **piano verificato, pronto per BUILD**. Ogni affermazione di stato è ancorata a file reali.

---

## 1. Verdetto di veridicità

Il documento è **sostanzialmente veritiero e ben ancorato all'architettura reale**. Tutti i file che dichiara di voler aggiornare esistono; tutti i meccanismi che dichiara assenti sono assenti.

### 1.1 Asserzioni VERIFICATE ✅

| Asserzione del piano | Evidenza nel codice |
|---|---|
| Baseline = Zelari 2.5.0 | `package.json` → `"version": "2.5.0"` |
| Limiti risorse già presenti ma **distribuiti host-side, non centrali** (§9.1) | `src/cli/gauntlet/policy.ts:6-9` (maxPieces 6 / maxRounds 3 / maxParallel 2 / wallMs 45min); `packages/core/src/agents/councilApi.ts:161-174` (`maxToolCallsPerTurn` default 5, `maxToolCallsChairman`, `maxToolLoopIterations`, `maxToolLoopHardCap`); `src/cli/missionSlice.ts:139` (`resolveAgentMissionToolBudget`), `src/cli/zelariMission.ts:165` (`DEFAULT_MAX_ITER=6`) |
| Nessun `HarnessManifest`, nessun `TaskContract`, nessun evento resource/task-contract | grep repo-wide: 0 match per `HarnessManifest`, `TaskContract`, `resource.snapshot`, `task.contract`, `session.harness_manifest` |
| Vocabolario eventi session chiuso (nuovi kind = schema review ADR-0021) | `packages/core/src/session/types.ts:34-59` (`SESSION_EVENT_KINDS`, 21 kind, nessuno dei 6 proposti) |
| `deriveMessages` è l'unico percorso model-visible | `packages/core/src/session/modelSurface.ts:1-17` (`MODEL_SURFACE_KINDS` = user.message, assistant.message, tool.call, tool.result, session.compacted) |
| Continuation policy mission già advisory-only, con budget iterations e user steer | `packages/core/src/mission/continuationPolicy.ts:44-52` (`MissionContinuationInput.budget`, `userSteer`), contratti locked `goalRewrite: false` / `doneByScore: false` |
| Profili versionati con tool manifest hash | `packages/core/src/runtime/profiles.ts` (MINIMAL/KRAKEN/COUNCIL/MISSION v1, `toolManifestHash()` sha256 riga ~99) |
| Compaction deterministica con criteri/constraint estratti (regex-heuristic) | `packages/core/src/session/compactionState.ts` (`CompactionStateSnapshot.userConstraints`, `activeCriteria`) |
| `tools/eval/` e `eval/anchors/` da creare | nessuna dir `tools/` né `eval/` a root |
| Completion authority = CompletionPolicy deterministica (ADR-0023) | `packages/core/src/verification/completionPolicy.ts`, `engine.ts`, `criteriaPack.v1.ts` |

### 1.2 Inesattezze / correzioni richieste ⚠️

1. **`resource.snapshot` NON è "state-only"** — §24 lo elenca tra i "nuovi state-only events", ma il Workstream E (§10) lo vuole model-visible (latest-only). Contraddizione interna. **Risoluzione**: è un evento **model-surface con proiezione latest-only** in `deriveMessages` (stesso spirito dello shadowing di `session.compacted`, ma per kind). L'invariante ADR-0016 "model-visible ⟺ logged" resta valido.
2. **Unified Cost Metric non è ex-novo** — `packages/core/src/verification/metrics.ts` esiste già con `verifiedSolveRate()`, `computeFalseDoneRate()`, `verificationCostRatio()` e commento "North star: average cost per verified solved task". La fase va trattata come **estensione** (aggiungere `RunCost` + aggregazioni), non creazione.
3. **Anchor manifest: JSON + zod, non YAML** — il repo non ha dipendenze YAML runtime (runtime deps: ink, ink-text-input, react, zod). Convenzione AGENTS.MD: "zero new heavy deps". → anchor in **JSON con schema zod**.
4. **Riuso obbligato di utility esistenti** — `packages/core/src/core/requestSnapshot.ts` esporta già `stableStringify`, `sha256Hex`, `canonicalTools` (riusate anche da `src/cli/budget/requestMeter.ts` via `@zelari/core/harness`). L'Harness Manifest **non deve duplicarle**. `profiles.ts` ha già `toolManifestHash` — va generalizzato, non riscritto.
5. **Collisione nominale "phase"** — `src/cli/phase.ts` definisce `WorkPhase = 'plan' | 'build'` (ortogonale al dispatch mode). Il piano usa `phase` per due concetti diversi: `manifest.profile.phase` (ok, = WorkPhase) e `ResourceBudget.phase` (`explore|implement|verify|repair` = stadio operativo del run). **Risoluzione**: rinominare il secondo in `stage` (o `executionStage`) ovunque nel codice nuovo.
6. **`profile.hash` non esiste ancora** — `ProfileSchema` non ha un hash dell'intero profilo; solo i tool sono hashati. Da aggiungere `profileHash(profile)` in `profiles.ts`.
7. **Token/cost telemetry già parzialmente presente** — `RequestUsageSnapshot` (requestSnapshot.ts:33-39) ha già promptTokens/completionTokens/cachedPromptTokens, e `src/cli/budget/requestSnapshotStore.ts` li persiste. Il ResourceLedger per i **token** parte da qui; il delta vero è il budget **tool-call/wall-clock centralizzato**.

---

## 2. Gap map — cosa manca davvero (tutto NEW)

- `packages/core/src/runtime/harnessManifest.ts`, `resourceBudget.ts`, `resourcePolicy.ts`
- `packages/core/src/session/taskContract.ts`
- 6 nuovi kind evento: `session.harness_manifest`, `task.contract`, `task.contract_updated`, `resource.snapshot`, `resource.limit_reached`, `resource.reserve_entered`
- `src/cli/harnessManifest.ts`, `src/cli/budget/resourceLedger.ts`, `src/cli/budget/resourceSnapshot.ts`, `src/cli/kraken/taskContract.ts`
- `tools/eval/` intera (anchorRunner, regressionGate, retentionPolicy, cost, report, targetedAnchors, types) + `eval/anchors/` bootstrap

## 3. Punti di innesto verificati (UPDATE)

| File | Innesto |
|---|---|
| `session/types.ts:34` | aggiungere 6 kind a `SESSION_EVENT_KINDS` (+ nota schema review ADR-0021) |
| `session/modelSurface.ts:16` | `MODEL_SURFACE_KINDS += resource.snapshot`; `deriveMessages` proiezione latest-only per kind |
| `session/invariants.ts` | nuovi codici violazione: `RESOURCE_USED_MONOTONIC`, `RESOURCE_REMAINING_COHERENT`, `RESERVE_NEGATIVE`, `TASK_CONTRACT_VERSION_MONOTONIC`, `MANIFEST_HASH_MISMATCH` |
| `session/compactionState.ts` | `userConstraints`/`activeCriteria` dal TaskContract quando presente, regex = fallback |
| `runtime/profiles.ts` | `profileHash()` + `resourcePolicy` default per profilo |
| `mission/continuationPolicy.ts` | input esteso con `remainingBudget`, `repairHistory` → `repair|pivot|hold` (user steer resta sovrano) |
| `verification/completionPolicy.ts` | budget insufficiente per evidence required → `BLOCKED (resource-exhausted)`, mai PASS |
| `src/cli/budget/modelContextBuilder.ts` | blocco `RESOURCE STATUS` iniettato dalla proiezione session (non da variabili volatili) |
| `src/cli/gauntlet/loop.ts` + `policy.ts` | combinare PASS/GAP/BLOCKED × ResourceBudget senza toccare autorità critic/CompletionPolicy |
| `src/cli/kraken/` (executor) | wiring ledger + snapshot emission |

---

## 4. Fasi di implementazione (allineate alle 11 PR del §29 del piano sorgente)

> Dipendenze: 1 → 2 → 3 (Track A); 4 → 5 → 6 → 8 (Track B); 7 e 9 semi-indipendenti; 10 dipende da 1+2; 11 per ultimo. Le due tracce (A e B) possono procedere in parallelo dopo la fase 1.

### FASE 1 — `feat(runtime): add canonical harness manifest` [P0]
- **NEW** `packages/core/src/runtime/harnessManifest.ts`: `HarnessManifestV1` (zod), `hashHarnessManifest()` (riusa `stableStringify`/`sha256Hex` da `../core/requestSnapshot.js`), `diffHarnessManifest()` base (campi cambiati).
- **UPDATE** `runtime/profiles.ts`: `profileHash(profile)`.
- **UPDATE** `session/types.ts`: kind `session.harness_manifest` (payload `{manifest, manifestHash}`).
- **NEW** `src/cli/harnessManifest.ts`: raccoglie hash prompt (kraken/gauntlet/council/mission da `promptModules.ts`/`gauntlet/prompts.ts`), `toolManifestHash`, `skillManifestHash`, policy hash, `coreVersion`/`cliVersion` da package.json; emette l'evento a session start e su cambio versione manifest.
- **Test** (26.1 piano): stesso harness → stesso hash; prompt/tool/resource-policy change → hash diverso; manifest ricostruibile dopo resume (replay equality).
- **Acceptance**: ogni nuova sessione registra il manifest; ` zelari-code --inspect`-style dump opzionale.

### FASE 2 — `feat(eval): add historical anchor format and runner` [P0]
- **NEW** `tools/eval/types.ts`: `AnchorManifest` (zod, **JSON**), `AnchorBaseline`, `EvalRunRecord`.
- **NEW** `tools/eval/anchorRunner.ts`: setup → run headless (`src/cli/runHeadless.ts` già esiste come entry) → verify commands → `RunCost` → record JSONL. Tier 0/1/2 nel manifest.
- **NEW** `eval/anchors/<categoria>/*.json` — bootstrap: prima ondata 8 anchor Tier 0 (5 local-bugfix, 3 verification/compaction), espansione a 15–25 entro la milestone (§7.6).
- **Esecuzione**: Node ≥24 (engines) → type-stripping nativo; import di `@zelari/core` dal workspace dist. Fallback se problematico su win32: includere `tools/eval` nel tsconfig root + script npm `eval:anchors`.
- **Test** (26.6): determinismo setup/reset, timeout, tool budget enforcement, verified success.

### FASE 3 — `feat(eval): add harness regression retention gate` [P0]
- **NEW** `tools/eval/retentionPolicy.ts`: `HarnessRetentionPolicy` + preset `stable` (0 regressioni) / `experimental` (1) / `research` (2), tutti `requireValidityPass: true`.
- **NEW** `tools/eval/regressionGate.ts`: baseline vs candidate → `HarnessEvalResult`; commit rule §8.5.
- **NEW** `tools/eval/report.ts`: report testuale §8.6.
- **Test** (26.7): zero-regression stable; validity failure sempre REJECT; violazioni costo riportate.

### FASE 4 — `feat(runtime): add central resource budget and ledger` [P0]
- **NEW** `packages/core/src/runtime/resourcePolicy.ts`: `ResourcePolicy` (zod: `maxToolCalls`, `reserve.verification`, `reserve.repair`, `wallClockMs?`, soglie pressure configurabili), default per profilo (kraken/v1: 40/6/4/900000 come da §11.2), `resourcePolicyHash()` — **entra nel manifest (Fase 1 field)**.
- **NEW** `packages/core/src/runtime/resourceBudget.ts`: funzioni pure `computeBudget(policy, used)`, `budgetPressure()` → `ample|normal|constrained|critical` (soglie policy-configurabili, non hard-codated — §12.3). Il tipo usa **`stage`** (`explore|implement|verify|repair`) per evitare collisione con `WorkPhase`.
- **NEW** `src/cli/budget/resourceLedger.ts`: ledger host-owned append-only (`ResourceLedgerEntry`: seq, reason, delta); ricostruzione da session log (conta `tool.call` events — niente double-count con `tool.interrupted`); esporta `rebuildLedgerFromEvents()`.
- **Invarianti** (9.5): `used <= limit`, `remaining = limit - used`, reserve ≥ 0, budget non mutabile dal modello, ToolRegistry choke point invariato (il conteggio passiva dagli eventi session, l'enforcement resta nell'harness config).
- **Test** (26.2): decrement, no double-count, hard limit, resume reconstruction.

### FASE 5 — `feat(session): expose durable latest resource snapshot` [P1]
- **UPDATE** `session/types.ts`: kind `resource.snapshot`, `resource.limit_reached`, `resource.reserve_entered` (payload §10.1, con `stage`).
- **UPDATE** `session/modelSurface.ts`: `MODEL_SURFACE_KINDS += 'resource.snapshot'`; `deriveMessages` proiezione **latest-only** (gli snapshot precedenti restano nel log, non nella surface — §10.2). Meccanismo nuovo: documentare accanto allo shadowing compaction.
- **NEW** `src/cli/budget/resourceSnapshot.ts`: emette snapshot dopo tool batch / stage change / soglia reserve attraversata / verify-repair start (§10.4).
- **UPDATE** `src/cli/budget/modelContextBuilder.ts`: mappa la proiezione nel blocco `RESOURCE STATUS` (formato §10.3).
- **UPDATE** `session/invariants.ts`: invarianti §24.1.
- **Test** (26.3): only-latest visible; compaction preserva ultimo stato; resume produce stessa surface.

### FASE 6 — `feat(runtime): reserve resources for deterministic verification` [P0]
- **UPDATE** `verification/completionPolicy.ts`: evidence required non verificabile per budget → `BLOCKED / resource exhausted`, mai falso PASS (§11.5). `unknown ≠ pass` resta (ADR-0023).
- **UPDATE** kraken executor + missionSlice: quando `remaining <= verificationReserve` → tool consentiti limitati a verify-set (test/typecheck/build/diff/repair mirato); verification reserve **protected**, repair reserve **advisory** (§11.4).
- **Test** (26.4): exploration non consuma protected reserve; deterministic PASS termina con budget residuo; insufficient → BLOCKED.

### FASE 7 — `feat(session): add first-class task contract` [P1]
- **NEW** `packages/core/src/session/taskContract.ts`: `TaskContract`, `TaskConstraint`, `TaskCriterion` (zod, §14.2), regole di autorità user > agent-derived, merge/versioning monotono.
- **UPDATE** `session/types.ts`: kind `task.contract`, `task.contract_updated` (append-only). Nota: esistono già `task.created`/`task.updated` generici — i nuovi kind sono dedicati al contratto (naming come da piano).
- **UPDATE** `session/compactionState.ts`: criteria/constraints dal contract, regex = fallback compatibility (§14.5).
- **NEW** `src/cli/kraken/taskContract.ts`: estrazione iniziale dal messaggio utente (source userSeq), aggiornamenti da steer.
- **Test** (26.8): user constraint preserved; derived logged; user wins; steer versioning; compaction preservation.

### FASE 8 — `feat(runtime): add budget-aware repair and pivot policy` [P1]
- **UPDATE** `mission/continuationPolicy.ts`: `ContinuationDecision = complete|repair|pivot|hold` con input `remainingBudget` + `repairHistory`; esempi decisionali §13.3 (GAP+ample→repair; repeated GAP→pivot; structural GAP+critical→hold; PASS→complete). User steer sovrano invariato; `VerificationEngine` resta deterministic truth.
- **UPDATE** `src/cli/gauntlet/loop.ts`/`policy.ts`: PASS/GAP/BLOCKED × budget senza cambiare autorità critic.
- **Test** (26.5).

### FASE 9 — `feat(eval): add unified cost-per-verified-solve metrics` [P1]
- **NEW** `tools/eval/cost.ts`: `RunCost` (§15.2), `costPerVerifiedSolve`, `wallPerSolve`, `toolCallsPerSolve`, pareto report (§15.4).
- **UPDATE** `packages/core/src/verification/metrics.ts`: **estendere** (non duplicare) — bridge verso `RunCost`; fonte dati: `RequestUsageSnapshot` + `requestSnapshotStore` + session log.
- **Test**: aggregazioni corrette con cache hits; pareto non promuove automaticamente a solve-rate maggiore.

### FASE 10 — `feat(eval): classify harness changes and target retention anchors` [P1]
- **UPDATE** `packages/core/src/runtime/harnessManifest.ts`: `diffHarnessManifest` → classi behavioral/structural/cosmetic (mappa campi §16.1).
- **NEW** `tools/eval/targetedAnchors.ts`: diff → set anchor mirati (mapping tag anchor ↔ campi manifest).
- **Test**: prompt change → behavioral → anchor gate; UI copy → cosmetic → standard CI.

### FASE 11 — `chore(ci): enforce stable retention gate` [P2]
- **NEW** layout `eval/results/<manifestHash>/{summary.json,anchors.jsonl}` (Eval Result Store §17 — file-based, niente DB).
- **UPDATE** `.github/workflows/*`: Tier 0 PR-blocking, Tier 1 merge/release-blocking (Phase 4 rollout §28).
- **Rollout progressivo**: Phase 1 shadow (manifest ON, gate report-only) → Phase 2 (snapshot model-visible, reserve advisory) → Phase 3 (reserve protected, Kraken BUILD first) → Phase 4 (gate blocking) → Phase 5 (repair/pivot: Gauntlet→Mission→Kraken).

---

## 5. Milestone 2.6 — checklist mappata

| Requisito §30 | Fase |
|---|---|
| manifest registrato per sessione + resourcePolicyHash dentro | 1, 4 |
| 15–25 anchor stabili, Tier 0 in CI, gate baseline vs candidate, retention budget esplicito | 2, 3, 11 |
| ResourceBudget centrale, ledger ricostruibile, latest snapshot model-visible, verification reserve, PASS non spende residuo, exhaustion non dà false PASS | 4, 5, 6 |
| TaskContract first-class, compaction lo usa, Gauntlet/Verification condividono criteria | 7, 8 |
| cost per verified solve misurato, manifest diff identifica behavioral | 9, 10 |

## 6. Rischi principali

1. **Estensione vocabolario session** — richiede schema review ADR-0021: aggiornare `MIGRATION.md` + `SESSION_SCHEMA_VERSION` resta 1 (payload additive) o bump 2 se si rompe replay. Decisione: additive, nessun bump.
2. **Proiezione latest-only in deriveMessages** — nuovo meccanismo di surface; test di regressione su `sessionReplayInvariant.test.ts` + `modelSurface.test.ts` obbligatori.
3. **tools/eval su win32/Node24** — type-stripping da verificare subito (spike 30 min in Fase 2); fallback tsconfig root.
4. **Double-count tool calls** — fonte unica = eventi `tool.call` del session log; l'harness enforcement continua a usare i suoi limiti per-turn (ridondanza intenzionale host-side, §9.2).
5. **Scope creep** — i "Track successivi" (§18-23: piece allocation, budget curves, --effort, memory, router, SPADE) restano OUT come da documento.

## 7. Convenzioni da rispettare (da AGENTS.MD)

- Un tool definition per file in `packages/core/src/core/tools/builtin/` (non toccato qui se non per conteggio).
- Async-first, zod per ogni schema LLM/tool, file ≤ 300 LOC per moduli nuovi, zero deps nuove (→ JSON non YAML), commit atomici single-task (le 11 fasi = 11 PR).
