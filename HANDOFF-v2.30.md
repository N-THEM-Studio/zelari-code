# HANDOFF v2.30.0 — sviluppo da altra macchina

> Scritto al rilascio di **v2.30.0** (2026-09-05). Questo file è l'unico veicolo cross-machine dello stato di sviluppo: il vault `.zelari/` è **gitignored** e NON viaggia con il clone. Le plan-tasks (`t31`, `t51–t54`) esistono solo su `.zelari/plan.json` della macchina di origine — tutto ciò che serve è inlineato qui.

## Stato al tag v2.30.0

Wave **W0–W4** del piano hardening completate, verificate e committate. Gate verdi al rilascio: `verify-versions` coherent, `verify-principles` PASS 0 errori, suite test delle aree toccate tutta verde (evolution 14, antiGoodhart 14, provenance/presets/exfil 19, costBudget+memory-audit 19, paths 5, honesty.claims 10).

Commit nel rilascio (da `ec7330f` a `39c201b` = W0–W4, poi release):
`ec7330f` docs(agents) W0 · `958e984` ci(audit) W0 · `8f198eb` feat(evolution) W1 · `ae8127d` feat(eval anti-Goodhart) W2 · `991b8ea`+`1a4a681` feat/test(safety) W3 · `ea68ead` feat(budget) W4 · `39c201b` feat(memory) W4 · release 2.30.0.

## COSA MANCA — da qui si riprende

### Wave 5 (blocco pianificato, in ordine consigliato)

1. **t51 — Snapshot eval per release in `docs/EVALS.md`** (CI o manuale): eseguire `npm run eval:gate` (o `eval:measured`) e compilare la tabella per-release/provider secondo la convenzione già scritta in `docs/EVALS.md` (sezione snapshot). I risultati grezzi finiscono in `eval/results/<manifest-hash>/`. Preparato il terreno: hash del manifest seal pubblicato in EVALS.md. Collegare a **t31** (benchmark competitivo vs Codex/Claude Code/OpenCode, `.zelari/plan-tasks/t31.md`, solo su macchina origine).
2. **t52 — Dogfooding: missioni zelari su zelari-code → PR con audit automatico** — chiude il ⬜ di P1 (roadmap). Output solo come PR, mai merge automatico; la PR include l'audit campionario stile ADR-0007 (grep delle asserzioni synthesis vs evidenze). Il guard rail esiste già: `scripts/touches-judge.mjs` + label `touches-judge` (job PR-only in `ci.yml`) + check hard `[judge]` nel gate. Su una PR: se il diff tocca `JUDGE_PATHS` (in `scripts/verify-principles.mjs`) servono due approvazioni.
3. **t53 — API stabilità `@zelari/core`** — `AgentHarness` + `ToolRegistry` + `Ledger` come tre interfacce pubbliche documentate (P4); include decidere la policy di semver delle export.
4. **t54 — `docs/GUIDA.md` aggiornata alle feature 2.29/2.30** — mancano: `zelari.config.json` + `--print-settings`, root unica `~/.zelari-code/` con migrazione, `/evolve` (status/fitness/proposals), `/memory audit`, `--permissions`, budget sessione con HOLD, provenance (ask rafforzati), guard exfil SSH.

### Leftover tecnici dichiarati (mini-task, ognuno mezza giornata o meno)

5. **Headless honesty resta euristico**: `src/cli/runHeadless.ts` (~1293 council, ~1417 graph) non passa `sessionId` alla `postCouncilHook` → `evidenceFromSpine` non scatta, il lint degrada a legacy. Fix: mettere in scope `sessionId` nelle closure e passare l'opzione (firma già pronta in `src/cli/workspace/postCouncilHook.ts`).
6. **Guard budget solo sul council turn**: il path kraken di `src/cli/hooks/useChatTurn.ts` (~2094) non ha il guard HOLD pre-turn; il record cumulativo a `agent_end` invece è globale. Portare lo stesso guard usato per il council turn (vedi `src/cli/costBudget.ts`).
7. **README — tabella env incompleta**: mancano le righe `ZELARI_PERMISSION_PRESET` e `ZELARI_PROVENANCE` (documentate solo in `--help`/THREAT_MODEL).
8. **Anchor hold-out**: `npm run evolve:seal -- --rotation-candidates` esiste ma nessun anchor hold-out è ancora stato scritto/autoralmente approvato; la rotazione (EVALS.md §rotazione) resta da eseguire la prima volta.
9. **Dependabot #6**: non riproducibile localmente (audit 0 vuln su root e desktop lockfile); CI ora blocca su high+. Dopo il push, verificare su GitHub se il report sparisce o va triato sul lockfile di `apps/desktop`.
10. **AGENTS.MD**: dopo questo rilascio rieseguire `/council` per il refresh auto-curato (decisioni 0036 già inside; tech-stack auto-derived).
11. **Pannello Desktop "Evolution"**: backlog non iniziato (fitness per task class + proposte in attesa) — richiede `apps/desktop`.
12. **Vault `.zelari/plan.json`**: ricrearlo sull'altra macchina (o copiarlo a mano): t39–t50 completed, t31/t51–t54 pending. La roadmap estesa è in `.zelari/docs/roadmap-hardening-2026-09.md` (anche quella locale).

## Come riprendere (ambiente)

- Node 24, `npm install` (workspace), poi: `npm run typecheck` (= build core + tsc root), `npm test`, `node scripts/verify-versions.mjs`, `npm run verify:principles`.
- Convenzioni: commit atomici single-task (`feat(scope): … (Wx/ty)`), tag **lightweight** `vX.Y.Z` dal commit di release, `scripts/bump-version.mjs <semver>` + lockstep **manuale** di `packages/core/src/version.ts` (`CORE_VERSION`) e `packages/core/README.md` (badge) — il gate `verify-versions` li controlla.
- CHANGELOG: voce scritta a mano **prima** del bump (l'insert automatico dello script è stantio e si aggancia a un'ancora 1.9.3 inesistente → non parte).
- Sicurezza invariants da non rompere: ADR-0036 (proposer ≠ measurer, `JUDGE_PATHS`), anchor sealed (drift = gate rosso), regola comportamentale in `evolveDecide`, provenance/kill-switch `ZELARI_PROVENANCE`.
