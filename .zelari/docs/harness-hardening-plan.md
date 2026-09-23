# Piano — Harness Hardening 2.x

> Baseline: `zelari-code@2.11.0` su `main`. Fonte: esplorazione diretta del source tree (4 report paralleli + spot-check). Non benchmark esterni.

## Verdetto

**Vale la pena, ma con scope chirurgico.** Il finding chiave: il contratto di verifica (ADR 0023) è **completo e testato ma di default non gira**; i permessi sono per categoria ma **senza ereditarietà** nei subagent; l'orchestrazione è matura ma **non adattiva**. Il massimo leverage non è aggiungere sottosistemi: è flip di default + wiring + un renderer. Coerente con la diagnosi "più architettura che affidabilità operativa".

## Cosa esiste già (verificato, file:line)

| Subsystem | Stato | Prova |
|---|---|---|
| Contratto verifica (Criterion/EvidenceRef/CompletionPolicy) | ✅ completo + 7 file test | `packages/core/src/verification/{types,engine,completionPolicy,criteriaPack.v1,sessionEvidence,metrics,verifier}.ts` |
| Strict gate hard (exit 4) + 1 repair pass | ✅ wired ma **opt-in** | `src/cli/kraken/verificationBridge.ts:49` (`ZELARI_STRICT_DONE=1`), `runHeadless.ts:1004`, TUI `useChatTurn.ts:868-901` |
| Criteria pack v1 (typecheck/test/build) | ✅ ma **opt-in alpha** | `src/cli/kraken/nativeVerification.ts:49` (`ZELARI_VERIFY_PACK=1`) |
| Permessi per categoria (allow/ask/deny + session grants + picker TUI) | ✅ | `src/cli/safety/toolPermissions.ts:111` `resolveToolPermission`, choke point `toolRegistry.ts:746` `wrapWithPermissions` |
| Toolset restriction per tentacolo (explore RO, verify no-mutators) | ✅ a livello registry | `toolRegistry.ts:278-285`, `taskAgentToProfile:690` |
| Worktree per writer + auto-merge | ✅ reale e testato | `src/cli/tools/krakenWorktree.ts`, `tests/unit/cli-taskTool-worktree.test.ts` |
| DAG executor + serializzazione writer per scope disgiunti | ✅ | `src/cli/kraken/executor.ts:579+`, `packages/core/src/kraken/conflict.ts:134` |
| Council lite (3) / ridotto (2, `skipSpecialists`) / memberSwap / per-member model | ✅ | `councilConfig.ts:21`, `councilApi.ts:642`, `roles.ts:256` |
| Failover cross-provider (single fallback) | ✅ | `crossProviderFailover.ts:85`, `providerFailover.ts:46`, wired `useChatTurn.ts:395` |
| Model per tentacolo/persona via env | ✅ | `src/cli/tools/krakenModel.ts:82-176` |
| Eval gate con anchor, retention, regressione union | ✅ | `tools/eval/{runGate,regressionGate,retentionPolicy}.ts`, 15 anchor in `eval/anchors/` |
| Seam core (Workspace/Fs/Shell/SubagentProvider + ExecutionContext) | ⚠️ implementati, **0 call-site CLI** | `packages/core/src/runtime/` (doppio binario ADR 0022, fase 2.9 pendente) |

## Gap verificati

