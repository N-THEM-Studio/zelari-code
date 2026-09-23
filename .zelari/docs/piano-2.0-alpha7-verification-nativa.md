# Piano 2.0 — da alpha.6 a RC (Verification 2.0 nativa)

**Baseline:** `v2.0.0-alpha.6` (HEAD `7db4f53`, branch `main`).  
**Fonte requisiti:** `Zelari_2.0_Alpha6_Stato_e_Cosa_Manca.md` (verificato veritiero — vedi `verifica-zelari-2.0-alpha6-vs-codice-e-piano.md`).  
**Regola guida (documento §20):** nessuna nuova capacità finché il circuito `evidence → completion` non è nativo, testato e tracciabile end-to-end.

Verifica locale after ogni fase: `npm run typecheck` e `npm run test` (subset mirati con `npm run test:session`). Commit atomici single-task come da convenzioni AGENTS.MD.

---

## Alpha.7 — Exit-2: Verification 2.0 nativa

### F1 — Exit-2.3: VerifierService runtime wiring + lock test (P1 massimo) — ✅ COMPLETATO

> **Stato:** completato nella sessione del 19/08. Lock test `src/cli/kraken/verifierAdvisoryLock.test.ts` (3 test: Caso 1a unknown+CONFIRMED→BLOCKED/exit 4; Caso 1b fail+CONFIRMED→REPAIR_REQUIRED + downgrade a unknown; Caso 2 PASS+REJECTED→PASS intatto/exit 0, reiezione registrata advisory nella spine). Verifica: 266/266 test verdi su `src/cli/kraken` + `packages/core/src/verification`, `tsc --noEmit` exit 0. Nota semantica emersa: con criterio `fail` la policy produce `REPAIR_REQUIRED` (non `BLOCKED`) — entrambi ≠ PASS → exit 4, la proprietà "no clean success" del documento §3 resta garantita.

**Gap:** nessun test end-to-end dimostra che CompletionPolicy resta autorità finale con verifier LLM attivo.

**File coinvolti:**
- `packages/core/src/verification/verifier.ts` (VerifierService, `inherit|fixed`, `effectiveModel`)
- `packages/core/src/verification/completionPolicy.ts` (`evaluateCompletion`, `STRICT_BUILD_POLICY`)
- `src/cli/kraken/verifier.ts` + `src/cli/kraken/verificationBridge.ts` (wiring lifecycle)
- `src/cli/kraken/verifier.test.ts`, `src/cli/kraken/verificationBridge.session.test.ts` (estensione)

**Nuovo test lock — `src/cli/kraken/verifierAdvisoryLock.test.ts`:**
- Caso 1: criterio deterministico `unknown|fail` + verifier `confirmed` → `evaluateCompletion` = `BLOCKED`; strict mode → nessun clean success (exit ≠ 0).
- Caso 2: criteri deterministici `pass` + verifier `rejected` → verdict deterministico NON riscritto; review LLM esposta come advisory/risk; al più `attention required`, mai falsificazione.

**Acceptance:** i due casi del documento §3 passano; `npm run test:session` verde; comportamento fissato anche a livello core (unit su `evaluateCompletion` + risultato verifier in input).

### F2 — Exit-2.4: criteria pack nativo nel path Kraken

**Gap:** il bridge dipende ancora da `kraken-selection` + verify tentacle report (`CriterionSource` include `'kraken-selection'`/`'verify-agent'`, `verification/types.ts:11-17`).

**File coinvolti:**
- `src/cli/kraken/verificationBridge.ts` (da report-parsing a costruzione Criteria nativa)
- `packages/core/src/verification/criteriaPack.v1.ts` (`codingCriteriaPack`)
- `src/cli/kraken/turnRuntime.ts` (invocazione engine nel ciclo turn)

**Azioni:** costruire i `Criterion[]` da task acceptance + `codingCriteriaPack()`; eseguire `VerificationEngine.evaluate()` direttamente nel turn Kraken; il verify tentacle resta solo come fonte *addizionale* di note, non come strutturante.

