Esatto. Avevo allargato troppo il bersaglio. **Kraken deve restare Kraken**: DAG, tentacoli, parallelismo, worktree, verify/rework. Da DSH prenderei solo alcuni meccanismi interni che possono rendere *questo* modello molto più efficiente.

Il punto che vedo più importante nel Kraken attuale è questo: ogni tentacolo costruisce un `SubAgentContext` nuovo, poi un nuovo `AgentHarness` con `system + user + tools`; inoltre il parent riceve solo la conclusione finale del subagent. È una buona architettura di isolamento, ma significa che retry, rework e task correlati tendono a ripartire “freddi”. 

### 1. La cosa che ruberei davvero da DSH: **tentacoli continuabili**

DSH ha introdotto il concetto di child session persistente/continuabile: il subagent può avere una sessione durabile e una activation riutilizzabile invece di essere sempre un processo cognitivo usa-e-getta. 

Questo per Kraken sarebbe fortissimo, soprattutto nel ciclo:

```text
general writer
      ↓
verify
      ↓ FAIL
rework
      ↓
verify
```

Oggi il rework è comunque guidato come `general`; riusa il worktree del writer, cosa ottima, ma il modello è un nuovo tentacolo. 

Io farei:

```text
Writer lineage W1
│
├─ turn 1: implementazione
│
├─ verifier esterno
│
├─ turn 2: "verifier found these issues..."
│
├─ verifier esterno
│
└─ turn 3 eventuale
```

**Stesso writer session/harness**.

Questo significa che al rework il modello ha già:

- file che ha letto;
- ragionamento operativo/model-visible precedente;
- decisioni prese;
- patch applicate;
- tool result utili;
- soprattutto il **prefix provider già caldo**.

Questa per me è **P0 assoluta**.

Non farei sessioni continuabili per tutti i nodi. Solo per una **lineage**:

```ts
writer root
   ↳ retry
   ↳ rework
   ↳ repair
```

Il verifier resta deliberatamente fresh, così conserva indipendenza.

---

### 2. `buildUpstreamContext()` va trasformato da testo a **evidence packet**

Qui Kraken oggi ha già avuto l'intuizione giusta: i risultati delle dipendenze vengono passati downstream e limiti a 2800 char per dependency / 8000 totali. Però attualmente prendi `dep.result` come stringa e fai truncation. 

Questo:

```ts
raw.slice(0, cap)
```

è economico, ma semanticamente cieco.

Ruberei da DSH l'idea che la superficie model-visible non debba necessariamente coincidere con tutto ciò che è stato prodotto, e la applicherei in maniera **Kraken-native**. DSH fa pruning deterministico dei risultati tool prima della summarization. 

Farei produrre ai tentacoli qualcosa del genere:

```ts
interface KrakenEvidence {
  summary: string;

  files: Array<{
    path: string;
    symbols?: string[];
    lines?: [number, number][];
  }>;

  findings: Array<{
    id: string;
    claim: string;
    confidence: number;
  }>;

  decisions?: string[];
  commands?: string[];
  changedFiles?: string[];

  artifacts?: Array<{
    type: 'diff' | 'test' | 'log';
    ref: string;
  }>;
}
```

E downstream:

```text
explore result 12k tokens
        ↓
KrakenEvidence ~800 tokens
        ↓
general
```

Non devi fare LLM summarization: **il tentacolo deve già chiudere con un protocollo strutturato**.

Questa sostituirebbe gradualmente `TaskNode.result?: string` con qualcosa tipo:

```ts
result?: string;
evidence?: KrakenEvidence;
```

backward-compatible.

---

### 3. **Kraken Observation Cache** condivisa tra tentacoli

Questa non la copierei letteralmente da DSH: è una conseguenza particolarmente adatta alla tua architettura.

Hai fino a 12 tentacoli paralleli per default. 

È molto probabile che più explore/general/verify facciano:

```text
read package.json
read tsconfig.json
grep AgentHarness
read executor.ts
git diff
...
```

indipendentemente.

Aggiungerei una cache **di osservazioni**, non di risposte LLM:

```ts
KrakenObservationCache

key = hash(
  repoSnapshot,
  cwd/worktree,
  tool,
  normalizedArgs
)
```

Esempio:

```text
tentacle A:
read_file("src/foo.ts")
→ filesystem
→ cache blob SHA abc

tentacle B:
read_file("src/foo.ts")
→ cache hit

tentacle C:
read_file("src/foo.ts")
→ cache hit
```

Per tool read-only:

- `read_file`
- `grep_content`
- `list_files`
- `ast_outline`
- `ast_find_symbol`
- LSP read operations
- semantic search

potrebbe essere enorme.

Invalidazione semplice:

```text
write/edit/apply_diff
       ↓
invalidate(path)

git/worktree change
       ↓
new snapshot namespace
```

Questo migliora **wall-clock e I/O**, e indirettamente token usage perché puoi restituire risultati già normalizzati/pruned.

---

### 4. Creerei un **Kraken Request Profile** per ogni tipo di tentacolo

Oggi `createSubAgentContext()` viene esplicitamente chiamato per ogni invocation e restituisce provider, model, registry e tool schemas. 

Separerei:

```text
oggi:

createSubAgentContext()
 ├ provider
 ├ model
 ├ ToolRegistry
 ├ AgentToolSpec[]
 └ cwd-dependent state
```

in:

```text
KrakenAgentProfile              ExecutionContext
─────────────────              ────────────────
provider                       cwd
model                          worktree
systemPrompt                   permissions
toolSchemas                    AbortSignal
generationConfig               registry executors
fingerprint
```

