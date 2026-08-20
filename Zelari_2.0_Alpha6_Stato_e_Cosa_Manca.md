# Zelari 2.0 Alpha.6 — Stato attuale e cosa manca

**Riferimento:** `v2.0.0-alpha.6`  
**Obiettivo:** fotografare lo stato reale dell’implementazione rispetto al piano Zelari 2.0 e definire il lavoro residuo prima di una RC.

---

## 1. Executive summary

L’alpha.6 è sensibilmente più avanti dell’alpha.4.

I due P0 principali individuati in precedenza risultano chiusi:

1. **versioni ed exports di `@zelari/core` sono coerenti**;
2. **la Session spine è ora la source of truth del model context** su headless/TUI, con `deriveMessages()` come percorso canonico e test architetturali che impediscono regressioni.

La parte fondamentale della 2.0 esiste quindi davvero:

- event-sourced Session spine;
- replay e resume;
- execution seams;
- WorkspaceProvider;
- versioned profiles;
- deterministic verification contract;
- CompletionPolicy;
- optional VerifierService;
- verifier model `inherit | fixed`;
- mission projection;
- Desktop controls per strict done, verifier e BoN alpha.

Il grosso del lavoro residuo non è più “inventare l’architettura”, ma **chiudere il wiring Verification 2.0**, rendere le evidence realmente traceable ai tool result, completare mission progress e consolidare docs/smoke/CI prima di una RC.

Valutazione qualitativa:

```text
Foundation / hygiene        ██████████  100%
Session spine               ██████████  100%
Execution seams/profiles    █████████░   ~90%
Deterministic verification  ████████░░   ~80%
LLM verifier integration    █████░░░░░   ~50%
Mission reliability         ██████░░░░   ~60%
Desktop product surface     ████████░░   ~80%
Docs / migration / CI       █████░░░░░   ~50%
────────────────────────────────────────
Alpha → RC readiness        ~75–80%
```

Le percentuali sono orientative, non metriche di progetto.

---

## 2. Cosa è già chiuso

### 2.1 Session spine

La Session spine è ora il percorso canonico:

```text
Session log
    ↓
deriveMessages()
    ↓
derivedToAgentMessages()
    ↓
model context
```

Il vecchio `sessionManager` può restare come compatibilità/migrazione/UI, ma non è più la seconda source of truth del model context.

Desktop usa il `sessionId` e i turn successivi possono riprendere tramite resume invece di dipendere dal solo history snapshot.

**Stato:** chiuso.

---

### 2.2 Versioning e exports core

Root e `@zelari/core` risultano allineati sull’alpha.6.

Gli exports pubblici 2.0 sono presenti per:

```text
@zelari/core/session
@zelari/core/runtime
@zelari/core/verification
@zelari/core/mission
```

**Stato:** chiuso.

---

### 2.3 Workspace e execution seams

Sono presenti le astrazioni relative a:

- `ExecutionContext`;
- workspace;
- worktree;
- filesystem;
- shell;
- subagent;
- profiles.

Il worktree è stato spostato nella direzione corretta: **workspace policy**, non mero flag di shell.

**Stato:** sostanzialmente chiuso.

---

### 2.4 Host / Profile / Phase

La separazione concettuale è corretta:

```text
Host
- TUI
- headless
- Desktop
- serve

Profile
- minimal
- kraken
- council
- mission

Phase
- plan
- build
```

`headless` non è stato trasformato in profile.

**Stato:** chiuso.

---

### 2.5 Deterministic verification core

Il core 2.0 contiene:

```text
VerificationEngine
CompletionPolicy
criteria pack
metrics
VerifierService
```

La separazione fra evidence deterministica e verifier probabilistico è corretta.

Il verifier LLM:

- è opt-in;
- non è autorità finale;
- può usare `inherit` o un modello dedicato;
- registra provider/model effettivi;
- non trasforma output non interpretabili in `pass`;
- mantiene progress e BoN come superfici sperimentali/advisory.

**Stato:** core chiuso, wiring runtime ancora incompleto.

---

### 2.6 Verifier dedicato / inherit

La configurazione supporta:

```text
Same as current model
```

oppure:

```text
Dedicated provider + model
```

Questo è coerente con il piano Zelari 2.0.

