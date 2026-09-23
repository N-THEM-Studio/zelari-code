# Kraken Graph — Enhancement: il quality gate sul verify

> Stato: **IMPLEMENTATO** (v1.28.x, non ancora rilasciato).
> Documento scritto *dopo* il codice e verificato contro il disco, non prima —
> a differenza di `kraken-graph-engine-plan.md`, che è marcato `PLAN` e descrive
> un design in parte superato da come è finito il codice.
> Ogni path e ogni nome citato qui esiste.

---

## 0. Il problema, in una riga

In `applyResult` ([src/cli/kraken/executor.ts](../../src/cli/kraken/executor.ts)) un nodo era `done` se `res.ok`.
`res.ok` significa "la tentacle è arrivata in fondo senza errori di esecuzione".

Quindi **il testo del verdetto non veniva mai letto.** Un nodo `verify` che girava
correttamente e concludeva *"questo lavoro è sbagliato, mancano tre cose"* veniva
registrato esattamente come uno che concludeva *"tutto a posto"*: `done`,
`isConverged` soddisfatto, grafo convergente sopra un difetto noto.

Conseguenza strutturale: l'unica iterazione che l'engine sapeva fare era su
**fallimento di esecuzione** — retry per nodo, poi un `fix` node con budget
globale 3. Su **giudizio di qualità**, zero. Un prompt del tipo "itera finché il
critic non trova più debolezze" non aveva alcun aggancio meccanico: il critic non
poteva far fallire niente.

---

## 1. Cosa è stato aggiunto

### 1.1 Il parser — `packages/core/src/kraken/verdict.ts` (nuovo, puro)

Rispetta lo split di CORREZIONE-1: logica pura in `@zelari/core`, zero import da
`src/cli`. Stessa forma di `conflict.ts`.

```ts
export type VerifyVerdict = 'pass' | 'fail' | 'unknown';
export function parseVerifyVerdict(text): { verdict, findings }
export interface UnresolvedFinding { nodeId, label, reason, findings }
```

Tre decisioni non ovvie, tutte con un test dedicato:

1. **Vince l'ULTIMA occorrenza del trailer.** I modelli ripetono l'istruzione
   prima di rispondere (*"devo chiudere con VERDICT: PASS o VERDICT: FAIL"*).
   Uno scan first-match legge quell'eco come risposta e **inverte il gate**
   proprio sui run verbosi, cioè quelli in cui il giudizio conta di più.
2. **`unknown` ≠ `fail` e si comporta come PASS (fail-open).** Un verify senza
   trailer non deve poter bloccare ogni grafo — un drift del prompt
   diventerebbe un blocco totale. Ma `unknown` resta distinto da `pass` perché
   **viene riportato**: un gate che ha smesso silenziosamente di funzionare è
   peggio di nessun gate.
3. Il trailer è riconosciuto solo **a inizio riga**, con tolleranza per la
   decorazione markdown (`**VERDICT: FAIL**`, `- VERDICT: PASS`, `> …`) e per
   testo in coda (`VERDICT: FAIL — 3 gaps`). Prosa che nomina la parola a metà
   frase non ribalta niente.

### 1.2 Il prompt — `buildAutoVerifyPrompt` in [planner.ts](../../src/cli/kraken/planner.ts)

Il verify chiude ora con una sezione `## How to report your verdict` che chiede
il trailer come **ultima riga assoluta**, e dice al modello che un FAIL rimanda
indietro il lavoro insieme a tutto ciò che ha scritto sopra — quindi i gap vanno
scritti in modo azionabile (file, cosa è sbagliato, cosa dovrebbe essere), e le
preferenze stilistiche non sono un FAIL.

**Non** è stata aggiunta una regola sul trailer al system prompt del planner:
`PlannedNodeSchema` accetta solo `kind: 'explore' | 'general'`, quindi il modello
non scrive mai nodi `verify` — li inietta `buildGraphFromPlan`. È stata aggiunta
invece la regola che conta adesso: i criteri di `acceptance` **sono applicati**,
quindi devono essere verificabili aprendo un file o eseguendo un comando, mai
soggettivi. Un criterio che nessuno può verificare ora brucia un giro di rework.

### 1.3 L'esecuzione — dal FAIL al rework

In `applyResult`, ramo `res.ok && node.kind === 'verify'` → `applyVerifyVerdict`.

