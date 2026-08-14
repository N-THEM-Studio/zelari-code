# PRINCIPLES.md — Principi primi di Zelari Code

> **Manifesto canonico.** Ratificato da sessione di governance il 2026-08-13
> ([ADR-0010](docs/decisions/0010-first-principles-manifesto.md)).
> Sostituisce le formulazioni sparse in `AGENTS.MD`, `CONTRIBUTING.md` e
> `.zelari/docs/`: in caso di conflitto **vince questo documento**.

## Metodo

Un candidato è un *principio primo* — non una convenzione — se supera tre test:

1. **Arbitra tradeoff** — quando due desideri confliggono, decide lui.
2. **È stabile tra versioni** — 1.0 → 1.34 non l'ha cambiato.
3. **Non è derivabile** — se discende da un principio più profondo, è una convenzione.

## I sei principi

### P1 · Verificabilità (Verifiability)

**Enunciato.** Ogni asserzione dell'agente è verificata o dichiarata non verificata; il prodotto stesso si sottomette allo stesso standard: nessuna release non banale parte senza audit indipendente ([ADR-0007](docs/decisions/0007-pre-release-audit-workflow-gate.md)).

**Perché è primo.** È il principio più profondo: *non fidarti di un'asserzione non verificata — inclusa la tua*. Ha generato l'evidence ladder (claimed→grep→tool→build), il lint di onestà sulle synthesis, la review di Minosse, il conformance reviewer letterale. Un audit esterno trovò 4 bug runtime che 759 test non vedevano (ADR-0007).

**Come è garantito.** Meccanismi deterministici (`honesty.ts`, tier ranking, microGate) + gate di processo (audit indipendente sulle release non banali). *Forte sul deterministico; il resto è mitigato, non garantito.*

### P2 · Determinismo del controllo (Deterministic control)

**Enunciato.** Tutto ciò che governa sicurezza, permessi e verifiche è codice deterministico e testato — mai promesse nel prompt. Le promesse di sicurezza non eccedono ciò che il meccanismo garantisce.

**Perché è primo.** Arbitra "sicurezza vs velocità": ha scelto il choke-point unico (`ToolRegistry.invoke`), l'ordine fisso phase → sandbox/blocklist → PreToolUse → execute → PostToolUse, il fail-open dichiarato (chip FAIL-OPEN), la detection della lingua senza LLM.

**Come è garantito.** Code-level: sandbox, shell blocklist, folder trust, lifecycle hooks, phase gate — tutti al choke-point unico, con test unitari dedicati. *Forte.*

### P3 · Sovranità dell'utente (User sovereignty)

**Enunciato.** L'utente è l'autorità sugli **obiettivi** e sulle **letture ambigue** (conformance letterale al prompt); il sistema governa i **mezzi pericolosi**, con trasparenza totale. I due domini si spartiscono il controllo: obiettivi → utente, mezzi pericolosi → sistema, onere di trasparenza → sistema.

**Perché è primo.** Arbitra "il sistema sa meglio" vs "l'utente decide": conformance persona, `/steer`, permission broker, `/trust`, conferme per azioni distruttive.

**Come è garantito.** Semi: gate deterministici sui mezzi pericolosi; prompt/conformance per la fedeltà agli obiettivi; trasparenza obbligatoria (messaggi azionabili, chip FAIL-OPEN).

### P4 · Runtime aperto e riusabile (Open, reusable runtime)

**Enunciato.** L'intero monorepo è **Apache-2.0** ([ADR-0009](docs/decisions/0009-apache-2-0-license.md)); `@zelari/core` espone un'API pubblica stabile ([ADR-0004](docs/decisions/0004-public-api-stability-policy.md)) ed è provider-agnostico. Il valore proprietario sta nell'**esperienza in-session**, non nel lock-in.

**Perché è primo.** Ha arbitrato "open vs controllato": vinto contro il dual-license (ADR-0008) e contro il deep-linking interno. La secrecy policy protegge l'esperienza (refusal del modello), non rivendica proprietà sul codice.