**Stato:** backend chiuso.

---

### 2.7 Desktop verifier controls

La UI Desktop include il controllo:

```text
Kraken — Verification model

Same as current model (recommended)
Custom provider + model…
```

e sono presenti anche controlli per:

- strict BUILD gate;
- Best-of-N alpha;
- execution profile.

**Stato:** UI presente; manca consolidamento smoke/round-trip.

---

## 3. P1 principale — VerifierService runtime wiring

Il problema più importante rimasto è il wiring del `VerifierService` nel normale lifecycle Kraken.

Il servizio esiste, ma la chiusura del contratto richiede test end-to-end che dimostrino che:

```text
deterministic evidence
       │
       ▼
CompletionPolicy
       │
       ├── PASS
       ├── BLOCKED
       └── REPAIR_REQUIRED
```

resta l’autorità finale anche quando il verifier LLM è attivo.

### Lock test necessario

Caso 1:

```text
deterministic criterion = UNKNOWN/FAIL
verifier LLM = CONFIRMED
```

Risultato atteso:

```text
CompletionPolicy = BLOCKED
strict mode => no clean success
```

Caso 2:

```text
deterministic criteria = PASS
verifier LLM = REJECTED
```

Risultato atteso:

- deterministic completion non viene riscritto;
- la review LLM viene mostrata come advisory/risk;
- il sistema può richiedere attenzione, ma non falsificare il verdict deterministico.

### Priorità

**P1 / Exit-2.3**

---

## 4. Criteria Pack ancora non completamente nativo nel Kraken path

Il `codingCriteriaPack()` esiste, ma il runtime Kraken continua a dipendere in parte dalla struttura legacy della selection e dal verify tentacle report.

Oggi il flusso è ancora troppo vicino a:

```text
Kraken selection
      ↓
required checks
      ↓
verify tentacle
      ↓
verification bridge
      ↓
CompletionPolicy
```

Il target 2.0 è:

```text
Task
 ↓
AcceptanceCriteria
 +
Zelari Coding Criteria Pack
 ↓
VerificationEngine
 ↓
actual deterministic checks
 ↓
EvidenceRef
 ↓
CompletionPolicy
```

Il bridge è corretto come fase di migrazione, ma non deve restare la forma finale.

### Azione

Portare il criteria pack direttamente nel normale verification path di Kraken.

### Priorità

**P1 / Exit-2.4**

---

## 5. EvidenceRef deve diventare realmente event-backed

Nel bridge attuale alcune verify note vengono trasformate in pseudo-evidence di tier `tool-output`.

Esempio concettuale:

```text
verify agent says:
"npm test: 58 passed"
```

e questa stringa viene usata come riferimento evidence.

Questo è più forte della pura narrazione finale, ma non è ancora la forma ideale P1.

Il target è:

```text
VerificationResult
       ↓
EvidenceRef
       ↓
session seq / event id
       ↓
actual tool/result
       ↓
real command output
```

### Target TypeScript

```ts
interface EvidenceRef {
  eventSeq: number;
  tier: EvidenceTier;
  digest?: string;
}
```

Il verify agent può ancora aggiungere una note, ma la note non deve essere confusa con il tool output originale.

### Priorità

**P1 prima della stable**

---

## 6. Mission progress / advisory early-stop

Il core mission e `VerifierService.progressScore()` esistono.

Manca ancora la vera integrazione:

```text
mission evidence
      +
deterministic progress
      +
optional verifier trend
      ↓
mission continuation policy
```

Il progress deve restare advisory:

- nessun goal rewrite silenzioso;
- nessun done solo da score;
- nessun early-stop se required criteria restano incompleti;
- steer utente sempre sovrano.

### Priorità

**Exit-2.5, dopo verifier wiring e criteria pack**

---

## 7. Strict Done — decisione di prodotto ancora da congelare

Il gate strict esiste e può produrre:

```text
blocked after repair
→ non-zero exit
→ session status stopped
```

È una buona implementazione.

La questione aperta è il **default**.

### Opzione A

Kraken interattivo:

```text
strict done = opt-in
```

Mission:

```text
strict done = default
```

### Opzione B

Tutta la 2.0 build:

```text
deterministic verification default
```

