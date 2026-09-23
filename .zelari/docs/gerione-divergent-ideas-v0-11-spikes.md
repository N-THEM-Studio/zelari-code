---
kind: doc
id: gerione-divergent-ideas-v0-11-spikes
date: 2026-07-16
tags: [design, ideation, divergent, v0.11, gerione, spike, council-cognition]
---
---
kind: doc
id: gerione-divergent-ideas-v0-11
date: 2026-07-17
tags: [design, ideation, divergent, v0.11, gerione, spike, council-cognition]
related: [customer-journey-map, information-architecture, design-tokens, synthesis]
---
# Gerione · Divergent Ideas — Spike backlog post-v0.10.0

> Design-phase · Gerione · 2026-07-17
> Scope: feature concepts **fuori dal tema "Steal Grok Build"**, per allargare il ventaglio creativo del council.
> Build-on: i 3 doc design-phase esistenti ([[customer-journey-map]], [[information-architecture]], [[design-tokens]], datati 2026-07-16) coprono già hooks/trust/inspect UX nel perimetro Grok-stealing. Questo doc **diverge** deliberatamente.

---

## Ideas (8 — mix technical / UX / product / unconventional)

| # | Idea | Cluster |
|---|---|---|
| 1 | **Shadow Council Mode** — quando il council gira, ogni agente genera un branch cognitivo parallelo (variante "aggressive" vs "conservative"); diff a fine sessione. | A |
| 2 | **Council Journal Visual** — post-sessione, auto-genera `.zelari/council/journal-<id>.md` committable: decisioni, alternative scartate, mini-ADR inline. | A |
| 3 | **Council Scratchpad Condiviso** — `.zelari/council/scratch.md` append-only durante la sessione; memoria cross-agent leggera (no lessons-Lake pesante). | A |
| 4 | **Hook Decision Visualizer** — su deny, TUI mostra catena causale `tool → hook → command → exit code → reason` con expand on hover (Desktop). | B |
| 5 | **Trust Inheritance (team → user)** — `.zelari/trust.toml` committato in repo con path approvati; l'utente eredita policy senza prompt ripetuto. | B |
| 6 | **Provider Failover Picker** — su errore provider, TUI mostra candidati alternativi (`Claude → Grok → local`) con picker "retry with". | C |
| 7 | **Replay Deterministic Mode** — dato plan + seed, rieseguire il council in modo riproducibile (riuso `replay-logs/` come store). | C |
| 8 | **Persona-Aware Error Messages** — tono adattivo (Mara/team-lead pragmatico vs Leo/indie informale vs Sofia/security rigoroso). | D |

---

## Themes (4 cluster)

| Theme | Ideas | Razionale sintetica |
|---|---|---|
| **A. Council Cognition UX** | 1, 2, 3 | Più trasparenza del pensiero collettivo + post-mortem ricchi |
| **B. Trust & Audit (estensione P0)** | 4, 5 | Visualizer causale + team-level trust, complementari al gate P0 |
| **C. Resilience & Reproducibility** | 6, 7 | Failover cross-provider + debug deterministico |
| **D. Adaptive Communication** | 8 | Personalizzazione tono, allineamento alle 4 personas già mappate |

---

## Top picks (3) — Feasibility + Novelty 1–5

| # | Idea | F | N | De-risk line |
|---|---|---|---|---|
| **★ 1** | Shadow Council Mode | 3 | 5 | Scope iniziale: 1 solo agente (Plutone), 1 sessione/spike; no impatto su altri 5 |
| **★ 2** | Council Journal Visual | 4 | 4 | Riusa `replay-logs/` esistente come sorgente; default `.gitignore`, commit opt-in esplicito |
| **★ 3** | Hook Decision Visualizer | 4 | 4 | Piggyback sul fail-open audit già previsto in P0 (`HookDecision` entity in IA); no nuove deps |

---

## Cross-reference personas

- **Mara** (team lead / platform eng) → **2** (journal come audit trail team), **5** (trust inheritance team-level)
- **Leo** (indie / power user) → **1** (shadow per sperimentare senza rischi), **6** (failover per resilienza laptop)
- **Sofia** (security / devsecops) → **4** (visualizer per audit causale), **5** (policy org-level)
- **Nico** (plugin author) → **1** (shadow branch come sandbox test plugin)

---

## Handoff (ai prossimi agenti)

- **Nettuno**: spike architetturale per Shadow Council → vedi ADR-idea `shadow-council-mode` (proposta in questo run).
- **Plutone**: Journal = estensione di `/inspect --journal`; Visualizer = componente TUI riusando token `HookDecisionChip` da [[design-tokens]].
- **Minosse**: due rischi nuovi da valutare → **R13** (information disclosure in journal committato), **R14** (trust inheritance → social-engineering attack via malicious `trust.toml` in repo).
- **Lucifero**: backlog **post-v0.10.0**, milestone candidato `v0.11.0`. Nessuna di queste idee blocca la ship di v0.10.0.

---

## Note di metodo

- Questo doc **non sovrascrive** i tre design-phase esistenti (ancora attuali, 1 giorno di vita).
- È complementare: i 3 doc descrivono il *come* delle feature P0/P0.5; questo descrive il *cosa potremmo esplorare dopo*.
- Tagliare P2 attuale (ACP/worktree/loop/marketplace/mode-auto) **non** preclude queste idee: sono ortogonali.