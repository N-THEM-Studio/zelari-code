---
kind: doc
id: synthesis-presa-di-conoscenza-v0-10-0
date: 2026-07-16
tags: [synthesis, v0.10, lucifero, design-phase, ground-truth-verified]
---
---
kind: doc
id: synthesis-prendi-conoscenza-v0-10
date: 2026-07-16
author: Lucifero (chairman)
session: design-phase
related:
  - plan-canonical-v0-10
  - synthesis
  - knowledge-map-workspace-state-v0-10
  - gerione-divergent-ideas-v0-11-spikes
  - 005-adr-idea-shadow-council-mode-post-v0-10-spike
tags: [synthesis, v0.10, lucifero, design-phase, ground-truth-verified]
---

# Synthesis · presa di conoscenza v0.10.0

> **Richiesta utente**: `prendi conoscenza del progetto`.  
> **Risposta in 1 riga**: stato riconciliato e sequenza operativa pronti. Il run implementation va lanciato solo dopo aver chiuso R1 (correzione evidenza) + R2 (dedupe `plan.json`) + R3 (missione placeholder).  

---

## 1 · Ground truth verificato in questo run

Tutte le affermazioni seguenti sono state verificate leggendo direttamente i file con `read_file`. Niente assunzioni sul contenuto.

| # | Fatto | File | Stato |
|---|---|---|---|
| F1 | `.zelari/plan.json` è **JSON valido** (apre con `{`, 518 righe) | `.zelari/plan.json` | ✅ verificato |
| F2 | Piano è **duplicato**: 3 fasi P0 + 3 fasi P1 + 2 fasi P2 + 2 fasi P0.5 + 1 milestone-holder (≥ 11 phase-id distinti in 80 righe) | `.zelari/plan.json:1-80` | ✅ verificato |
| F3 | `.zelari/mission-state.json` `userPrompt: "x"`, `intent: greenfield`, `maxTasks: 8`, mission `m_fd0f70ad` running | `.zelari/mission-state.json:1-47` | ✅ verificato |
| F4 | `plan-canonical-v0-10.md` esiste e identifica i **task ship-path** (12 task curati: 3 P0 + 2 P0.5 + 3 P1 + 3 P2-spike + 1 milestone v0.10.0) | `.zelari/docs/plan-canonical-v0-10.md` | ✅ verificato |
| F5 | HANDOFF.md dichiara Opzione B pushata su `main` in v0.7.8 (919/919 test GREEN), bug 4-vs-12 task risolto a livello codebase ma drift persiste se non si re-emette `plan.json` via `createPlan` | `HANDOFF.md:1-119` | ✅ verificato |
| F6 | `risks.md` registro live (R1–R10), aggiornato da Minosse 2026-07-16 | `.zelari/risks.md:1-95` | ✅ verificato |
| F7 | Doc design-phase pre-esistenti (`customer-journey-map`, `information-architecture`, `design-tokens`) **completi e allineati** al 2026-07-16 — non vanno duplicati | `.zelari/docs/*.md` | ✅ verificato (Gerione) |
| F8 | Workspace-state map (Plutone) Layer 0 + product knowledge-map Layer 1 + 3 backlink | `.zelari/docs/knowledge-map-workspace-state-v0-10.md` | ✅ verificato |

## 2 · Correzione importante a Minosse (R1)

**R1 (Artefatti JSON non parsabili)** ha evidenza **sbagliata**:

- Cosa dice R1: "`.zelari/plan.json:1` e `.zelari/mission-state.json:1` iniziano senza `{`"
- Cosa ho verificato: entrambi i file **iniziano correttamente con `{`** e parsano come JSON valido (518 / 47 righe lette senza errore).

**Mitigation richiesta a Minosse** (azione concreta, bloccante prima del prossimo run):

1. Correggere R1 in `risks.md` → cambiare evidenza, mantenere categoria "Tecnica / affidabilità" ma riscrivere: *"Piano JSON valido sintatticamente ma semanticamente inconsistente: 11 phase-id distinti dove canonical prevede 4 + milestone unica. Risk re-classificato come Drift semantico (era: JSON malformato)."*
2. Promuovere **R1-bis · Drift semantico plan canonico ↔ plan.json** con severity High — è il vero blocker.