Il nodo verify resta **`done` in ogni caso**: ha fatto il suo lavoro, e farlo
bene significa essere libero di dire di no. È il **writer** che torna indietro.

Su FAIL nascono due nodi (`spawnReworkPair`):

| Nodo | Kind | Deps | Note |
|---|---|---|---|
| `rework-<root>-<n>` | `fix` | `[verifyId]` | prompt = task originale + `## Reviewer findings`; eredita `scope` e `acceptance` del writer |
| `verify-rework-<root>-<n>` | `verify` | `[reworkId]` | stesso prompt del verify originale |

Chi dipendeva dal vecchio verify (tipicamente il `merge`) viene **ripuntato** sul
nuovo — stesso pattern di `spawnFixNode`. Senza questo il merge unirebbe il
branch a metà rework.

L'aciclicità è preservata per costruzione: i nodi nuovi hanno archi solo verso
nodi già esistenti, e il rewiring sposta un arco **in avanti** lungo la catena.

### 1.4 Il punto delicato: un solo worktree per scope

Con `ZELARI_KRAKEN_WORKTREE=1` il writer lavora in un worktree isolato,
registrato in `nodeRunState` **sotto l'id del writer**, e il merge avviene dopo
la verifica. Se il rework aprisse un worktree proprio si otterrebbero **due
branch sullo stesso scope**: `collectWorktreeSources` risale ai writer, quindi il
lavoro del rework verrebbe unito mai o due volte — esattamente la classe di
fallimento che la correzione sul merge node aveva appena chiuso.

Soluzione, senza toccare `taskTool`:

- la creazione del worktree dentro `runTentacle` è governata da
  `agent === 'general' && deps.allowWorktree !== false`. Il rework passa
  **`deps: { ...this.deps, allowWorktree: false }`** → nessun worktree nuovo, e
  `cwdOverride` vince;
- `cwdOverride` = il worktree del writer, risolto da
  **`inheritedWorktreeCwdFor`** (l'ex `verifyCwdFor`, generalizzato: serviva già
  esattamente questo ai verify);
- l'handle resta registrato sotto il writer, quindi il merge continua a vedere
  **un** branch.

Coperto da un test che asserisce `cwdOverride`, `allowWorktree: false` e
`deferMerge: false` sulla chiamata del rework.

### 1.5 Budget per lineage, non per nodo

**Questo è il bug che il test ha trovato e che vale la pena ricordare.** Il
contatore delle round era inizialmente per id di nodo. Ma un rework *è* un
writer: alla seconda bocciatura il writer da rimandare indietro è il rework
stesso, il cui contatore era a zero. Risultato: catena
`rework → verify → rework → …` **infinita**, terminata solo dal cap di
iterazioni dello scheduler — e quindi grafo non convergente.

Le round si contano ora per **lineage** (`reviewLineage: reworkId → writer
originale`), e i nodi prendono il nome dalla radice: `rework-g1-1`,
`rework-g1-2`, non `rework-rework-g1-1-1`.

Il contatore è **separato da `fixBudgetRemaining`**: un rework di qualità non
deve consumare il budget riservato ai fallimenti di esecuzione. Test dedicato.

### 1.6 Convergenza degradata

`ZELARI_KRAKEN_MAX_REVIEW_ROUNDS`, **default 1**. Una round è un re-run completo
del writer più una verifica: il costo è circa il raddoppio di quel ramo, e il
secondo parere di un modello che ha appena giudicato il lavoro di un suo pari ha
rendimenti in forte calo.

A budget esaurito il grafo **converge lo stesso**, ma:

- il `result` del writer viene marcato
  `[accepted with unresolved verify findings from "…"]` (stesso pattern del
  marker di `reconcileRepairedNode`);
- `KrakenExecutionSummary.unresolvedFindings` elenca il verdetto;
- il digest stampa una sezione `unresolved verify findings`;
- lo **snapshot cross-run** lo include, e `formatSnapshotForPlanner` non fa più
  early-return sui run convergenti: il nodo finisce sotto *"Completed but
  REJECTED by review"* invece che sotto *"do NOT redo this work"*. Prima un run
  convergente-ma-bocciato non diceva niente al planner successivo, che quindi
  archiviava il lavoro rifiutato come concluso.

La scelta "degradato invece che fallito" è deliberata: un grafo che non converge
mai per un difetto residuo perde anche tutto il lavoro buono che ha attorno.