1. **Kraken BUILD di default chiude senza un check deterministico**: strict OFF + pack OFF ⇒ solo legacy gate narrativo (`verificationBridge.ts:49`, `nativeVerification.ts:49`).
2. **Nessun artifact Completion Proof**: solo spine event + one-liner stderr (`runHeadless.ts:1006`).
3. **Subagent policy senza ereditarietà**: `createKrakenSubAgentContextFactory` crea `defaultPermissionPolicy({auto:true})` fresh — il figlio può eccedere il padre (`toolRegistry.ts:733`).
4. **Headless allow-all hardcoded** (`runHeadless.ts:546-553`).
5. **Nessuna policy per-comando/per-path**: solo blocklist shell hardcoded (`safety/shellBlocklist.ts:33`).
6. **Verifier advisory sotto-alimentato**: vede un summary sintetico + status; non vede diff né output test. (Blind al reasoning del builder — bene — ma cieco anche al lavoro.)
7. **Nessun dispatch adattivo**: mode solo esplicita; council full = 6 chiamate LLM anche per task banali.
8. **Eval gate senza soglia verification**: `verified` esiste in `AnchorRunRecord` ma `retentionPolicy` non lo consuma.

---

## P0 — "Done means verified" di default + capability policy

### P0.1 — Strict done gate ON di default (surface kraken)
- **Cambia**: `strictDoneEnabled('kraken')` → default `true`, opt-out `ZELARI_STRICT_DONE=0` (`verificationBridge.ts:49-58`). Mission resta ON.
- **Nota**: ADR-0025 fissò l'opt-in per compat 1.x — cambiare default è decisione deliberata (breaking): bump minor + nota CHANGELOG.
- **Test**: aggiornare `strictDefaults.test.ts`; nuovi case: default kraken ⇒ gate attivo; opt-out ⇒ comportamento 1.x.

### P0.2 — Native pack ON di default (auto-binding)
- **Cambia**: `nativePackEnabled` → default `true`, opt-out `ZELARI_VERIFY_PACK=0` (`nativeVerification.ts:49`). `resolvePackCommands` già droppa i criteri senza script ⇒ i repo senza `typecheck`/`test` non pagano costi né falsi BLOCKED.
- **Test**: `strictGatePackIndependence.test.ts`, `nativeVerification.test.ts` con default flipped; case repo-senza-script = nessun criterion aggiunto.

### P0.3 — Completion Proof artifact
- **Nuovo**: `src/cli/kraken/completionProof.ts` — `renderCompletionProof(evaluation)` → `{markdown, json}` (json = `strictGateEventPayload` già pronto) + `writeCompletionProof` → `.zelari/completion-proof.{md,json}`.
- **Hook**: `runHeadless.ts:961` (post gate), `:997` (post repair), `:1757` (mission), `useChatTurn.ts:870` (TUI).
- **Markdown**: verdict + tabella per-criterion (id, required, status, evidence tier, seq anchor, digest) + sezione pack + verifier advisory + pointer allo spine.
- **Test**: `completionProof.test.ts` — PASS / REPAIR_REQUIRED / BLOCKED-no-evidence / BLOCKED-exhausted / PASS-con-advisory-REJECTED.

### P0.4 — Capability inheritance nei tentacoli
- **Cambia**: thread della `permissionPolicy` del parent dentro `createKrakenSubAgentContextFactory` (`toolRegistry.ts:697-742`) + nuova `intersectPermissionPolicy(parent, agent)` in `safety/toolPermissions.ts`. Regola: **deny > ask > allow**; il figlio non può mai superare il padre.
- **Test**: parent `write: ask` ⇒ general riceve `ask`; parent `execute: deny` ⇒ verify (che ha bash) non esegue; parent liberale ⇒ policy dell'agente invariata.

### P0.5 — Policy engine v1 (per-comando / per-path per agente)
- **Nuovo**: schema `.zelari/policy.json` (project, gated da folder trust) + `~/.zelari-code/policy.json` — regole ordinate `{agent?, category|tool, glob (comando o path), effect}`; stile `git push* → deny`, `npm test* → allow`.
- **Enforcement**: `PolicyEngine.resolve(tool, args, agentCtx)` chiamato dentro `wrapWithPermissions`; command glob in `wrapWithShellSafety`, path glob in `wrapWithSandbox`. Headless: `ask` → fail-closed (deny) salvo `--yolo`.
- **Scope v1**: solo shell-command glob + write-path glob per ruolo (lead/explore/general/verify). Niente network policy.
- **Test**: precedenza deny>ask>allow; interazione con P0.4 (intersezione); headless fail-closed.