con intensità adattiva.

La soluzione consigliata:

```text
Kraken interactive
→ strict configurable

Mission
→ strict evidence gate default
```

La decisione va congelata prima della stable.

---

## 8. `history_snapshot` legacy

`history_snapshot` è ancora presente in alcuni percorsi.

Ora non è più una source of truth del modello, quindi non è P0.

Può restare temporaneamente come:

- UI compatibility;
- export compatibility;
- migration helper.

Prima della RC va però valutato:

- deprecazione;
- rimozione;
- oppure documentazione esplicita come mirror non canonico.

Target:

```text
Session spine = canonical
history_snapshot = compatibility only
```

---

## 9. Desktop — manca il round-trip smoke

La UI del verifier esiste.

Manca un test/smoke completo:

```text
Desktop settings
   ↓
Same as session / Dedicated
   ↓
persist
   ↓
restart/load
   ↓
runtime resolution
   ↓
verification event logs actual model
```

Il test deve coprire:

### Inherit

```text
Primary = A
Verifier = inherit

effective verifier = A
```

### Dedicated

```text
Primary = A
Verifier = B

effective verifier = B
```

### Reset

```text
Dedicated B
→ clear override
→ inherit A
```

### Priorità

**Exit-3.1**

---

## 10. Profile smoke tests

I profili esistono ma serve una matrice smoke reale.

Minimo:

```text
minimal + plan
minimal + build

kraken + plan
kraken + build

council + plan

mission + build
```

Usare provider fake/deterministici dove possibile.

Obiettivi:

- profile loader corretto;
- capability manifest corretto;
- Session metadata corretto;
- nessun side effect non consentito in plan;
- host/profile/phase wiring stabile.

### Priorità

**Exit-3.2**

---

## 11. GUIDA 2.0 ancora incompleta

La guida deve documentare chiaramente:

```text
Host
Profile
Phase
Session spine
resume
fork
export session
Strict Done
VerificationEngine
Verifier LLM
Same as session
Dedicated model
Progress
Best-of-N alpha
```

Le sezioni session/history legacy vanno aggiornate per distinguere:

```text
legacy session/history compatibility
```

da:

```text
2.0 canonical Session spine
```

### Priorità

**Exit-3.3**

---

## 12. MIGRATION 1.x → 2.x da completare

Il file di migration espone già i nuovi package path 2.0, ma deve spiegare il cambiamento fondamentale:

### Prima

```text
consumer reconstructs/provides history
```

### Dopo

```text
append Session events
       ↓
deriveMessages()
       ↓
AgentHarness
```

Documentare anche:

- profile metadata;
- resume/fork;
- verification contract;
- EvidenceRef;
- eventuali legacy adapters;
- breaking changes effettive.

### Priorità

**Exit-3.4**

---

## 13. CI matrix

La CI corrente è un buon gate singolo, ma non una vera matrix.

Zelari tocca componenti sensibili alla piattaforma:

- shell;
- paths;
- process groups;
- signals;
- worktrees;
- locks.

Prima della RC aggiungere almeno smoke multi-OS.

### Proposta

Full suite:

```text
Ubuntu + Node 24
```

Core/session/runtime smoke:

```text
Ubuntu
Windows
macOS
```

Possibile Node matrix:

```text
Node 20
Node 24
```

Desktop build smoke dove ragionevole.

### Priorità

**Exit-3.5**

---

## 14. Headless Session smoke end-to-end

Serve un test prodotto:

```text
headless run
   ↓
session_started
   ↓
session id
   ↓
resume
   ↓
second turn
   ↓
export session
   ↓
fresh reader/replay
   ↓
same semantic trajectory
```

Eseguirlo almeno per:

```text
Kraken
Council
```

e, se possibile, Mission.

### Priorità

**Exit-3.6**

---

## 15. Dependabot / dependency security

Prima di una RC:

```text
alerts
  ↓
triage
  ↓
runtime vs dev-only
  ↓
reachable vs non-reachable
  ↓
upgrade / mitigate / documented accept
```

Gli high alert non dovrebbero restare senza triage prima di una RC.

Non è necessario bloccare l’alpha su ogni warning moderato, ma serve una fotografia firmata.

---

## 16. Cleanup tecnico