**Acceptance:** nuovo test bridge che asserisce `source: 'criteria-pack'` e che il flusso funziona senza report del tentacle; il vecchio percorso marcato deprecated nel codice.

> **✅ F2 COMPLETATO (verificato).** Implementazione reale:
> - `src/cli/kraken/nativeVerification.ts` (nuovo): `evaluateNativePack()` esegue il pack via core `VerificationEngine` + `NodeShellProvider`; binding adattivo ai veri script npm (`resolvePackCommands`), override env (`ZELARI_VERIFY_TYPECHECK_CMD`/`_TEST_CMD`/`_BUILD_CMD`/`_TIMEOUT_MS`), drop dei criterion required senza comando bound. Pack **opt-in** alpha: `ZELARI_VERIFY_PACK=1` (specchia `ZELARI_STRICT_DONE`).
> - `src/cli/kraken/verificationBridge.ts`: `evaluateStrictBuildGate()` ora è async e fonde i risultati del pack nella STESSA `evaluateCompletion` (blockers add up); `strictGateEventPayload()` registra la sezione `native` (packId, criterion, status, tier, digest sha256) nella spine; engine id `kraken-legacy+completion-policy+criteria-pack`.
> - `packages/core/src/verification/criteriaPack.v1.ts`: fix bug `null ?? default` — ora `null` disabilita davvero il check (come da docstring), `undefined` usa il default.
> - Call-site aggiornati ad `await`: `src/cli/runHeadless.ts` (2×), `src/cli/hooks/useChatTurn.ts` (3×).
> - Test: `src/cli/kraken/nativeVerification.test.ts` (11 test, shell stub) — lock: typecheck fallito → REPAIR_REQUIRED anche con selection tutta pass con note; timeout → unknown ≠ pass (BLOCKED); pack off → identico al legacy. Verifica: 282/282 pass (24 file) + `tsc --noEmit` exit 0.
> - Nota rispetto all'acceptance originale: `source: 'criteria-pack'` arriva dai criterion del pack nel payload `native`; il flusso senza verify-report è coperto dal test "failing typecheck forces REPAIR_REQUIRED…" (il pack blocca indipendentemente dal tentacle). Il path legacy resta attivo in parallelo come da regola di composizione.

### F3 — EvidenceRef event-backed ✅ (completato) (P1 pre-stable)

**Gap:** `EvidenceRef.seq` è opzionale e `ref` è free-text (`verification/types.ts:80-92`) → note dell'agente promosse a pseudo-evidence tier `tool-output`.