---

## 2. Le due lacune di budget chiuse insieme

**Fix budget proporzionale** — `DEFAULT_FIX_BUDGET = 3` era un numero cieco alla
dimensione del grafo: su 20 nodi si esauriva ai primi tre fallimenti e ogni
fallimento successivo andava terminale, cascade-skippando i dipendenti. *Più il
grafo era grande, meno riparazione riceveva.* Ora
`max(3, ceil(nodeCount / 2))`, risolto in `execute()` quando la dimensione è
nota. `ZELARI_KRAKEN_FIX_BUDGET` continua a vincere.

**Budget wall-clock globale** — `ZELARI_KRAKEN_GRAPH_TIMEOUT_MS`, default `0`
(disattivo). Esistevano solo timeout per nodo, che non dicono nulla sul totale:
grafo largo + retry + fix + rework può correre molto più a lungo di qualsiasi
singolo nodo senza che nulla se ne accorga. Alla scadenza si usa il **path di
cancellazione già esistente**, quindi il run si assesta comunque, i nodi mai
partiti diventano `skipped` e il digest viene stampato lo stesso.

---

## 3. Superficie di configurazione

| Variabile | Default | Effetto |
|---|---|---|
| `ZELARI_KRAKEN_MAX_REVIEW_ROUNDS` | `1` | round di rework per lineage su verify FAIL; `0` disattiva il rework (i FAIL diventano findings irrisolti) |
| `ZELARI_KRAKEN_GRAPH_TIMEOUT_MS` | `0` | tetto wall-clock sull'intero run; `0` = nessuno |
| `ZELARI_KRAKEN_FIX_BUDGET` | `max(3, ⌈n/2⌉)` | invariata come nome, default ora proporzionale |

---

## 4. Cosa questo NON risolve

Va detto, perché è la differenza tra un gate e una garanzia.

**Il giudizio resta quello di un modello.** Il gate rende *azionabile* il
verdetto; non lo rende corretto. Un verify che sbaglia FAIL costa una round; uno
che sbaglia PASS lascia passare il difetto esattamente come prima. Criteri di
acceptance meccanici (un comando che esce 0, una firma esportata) valgono molto
più di criteri descrittivi — per questo il system prompt del planner ora lo
chiede esplicitamente.

**Niente replanning adattivo.** La topologia è ancora decisa dal planner in una
passata sola, prima che esista qualunque evidenza. Un `explore` può cambiare il
*testo* dei prompt a valle (via `buildUpstreamContext`), non la *forma* del
grafo. Questa è la fase successiva naturale, e la più invasiva: richiede nodi che
appendono nodi sulla base di ciò che hanno scoperto, con un budget di crescita
proprio. Il rework introdotto qui è il primo caso di grafo che si estende a
runtime, e il vincolo che ha imposto — *ogni arco nuovo punta solo a nodi già
esistenti* — è la regola da riusare lì.

**Niente criteri percettivi.** Un verify legge file ed esegue comandi. Non vede
uno schermo, non gioca, non ascolta. Chiedere a un critic di giudicare "resa
visiva" o "feel" produce un verdetto inventato, e iterare su un verdetto
inventato è una passeggiata casuale, non un'ottimizzazione. Se il criterio conta
davvero, va reso misurabile (frame-time, replay deterministico, screenshot a seed
fissi confrontati con un riferimento) oppure resta un giudizio umano.

---

## 5. Verifica

```bash
npx vitest run tests/unit/cli-kraken- packages/core/src/kraken/
```

211 test verdi (erano 190). Suite completa: 1950/1954, con 4 rossi **preesistenti
e non correlati** in `core-shellTool.test.ts` (3, dipendenti dall'ambiente:
`pwsh`/`powershell` non classificati su questa macchina) e `cli-skillsMd.test.ts`
(1). Baseline prima di questo lavoro: 1918/1922, stessi 4.

I test che meritano di essere letti prima di modificare questo codice:

- `verify verdict gate > runs the rework inside the writer worktree and does NOT open a second one` — la regressione del doppio branch (§1.4);
- `verify verdict gate > honours maxReviewRounds > 1` — il conteggio per lineage (§1.5);
- `verify verdict gate > does not spend the fix budget on rework rounds` — la separazione dei due budget;
- `parseVerifyVerdict > lets the LAST trailer win…` — l'inversione del gate sui run verbosi.