Piccoli punti da ripulire prima della RC:

- commenti duplicati / residue nel verification bridge;
- `@ts-nocheck` nei file centrali quando eliminabile;
- legacy adapter chiaramente marcati;
- flag alpha documentati;
- dead code prodotto dalla migrazione Session;
- eventuali env flag sostituiti da config/profile policy quando appropriato.

Non sono priorità architetturali, ma migliorano la qualità della RC.

---

## 17. Cosa NON va più rifatto

Non riaprire questi temi salvo bug:

- Session spine;
- `deriveMessages` canonical path;
- replay invariants;
- root/core version alignment;
- public exports;
- WorkspaceProvider;
- execution seams;
- host/profile separation;
- versioned profiles;
- CompletionPolicy;
- deterministic evidence tiers;
- strict non-zero exit;
- verifier `inherit | fixed`;
- Desktop verifier selector;
- Desktop strict gate;
- Desktop BoN alpha control.

Il rischio attuale è scope creep, non carenza di fondamenta.

---

## 18. Roadmap consigliata

### Alpha.7 — chiudere Exit-2

Ordine:

1. **VerifierService runtime wiring + lock tests**
2. **Criteria Pack nativo nel Kraken verification path**
3. **EvidenceRef event-backed**
4. **Mission progress/advisory early-stop**
5. nessuna nuova grande feature

Obiettivo:

```text
Verification 2.0 nativa
```

e non più principalmente:

```text
legacy verify report
→ 2.0 adapter
```

---

### Alpha.8 / Beta — Exit-3

1. Desktop verifier round-trip smoke
2. profile smoke matrix
3. GUIDA 2.0
4. MIGRATION completa
5. CI multi-OS
6. headless resume/export smoke
7. dependency triage
8. cleanup legacy mirrors

---

### RC.1

Una RC dovrebbe iniziare solo quando il circuito è completo:

```text
AcceptanceCriteria
       ↓
deterministic checks
       ↓
real event-backed evidence
       ↓
CompletionPolicy
       ↓
optional verifier
       ↓
logged verdict
       ↓
host / mission consume verdict
```

A quel punto congelare feature nuove e concentrarsi solo su:

- bug;
- regressioni;
- portability;
- docs;
- security;
- migration.

---

## 19. Criteri per passare a RC

### Session

- [ ] single canonical context path
- [ ] resume/replay smoke
- [ ] export smoke
- [ ] no legacy source-of-truth

### Verification

- [ ] criteria pack realmente usato
- [ ] verifier advisory lock test
- [ ] evidence refs a tool/session events
- [ ] strict completion behavior definito
- [ ] false-done test suite

### Profiles/runtime

- [ ] profile smoke matrix
- [ ] plan/build capability tests
- [ ] worktree isolation smoke

### Mission

- [ ] progress integration
- [ ] interrupt/resume
- [ ] evidence-based completion

### Desktop

- [ ] inherit verifier smoke
- [ ] dedicated verifier smoke
- [ ] reset/fallback smoke

### Docs

- [ ] GUIDA 2.0
- [ ] MIGRATION 2.0
- [ ] flag alpha documentati

### CI/security

- [ ] OS matrix minima
- [ ] Node versions supportate testate
- [ ] dependency alerts triaggiati
- [ ] principles/version/typecheck/tests verdi

---

## 20. Verdetto

L’alpha.6 ha superato la fase in cui Zelari 2.0 era principalmente una nuova architettura affiancata alla 1.x.

La nuova spine è ora reale.

Ciò che manca è soprattutto trasformare Verification 2.0 da:

```text
legacy verification
       ↓
2.0 bridge
       ↓
CompletionPolicy
```

a:

```text
AcceptanceCriteria
       ↓
native deterministic verification
       ↓
event-backed EvidenceRef
       ↓
CompletionPolicy
       ↓
optional independent verifier
```

Questa è la milestone qualitativa più importante prima della RC.

La regola da seguire adesso è:

> **Non aggiungere più capacità finché il circuito evidence → completion non è nativo, testato e tracciabile end-to-end.**

E la priorità operativa è:

> **Alpha.7 = Verification 2.0 completa. Alpha.8/Beta = surface, docs, portability e hardening. Poi RC.**
