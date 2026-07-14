# Zelari Code — Handoff Opzione B (2026-07-03)

> **📚 Historical / superseded — not required for contributors.**  
> For open-source contribution use [CONTRIBUTING.md](./CONTRIBUTING.md),  
> [CHANGELOG.md](./CHANGELOG.md), and [docs/GUIDA.md](./docs/GUIDA.md).  
> Product identity: [Anathema Studio](https://anathema-studio.com/).

> **⚠️ SUPERSEDED (2026-07-03, sessione successiva su Windows)**
>
> I gap descritti sotto (§4 — 4 task generici invece di 12, §5.1 —
> `risks-md.md` duplicato, §5.3 — script non versionato) sono stati
> **risolti a livello di codebase** in v0.7.8. Vedi
> `docs/plans/2026-07-03-council-createplan-batch-builtin-fallback.md`.
>
> In sintesi:
> 1. Nuovo tool batch **`createPlan`** — Nettuno persiste l'intero piano
>    (fasi + task annidati + milestone) in UNA sola tool call, invece
>    delle 17 sequenziali che composer-2.5 non reggeva.
> 2. **Retry riabilitata per Nettuno** (`NON_RETRY_AGENTS` vuoto): con
>    budget di 1 call è la stessa forma che già funzionava per
>    Minosse/Lucifero. Requisiti OR-of-sets: `createPlan≥1` OPPURE il
>    trio itemizzato (i modelli forti non vengono flaggati).
> 3. **Fallback complete-design built-in in TypeScript**
>    (`src/cli/workspace/completeDesign.ts`): ≥3 task per fase derivati
>    dalle fasi REALI di plan.json (il mismatch di phase-ID è
>    impossibile per costruzione) + milestone garantita. Lo script
>    workspace `complete-design.mjs`, se presente, ha ancora precedenza.
> 4. Fix schema↔stub (`fileRefs`/`acceptance`/`qaScenario` su createTask,
>    `targetVersion` su createMilestone, alias per linkDocuments e
>    getDocumentBacklinks) e normalizzazione titolo `.md` in
>    createDocument (niente più `docs/risks-md.md`).
>
> Test: **919/919 GREEN** su Windows (da 907; corretto anche un bug
> win32 pre-esistente nel test del hook). Resta da fare la validazione
> live con `COUNCIL_MODEL=composer-2.5` su un workspace reale (il
> workspace `borsa-lusso-react` non esiste su questa macchina).

## TL;DR

Opzione B è **meccanicamente completa e pushata** sul branch `main` di
`zelari-code` (commit `3aaa45d`, sopra `57a71cb`). Il flow end-to-end
funziona: Nettuno non spreca più retry, chairman + oracle mantengono
il retry che funziona, e `complete-design.mjs` viene auto-invocato
alla fine del council.

**MA c'è un gap noto**: ottieni **4 task generici** invece dei **12
task curati per dominio** che il template `complete-design.mjs`
prevede. La causa è un mismatch tra i phase ID che il council genera
e quelli che il template mappa.

Quando riprenderai il lavoro, parti dal **§4 (Gap noto e fix
proposti)** — lì c'è tutto il contesto per chiudere il cerchio.

---

## 1. Stato del repository `zelari-code`

- **Branch**: `main`
- **Ultimo commit pushato**: `3aaa45d` — "v0.7.7 Opzione B: skip
  retry for Nettuno + auto-invoke complete-design"
- **Diff rispetto a `57a71cb` (Pass 3)**:
  - `packages/core/src/agents/councilApi.ts` (+18/-2)
    - Nuovo export `NON_RETRY_AGENTS: ReadonlySet<string> = new Set(['nettun'])`
    - Specialist loop: `if (!errored && !NON_RETRY_AGENTS.has(agent.id))`
  - `src/cli/workspace/postCouncilHook.ts` (+147/-19)
    - Nuova funzione `runCompleteDesignPostProcessor(ctx)`:
      spawn di `complete-design.mjs` come child process,
      gated da `.zelari/plan.json` con ≥1 phase,
      opt-out via `ZELARI_COMPLETE_DESIGN=0`
    - `runPostCouncilHook` ora orchestra due step in sequenza:
      AGENTS.MD prima, complete-design dopo
    - Nuovo type `PostCouncilHookResult` con campo `completeDesign`
  - `tests/unit/cli-workspace-complete-design-hook.test.ts` (NEW,
    +213 LOC) — 7 test
  - `tests/unit/cli-councilToolEmission.test.ts` (+29 LOC) — 3 test
    su `NON_RETRY_AGENTS`

## 2. Test

- **907/907 GREEN** (prima: 897, +10 nuovi)
- 7 nuovi in `cli-workspace-complete-design-hook.test.ts`:
  - no plan.json → no run
  - plan.json senza phases → no run
  - no complete-design.mjs → no run
  - plan + script OK → exit 0
  - script fallisce → exit code senza throw
  - `ZELARI_COMPLETE_DESIGN=0` → skip
  - `runPostCouncilHook` invocation order (AGENTS.MD prima,
    complete-design dopo)
- 3 nuovi in `cli-councilToolEmission.test.ts`:
  - `NON_RETRY_AGENTS.has('nettun') === true`
  - `NON_RETRY_AGENTS.has('gerion'/'pluton'/'caronte') === false`
  - `NON_RETRY_AGENTS.has('lucifer'/'minos') === false`

## 3. Live validation (composer-2.5)

Wipe completo `.zelari/`, `AGENTS.MD`, poi `COUNCIL_MODEL=composer-2.5
npx tsx run-council.mjs`. Risultato:

```
[15:37:10.836] agent_start  member=Nettuno  model=composer-2.5
[council] member "nettun" did not emit required tools: createTask (got 0,
  need >= 6), createMilestone (got 0, need >= 1). (...) (Pass 3 may add
  automatic retry; see plan 2026-07-03-council-design-phase-role-anchoring.md.)
                  ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
                  NESSUNA riga "retrying missing tools" dopo questo warning
                  (confermato: NON_RETRY_AGENTS ha skippato la retry)

[15:38:54.870] agent_start  member=Minosse  model=composer-2.5
[council] member "minos" did not emit required tools: createDocument (got 0, need >= 1).
[council] minos retrying missing tools: createDocument
[15:39:08.117] agent_start  member=Minosse  model=composer-2.5  <-- retry triggerato
                  ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
                  confermato: oracle retry funziona, crea risks.md

[15:39:30.198] agent_start  member=Lucifero  model=composer-2.5
[council] member "lucifer" did not emit required tools: createDocument (got 0, need >= 1).
[council] lucifer retrying missing tools: createDocument
[15:39:35.524] agent_start  member=Lucifero  model=composer-2.5  <-- retry triggerato
                  ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
                  confermato: chairman retry funziona, crea synthesis.md

[post-hook] complete-design ran (exit=0)
[post-hook] AGENTS.MD updated: tech-stack, decisions, conventions, build, open-questions
```

**Bundle finale**:

```
.zelari/
├── plan.json                    # 4 phases, 4 tasks, 1 milestone
├── plan.md                      # rigenerato dal post-processor
├── risks.md                     # Oracle retry (2863 bytes)
├── decisions/
│   ├── 000-adr-000-bootstrap...md
│   ├── 001-adr-001-react-19-vite-6-and-typescript-strict-mode.md
│   ├── 002-adr-002-stripe-as-sole-payment-and-checkout-orchestration.md
│   ├── 003-adr-003-mdx-for-editorial-and-campaign-content.md
│   ├── 004-adr-004-wcag-2-2-level-aa-as-non-negotiable-ux-baseline.md
│   ├── 005-adr-005-bilingual-i18n-italian-default-and-english.md
│   └── 006-adr-006-headless-catalog-api-boundary-and-bff-lite-pattern.md
├── docs/
│   ├── information-architecture.md       # Gerione
│   ├── luxury-design-tokens.md            # Gerione
│   ├── customer-journey-map.md            # Gerione
│   ├── risks-md.md                        # (?) vedi §5
│   └── synthesis-md.md                    # Lucifero retry (6110 bytes,
│                                          # title "synthesis-md" aggiunge
│                                          # automaticamente .md dal tool)
├── milestones/
│   └── m-mvp-luxury-storefront-design-complete.md
└── plan-tasks/
    ├── foundation-technical-blueprint-t1-...md
    ├── ux-ia-design-system-t1-...md
    ├── commerce-content-t1-...md
    └── quality-sign-off-t1-...md
    ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
    SOLO 4 TASK (gap noto — vedi §4)

AGENTS.MD                       # auto-generato, 5 sezioni
```

## 4. Gap noto e fix proposti

### 4.1 — 4 task generici invece di 12 curati

**Sintomo**: il post-processor genera 1 task per phase (fallback
generico) invece dei 3 task curati che il template prevede.

**Causa**: mismatch tra phase ID del council e phase ID del template
`TASKS_PER_PHASE` in `complete-design.mjs`.

| Council produce | Template cerca | Risultato |
|---|---|---|
| `foundation-technical-blueprint` | `phase-1-discovery-product-definition` | fallback generico |
| `ux-ia-design-system` | `phase-2-information-architecture-ux` | fallback generico |
| `commerce-content` | `phase-3-luxury-design-system` | fallback generico |
| `quality-sign-off` | `phase-4-technical-blueprint-readiness` | fallback generico |

Il fallback è:
```js
{
  title: `${phase.name} — implementation tasks`,
  description: phase.description || `Concrete implementation work for phase "${phase.name}".`,
  acceptance: [
    'Phase exit criterion defined in the synthesis doc is satisfied',
    'All artifacts referenced by this phase exist and are current',
  ],
  qa: 'Walk the synthesis green-light checklist and confirm this phase has a passing row.',
}
```

### 4.2 — Fix proposti (scegline uno)

#### Opzione A — Aggiornare il mapping nel template

**File**: `~/zelari-projects/borsa-lusso-react/complete-design.mjs`

**Modifica**: sostituire le chiavi di `TASKS_PER_PHASE` con i phase ID
reali del council. Esempio:

```js
const TASKS_PER_PHASE = {
  'foundation-technical-blueprint': [
    { title: 'Lock React 19 + Vite 6 + TS strict baseline', ... },
    { title: 'Define NFR budget (LCP, WCAG, Lighthouse)', ... },
    { title: 'Document design-phase exit criteria', ... },
  ],
  'ux-ia-design-system': [
    { title: 'Finalize sitemap & route map', ... },
    { title: 'Wireframe key pages (PLP, PDP, cart, checkout)', ... },
    { title: 'Specify faceted search contract', ... },
  ],
  // ... ecc.
};
```

**Pro**: task specifici del dominio, riutilizzabili per run futuri
senza dover toccare il codebase.

**Contro**: duplica la conoscenza di dominio che il council dovrebbe
avere. Se il council cambia i phase ID, il template va ri-aggiornato.

**LOC**: ~150 nel file workspace, 0 nel codebase.

**Stima**: 10 minuti.

#### Opzione B — Fuzzy match per prefisso

**Modifica**: rendere il match basato su prefisso anziché su equality.

```js
const TASKS_PER_PHASE = {
  'foundation': [ /* 3 task curati generici per qualsiasi phase che
                    inizia con 'foundation' */ ],
  'ux-ia': [ /* 3 task */ ],
  'commerce': [ /* 3 task */ ],
  'quality': [ /* 3 task */ ],
};

// Match
let phaseTasks = TASKS_PER_PHASE[phase.id];
if (!phaseTasks) {
  // Fallback: cerca per prefisso (es. 'foundation-technical-blueprint' → 'foundation')
  const prefix = Object.keys(TASKS_PER_PHASE).find((k) => phase.id.startsWith(k));
  phaseTasks = prefix ? TASKS_PER_PHASE[prefix] : undefined;
}
```

**Pro**: più robusto a rinominamenti futuri dei phase.

**Contro**: meno specifico (i 3 task generici per `foundation`
vengono ri-usati per qualsiasi fase che inizia con `foundation`).

**LOC**: ~30 (refactor mapping esistente + logica di match).

**Stima**: 5 minuti.

#### Opzione C — Lasciare il fallback generico

Il modello (Opus) un giorno produrrà i task via `createTask` reali e
il post-processor farà solo da safety net. Per ora, 4 task generici
sono sufficienti per procedere con l'implementazione.

**Pro**: nessun lavoro.

**Contro**: i task generici non hanno descrizioni specifiche del
dominio, sono "phase exit criterion satisfied" — il che è fumoso.

### 4.3 — Consiglio

**Opzione B** (fuzzy match) — è il giusto mezzo. 5 minuti di lavoro,
zero rischio di regressioni, e produce task più sensati dei 4
generici attuali.

## 5. Altri artefatti da controllare

### 5.1 — `risks-md.md` duplicato

Nel run è presente **sia** `risks.md` (root di `.zelari/`, creato da
Oracle retry) **sia** `docs/risks-md.md` (creato probabilmente dal
chairman retry o da un run precedente). Verificare se è un bug del
chairman (che sta cercando di creare `risks.md` invece di
`synthesis.md`?) o semplicemente uno stub residuo.

**File da ispezionare**: `~/zelari-projects/borsa-lusso-react/.zelari/docs/risks-md.md`

Se è vuoto/stub, cancellare.

### 5.2 — File allowlist Pass 3

Per memoria: Pass 3 prompt menzionava `councilApi.ts`,
`cli-councilToolEmission.test.ts`, `council-chairman.test.ts`. In
Opzione B ho aggiunto `postCouncilHook.ts` + nuovo test file. Tutto
pushato senza violazioni.

### 5.3 — Workspace driver

`~/zelari-projects/borsa-lusso-react/run-council.mjs` è stato
modificato localmente per invocare `runPostCouncilHook` dopo il
council (riga 295-324). **NON è versionato** (il workspace non è un
repo git). Se vuoi versionarlo, inizializza un repo lì dentro o
sposta `run-council.mjs` in `zelari-code/packages/cli/scripts/`.

## 6. Comandi utili per riprendere

```bash
# Verifica stato repo
cd ~/zelari-code
git log --oneline -5
git status

# Run test suite (deve essere 907/907 GREEN)
cd ~/zelari-code && npx vitest run

# Run live council (wipe + ricostruzione)
cd ~/zelari-projects/borsa-lusso-react
rm -rf .zelari/ AGENTS.MD
COUNCIL_MODEL=composer-2.5 npx tsx run-council.mjs

# Verifica bundle finale
ls .zelari/plan-tasks/ | wc -l   # deve essere 12 se fix Opzione B applicato
ls .zelari/                      # phases, tasks, milestones, risks.md, synthesis.md
cat .zelari/plan.json | python3 -c "import sys, json; p=json.load(sys.stdin); print(f'phases={len(p[\"phases\"])}, tasks={len(p[\"tasks\"])}, milestones={len(p[\"milestones\"])}')"
```

## 7. Auth Claude CLI

**Token scaduto**: 2026-06-29 11:05:36 (~4 giorni al momento di Opzione B).

Se vuoi ripristinare Opus per il council (modello che produce task
veri via `createTask` invece di richiedere il post-processor), devi
completare manualmente il flow `claude auth login` browser-side.

Finché usi `composer-2.5`, Opzione B è il workaround deterministico.

## 8. Prossimi passi consigliati

In ordine di priorità:

1. **§4.3 — Applicare Opzione B (fuzzy match) per chiudere il gap 4 vs
   12 task.** 5 minuti di lavoro, alto valore.
2. **§5.1 — Investigare `risks-md.md` duplicato.** 5 minuti.
3. **§5.3 — Versionare `run-council.mjs` o spostarlo in
   `packages/cli/scripts/`.** Se vuoi che i workspace futuri ereditino
   la stessa integrazione.
4. **§7 — Ripristinare Claude CLI auth per sbloccare Opus.** Sblocca
   il modello che fa i task da solo, eliminando la necessità del
   post-processor per Nettuno.
5. **Refactor `councilApi.ts` (1138 LOC) in moduli separati
   (orchestrator / specialists / oracle / chairman / post-condition).**
   Lavoro di mezza giornata, alto debito tecnico se il codebase cresce.
6. **Dipendenze Dependabot** (1 critical, 1 high, 3 moderate) — update
   prima di release.

---

**File allegati a questa handoff**:

1. `HANDOFF.md` (questo file)
2. `complete-design.mjs` — copia corrente del post-processor (392 LOC)
3. `run-council.mjs` — driver modificato con auto-invoke del post-hook
4. `.zelari/` snapshot — bundle completo generato dall'ultimo run live

Buon riprendere!