**Come è garantito.** Publish pipeline (tag==version, OIDC Trusted Publishing), exports map, test di stabilità API. *Forte sul meccanico; l'esperienza è protetta solo da policy comportamentale.*

### P5 · Leggerezza (Lightness)

**Enunciato.** Std-lib first nel **runtime core**; dipendenze pesanti ammesse solo nell'**interfaccia** (TUI Ink+React, Desktop Tauri), mai nel core. Zero utility pesanti (lodash, immer, …).

**Perché è primo.** Ha arbitrato "produttività vs semplicità": il core gira con poche dipendenze audibili; React vive nella UI CLI, non nel core — coerente con questa formulazione.

**Come è garantito.** Gate meccanico `scripts/verify-principles.mjs` (blacklist dipendenze pesanti + allowlist runtime del core) eseguito in CI su ogni PR (`.github/workflows/ci.yml`).

### P6 · Orchestrazione giusta per il lavoro (Right-sized orchestration)

**Enunciato.** La struttura multi-agente si sceglie per il lavoro, non per identità: kraken (single-agent con tentacoli), council (6 ruoli), zelari (missioni autonome) sono istanze dello stesso principio. Nessun default è sacro.

**Perché è primo.** Risolve la tensione identitaria "council-first vs kraken-first": il default kraken è una scelta coerente, non una violazione.

**Come è garantito.** Governance: ogni nuova modalità deve motivare costo/latenza rispetto al lavoro (es. `ZELARI_COUNCIL_TIER=lite`).

## Derivazioni (convenzioni, non principi)

Derivano da P1+P2+P5; vanno rispettate, ma non sono prime:

| Convenzione | Deriva da |
|---|---|
| Zod per tutti i tool args | P2 (validazione deterministica) |
| Un tool per file in `builtin/` | P1 (reviewabilità) |
| Moduli ≤ ~300 LOC | P1 |
| Commit atomici single-task | P1 |
| Async-first | P5 (niente blocchi, niente framework inutili) |
| Language policy (lingua dell'utente) | P3 |
| Fail-open dichiarato + chip | P2 (non promettere enforcement che non c'è) |
| Evidence ladder, honesty lint, microGate | P1 |

## Garanzia: cosa è garantito e cosa no

| Principio | Garanzia attuale |
|---|---|
| P2 Determinismo del controllo | **Garantito** — code-level, testato |
| P1 Verificabilità | **Forte sul deterministico** — l'audit pre-release resta processo |
| P4 Runtime aperto | **Garantito sul meccanico** (CI publish) — l'esperienza è policy |
| P3 Sovranità dell'utente | **Mitigata** — la fedeltà agli obiettivi è prompt, non meccanismo |
| P5 Leggerezza | **Garantita** — verify-principles + CI su PR |
| P6 Orchestrazione giusta | **Governance** — decisioni, non check |

## Roadmap di garanzia

1. ✅ `scripts/verify-principles.mjs` — check meccanici per P5 (blacklist + allowlist core), P4 (licenza), P2 (Zod per tool, choke-point hooks) e per le preferenze (1 tool/file, LOC).
2. ✅ CI su `pull_request` — `.github/workflows/ci.yml`: typecheck + test + verify-principles come gate di merge.
3. ⬜ P1 sulle release — automatizzare l'audit campionario stile ADR-0007.

## Decisioni di questa ratifica

1. Il principio identitario è **"l'orchestrazione giusta per il lavoro"** (P6): il default kraken non viola alcun principio.
2. Licenza dell'intero prodotto: **MIT → Apache-2.0** (ADR-0009); secrecy policy riformulata "runtime aperto, esperienza protetta".
3. **P5 è primo** con esenzione esplicita per l'interfaccia.
4. **P3 a domini condivisi**: obiettivi all'utente, mezzi pericolosi al sistema, trasparenza obbligatoria.
5. **P1 confermata come radice** dell'intero sistema di principi.