**R2 (piano duplicato) e R3 (missione placeholder) restano confermati** con la mia verifica.

## 3 · Risposta a Caronte sulle 3 opzioni (Gerione aveva già suggerito 1+2)

| Opzione | Risposta chairman | Razionale |
|---|---|---|
| **1 · Sintetizzare/normalizzare il piano** | ✅ **Sì, ma verifica-driven, non createPlan cieco** | `plan-canonical-v0-10.md` esiste già. Il task è: (a) correggere R1 in `risks.md`, (b) checkare ID-per-ID che ogni task del canonical sia presente in `plan.json`, (c) marcare i duplicati come `blocked`, (d) **NON** ri-emettere `createPlan` se non c'è drift residuo (rischio: produrre un **terzo** duplicato). |
| **2 · Chiudere gap HANDOFF** | ✅ **Sì, in parallelo a Opzione 1** | Post-processor è risolto a livello codice, ma serve un **drift-check task** tra `synthesis.md` e `plan.json` per garantire che il prossimo run non rigeneri 4 task generici. Aggiungo questo come R11. |
| **3 · Nuovo council run** | ⚠️ **NO — finché R1-bis, R2, R3 non sono chiusi** e finché non c'è un **prompt concreto** (non `"x"`) per la mission `m_fd0f70ad`. Prompt suggerito: *"Implementa P0 step 1: wire LifecycleHookRunner in ToolRegistry.invoke, fail-open audit JSONL, smoke test."* |

**Sequenza operativa raccomandata:**

```
[1] chairman correction: riscrivi R1 in risks.md, aggiungi R1-bis · drift semantico
    ↓
[2] Nettuno verification-only: diff plan-canonical-v0-10.md vs plan.json
    ↳ se drift = 0 → basta marcare duplicati come blocked
    ↳ se drift > 0 → createPlan atomico (unica call, come da HANDOFF §post-opzione-B)
    ↓
[3] Plutone update workspace-state map: branch "Pending" → branch "Stato"
    ↓
[4] (solo dopo 1+2+3) run implementation con prompt reale per mission m_fd0f70ad
```

## 4 · Top risks (post-correzione R1)

| ID | Severità | Stato | Cosa blocca |
|---|---|---|---|
| **R1-bis** · Drift semantico plan-canonical ↔ plan.json | **High** | nuovo | Prossimo run implementation |
| R2 · Piano e milestone divergenti | High | confermato | Quality-gate pre-ship |
| R3 · Missione placeholder `m_fd0f70ad` running | High | confermato | Qualsiasi nuovo run |
| R4 · RCE via lifecycle hooks | Critical | confermato | P0 step 1 |
| R5 · Dependabot 1c+1h+3m | High–Critical | confermato | Tag v0.10.0 |
| R6 · `councilApi.ts` 1138 LOC refactor risk | High | confermato | Quality-gate pre-ship |
| R7 · Latenza cumulativa hook | Medium–High | confermato | NFR spec |
| R8 · Trust badge solo visivo (a11y) | Medium | confermato | P0.5 step 2 |
| R9 · Replay log può esporre dati sensibili | High | confermato | R9-bis: aggiungere retention/denylist |
| R10 · Scope creep su richiesta esplorativa | Medium | confermato (Gerione 8 spike + ADR-005) | Self-discipline council |
| **R11 · Drift design-phase docs ↔ plan** (nuovo) | Medium | proposto | Aggiungere check ID-per-ID in post-processor |

**Action**: Chairman → invio richiesta di rettifica a Minosse (correzione R1 + aggiunta R1-bis + R11).

## 5 · Phases del run (post-normalizzazione)

Le fasi **non** sono il piano implementativo — sono la **sequenza operativa di normalizzazione**, da eseguire PRIMA di qualunque implementation. Allineate a Nettuno ma con la correzione critical (no `createPlan` cieco).

### Fase 1 · Normalizzazione piano (chairman + Nettuno)  · exit: plan.json semanticamente coerente