Il primo è immutabile e cached:

```ts
profiles.get('explore')
profiles.get('general')
profiles.get('verify')
```

Il secondo nasce per ogni node.

Questo rende molto più facile garantire:

```text
general #1
general #2
general #3
```

abbiano **system prompt, tool schemas, ordine tool e generation config byte-identical**.

È il principio dietro la stabilità della prefix cache che DSH cerca di preservare: cambiare configurazioni davanti alla parte nuova rompe la riusabilità del prefisso. 

Non serve introdurre il loro framework: basta una tua struttura:

```ts
interface KrakenAgentProfile {
  kind: TaskAgentKind;
  provider: string;
  model: string;

  system: string;
  tools: readonly AgentToolSpec[];

  fingerprint: string;
}
```

---

### 5. Renderei il **context del grafo append-only**, non riscritto

Questo è un altro principio DSH che vale la pena rubare.

Nel planner hai:

```text
Goal
workspace
previousAttempt
```

e il workspace viene costruito come summary fino a 24 entry. 

Per una run Kraken farei invece creare una volta:

```ts
KrakenRunContext {
  goal
  repoRoot
  gitHead
  branch
  projectDigest
  relevantInstructions
}
```

con fingerprint:

```text
krctx:a3d9...
```

e quello resta congelato per tutta la run.

I nodi aggiungono soltanto:

```text
RunContext
+ node prompt
+ dependency evidence
```

non ricostruiscono continuamente la descrizione globale.

Il concetto corrisponde alla distinzione DSH tra contesto stabile e runtime context materializzato solo quando cambia. 

Per Kraken questo è molto più semplice del loro sistema generale.

---

### 6. Kraken dovrebbe avere **tool-result pruning locale**

Il parent già riceve solo il risultato finale del tentacolo, quindi sei già messo bene rispetto a molti agent system. 

Ma *dentro* il tentacolo un `grep`, test output o compiler output può continuare a gonfiare la context window durante i suoi 10–20 tool call. I `general/deep`, ad esempio, arrivano a 20 tool call. 

Quindi implementerei una mini versione Kraken del pruner DSH:

```text
tool result < 8k chars
→ keep

tool result > 8k
→ head + salient lines + tail
→ original salvato fuori contesto
```

Ancora meglio:

```text
test output:
  FAIL lines
  stack traces rilevanti
  final summary

grep:
  first N hits per file
  total count

read:
  requested symbol/range
  non intero file
```

Questa probabilmente vale più di una compaction LLM del tentacolo.

---

### 7. Ridurrei drasticamente i verifier LLM inutili

Qui andrei oltre DSH.

Il planner Kraken aggiunge automaticamente un `verify` per ogni `general`, e con più general crea poi il merge. 

È corretto per qualità, ma costoso.

Fare:

```text
general
  ↓
deterministic verification
  │
  ├─ clean → PASS
  │
  └─ ambiguous/risky
        ↓
      LLM verifier
```

Per esempio:

```text
TypeScript change
→ typecheck + targeted tests + lint

simple rename
→ LSP references + tests

generated file
→ schema validation

UI semantic behavior
→ LLM verifier
```

Non eliminerei il verifier. Lo renderei **escalation layer**.

Su grafi con 5 writer potresti passare da:

```text
5 writer
5 LLM verifier
```

a magari:

```text
5 writer
5 deterministic verifier
2 LLM verifier
```

senza perdere la filosofia Kraken.

---

## Quindi la mia priorità sarebbe

| Priorità | Modifica | Prestazioni | Token | Qualità |
|---|---|---:|---:|---:|
| **P0** | Continuable writer lineage | ★★★★★ | ★★★★★ | ★★★★★ |
| **P0** | Structured Evidence Packet | ★★★★☆ | ★★★★★ | ★★★★★ |
| **P0** | Observation cache condivisa | ★★★★★ | ★★★☆☆ | ★★★★☆ |
| **P1** | Stable KrakenAgentProfile | ★★★☆☆ | ★★★★★ cache | ★★★☆☆ |
| **P1** | Tentacle tool-result pruning | ★★★★☆ | ★★★★★ | ★★★★☆ |
| **P1** | deterministic-first verification | ★★★★★ | ★★★★★ | ★★★★☆ |
| **P2** | frozen KrakenRunContext | ★★★☆☆ | ★★★★☆ | ★★★★☆ |

La cosa che cambierebbe davvero l'identità prestazionale di Kraken è questa:

```text
                     KRAKEN
                        │
                ┌───────┴────────┐
                │  Run Context   │
                │ frozen + hash  │
                └───────┬────────┘
                        │
               ┌────────┴─────────┐
               │ ObservationCache │
               └────────┬─────────┘
                        │
           ┌────────────┼────────────┐
           ▼            ▼            ▼
       explore       writer A     writer B
         │              │            │
       evidence      session A     session B
         │              │            │
         └──────────────┤            │
                        ▼            ▼
                    verifier      verifier
                        │ FAIL
                        ▼
                  resume writer A
                  ← NOT new agent
```

**Questa è la direzione che sceglierei.** Non copiare SessionSurface, Cordis, plugin architecture ecc. di DSH. Prenderei da loro essenzialmente **continuation + cache-stable prefix + deterministic pruning**, e li farei diventare feature native del Kraken DAG. 

Se dovessi implementarne **una sola per prima**, farei `continuable writer lineage`: è probabilmente quella con il miglior rapporto modifica/beneficio perché il tuo executor ha già esplicitamente il concetto di `reworks`, lineage e worktree ereditato. Devi far sì che **anche la memoria del writer segua la stessa lineage che oggi segue il filesystem**.
