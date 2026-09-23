# Roadmap Hardening & Miglioramento — 2026-09 (post v2.29.0)

> Stato: **piano attivo**. Task duraturi registrati in `.zelari/plan.json` (t39–t54).
> Questo documento è la narrazione estesa; il vault `plan.json` resta la fonte operativa.

## Contesto

v2.29.0 ha chiuso il ciclo "Evolution Engine v0" (ADR-0036): PRINCIPLES inglese
canonico, THREAT_MODEL, EVALS, consolidamento config path (`~/.zelari-code/`),
`zelari.config.json` + `--print-settings`, honesty lint evidence-backed, lineage
sha256 su `/promote-member`, ledger shadow + task classifier + `/evolve status`.

## Wave 0 — Igiene repo (rischio zero)

- **t33** `--help` completo — *verificato già soddisfatto su disco* (diff dispatcher↔help = 0 mancanti; snapshot test opzionale).
- **t34** smaltimento untracked + banner HANDOFF — *verificato già soddisfatto* (git status pulito, banner SUPERSEDED su tutti i 4 HANDOFF*.md).
- **t39** triage Dependabot #6 + policy `npm audit` in CI — #6 non riproducibile (0 vuln su root e apps/desktop); step CI blocking solo su `high+`.
- **t40** refresh AGENTS.MD — ADR-0026..0036 + tech-stack/build aggiornati.

## Wave 1 — Evolution v0.1: chiudere il loop misurabile (~1–2gg)

- **t41** ledger shadow anche dalle run TUI (oggi solo headless, `runHeadless.ts`).
- **t42** fitness deterministica v1 in `ledgerStats`: pass-rate pesato per
  evidenceTier, steer/rollback rate, costi — zero LLM (ADR-0036: proposer≠measurer).
- **t43** `/evolve proposals`: surface TUI read-only del loop `evolvePropose` esistente.
- **t44** popolare `evidence` nei caller reali della synthesis (API esistente da
  2.29.0 in `runChecks.ts`; nessun caller passa ancora gli EvidenceRef).

## Wave 2 — Anti-Goodhart (dipende da t42)

- **t45** anchor sealed/hold-out + rotazione + regole comportamentali nel promote:
  steerCount↑ o evidenceTier↓ ⇒ reject anche a parità di pass-rate.

## Wave 3 — Hardening sicurezza

- **t46** provenance del contesto al choke-point: istruzioni originate da contenuto
  non-user (file/web/MCP) ⇒ conferma rafforzata su write/exec.
- **t47** chiudere i vettori `open` di docs/THREAT_MODEL.md (MCP injection, exfil via `ssh_run`).
- **t48** preset `--permissions strict|standard|yolo` — sola UX sul policy engine esistente.

## Wave 4 — Governance

- **t49** budget sessione/missione con HOLD + cost in status line (riuso ADR-0013 + `tools/eval/cost.ts`).
- **t50** memoria: confidence decay + detection contraddizioni (flag per review).

## Wave 5 — Ecosistema & dogfooding

- **t51** snapshot eval per release in docs/EVALS.md (collega t31 benchmark pubblico).
- **t52** dogfooding PR con audit automatico stile ADR-0007 (chiude il ⬜ di P1; label `touches-judge` già attiva).
- **t53** stabilità API `@zelari/core` (ADR-0004: AgentHarness/ToolRegistry/Ledger come interfacce pubbliche).
- **t54** GUIDA.md aggiornata alle feature 2.29.0.

## Ordine consigliato

W0 → W1 → t46+t47 → t45 (serve ledger popolato) → W4/W5.

## Invarianti non negoziabili (da ADR-0036 / PRINCIPLES P1)

1. Il motore che propone non è il motore che misura; nessun artefatto può promuovere se stesso.
2. Gli anchor Tier-0 e i judge paths (`JUDGE_PATHS` in `scripts/verify-principles.mjs`) restano fuori dal genoma.
3. Ogni salto di scope oltre la sessione richiede conferma umana (P3).
