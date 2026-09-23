# Piano — Authority & Verification Hardening v2 (post-2.12.0)

> Baseline: `zelari-code@2.12.0` su `main` (HEAD `78a969c`). Fonte: lettura diretta dei sorgenti citati.
> Predecessore: `harness-hardening-plan.md` (P0.1–P0.6, P1.1–P1.2 — **tutti implementati**, commit `8d3bbb8`, `05b7a50`, `2e56359`, `8c89127`, `1360f00`).
> **Aggiornamento 2026-08-26**: riconciliato con `Zelari_Code_Piano_di_Lavoro.md.txt` (piano di lavoro completo dell'utente, item §1–§18 + roadmap Release A–D + KPI). §1–§10 confermano 1:1 P0.A–P1.E di questo piano; le aggiunte (criteri di accettazione più fini, P2/P3 §11–§18, KPI) sono integrate e marcate **〔PW〕**. Mapping: §1→t14 · §2→t15 · §3→t16 · §4→t17 · §5→t18 · §6→t19(+t24) · §7→t20 · §8→t22 · §9→t23 · §10→t21 · §11→t25 · §12→t26 · §13→t27 · §14→t28 · §15–16→t29 · §17→t30 · §18→t31.

## Verdetto sulle proposte esterne

**Coerenti con lo stato attuale: sì.** Tutte le diagnosi tecniche sono accurate (verificate file:line sotto). Due correzioni di contesto:

1. **§9 (auto-orchestrator)**: `automatic` no-op è vero per `delegationPolicy.ts`, MA esiste già `src/cli/orchestration/policy.ts` (`chooseOrchestration`, deterministica, wired in headless `--mode auto`) che classifica `solo|kraken`. La proposta chiede un passo oltre (strategie fini + confidence + wiring TUI), non una partenza da zero.
2. **§10 (verifier cross-family)**: il *selection verifier* (`verifier.ts`, ADR-0020) default = parent model (vero), MA il *completion reviewer advisory* (`verifierLifecycle.ts:126-146`) ha già `resolveCrossModelVerifier` + `familyCandidates` (P0.6, default cross-family quando ≥2 provider) **e input blind** (task+diff+testOutput, mai narration). Mancano la dimensione **risk** e i **two independent reviewers**.

Nota di allineamento: gli item P2 del round precedente (ownership, reputation) erano esplicitamente out-of-scope; il Piano di Lavoro li promuove a roadmap strutturata (Release C/D) — accettato, restando **dopo** P0/P1 misurati con `eval:gate` (sequenza invariata).

## Verifica claim-by-claim (evidenza)

| # | Claim | Esito | Evidenza |
|---|---|---|---|
| 1 | Project rule maschera deny globale | ✅ esatto | `policyEngine.ts:279-288` concatena `[...p.shell, ...g.shell]`, first-match-wins; docstring riga 15 ammette l'override; test `policyEngine.test.ts:163` lo codifica |
| 2 | Fail-open su JSON rotto | ✅ esatto | header riga 30: "a broken file NEVER throws — … ignored" |
| 3 | Shell matching su stringa | ✅ esatto | `matchAgentPolicyRule` → `resolvePolicyRule(rules.shell, args.command)`; glob prefisso `git push*` |
| 4 | Write matching solo `path`/`file_path` | ✅ esatto | `policyEngine.ts:203-210`: cerca solo `a['path']` / `a['file_path']` |
| 5 | Sandbox senza symlink confinement | ✅ esatto | `sandboxPath.ts:31-33`: "Symlink resolution is the caller's responsibility"; solo containment testuale |
| 6 | Verifica nativa Node/npm-centric | ✅ esatto | `nativeVerification.ts:63-90`: solo `package.json` → `npm run <script>`; droppa criteri senza script |
| 7 | Proof best-effort, non atomico | ✅ esatto | `completionProof.ts:220-231`: catch → `null`; `writeFile` diretto; nessun digest/commitSha (JSON=spine payload: già buono) |
| 8 | TaskContract thin wrapper | ✅ esatto | `taskContract.ts` (CLI) = 46 righe; core ha `goal/constraints/acceptanceCriteria` (+`verificationHint`) ma **non** ha `scope` né `risk` |
| 9 | `automatic` = no-op | ✅ ma superato da `orchestration/policy.ts` (v. sopra) |
| 10 | Verifier default = parent | ⚠️ parziale: cross-family già default nel reviewer advisory; manca risk-based |

## P0 — Authority & Confinement (policy engine v2)

### P0.A — Layered policy restrict-only 〔critica, breaking〕 (t14, §1)
- **File**: `src/cli/safety/policyEngine.ts`, `src/cli/toolRegistry.ts` (wiring via import riga 72, `mergeRuleEffect` nel choke-point `wrapWithPermissions`).
- **Modifica**: `PolicySet` → `LayeredPolicySet { global: Map<string,PolicyRuleSet>; project: Map<string,PolicyRuleSet>; warnings }`. Match **indipendente** per strato; effetto = `intersectEffects(deny > ask > allow)` tra strati, poi l'attuale `mergeRuleEffect` verso la category policy (già restrict-only, invariato).
- **Escape hatch**: `ZELARI_POLICY_PRECEDENCE=legacy` ripristina l'ordine attuale (documentato come insicuro).
- **Breaking**: default nuovo `restrict-only` → minor bump 2.13.0 + CHANGELOG + `docs/GUIDA.md`.
- **Test**: invertire il caso `policyEngine.test.ts:163` (project `allow` NON maschera global `deny`); legacy env → comportamento vecchio; interazione con capability inheritance (P0.4 predecessore).
- **〔PW〕 Criteri aggiuntivi**: una `ask` globale non può degradare ad `allow`; una policy di **agente può solo restringere** lo strato ereditato (test dedicato del tratto agent ⊂ inherited, oltre a global/project).

### P0.B — Strict policy load mode (t15, §2)
- **File**: `policyEngine.ts`, `runHeadless.ts`, TUI `useChatTurn.ts`.
- **Modifica**: `loadPolicySet(root, { mode: 'permissive' | 'strict' })` → in strict un parse error / file malformato solleva `PolicyLoadError` ⇒ turn **blocked** (headless exit 2, reason `policy-load-failed`). Default: `strict` in headless/mission/CI (`ZELARI_POLICY_MODE` override), `permissive` in TUI (warning + picker esistente).
- **Test**: broken JSON + strict → blocked; TUI → warning e run continua.
- **〔PW〕 Criteri aggiuntivi**: errore **machine-readable** (code `policy_invalid`, file, riga/parse detail nel payload spine); il Completion Proof **registra il blocco** (`BLOCKED` con reason `policy-load-failed` in evaluation, non solo log).

### P0.C — ResourceClaim v1 (due passi)
**C1 — claim multi-risorsa per write/edit (policy v2)** (t16, §3)
- **File**: nuovo `src/cli/safety/resourceClaims.ts` + `policyEngine.ts` + mapping nel `toolRegistry.ts`.
- **Modifica**: `type ResourceClaim = { kind:'path'; operation:'read'|'write'; path } | { kind:'process'; executable; argv } | { kind:'network'; host; port? } | { kind:'mcp'; server; tool } | { kind:'ssh'; target }`. Tabella centrale `resourceClaimsFor(toolName, args)` (v1 pragmatico: niente metodo per-tool; fallback euristica `path|file_path` attuale). Il matcher valuta **tutti** i claim (risolve `apply_diff`, MCP multi-risorsa).
- **Schema**: policy `version: 2` con `claims: { path?, process? }`; `version: 1` resta interpretato con la semantica attuale (compat replay).
- **〔PW〕 Criteri aggiuntivi**: claim kinds `ui`/`agent` previsti dall'unione tipi ma **v1.1** (non bloccanti per v1); criterio esplicito "un subagent non può ottenere capability non possedute dal parent" — già garantito da `intersectPermissionPolicy` (P0.4), aggiungere test di regressione che attraversa resource claims.

**C2 — `exec_process` strutturato + process claims** (t17, §4)
- **File**: nuovo `src/cli/tools/execProcess.ts` (1 tool per file, convenzione repo), factory in `src/cli/tools/`.
- **Modifica**: tool `exec_process({ program, args[], cwd? })` — capability bassa; policy `{ kind:'process', executable:'git', argv:['push',...] }` matcha su executable + prefisso argv. `bash` resta, classificato raw-shell: normalizzazione best-effort del prefisso (`env X=… cmd`, `command cmd`, spazi multipli) nel matcher — **documentata non esaustiva**, mitigata dall'esistenza di `exec_process`. Regola consigliata: structured exec → allow secondo policy; raw shell → ask/restricted.
- **Test**: `env FOO=x git push` matcha regola process `git push`; `bash -lc '…'` NON bypassa (raw-shell → ask di default se regole process esistono).
- **〔PW〕 Criteri aggiuntivi**: i comandi strutturati eseguiti entrano nel **Completion Proof** (sezione evidence: program+argv+exit code).

### P0.D — Symlink-safe sandbox centralizzato (t18, §5)
- **File**: `src/cli/safety/sandboxPath.ts` + wrapper unico nel `toolRegistry.ts` (garanzia data UNA volta, non per-tool).
- **Modifica**: pipeline `resolve → realpathSync(ancestor esistente più vicino) → containment su ENTRAMBI (testuale + reale) → open/write`. Per write: containment reale della parent dir pre-create; re-check post-write dove economico.
- **Test**: `workspace/link → /tmp`, write `link/file` ⇒ `SandboxViolationError`; parent-junction su Windows (skip-guard se symlink non permesso); regressione `../../` classico.
- **〔PW〕 Criteri aggiuntivi**: symlink **chain** (a→b→fuori); TOCTOU check→write dove tecnicamente testabile (re-check post-realpath); normalizzazione Windows path già coperta da test esistenti — aggiungere case-folding solo dove applicabile (case-insensitive FS), con skip-guard su FS case-sensitive.

## P1 — Verification generalizzata + proof + contract

### P1.A — VerificationAdapter multi-ecosistema (t19, §6)
- **File**: nuovo `src/cli/kraken/verificationAdapters/{types,node,python,rust,go}.ts` (≤300 LOC ciascuno, zero nuove dip).
- **Interfaccia**: `interface VerificationAdapter { id: string; detect(root): Promise<number>; buildPlan(root): Promise<Plan> }` con `Plan = { typecheck?: string; test?: string; build?: string }`.
- **Adapter v1**: Node (pm via `packageManager` + lockfile: npm/pnpm/yarn/bun), Python (`pyproject.toml`/`requirements.txt` → pytest; ruff/mypy se configurati), Rust (`Cargo.toml` → cargo check/test/clippy), Go (`go.mod` → go vet/test). Score massimo vince; env override esistente resta sopra tutti.
- **v1.1 (t24)**: Java (`gradlew` → `./gradlew test|build`; `pom.xml` → `mvn`) e .NET (`*.sln`/`*.csproj` → `dotnet build|test`).
- **Refactor**: `resolvePackCommands`/`readPackageScripts` delegano al registry adapter (API esportata mantenuta per compat test).
- **Test**: fixture tmpdir per detect/buildPlan di ogni adapter; nessun adapter ⇒ nessun criterio (fail-honest invariato).
- **〔PW〕 conferme**: check assente NON genera falso fallimento (già fail-honest); check presente e fallito blocca completion (strict gate); ogni verifica emette evidence strutturata (già spine VerificationResult).

### P1.B — Completion Proof transaction-grade (t20, §7)
- **File**: `completionProof.ts`, `verificationBridge.ts`, `runHeadless.ts`.
- **Modifica**:
  - write atomico: `tmp → fh.sync() → rename` (entrambi i file);
  - `proofPersistence: 'best-effort' | 'required'` — in strict/headless verified: PASS + proof non persistibile ⇒ **BLOCKED** (exit 4);
  - wrapper JSON v2: `{ kind:'completion-proof', version:2, evaluation: <spine payload verbatim>, attestation: { commitSha, diffDigest (sha256 `git diff HEAD`), taskContractDigest?, verificationPlanDigest?, harnessManifestDigest? } }` — digest via `node:crypto`.
- **Test**: fallimento rename/permessi in required ⇒ BLOCKED; attestation deterministica (no clock).
- **〔PW〕 Criteri aggiuntivi**: `harnessManifestDigest` = sha256 di manifest deterministico `{harnessVersion, adapters/pack, policyLayers}`; **proof validabile offline** (script `validate` o funzione esportata che riverifica i digest senza eseguire nulla) così il CI può richiederlo come condizione di successo.

### P1.C — TaskContract → compiler (policy + verification) (t22, §8)
- **Prerequisiti**: P0.A (strati), P1.A (plan), P1.B (digest).
- **Core** (`packages/core/src/session/taskContract.ts`, minor bump): `TaskContractSchema` + opzionali `scope?: { allowedPaths?: string[]; forbiddenPaths?: string[] }`, `risk?: 'low'|'medium'|'high'|'critical'` — backward-compatible col replay spine (campi assenti nei vecchi eventi).
- **CLI**: nuovo `src/cli/kraken/contractCompiler.ts`: `compileCapabilityRules(contract) → PolicyRuleSet` (strato **contract**: `allowedPaths` → allow + deny `**` sotto; `forbiddenPaths` → deny) e `compileVerificationPlan(contract) → { commands: string[] }` (criteri acceptance con `verificationHint.kind='command'` ⇒ comandi bound; euristica "tests pass" ⇒ adapter test).
- **Wiring**: strato contract entra nell'intersezione P0.A (non scavalcabile da project/global); verification plan si unisce ai criteri native pack; la CompletionPolicy deriva dal contract.
- **ADR nuovo**: aggiorna la decisione del piano precedente ("criteria pack = contratto") → "il contratto **compila** nel pack". Da registrare in `.zelari/decisions/` + `AGENTS.MD`.
- **Test**: `scope.allowedPaths=['src/auth/**']` ⇒ write fuori scope deny a tutti gli agent; criterio command ⇒ criterion nel pack; replay di eventi vecchi senza `scope` ok.
- **〔PW〕 conferme**: versioning del contract a ogni modifica e tracking degli steer **già esistenti** (`taskContract.ts` versione + steer events) — aggiungere test esplicito: modifica contract ⇒ versione+1 e digest aggiornato nel proof.

### P1.D — Risk-based verifier routing (t21, §10)
- **File**: `verifierLifecycle.ts`, `krakenModel.ts` (metadati famiglia/costo già presenti).
- **Modifica**: `resolveIdentity(..., risk)`: `low` → solo deterministico (reviewer off); `medium` → famiglia diversa più economica tra i candidates; `high` → famiglia diversa più forte (pricing/capability); `critical` → **dual review** (due run advisory indipendenti, merge pessimistico). Risk dal contract (P1.C) con fallback `'medium'`.
- **〔PW〕 conferme**: blind input già realtà (P0.6: task+diff+testOutput, mai reasoning del builder) — formalizzare il criterio nel test ("il verifier non riceve narrativa del builder"); reviewer failure non ignorato; **divergenze fra i due reviewer = evidence** nel proof (non solo merge pessimistico).
- **Test**: routing per risk con candidates finti; critical ⇒ due chiamate, verdict pessimistico; advisory lock invariato.

### P1.E — OrchestrationDecision v2 (auto-orchestrator vero) (t23, §9)
- **File**: estendere `src/cli/orchestration/policy.ts` (+ test), wiring headless + TUI kraken.
- **Modifica**: output `{ strategy: 'lead-only'|'explore'|'lead+verify'|'parallel-build'|'graph'|'council', confidence, estimatedCost, estimatedLatency, rationaleCode }`; input `{ contract(risk,scope), repoSize, changedFileEstimate, previousFailures(spine), budget }`. **Deterministica prima** (regole), LLM solo tie-break futuro. Mapping v1: `lead-only|explore → solo`; `lead+verify|parallel-build|graph → kraken` (+ injection della delegation policy corrispondente al posto del no-op `automatic`); `council → council-lite` (mission solo se giustificato da rationaleCode).
- **〔PW〕 Criteri aggiuntivi**: task piccolo ⇒ nessuna over-orchestrazione (test golden); la scelta viene **registrata nella telemetria** (evento spine `orchestration_decision` con strategy+confidence+rationaleCode).
- **Test**: tabella decisioni deterministica; fail-closed default invariato.

## P2/P3 — Backlog strutturato (dal Piano di Lavoro §11–§18)

> Confermato differimento DOPO Release B misurata con `eval:gate`. Ground truth verificata:
> - **Nessun** sistema reputation/ROI esiste (0 match `reputation|solveRate|solve_rate|spawnScore` su 341 file `src/cli`).
> - Infra parziale riutilizzabile: `src/cli/checkpoint/checkpointManager.ts` (checkpoint), `src/cli/kraken/krakenWorktree.ts` (isolamento worktree opt-in `ZELARI_KRAKEN_WORKTREE`), `src/cli/ast/` + `src/cli/lsp/` (ownership semantico), `tools/eval/` metriche (verifiedSolveRate, regression gate), `src/cli/provider/` pricing/model discovery.

- **P2.A — File ownership (t25)**: write scope per subagent (es. `src/frontend/**`); due agenti non possono scrivere contemporaneamente lo stesso scope senza arbitration. Base: `resourceClaimsFor` (P0.C1) + scheduler wave di `executor.ts` (oggi max 12 paralleli senza ownership).
- **P2.B — Semantic ownership (t26)**: ownership a livello di simbolo via AST/LSP (`AuthService.login()` vs `TokenService.refresh()` anche nello stesso file); conflitti rilevati prima del merge.
- **P2.C — Worktree scheduling automatico (t27)**: stima overlap dei path prima dello spawn → low overlap = worktree paralleli, high overlap = sequenziale. Estende `planner.ts` (DAG) + `krakenWorktree.ts`.
- **P2.D — Transactional agent execution (t28)**: per unità di lavoro `checkpoint → edit → diagnostics → verification → PASS: commit | FAIL: rollback`. Un subagent fallito non sporca il workspace; commit intermedi correlati al task. Estende `checkpointManager.ts` + strict gate.
- **P2.E — Model reputation + repo-specific routing (t29)**: metriche per model/provider/repo/lingua/ruolo (verified solve rate, first-pass, repair count, cost, latency, regression, review rejection). Router impara per-repo, non solo ranking globali.
- **P2.F — Orchestration ROI controller (t30)**: `spawnScore = expectedSuccessGain / (cost + latency + duplicationRisk)`; sotto soglia ⇒ do not spawn. Obiettivo: meno token/latenza a parità di verified solve rate.
- **P3.A — Benchmark competitivo riproducibile (t31)**: 50–100 task reali pinned (repo+commit, modelli/versioni, acceptance, timeout/budget identici) vs Codex/Claude Code/OpenCode. Metriche: VSR, first-pass VSR, regression rate, human interventions, repair iterations, wall time, token, costo, files changed, rollback rate, false-done rate. Riutilizza `eval/` anchor runner.

## Roadmap Release A–D (dal Piano di Lavoro, riconciliata)

| Release | Target | Task | Exit criteria |
|---|---|---|---|
| **A — Safety Hardening** | 2.13.0 | t14, t15, t16, t17, t18 | Nessun privilege escalation fra global/project/agent/parent; tutte le write passano da resource policy; security regression suite verde |
| **B — Universal Verification** | 2.14.x | t19, t20, t22 (+t24 per exit completa) | Adapter node/python/rust/go (v1) + java/.NET (v1.1); proof verificabile offline; nessun BUILD dichiara completo senza evidence |
| **C — Adaptive Harness** | 2.15.x | t21, t23, t25, t28 | Niente over-orchestrazione su task semplici; parallelismo quando utile; failure di un agente non contamina gli altri |
| **D — Self-Optimizing** | post | t26, t27, t29, t30, t31 | Scelta modello/orchestrazione giustificata automaticamente; VSR non peggiora riducendo costo/latenza; benchmark competitivi riproducibili |

## KPI target (dal Piano di Lavoro) e misurazione

| KPI | Target | Come si misura |
|---|---:|---|
| Verified Solve Rate | > 95% | `eval:gate` — `verifiedSolveRate` già in regressionGate (t13) |
| False-Done Rate | < 0.5% | proof + strict gate (misurabile da Release B; anchor strict già in `eval/anchors/verification/`) |
| Security policy bypass | 0 | security regression suite (exit criterion Release A) |
| First-pass solve rate | ↑ release su release | metriche eval, confronto baseline |
| Human interventions | −30% vs baseline | richiede baseline da raccogliere (spine + P3.A) |
| Token cost per verified solve | −20% vs baseline | `src/cli/budget/` + metriche eval |
| Repair iterations | < 1.5 media | eventi repair nella spine |
| Proof persistence (required) | 100% | test t20 |
| Regression detection | > 99% | `eval:gate` regression gate |

## Sequenza & dipendenze
```
P0.A → P0.B            (semantica policy — primo sprint, breaking minor 2.13.0)
P0.D                   (indipendente)
P0.C1 → P0.C2          (claims; C2 dopo C1)
P1.A (+t24 v1.1)       (indipendente)
P1.B + P1.D            (proof + risk verifier)
P1.C                   (richiede P0.A + P1.A + P1.B; ADR)
P1.E                   (richiede P1.C per risk/scope)
--- Release C/D (P2/P3) solo dopo eval:gate con delta misurato di A/B ---
```
Ogni sprint: `npm run typecheck` + `npm test` suite mirata + `npm run verify:principles`; merge misurato `npm run eval:gate -- --baseline <hash> --candidate <hash>`.

## Rischi
- **Breaking default policy + formato proof v2** → opt-out documentati (`ZELARI_POLICY_PRECEDENCE=legacy`), CHANGELOG, GUIDA, MIGRATION.
- **Test symlink su Windows** richiedono dev-mode/admin → skip-guard dinamico.
- **`exec_process` adozione dai modelli** → aggiornare tool catalog dei prompt (core agents) gradualmente; bash resta per compat.
- **Zero nuove dip** (P5): parsing shell minimo hand-rolled; digest `node:crypto`; nessun SDK adapter.
- **Agente figlio più restrittivo del necessario** con contract layer → rationaleCode nel deny message (debuggabilità).
- **Release B exit include Java/.NET** → suddiviso t19 (v1) / t24 (v1.1) per non ritardare la ship; exit completa solo con t24.
- **KPI "human interventions" senza baseline** → raccogliere baseline dal primo run Release B prima di dichiarare −30%.