### P0.6 — Blind verifier v2 (sostanza senza narration)
- **Cambia**: input del `VerifierService` esteso a `{task, diffSummary, testOutputExcerpt, deterministicResults}` — **mai** reasoning/spiegazione del builder (proprietà da preservare esplicitamente). Build dell'input in `verifierLifecycle.ts` dal session spine + git diff.
- **Cross-model di default**: se `ZELARI_KRAKEN_VERIFY_MODEL` unset e ci sono ≥2 provider con chiave, scegli famiglia diversa dal builder (estendere `krakenModel.ts` con `pickDifferentFamily`).
- **Invariato**: advisory lock (mai flip del verdict deterministico) — già testato in `verifierAdvisoryLock.test.ts`.
- **Test**: l'input NON contiene narration; default cross-model; lock cases.

## P1 — Orchestrazione adattiva + misura

### P1.1 — `--mode auto` (chooseOrchestration)
- **Nuovo**: `src/cli/orchestration/policy.ts` — `chooseOrchestration(task, signals)` pura: riusa `classifyMission`, `resolveCouncilRunMode`, `extractTaskScope`, presenza `.zelari/plan.json`, lunghezza prompt. Output `{mode, profile, councilSize, skipSpecialists}`.
- **Regole v1**: banale → kraken single; medio → kraken+verify; complesso/multi-area → council lite (o DAG se graph mode). Wiring: dispatcher `runHeadless.ts:196` + `headless.ts:183`.
- **Opt-in**: `--mode auto` o `ZELARI_MODE=auto` (mai default silently).

### P1.2 — Eval gate: soglia verifica
- **Cambia**: `retentionPolicy.ts` + `minVerificationGatePassRate` opzionale; `regressionGate.ts` calcola `verifiedSolveRate` dai record `verified`; colonna nel report + reason line.
- **Nuovi anchor**: 2 in `eval/anchors/verification/` — caso "test che fallisce ⇒ exit 4" e caso "evidence mancante ⇒ BLOCKED".

## P2 — solo dopo P0/P1 misurati con `eval:gate`
- `ModelRouter.choose` capability-based (`capabilities.ts` + `modelDiscovery.ts`, wiring in `krakenModel.ts`).
- Network policy nel policy engine.
- Council dinamico per dominio via `memberSwap` esistente (security/frontend/db).
- Auto-bisect regressioni sulle missioni (checkpoint + git diff).

## Out of scope (esplicito)
Semantic locking, agent reputation/bandit, orchestration ROI controller, worktree scheduling intelligente (la base esiste già), espansione MCP server, nuovi membri Council.

## Sequenza e dipendenze
`P0.1 → P0.2` (default del gate) `→ P0.3` (proof) `→ P0.4 → P0.5`; `P0.6` parallelo. P1 dopo P0. Ogni merge misurato: `npm run eval:gate -- --baseline <hash> --candidate <hash>`.

## Rischi
- **Flip default strict = breaking** → opt-out documentato + CHANGELOG + bump minor.
- **Pack ON = costo/latenza per build turn** → auto-unbind script assenti, timeout esistenti, singolo repair pass.
- **Policy engine fail-open/fail-closed** → v1 fail-closed in headless, TUI col picker esistente.

## Collegamento all'analisi esterna
Delle ~20 proposte della scorecard: 6 entrano in P0/P1 (policy engine, inheritance, blind verifier, verification-as-primitive, adaptive orchestration, proof-of-work). Il resto (reputation, bandit, ROI, semantic locking) resta out: ricreerebbe l'over-architettura che la stessa analisi diagnostica. TaskContract non serve come nuovo schema: **criteria pack v1 già è il contratto** — va solo acceso di default.
