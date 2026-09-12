# Piano — "Ruba Cursor Projects": slice A+C, roadmap B/D/E, UI desktop lead-chat

> Data: 2026-09-12 · Branch: `main` (ff317c8) · Fonti: [Cursor Projects](https://cursor.com/blog/projects),
> `HANDOFF-experimental-cursor-learn.md`, grounding su disco (esplorazioni 2026-09-12).
> Nota branch: le basi della Fase 1 (opsKnowledge/repeatFailure/promotion + test) sono **già su `main`**;
> `experimental/cursor-learn` (7c27b20) esiste in locale ma non è il checkout. A+C atterrano direttamente su `main`.
> Tutto il percorso di write resta opt-in dietro `ZELARI_PROMOTE_OPS_KNOWLEDGE` (default OFF).

---

## Slice A — "seconda battuta identica → proposta WorldCheck" (loop lint-rule)

**Obiettivo.** Chiudere il cerchio descritto nell'articolo (*"adds a lint rule whenever it sees the same mistake twice"*):
al 2° fallimento identico oggi nasce un vincolo-candidato; manca la proposta di **check verificabile** in
`.zelari/world/checks.json`, applicabile solo con conferma umana.

**Stato oggi (grounding):**
- fingerprint `failureFingerprint` → `src/cli/memory/repeatFailure.ts:31-36` (`sha256(cmd\0exit\0digest)[:24]`, pure functions)
- 2° fallimento → constraint candidate `con-<fp>` → `src/cli/memory/opsKnowledge.ts:230-262`
- ⚠️ il return con le proposals è **scartato** in `src/cli/headless/runOneTurn.ts:164` e `src/cli/hooks/useChatTurn.ts:940` → l'utente non vede mai la proposta
- `/memory promote` (`src/cli/slashHandlers/memory.ts:196-205`) scrive **solo** AGENTS.md (`src/cli/memory/promotion.ts:41`)
- `checks.json`: unico I/O prodotto in `src/cli/workspace/worldModel.ts`; `setWorldChecksTool` (L288-314) fa **replace integrale** del file → non riutilizzarlo per append (rischio wipe)
- gate: `isWorldModelGateEnabled` (`src/cli/executor.ts:302-313`) abilita lo schema-loop gate alla sola **esistenza** di `checks.json` → non creare il file per errore

**Passi:**
1. `src/cli/memory/repeatCheck.ts` (nuovo, pure functions): `proposalFromConstraint(constraint) → CheckProposal`
   `{fp, command, exit, digest, suggestedCheck}`. Il check suggerito **non** è rilanciare il comando fallito:
   template da confermare (`expectExit: 0`, command da riempire o derivato dalla procedure di fix presente in memory
   per lo stesso digest, se c'è).
2. `src/cli/workspace/worldModel.ts`: nuovo `appendWorldCheck(check)` — read-modify-write con dedup per `id`
   (merge, mai replace). Test merge in `tests/unit/cli-worldModel.test.ts`.
3. Conferma umana: estendere `/memory promote con-<fp>` con `--as-check` (o nuovo slash `/world check add`) che
   legge la proposta, accetta `command`+`expectExit`, chiama `appendWorldCheck`. Generazione flag-gated;
   **applicazione a checks.json sempre esplicita**.
4. Wiring: consumare il return in `runOneTurn.ts:164` e `useChatTurn.ts:940` (oggi scartato) → notice nel turn
   summary, stesso formato di `formatPromoteNotice` (`src/cli/memory/promotion.ts:25-27`).
5. La proposta vive come memory candidate finché l'umano non conferma: `checks.json` e il gate Kraken restano intatti.

**Test:** estendere `src/cli/memory/opsKnowledge.test.ts` (2° fingerprint, L349-365 → ora produce anche proposal);
nuovi `repeatCheck.test.ts`, caso append+dedup in `tests/unit/cli-worldModel.test.ts`; `promotion.test.ts` per `--as-check`.

**Acceptance:**
- [ ] 2 fallimenti identici → proposal esiste; `checks.json` NON toccato
- [ ] conferma umana → check appended con dedup id, file mai wiped
- [ ] flag OFF → nessuna write
- [ ] vitest verde sui file elencati

---

## Slice C — playbook condiviso `.zelari/how-we-test.md`

**Obiettivo.** Il "shared context" dell'articolo (*"if one agent figures out how to test a service, every future
agent uses it"*): proiettare le procedure verificate in markdown leggibile da umani e agenti.
Handoff 1.4 (`HANDOFF-experimental-cursor-learn.md:39-45`) lo teneva fuori v1: qui lo eseguiamo.

**Stato oggi:** `rememberProcedure` (`opsKnowledge.ts:124-163`) salva in SQLite `.zelari/memory/memory.db`
(`kind:'procedure'`, `metadata.verified:true`, dedup `opsKnowledgeKey` L70). Nessuna proiezione markdown esiste.

**Passi:**
1. `src/cli/memory/howWeTest.ts`: query `kind==='procedure' && metadata.verified` → `projectHowWeTest(rows) → md`
   (sezioni per `criterionId`, comando, digest corto, ultima osservazione, header "generato — non editare").
2. Trigger: (a) slash `/memory how-we-test` (rigenera), (b) auto-dopo `promoteOpsKnowledge` quando `created>0`
   (L294-303, stesso flag opt-in). Scrittura atomica (tmp+rename).
3. Fase gardener `--phase how-we-test`: rimandata al slice B per non gonfiare questo slice.

**Test:** `howWeTest.test.ts` (shape, dedup per opsKnowledgeKey, empty state, idempotenza), fixture riusate da `opsKnowledge.test.ts`.

**Acceptance:**
- [ ] file generato, ordinato per criterion, rigenerabile idempotente
- [ ] auto-write solo con flag ON
- [ ] vitest verde

---

## Roadmap (fuori slice, ordinata)

- **B — trigger PR/CI nel gardener.** Nota: il gardener è ora anche in Settings/Automations (commit ff317c8) — punto
  di aggancio naturale. Poll PR+status via GitHub MCP (`mcps/github`) → mission one-shot `--once` di repair.
  Resta cron: niente daemon (ADR-0014).
- **D — migration trust ladder** (Fase 4 handoff): primi N step della migrazione → `reviewGate` richiesto
  (`BLOCKED`→`PASS` solo con approvazione umana); auto-avanzamento solo con verification verde
  (ADR-0023, `unknown ≠ pass`). Policy dichiarativa, non "review decrescente" a sensazione: qui zelari può fare
  meglio di Cursor perché la scala di fiducia la decide l'evidence.
- **E — post-ship watch:** trigger gardener → `ssh_run` (`journalctl`, `docker ps`) su prod-vps → triage che
  **linka gli ADR** delle decisioni originali. È il loro pitch ("monitoring with the context behind decisions");
  noi il contesto decisionale lo abbiamo già strutturato in `docs/decisions/`.
- **Metriche:** outcome per-mission in `evidence:report` (PR merged, repair rate) — riprendere il task
  "M — Metriche front-door" cancellato; l'articolo dà l'argomento (+30% PRs, 6x power user).

---

## Desktop UI — "una chat principale + sub-chat dei lead" (pattern x.ai/bot)

**Verdetto:** direzione giusta, implementazione a fasi, **no** alla rimozione secca delle chat dalla sidebar.
Dettagli nella risposta in chat; qui il piano.

**Stato oggi (grounding):**
- Sidebar inline nel god-file `apps/desktop/src/App.tsx:3293-3430` (~4.3k LOC); conversazioni **solo localStorage**
  (`chatStorage.ts`, cap 80 chat / 200 msg), non legge `.zelari/sessions`
- Eventi live via Tauri `agent-event` da sidecar long-lived `--serve-harness` (`agentClient.ts:674-677`,
  `src-tauri` sidecar); multiplex run in `runs/useRunCoordinator.ts`
- `components/KrakenActivity.tsx` + `activity/useRunActivity.ts` renderizzano **già** lead+tentacles con `parentId`
  (`activity/types.ts:40-42`) dagli eventi `agent_spawned/status/tool/ended` — ma **dentro** la chat, non in sidebar
- Componenti **orfani** (esistono, nessun import): `WorkbenchPanel.tsx`, `WorkbenchLiveTail.tsx` (poll 1.5s
  `.zelari/radio/workbench-*.md`), `KrakenGraphVisualizer.tsx`, `PlanReviewPanel.tsx`
- Nessun reader `.zelari/radio/*.jsonl` nel desktop; transcript tentacles su disco CLI non raggiungibili dalla sidebar
- Segnale da verificare: `liveSend.ts` + `steerRecovery.ts` (+ test) suggeriscono un canale di steering run esistente

**Fasi:**
1. **F1 — Sidebar a sezioni + gerarchia missione (read-only).** Estrarre `Sidebar.tsx` da App.tsx (convention
   ≤300 LOC); sezioni "Missioni" (conversazioni con `sessionId`) / "Chat"; sotto la missione attiva, children =
   tentacles dai dati KrakenActivity già ricevuti. **Zero nuovi canali**: stessi eventi Tauri.
2. **F2 — Trace tentacle leggibile.** Rimontare `WorkbenchLiveTail` come pannello del tentacle selezionato
   (click → transcript live da `.zelari/radio`). Lettura file, niente spine v2.
3. **F3 — Main chat sempre responsive.** Streaming non bloccante + card tentacle inline con **badge verifica**
   (PASS / REPAIR_REQUIRED / BLOCKED da ADR-0023). È il differenziatore vs Grok: loro mostrano attività, noi
   mostriamo evidence.
4. **F4 — Bidirezionale (grosso).** Messaggi a un tentacle in volo → richiede canale in-flight nel protocollo v2
   (`src/cli/headless/protocol.ts`) e regola di ownership (il lead approva). Prima un ADR, poi codice.
   Verificare prima quanto copre già `liveSend`/`steerRecovery`.

**Cosa NON fare:** eliminare le chat semplici da localStorage — non ogni conversazione è una missione;
sezioni, non sostituzione.

---

## Verifica (comandi)

```bash
npx vitest run src/cli/memory/opsKnowledge.test.ts src/cli/memory/repeatCheck.test.ts \
  src/cli/memory/howWeTest.test.ts src/cli/memory/promotion.test.ts \
  tests/unit/cli-worldModel.test.ts tests/unit/cli-memoryCommands.test.ts
npm run typecheck
```

Smoke manuale flag: `ZELARI_PROMOTE_OPS_KNOWLEDGE=1` + doppio fallimento deterministico → proposta; conferma → append con dedup.
