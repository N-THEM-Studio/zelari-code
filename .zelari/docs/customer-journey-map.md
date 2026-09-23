---
kind: doc
id: customer-journey-map
date: 2026-07-16
tags: [design-phase, gerione, ideation]
---
# Customer Journey Map — zelari-code AI Council

## Personas

### P1 · Dev Lead "Marco"
Senior engineer, 8+ anni, vuole orchestrare più LLM agenti per task complessi senza
scrivere un framework custom. Cerca opinioni strutturate, non chatbot generici.

### P2 · TUI Power User "Yuki"
Vive nel terminale, ama Ratatouille/Ink. Non aprirà mai una GUI Tauri se il TUI
è curato. Valuta tool dalla velocità di `tab + enter`.

### P3 · Integration Engineer "Priya"
Vuole embeddare il council in pipeline CI/CD via MCP server. Ha bisogno di API
stabili, exit codes puliti, output JSON streamabile.

### P4 · Open-Source Contributor "Tomás"
Arriva dal monorepo MIT Anathema. Vuole capire l'architettura in < 10 minuti,
aggiungere un MCP server o una skill, aprire una PR sensata.

---

## Journey Stages

### 1 · Discovery
- **Touchpoint**: README, landing `zelari.studio`, HN/Reddit mention
- **Azione**: legge value prop "6 agenti specializzati in council"
- **Emozione**: curiosità + scetticismo ("è l'ennesimo wrapper LLM?")
- **Pain**: troppi tool simili, difficile capire cosa lo differenzia

### 2 · Install
- **Touchpoint**: `npm i -g @zelari/cli` o clone del monorepo
- **Azione**: installa dipendenze, configura `ANTHROPIC_API_KEY`
- **Emozione**: friction se Node < 20 o auth Claude scaduta
- **Pain**: dipendenze pesanti, auth CLI che scade silenziosamente

### 3 · First Run
- **Touchpoint**: `zelari council run --mission "refactor auth.ts"`
- **Azione**: lancia un council e guarda i 6 agenti lavorare
- **Emozione**: wow moment se TUI è reattivo e l'output è strutturato
- **Pain**: TUI che lagga, log spammati, prompt placeholder come `"x"`

### 4 · Mission Creation
- **Touchpoint**: comando `mission` o TUI wizard
- **Azione**: scrive prompt reale, sceglie tema (es. "Steal Grok Build → v0.10")
- **Emozione**: fiducia crescente se il prompt engine capisce il contesto
- **Pain**: piano duplicato, fasi vaghe, output non azionabile

### 5 · Council Execution
- **Touchpoint**: TUI live + log stream
- **Azione**: legge synthesis, valida ADR, fa follow-up
- **Emozione**: produttività se la pipeline è trasparente (gate, ruoli)
- **Pain**: council opaco, agenti che ripetono lavoro, micro-gate invisibili

### 6 · Review & Commit
- **Touchpoint**: ADR in `.zelari/decisions/`, plan.json, output synthesis
- **Azione**: legge, commenta, applica i diff suggeriti
- **Emozione**: soddisfazione se gli artifact sono puliti e linkabili
- **Pain**: file `councilApi.ts` da 1138 LOC, nessun diff atomico

---

## Pain Points Top 5

1. **Mission con prompt placeholder** (`"x"`) → council si avvia ma produce nulla
2. **Piano duplicato** (11 fasi, 2 milestone, post-processor mancante)
3. **Output verboso non azionabile** — mancano snippet copy-paste
4. **Auth Claude CLI scaduta** rompe il flusso senza warning
5. **Onboarding architetturale opaco** — contributor non sa da dove partire