**File coinvolti:**
- `packages/core/src/verification/types.ts` (schema: `seq` obbligatoria per tier `tool-output|command-output|fs-observation`; note confinate in campo separato, es. `note`)
- `src/cli/kraken/verificationBridge.ts` (write-side: popolare `seq`/`digest` dall'evento sessione reale)
- `packages/core/src/verification/sessionEvidence.ts` (read-side: già ricostruisce dalla spine — verificare copertura evidence)

**Nota schema:** il documento propone `eventSeq`; lo schema attuale usa già `seq`+`digest` — si **rafforza** la cardinalità invece di rinominare (breaking change non necessario; decidere in ADR se comunque allineare i nomi).

**Acceptance:** test che ogni `VerificationResult.evidence[]` con tier deterministico ha `seq > 0` puntante a un evento esistente del log e `digest` sha256 presente; le note del verify agent non compaiono più come `ref` di tier `tool-output`.

### F4 (COMPLETATO) — Exit-2.5: mission progress advisory

**File coinvolti:**
- `packages/core/src/mission/missionState.ts` (stato mission)
- `packages/core/src/verification/verifier.ts` (`progressScore` — già testato: deterministic/blended sperimental)
- consumer mission nel CLI (lifecycle mission)

**Regole (documento §6):** nessun goal rewrite silenzioso; nessun done da score; nessun early-stop con required criteria incompleti; steer utente sovrano.

**Acceptance:** test che il progress influenza solo advisory/continuation, mai il verdict; mission interrompibile/riprendibile (spine resume già disponibile E1.4).

### F5 — Strict Done default (decisione di prodotto da congelare) — ✅ COMPLETATO (ADR-0025)

**Implementazione (2026-08-20):** `docs/decisions/0025-strict-done-defaults.md` + indice README; `strictDoneEnabled(surface)` + `options.surface` in `verificationBridge.ts`; wind-down mission in `runHeadless.ts` (gate strict default ON → `mission-strict-blocked` + exit 4); flag `--no-strict-done` e help in `headless.ts`; 7 lock test in `src/cli/kraken/strictDefaults.test.ts`. Verifica: 2886/2886 test + typecheck exit 0.  nota RC: rivalutare default Kraken dopo Exit-3.2; `requireEventBackedEvidence` ON nel `STRICT_BUILD_POLICY`.
**Output:** ADR in `.zelari/decisions/` + applicazione del default per profile (`packages/core/src/runtime/profiles.ts`). Nessuna nuova implementazione: solo policy default + ADR.

---

## Alpha.8 / Beta — Exit-3: surface, docs, portability

| # | Item | File/luogo | Note |
|---|---|---|---|
| F6 ✅ | Desktop verifier round-trip smoke (Exit-3.1) | **Fatto (2.0.0-alpha.7):** `src/cli/kraken/verifierResolution.ts` (ponte override→`ModelSelection`, unico seam) + `src/cli/kraken/verifierRoundTrip.test.ts` (4 test: inherit/dedicated/reset via canale reale `applySetConfig` → fresh disk read → resolution → evento spine `verification.run` con modello effettivo; + unit mapper) | Casi §9 coperti: Primary=A/inherit→A, dedicated B→B, reset→A; snapshot UI (`buildDesktopConfigSnapshot().krakenVerifier`) verificata in ogni caso |
| F7 ✅ | Profile smoke matrix (Exit-3.2) | **Fatto (2.0.0-alpha.7):** `src/cli/profileMatrix.test.ts` (9 test) | Matrice §10 completa (minimal/kraken/council/mission × plan/build) su 3 gambe: loader (`resolveHeadlessProfileId`, explicit wins) · spine metadata (`session.started` con `profile`+`toolManifestHash` del set dichiarato ADR-0022) · registry reale di fase (plan: `PLAN_BLOCKED_TOOLS` strippati + plan-domain tools; build: mutatori + declared ⊆ registry). Invarianti wiring source-level: kraken/council `planModeFromOpts(opts)`, mission slice `planMode: false`, PLAN_BLOCKED set bloccato. Nota design: profilo 2.0 = manifest dichiarativo (upper bound), phase = restrizione runtime |
| F8 ✅ | GUIDA 2.0 (Exit-3.3) | **Fatto (2.0.0-alpha.7):** `docs/GUIDA.md` +155 righe, 3 sezioni nuove (Host/Profile/Phase ADR-0022 · Session spine 2.0 canonica con resume/export/fork + legacy mirror ADR-0024 · Verifica deterministica/Strict Done/Verifier LLM ADR-0023/0025) | Ground truth dai flag reali (`--profile`, `--resume`, `--export-session`, `--strict-done`/`--no-strict-done`, exit 4); fork documentato come API core (non flag CLI); verifier LLM onesto sul wiring residuo; "Sessioni e branch" marcata legacy 1.x con pointer alla spine; indice 17a/b/c + tabella flags + exit code 4 + sottosezione env (`ZELARI_STRICT_DONE`/`ZELARI_MISSION_STRICT`/`ZELARI_VERIFY_PACK`/`ZELARI_SESSIONS_DIR`); verify-versions verde |
| F9 ✅ | MIGRATION 2.0 (Exit-3.4) | **Fatto (2.0.0-alpha.7, commit `e5b981b`):** `MIGRATION.md` +144/−21 (173→296 righe), header `1.34.x`→`2.0.0-alpha.7` | Paradigma §12 before/after in codice reale (1.x consumer possiede `messages`; 2.0 append→`store.open`→`deriveMessages`→`derivedToAgentMessages`); resume/fork/lineage (`resumeSession`, `forkSession` API core senza flag CLI); profile metadata + distinzione F7; verification contract (tier, EvidenceRef event-backed, ADR-0025, exit 4); mission advisory; legacy mirror rimosso a rc; breaking changes alpha; verify-versions verde |
| F10 ✅ | CI multi-OS (Exit-3.5) | **Fatto (2.0.0-alpha.7):** `.github/workflows/ci.yml` riscritta (844 B → 2.5 KB) | Job `verify` full-suite invariato (Ubuntu+Node24) + nuovo job `smoke` matrix 3 OS (ubuntu/windows/macos) × Node 20/24 (engines >=20, vitest >=20 ok): build core → vitest session+runtime+verification+mission+spine CLI → `tsc`+bundle+`bin --version`. Gamba Windows verificata localmente (18 file/131 test + bundle `v2.0.0-alpha.7`); YAML validato js-yaml; Desktop build smoke già coperto da `release-desktop.yml` (3 OS su tag) |
| F11 | Headless e2e smoke (Exit-3.6) | `src/cli/runHeadless.ts` + nuovo test e2e | run→session_started→resume→secondo turno→export→replay fresh reader→stessa traiettoria; Kraken+Council (+Mission se possibile)  ✅ **Fatto (2.0.0-alpha.7):** `src/cli/headlessE2eSession.test.ts` — `runHeadless` reale (unica seam mockata: `resolveStream.js`, provider deterministico echo) per Kraken e Council: session_started NDJSON → id stabile → resume stesso log (`session.resumed`, seq monotonic) → export `zelari-session-export/1` → replay fresh reader → `deriveMessages` identica su log/replay/export. Mission escluso dallo smoke (loop completo con goal+gate: costo/ambito — dedicato a Exit-3 successiva). |
| F12 ✅ | Dependency triage (Exit-3 §15) | **Fatto (2.0.0-alpha.7):** `npm audit fix` non-forzato + `docs/security/dependency-triage-2.0.0-alpha.7.md` (fotografia firmata) | BEFORE 3 high tutti dev-only (`nanoid`/`postcss` via vitest→vite, `undici` via jsdom), runtime deps del pacchetto pulite, nessuno dei tre nel bundle (bundle-cli.mjs esternalizza solo react/ink/ws/ts/playwright). Fix semver-compatibili: nanoid 3.3.18, postcss 8.5.26, undici 7.29.0 → **0 vulnerabilities**. Finding di processo chiuso: node_modules stale (vitest 2.1.9 installato vs ^4.1.9 dichiarato) nascondeva 52 file `tests/unit/` ai run locali; post-resync suite verificata su vitest 4.1.9: **341 file / 3451 test pass** + 2 fix timeout cold-start (`cli-toolDisplay` 30s, `headlessE2eSession` kraken 90s — in isolamento ~11s) + tsc exit 0 |
| F13 | Cleanup | ✅ Fatto (2.0.0-alpha.8): `history_snapshot` marcato COMPAT MIRROR (ADR-0024) ai 4 emit-site + commento a 966; 3/5 `@ts-nocheck` rimossi (chatState/eventsToMessages/useSession, con fix tipo reale); bridge 0 commenti duplicati; 2 `@ts-nocheck` TUI 1.x restano come debito documentato negli header | Commit `ab65419` |

---

## RC.1 — gate di uscita (checklist dal documento §19)

Partire solo a circuito completo: `AcceptanceCriteria → deterministic checks → EvidenceRef event-backed → CompletionPolicy → optional verifier → logged verdict → host/mission consume verdict`. Poi solo bug/regressioni/portability/docs/security/migration. La checklist §19 del documento è la definizione di done per la RC — copiarla come gate di release e spuntarla item per item.

---

## Ordine di esecuzione consigliato (prossimo turno)

1. **F1 lock test** (Caso 1 + Caso 2) — slice sottile, alto valore, zero rischio architetturale.
2. F2 criteria pack nativo.
3. F3 EvidenceRef obbligatorio.
4. F4 mission progress.
5. F5 ADR strict default.
Poi F6–F13 in parallelo dove possibile.