- **Task 1.1** Correzione R1 + aggiunta R1-bis + R11 in `risks.md` (chairman — 1 call)
- **Task 1.2** Diff `plan-canonical-v0-10.md` vs `plan.json` ID-per-ID, marca duplicati come `blocked` (Nettuno — read-only)
- **Task 1.3** *Solo se drift > 0*: `createPlan` atomico con i 12 task curati del canonical (Nettuno — 1 call)

### Fase 2 · Chiusura gap HANDOFF (Nettuno + Gerione) · exit: nessun drift residuo

- **Task 2.1** Aggiungere drift-check design-phase docs ↔ plan come quality-gate in `postCouncilHook.ts` (Plutone — verifica solo)
- **Task 2.2** Rimuovere `risks-md.md` ridondante (Minosse — già pianificato, verificare rimozione effettiva)
- **Task 2.3** Aggiornare `HANDOFF.md` sezione "When you resume" con i link a `plan-canonical-v0-10.md` (Plutone)

### Fase 3 · Mission reset (Plutone) · exit: missione archiviata, prompt reale pronto

- **Task 3.1** Archiviare missione `m_fd0f70ad` (Plutone — set status `archived`)
- **Task 3.2** Chiedere all'utente il **prompt reale** per il prossimo implementation run (chairman — 1 domanda)
- **Task 3.3** Validazione semantica minima nel planner: rifiutare `userPrompt === "x"` (futuro enhancement)

### Fase 4 · Stabilizzazione v0.10.0 (post-implementation) · exit: tag v0.10.0

- **Task 4.1** Split `councilApi.ts` 1138 LOC in ≤300 LOC moduli (non in questo run, lo fa Plutone/Pluto)
- **Task 4.2** Triage Dependabot critical+high prima del bump
- **Task 4.3** `CHANGELOG.md` v0.10.0 + bump + tag (Plutone)

## 6 · Sequenza di opzioni per l'utente

```
[utente]  → "prendi conoscenza del progetto"        ✅ FATTO (questo synthesis)
[utente]  → "vai con Opzione 1 (merge plan)"        ⏳ pronto per esecuzione
[utente]  → "vai con Opzione 2 (chiudi gap HANDOFF)" ⏳ pronto per esecuzione
[utente]  → "vai con Opzione 3 (nuovo run)"          ⛔ BLOCCATO finché R1-bis, R2, R3 non sono chiusi e prompt non è reale
[utente]  → "fammi vedere solo il piano canonico"    📄 già in .zelari/docs/plan-canonical-v0-10.md
[utente]  → "vai dritto a Fase 1 (normalizzazione)"  ✅ chairman già sa cosa fare
```

## 7 · Green-light checklist — quando il prossimo implementation run può partire

- [ ] R1 corretto in `risks.md`, R1-bis aggiunto
- [ ] `plan.json` semanticamente coerente (no drift vs canonical) o re-emesso atomicamente
- [ ] Missione `m_fd0f70ad` archiviata (non più `running`)
- [ ] Prompt reale (non `"x"`) per la prossima mission impostato dall'utente
- [ ] Drift-check design-phase ↔ plan presente come quality-gate
- [ ] Dependabot critical chiuso o accettato esplicitamente
- [ ] Post-processor `complete-design.mjs` (o fallback built-in) testato end-to-end su workspace reale (non solo `composer-2.5` headless)

Tutti i 7 punti chiusi → `GO` per implementation P0 step 1 (`LifecycleHookRunner` su `ToolRegistry.invoke`).

---

## Handoff

- **Chairman (me)**: richiesta di rettifica R1 + creazione R1-bis + R11 inviata a Minosse.
- **Nettuno**: in attesa di `read-only` diff plan-canonical ↔ plan.json (autorizzazione preventiva del chairman: non serve nuovo round intero, può operare in 1 call).
- **Gerione**: spike v0.11 + ADR-005 rimangono **backlog non-ship**, coerente con il verdetto di questo synthesis.
- **Plutone**: workspace-state map aggiornata già in fase 1.3 (cross-link al canonical aggiunto).
- **Lucifero prossimo run**: dopo `createPlan` normalizzato, emette nuovo `synthesis.md` con verdict GO P0+P0.5 come il precedente, ma con R1 rettificato.

## Deliverable emesso in questo run

- `docs/synthesis-prendi-conoscenza-v0-10.md` (questo doc)
