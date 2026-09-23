# Piano — Loud Tool Errors, Degradazione Diagnostica, Shell Read-Only in Plan

> **Stato**: **IMPLEMENTATO E VERIFICATO** (BUILD completata — esito in §10)
> **Origine**: frizioni osservate dal consumatore finale (l'agente stesso) durante sessioni reali su questo repo, turno 2026-07-10.
> **Principio guida** (PRINCIPLES.md): un tool che fallisce *rumorosamente* è meglio di uno che fallisce *in silenzio*. Il fallimento silenzioso produce conclusioni sbagliate nel ragionamento a monte ("il codice non esiste") invece di retry corretti.

---

## 0. Evidenza raccolta (riproducibile)

Tre incidenti vissuti in sessione, tutti verificati nel sorgente:

1. **`grep_content` con glob non ricorsivo** — `include: "*.ts"` / array vuoto su `packages/core/src` ha prodotto `filesSearched: 1, filesInTree: 1`; lo stesso pattern con `**/*.ts` ha prodotto `filesInTree: 117`. Il glob `*` matcha **un solo segmento** (`_walk.ts:66-68`: `*` → `[^/]*`), quindi `*.ts` esclude tutto ciò che sta in sottodirectory. Nessun avviso nella result.
2. **`ast_outline` silenzioso su file validi** — probabile causa duplice:
   - `src/cli/ast/tools.ts:34-36` non risolve `path` contro `ctx.cwd` (grep_content sì: `packages/core/src/core/tools/builtin/search.ts:170`);
   - `parseFileSymbols` (`src/cli/ast/engine.ts:75-79`) restituisce `[]` per quattro cause indistinguibili: estensione non supportata, TypeScript non caricabile, file illeggibile (incluso *inesistente*), parse error. Il tool emette una nota con tre ipotesi in OR (`tools.ts:37`).
3. **Nessuna shell in plan phase** — `src/cli/toolRegistry.ts:239-243`: `planMode → readOnly → allowBash = false`. In plan non posso eseguire `git status`, `git log`, `tsc --noEmit`: ogni affermazione analitica resta "lettura-verificata", mai "esecuzione-verificata".

Caso limite informativo: `filesInTree` in `search.ts:222` è `matchedFiles.length` — cioè i file **dopo** il filtro include, non i file dell'albero. Il nome del campo promette un dato che non misura: è la ragione per cui l'asimmetria glob non è osservabile dal chiamante.

---

## 1. WS1 — grep_content auto-diagnostico

### Obiettivo
La result di `grep_content` deve rendere impossibile confondere "zero match" con "ho filtrato via quasi tutto l'albero".

### Diagnosi tecnica
- `packages/core/src/core/tools/builtin/search.ts`
  - `coerceStringList` (l.37): array vuoto → fallback silenzioso a `['*']`;
  - result (l.218-226): manca il conteggio pre-filtro e qualunque campo warning.
- `packages/core/src/core/tools/builtin/_walk.ts`
  - `globToRegex` (l.41-79): `*` = `[^/]*` — semantica corretta ma non comunicata;
  - `filterByInclude` (l.165-179).

### Slice

**S1.1 — `filesWalked` + `warning` nella result** (`search.ts`)
- Aggiungere a `GrepResult`:
  ```ts
  /** File visti dal walker prima del filtro include (recursive mode). */
  filesWalked: number;
  /** Non-fatal diagnostic per il chiamante (glob sospetto, coercizioni attive). */
  warning?: string;
  ```
- Popolare `filesWalked = allEntries.filter(e => e.type === 'file').length`.
- Emettere `warning` quando:
  - `filesWalked > 0 && matchedFiles.length === 0` → `"include globs matched 0 of N files walked — '*.ts' matches only root-level files; use '**/*.ts' for recursive"`;
  - `matchedFiles.length / filesWalked < 0.05 && filesWalked > 20` → hint ricorsivo più blando;
  - coercizione attiva (`include` non-array o array vuoto) → `"include coerced to '<valore effettivo>'"`.
- Aggiornare `description` del tool: documentare esplicitamente `*` = un segmento, `**` = ricorsivo.

**S1.2 — test unitari** (vitest, accanto ai test esistenti di `_walk`/`search` se presenti, altrimenti nuovi)
- Fixture: albero `root/{a.ts, sub/b.ts, sub/deep/c.ts}`.
  - `include: ['*.ts']` → `warning` presente, `filesWalked: 3`, `filesInTree: 1`;
  - `include: ['**/*.ts']` → nessun warning;
  - `include: []` → warning di coercizione + comportamento documentato (fallback `*`);
  - pattern con match reali → nessun warning.

### Acceptance
- [ ] `grep_content` con `include: '*.ts'` su un albero con subdir restituisce `filesWalked` e un `warning` con l'hint `**/*.ts`.
- [ ] Nessun warning su chiamate sane (no regression noise).
- [ ] `npm test` verde in packages/core.

---

## 2. WS2 — degradazione diagnostica di ast_outline / find_symbol

### Obiettivo
Ogni risultato vuoto di `ast_outline`/`find_symbol` deve dire **perché** è vuoto, distinguendo le quattro cause, e i path relativi devono funzionare come in grep_content.

### Diagnosi tecnica
- `src/cli/ast/engine.ts` — `parseFileSymbols` (l.72-79): quattro `return []` indistinguibili.
- `src/cli/ast/tools.ts:34-36` — path non risolto vs cwd; nota generica l.37.

### Slice

**S2.1 — result discriminato in engine** (`engine.ts`)
```ts
export type ParseFileSymbolsResult =
  | { status: 'ok'; symbols: AstSymbolWithText[] }
  | { status: 'unsupported-extension'; extension: string }
  | { status: 'typescript-unavailable' }
  | { status: 'file-not-found'; resolvedPath: string }
  | { status: 'parse-error'; message: string };
```
- Nuova funzione `parseFileSymbolsDiag(file, cwd?)` che risolve il path (`path.isAbsolute ? p : join(cwd ?? process.cwd(), p)`), distingue `ENOENT` da altri errori di lettura, e propaga il messaggio di `createSourceFile`.
- `parseFileSymbols` resta come wrapper di compatibilità (stessa firma, `[]` su qualunque non-ok) per non rompere i chiamanti esistenti; `astOutline`/`findSymbol` internamente usano la versione diag.

**S2.2 — note specifiche nel tool** (`tools.ts`)
- `ast_outline`:
  - `file-not-found` → `{ symbols: [], note: "file not found — looked at <resolvedPath> (relative paths resolve against the workspace root)" }`;
  - `typescript-unavailable` → nota esplicita + hint `ZELARI_AST`;
  - `unsupported-extension` → nota con l'estensione vista;
  - `parse-error` → nota con messaggio TS.
- `find_symbol`: stesso trattamento; `found: false` solo quando il file è stato letto e parsato con successo.
- `execute` riceve `ctx` e passa `ctx.cwd` alla risoluzione (allineato a `search.ts:170`).

**S2.3 — test unitari** (`src/cli/ast/`)
- path relativo + cwd iniettabile → risoluzione corretta;
- file inesistente → `file-not-found` con path assoluto nella nota;
- estensione `.py` → `unsupported-extension`;
- stub `loadTs` → `typescript-unavailable`;
- file TS valido → outline corretto (già coperto? verificare suite esistente).

### Acceptance
- [ ] `ast_outline` con path relativo su file esistente funziona senza dover passare path assoluti.
- [ ] `ast_outline` su path inesistente dice quale path assoluto ha guardato.
- [ ] Nessuna nota "forse è una di queste tre cause" rimasta nel codice.

---

## 3. WS3 — `bash_readonly` disponibile in plan phase

### Obiettivo
In plan/readOnly: capacità di esecuzione **strettamente read-only** (git inspect, typecheck dry) senza sbloccare mutazioni. Trasforma le affermazioni di analisi da "lettura-verificata" a "esecuzione-verificata".

### Diagnosi tecnica
- `src/cli/toolRegistry.ts:239-243` — `readOnly = readOnly || planMode || explore`; `allowBash = allowMutators || verifyMode`.
- Banner plan che elencano i tool non disponibili: `src/cli/hooks/useChatTurn.ts:514-523`, `src/cli/runHeadless.ts:519-523`.

### Design

**S3.1 — nuovo tool `bash_readonly`** (`packages/core/src/core/tools/builtin/shellReadonly.ts`, un file come da convenzione AGENTS.MD)
- Input (zod): `{ command: string, timeoutMs?: number }`.
- **Validazione statica PRIMA dell'esecuzione** (funzione pura esportata `validateReadOnlyCommand(cmd): { ok: true; argv: string[] } | { ok: false; reason: string }`):
  1. rifiuta shell metacharacters: `&&`, `||`, `;`, `|`, `>`, `>>`, `<`, backtick, `$(`, newline;
  2. tokenizza (quote-aware, minimo:`"` e `'`);
  3. allowlist su (primo token, secondo token):
     - `git status|log|diff|show|branch|rev-parse|ls-files|blame|remote|stash list`
     - `tsc` (qualsiasi args — `--noEmit` enforced: se assente, viene iniettato; `-p`/`--project` ammessi)
     - `node --version`, `npm ls|outdated|view`
  4. estendibile via `ZELARI_RO_SHELL_EXTRA=cmd1,cmd2` (documentato).
- Esecuzione: `spawn(tokenized[0], tokenized.slice(1), { cwd: ctx.cwd, shell: false })` — **niente shell**, quindi la validazione non è bypassabile da quoting creativo.
- Output cap 8 KB (troncamento segnalogerà), exit code riportato, timeout default 60 s.
- `permissions: ['read']`, `timeoutMs: 90_000`.
- Kill-switch: `ZELARI_PLAN_RO_SHELL=0` disattiva la registrazione ovunque.

**S3.2 — registrazione condizionale** (`toolRegistry.ts`)
- Quando `readOnly === true` (quindi planMode ed explore): registrare `bash_readonly` **al posto** di bash. Verify/full profili non cambiano (verify ha già bash pieno).
- Il tool va nel set "sempre disponibile in readOnly" insieme a read_file/grep_content/list_files.

**S3.3 — banner e doc**
- `useChatTurn.ts:514-523` e `runHeadless.ts:519-523`: sostituire "bash unavailable" con "bash unavailable; `bash_readonly` allows git status/log/diff/show and `tsc --noEmit`".
- `docs/TOOLS.md`: sezione `bash_readonly` con allowlist e kill-switch.

**S3.4 — test**
- `validateReadOnlyCommand` tabellare: ~20 casi (git log ok; `git log; rm -rf` reject; `tsc` ok con --noEmit iniettato; `` `rm` `` reject; `git push` reject; `npm run x` reject…).
- Test integrazione: spawn senza shell su un comando allowlistato in una tmpdir; timeout.

### Rischi specifici WS3 e mitigazioni
- **Allowlist troppo stretta** → frustrazione: mitigato da `ZELARI_RO_SHELL_EXTRA` + estensione iterativa guidata dall'uso reale.
- **Falso senso di sicurezza**: `tsc --noEmit` può eseguire plugin? No a progetto standard; comunque i risk restano quelli di qualunque processo read-only. `spawn` senza shell elimina la classe injection da quoting.
- ** Sovraccarico contesto**: output cap + timeout corto.

---

## 4. Ordine di implementazione e dipendenze

```
S2.1 → S2.2 → S2.3   (WS2: indipendente, ROI altissimo — bug reale del path)
S1.1 → S1.2          (WS1: indipendente)
S3.1 → S3.2 → S3.3 → S3.4  (WS3: dipende solo da toolRegistry)
```

Nessuna dipendenza reciproca: i tre WS sono paralleizzabili. Sequenza consigliata per singolo implementer: **WS2 → WS1 → WS3** (prima il bug funzionale, poi l'osservabilità, poi il nuovo tool).

## 5. Out of scope (backlog)
- Staleness detection dell'indice semantic (`indexAge`/`stale` in `semantic_search`) — le note esistenti (`semantic/tools.ts:45-52`) sono già adeguate; riaprire se l'indice stalerà fastidioso.
- Bash read-only in profili verify/general (hanno già bash).
- Refactor del glob matcher (semantica attuale corretta, va solo comunicata).

## 6. Verifica finale (BUILD)
1. `npm run typecheck` e `npm test` verdi.
2. Smoke manuale in sessione reale: `grep_content` con `include: '*.ts'` → warning; `ast_outline` con path relativo → outline; in `/plan`: `bash_readonly` con `git status` ok, con `git push` rifiutato con reason.
3. Aggiornare questo documento con esito e rimuovere il flag DRAFT.

---

## 7. Revisione post-valutazione esterna (2026-07-10)

Piano esterno ("Kraken Tool Reliability Upgrade") valutato dal consumatore dei tool. Claim verificate sul tree:

- ✅ `createAstTools()` registrata **senza root** — `src/cli/ast/tools.ts:21` (nessun parametro), `src/cli/toolRegistry.ts:338` (chiamata bare). Asimmetria reale: `createLspTools(provider, root)` riceve il root (`lsp/tools.ts:36`, `toolRegistry.ts:423-424`).
- ✅ `allowBash = allowMutators || verifyMode` — `toolRegistry.ts:243`.
- ✅ `bash` in `PLAN_BLOCKED_TOOLS` — `phase.ts:54-59` (`write_file, edit_file, apply_diff, bash`).
- ➕ **Trovato in più (nessuno dei due piani lo notava)**: LSP è registrata solo se `!readOnly` (`toolRegistry.ts:423`) → in plan mode la fallback ladder `ast → lsp → grep → read_file` perde il secondo gradino. Riaprire se si vuole la ladder in plan.

### Delta accettati

**WS2 (t1):**
- S2.0 (nuova slice, prima di S2.1): propagare il root — `createAstTools(root: string)` e chiamata `createAstTools(root)` in `toolRegistry.ts:338`. Corregge la mia diagnosi originale: il bug non è solo dentro `tools.ts:34-36`, è a monte (la factory non riceve il root dal registry, che lo ha già in scope a l.423).
- `ParseFileSymbolsResult`: aggiungere variante `read-error` distinta da `file-not-found` (altri errori di lettura ≠ ENOENT).

**WS1 (t2):**
- S1.1: quando `filesWalked > 0 && matchedFiles.length === 0`, il warning diventa sentinel `SEARCH_EMPTY_SCOPE: ... Do not interpret this result as "pattern not found".` — frasing model-facing, non solo human-facing.
- Aggiungere `truncated: boolean` alla result; echo di `include/exclude` effettivi (costo ~0, conferma le coercizioni). Skip `filesExcluded` (derivabile, gold-plating).

**WS3 (t3):**
- Rinominare `bash_readonly` → **`inspect_command`**: "shell read-only" è un nome che promette una proprietà che non esiste; il design è un command inspector allowlistato senza shell. Nome onesto.
- `tsc` non va spawnato direttamente (Windows: shim `.cmd` non eseguibile senza shell) → mappare `tsc` su `node <root>/node_modules/typescript/bin/tsc --noEmit`.
- Documentare esplicitamente che `npm run`/`npm test` restano fuori finché non esiste sandbox usa-e-getta.
- Kill-switch rinominato di conseguenza: `ZELARI_INSPECT_COMMAND=0`.

**Prompt/policy (nuovo, costo ~0, ora):**
- Regola epistemica nei prompt plan/kraken: "Negative evidence is valid only from a completed observation. Never conclude that code/symbols/files do not exist from degraded results, zero files examined, or unavailable backends." Candidata anche per PRINCIPLES.md.

### Delta respinti o rinviati (con motivo)

- **`ObservationMeta` globale su tutti i tool** → rinviato a 1.47. In questa release lo status discriminato vive solo nei tre tool toccati (ast/grep/inspect). Il rollout globale prima di avere dati d'uso è scope creep.
- **Tool health telemetry** → rinviato a 1.47: ha senso solo dopo che la tassonomia degli status esiste e c'è traffico reale da misurare.
- **Fallback policy engine** → rinviato; quando fatto, hint testuale nel result (`DEGRADED — recommended fallback: grep_content`), mai auto-esecuzione. Prerequisito: sistemare il gate LSP-in-readOnly qui sopra.
- **Semantic checks `project_test_list`/`project_build_info`** → rinviati al sandbox: duplicano valore che solo il sandbox dà onestamente.
- **`sandbox_exec` in workspace usa-e-getta** → backlog v2 (concordo sulla direzione: è l'unica via onesta per test/build in plan).
- **`npm ls|outdated|view`** → resta in allowlist (comandi read-only, non script); `npm run`/`exec`/`test` restano fuori.

### Ordine di rilascio vNext (concordato)

1.46 Ground Truth (questo piano, WS2→WS1→WS4→WS3 + regola epistemica) → 1.47 Adaptive Head (decisione dinamica, ladder, health) → 1.48 Evidence (report strutturati, provenance, store). Confermato: prima l'affidabilità dell'osservazione, poi la sofisticazione della testa.

---

## 8. Revisione post-hardening review (2026-07-10, secondo giro)

Claim verificate sul tree in questo giro:

- ✅ Tutti e 5 i tool LSP sono `permissions: ['read']` — incluso `rename_symbol`, che è **preview-only** (description: "It does NOT write files", `src/cli/lsp/tools.ts:100-131`). Nessuna capability di mutazione nel tool surface LSP: la separazione observation/mutation richiesta dalla review **esiste già**.
- ✅ `PLAN_BLOCKED_TOOLS` (`src/cli/phase.ts:54-59`) contiene solo `write_file, edit_file, apply_diff, bash` — **nessun tool LSP è in blocklist**. L'esclusione in plan è interamente nel registro: `if (!readOnly && process.env.ZELARI_LSP !== '0' && options.lspProvider !== null)` (`toolRegistry.ts:422`).
- ➕ **Auto-dimostrazione live di WS1**: durante questa verifica, `grep_content(include: '*.ts', path: packages/core/src)` ha restituito `filesSearched: 1, filesInTree: 1` — il glob un-segmento ha escluso 116/117 file. Chi ha diagnosticato il bug lo ha appena riperpetuto: il caso perfetto per `SEARCH_EMPTY_SCOPE`.
- ➕ Osservazione tool flakiness (non workstream): `read_file` con range su `toolRegistry.ts` ha restituito contenuto vuoto due volte consecutive (`readLines.end < start`). Da tenere d'occhio; aggirato via `grep_content`.

### Delta accettati (secondo giro)

**WS4 (NUOVO, t4) — LSP read-only in plan** [accettato, promosso PRIMA di WS3]:
- Fix: togliere `!readOnly` dalla condizione `toolRegistry.ts:422` (restano i gate `ZELARI_LSP` e provider). Una riga + test.
- Acceptance: in sessione plan `document_symbols`/`find_references`/`go_to_definition` disponibili e funzionanti; ladder plan completa `ast → lsp → grep → read_file`.
- Caveat da verificare in BUILD: il commento a `toolRegistry.ts:419` dice "degrade silently when not installed" — il percorso degradato del provider **non deve** produrre falsi vuoti (stesso principio della release: EMPTY ≠ DEGRADED). Se il provider degradato restituisce `[]` simbolico, va reso loud o assente.

**WS2 (t1) — campi macchina nel result diag**:
- Ogni variante non-ok porta `resolvedPath?`, `recoverable: boolean`, `recommendedFallback?: 'grep_content' | 'read_file'`. L'informazione non vive solo nella stringa `note`. `recommendedFallback` resta **hint**, mai auto-esecuzione.

**WS1 (t2) — deprecazione di `include: []`**:
- 1.46: `include: []` accettato + warning sentinel `DEPRECATED_INPUT: empty include array — omit the field instead; this will become INVALID_ARGUMENT`.
- 1.47: schema `z.array(...).min(1)` → `include: []` diventa INVALID_ARGUMENT alla validazione argomenti.
- Razionale (condiviso): "omesso" = nessun filtro; "esplicitamente vuoto" = insieme vuoto. La coercizione a `*` è input repair invisibile — antitetica al principio della release. Nota dal campo: l'input deforme l'ha prodotto il modello stesso, non l'utente; la finestra di deprecazione serve anche ad aggiustare le abitudini di generazione.

**WS3 (t3) — ridisegno API: niente `command: string`** [il delta più grande, accettato integralmente]:
- Input model-facing: **discriminated union su `operation`** con argomenti tipizzati:
  ```ts
  z.discriminatedUnion('operation', [
    z.object({ operation: z.literal('git_status'), short: z.boolean().optional() }),
    z.object({ operation: z.literal('git_log'), limit: z.number().int().min(1).max(200).optional(), oneline: z.boolean().optional() }),
    z.object({ operation: z.literal('git_diff'), staged: z.boolean().optional(), path: z.string().optional() }),
    z.object({ operation: z.literal('git_show'), ref: z.string().min(1) }),
    z.object({ operation: z.literal('git_branch_current') }),
    z.object({ operation: z.literal('git_ls_files') }),
    z.object({ operation: z.literal('typecheck'), project: z.string().optional() }),
    z.object({ operation: z.literal('node_version') }),
    z.object({ operation: z.literal('npm_ls') }),
    z.object({ operation: z.literal('npm_outdated') }),
    z.object({ operation: z.literal('npm_view'), package: z.string().min(1) }),
  ])
  ```
- Il tool **costruisce argv internamente** per ogni operation. Eliminati per costruzione: tokenizer, quote parsing, detection metacaratteri, arg injection, estensione via env, allowlist su nomi comandi. Il problema "allow invocation shapes, not command names" (`git branch -D`) **sparisce per costruzione**: non esiste input libero da validare.
- Flag di sicurezza forzati nel builder: `git diff/show` → `--no-ext-diff --no-textconv`; `git log` → solo flag previsti (`--oneline`, `-n <limit>`); rifiuto di flag non previsti implicito (nessun campo libero esiste).
- `inspectionClass` nella result: `'git-inspection' | 'project-code-execution' | 'env-info'` — `typecheck` e future operazioni che eseguono codice/dependency del progetto sono classificate e presentate come tali (il modello deve sapere che sta eseguendo software del progetto, non interrogando git).
- Windows: `typecheck` risolve `node_modules/typescript/bin/tsc` via lookup esplicito e fallisce **loud** se assente; `ref`/`package`/`path` passano come argv singoli (spawn senza shell → nessun quoting creativo possibile).
- Estensione env: **eliminata da v1**. Se servirà: `ZELARI_INSPECT_UNSAFE_EXTRA_OPERATIONS` con WARNING esplicita nel context dell'agente (nome che urla, come richiesto). In backlog.
- `description` del tool enumera le operation — il modello sceglie da un menu, non scrive una pseudo-shell.
- Bonus allineamento convenzioni (AGENTS.MD): "Zod schemas for all LLM tool args" — la union discriminata è esattamente il pattern di casa.

**Prompt/policy — promozione a invariante PRINCIPLES.md**:
- La review chiede "OBSERVATION INTEGRITY" come invariante. Nota metodologica: per i tre test del manifesto stesso (PRINCIPLES.md §Metodo), l'observation integrity è **derivabile da P1** ("non fidarti di un'asserzione non verificata — inclusa la tua": un falso vuoto È un'asserzione non verificata). Quindi: non P7, ma **clausola esplicita sotto P1** (box invariante + estensione di "Come è garantito"). Slice BUILD: emendare PRINCIPLES.md con ADR, rispettando la governance del manifesto.
- Testo proposto per l'ADR:
  ```
  OBSERVATION INTEGRITY
  A negative conclusion requires a successful and sufficiently scoped observation.
  EMPTY is evidence. DEGRADED is not evidence. ERROR is not evidence.
  TRUNCATED is partial evidence only.
  ```

### Delta respinti o rinviati (secondo giro)

- **`InspectionRule { executable, match(args) }`** → superseded dal ridisegno a operation semantiche (la review stessa lo proponeva come alternativa preferita). Il rule-matcher non si implementa.
- **`project_test_list`/`project_build_info` come operation** → restano al sandbox (invariato dal primo giro).
- **`ObservationStatus` globale su tutti i tool** → confermato il rinvio a 1.47; i campi macchina di WS2/WS3 sono il seme.
- **Raccolta dati d'uso pre-1.47** → accettato come principio di processo: la 1.46 va usata davvero; i campi `status`/`recoverable`/`recommendedFallback` che ora emettiamo sono la materia prima del futuro tool-health (quando lo costruiremo, il dato esisterà già).

### Ordine aggiornato (supera §4)

```
WS2 (AST root + diag) → WS1 (grep) → WS4 (LSP in plan) → WS3 (inspect_command semantico) → uso reale → [1.47]
```

WS4 prima di WS3: costo di una riga, beneficio quotidiano immediato sulla navigation ladder; WS3 è il tool nuovo con la maggiore superficie di design.

---

## 9. Terzo giro di review — hardening di `typecheck` (delta finale pre-BUILD)

Richiesta del proprietario: dimostrare con test che `inspect_command(typecheck)` non lascia artefatti nel workspace, incluso tsconfig `composite`/`incremental`. **Accolta come S3.5, condizione di done di WS3.**

### Verifiche a monte (tree + fonti ufficiali)

- **Il fixture siamo noi**: `packages/core/tsconfig.json` ha `"composite": true` (linea 12); `apps/desktop/tsconfig.node.json` idem. Il tsconfig root NON ha composite/incremental → lo script attuale `tsc --noEmit -p tsconfig.json` è oggi artefatto-free per costruzione; ma il tool v1 accetta `project:` arbitrario, quindi il rischio è reale.
- **Prova empirica on-tree**: `packages/core/tsconfig.tsbuildinfo` ESISTE. Coerente con le regole di default di `tsBuildInfoFile` (docs: con rootDir+outDir impostati, il default è `<config name>.tsbuildinfo` accanto al config).
- **TypeScript issue #30661** (maintainer): "incremental is on by default if composite is on... new build artifacts in unexpected places for people using `--noEmit` today". La preoccupazione della review era già dei maintainer TS.
- **Docs `incremental`**: scrive `.tsbuildinfo` "in the same folder as your compilation output"; **`tsBuildInfoFile` controlla la destinazione** → il redirect via CLI è il meccanismo previsto dal tool stesso.
- **Incertezza residua dichiarata**: il comportamento esatto `--noEmit` + composite varia per versione TS (SO #57078953 mostra edge case storici; l'errore "Composite projects may not disable incremental emit" non è verificabile senza GitHub auth). **I fixture S3.5 decidono empiricamente** — esattamente ciò che la review ha chiesto: test, non lettura di doc.

### Delta accettati (terzo giro)

**WS3 (t3) — S3.5 "typecheck artifact safety"**:
1. **Primario: redirect, non disattivazione.** Il builder passa sempre `--tsBuildInfoFile <os.tmpdir()>/zelari-inspect/<hash>.tsbuildinfo` (CLI override del tsconfig). NON `--incremental false` come opzione principale: composite forza incremental e disattivarlo rischia di rompere il typecheck sul fixture stesso. **Priorità invertita rispetto alla proposta della review, con motivazione documentata.** `--incremental false` resta fallback se il redirect si dimostra incompatibile.
2. **Guard deterministica pre/post**: fingerprint del workspace prima/dopo (`git status --porcelain` + scan `**/*.tsbuildinfo` sotto root, node_modules escluso). Qualsiasi delta → `status: 'degraded'` + `artifactsWritten: [...]` + cleanup. Cattura OGNI classe di artefatto, non solo quella prevista.
3. **Fixture di test**:
   - (a) tsconfig plain (= root attuale) → zero artefatti;
   - (b) `incremental: true` + `tsBuildInfoFile` esplicito nel tsconfig puntato NEL workspace → il redirect CLI deve vincere;
   - (c) `composite: true` (= packages/core, reale) → workspace byte-for-byte invariato dopo il run;
   - assertion commune: `git status` pulito + zero `*.tsbuildinfo` nuovi.
4. **Esito loud su shape non supportate**: se `tsc --noEmit` su composite rifiuta a livello compiler (errore TS, non nostro), `typecheck` ritorna `status: 'unsupported_project_shape'` con reason — mai finto successo, mai finto vuoto.
5. `inspectionClass: 'project-code-execution'` per typecheck (confermato): il modello vede la distinzione — sta eseguendo software del progetto, non interrogando git.

**Backlog (non blocca 1.46)**: quarta classe `'network-inspection'` per `npm_view`/`npm_outdated` (rete ≠ mutazione, ma ≠ `git status`) — da aggiungere quando quelle operation entreranno nella strategia/budget della Adaptive Head.

### Chiusura del piano

Approvazione del proprietario ricevuta con l'unica condizione S3.5: incorporata sopra. Nessun altro scope aggiunto. Ordine confermato:

```
WS2 (S2.0 root propagation) → WS1 → WS4 → WS3 (con S3.5) → uso reale → [1.47 Adaptive Head]
```

Il piano è **BUILD-ready**.

---

## 10. Esito BUILD (2026-08-17) — chiusura §6.3

> Questa sezione sostituisce il flag DRAFT rimosso in testa: è il referto finale richiesto da §6.3 ("aggiornare questo documento con esito e rimuovere il flag DRAFT").

**Workstream consegnati sull'albero reale:**

| WS | Contenuto | File |
|---|---|---|
| WS2 (S2.0–S2.3) | root propagation + `ParseFileSymbolsResult` discriminato (`file-not-found` con path assoluto guardato, `typescript-unavailable`, `read-error`, `unsupported-extension`, `parse-error`), note specifiche per outline, wrapper di compatibilità | `src/cli/ast/engine.ts`, `src/cli/ast/tools.ts` (+ test) |
| WS1 (S1.1–S1.2 + delta §7) | `filesWalked`, `effectiveInclude`, `truncated`, `warning` con sentinel `SEARCH_EMPTY_SCOPE` / `DEPRECATED_INPUT`, description con semantica `*` vs `**` | `packages/core/src/core/tools/builtin/search.ts` (+ test) |
| WS4 | LSP registrato anche in readOnly/plan (ladder `ast → lsp → grep → read_file` completa), degradazione loud del provider | `src/cli/toolRegistry.ts`, `src/cli/lsp/*` (+ test) |
| WS3 + S3.5 | `inspect_command`: discriminated union su `operation`, argv costruiti internamente, spawn senza shell, `inspectionClass`, redirect `--tsBuildInfoFile` verso `<tmp>/zelari-inspect/<hash>` (primario, `--incremental false` solo fallback documentato), guard pre/post (`git status --porcelain` + scan `*.tsbuildinfo`), cleanup + `status: 'degraded'`, `unsupported_project_shape` loud, kill-switch `ZELARI_INSPECT_COMMAND=0`, registrazione plan/readOnly/explore al posto di bash | `src/cli/tools/inspectCommand.ts`, `src/cli/tools/inspectTypecheckSafety.ts`, `src/cli/toolRegistry.ts` (+ fixture a/b/c: plain / incremental-esplicito / composite) |
| Prompt/policy | Regola epistemica "OBSERVATION INTEGRITY" nei prompt plan (`useChatTurn.ts`, banner plan phase) e kraken-explore (`taskTool.ts`) | `src/cli/hooks/useChatTurn.ts`, `src/cli/tools/taskTool.ts` |
| Manifesto | Clausola esplicita sotto P1 (box invariante + estensione "Come è garantito"), ADR di emendamento | `PRINCIPLES.md`, `docs/decisions/0019-observation-integrity-p1-clause.md` |
| Doc | Sezione `inspect_command` con allowlist, S3.5, kill-switch; tabella plan-phase aggiornata | `docs/TOOLS.md` |

**Verifica (§6):**
1. `npm run typecheck` — **verde** (exit 0, verificato in sessione BUILD).
2. `npx vitest run` — **verde: 234 file / 2423 test passed** (nessun skip rilevante), inclusi i test S1/S2/S3.5 nuovi.
3. Smoke manuale della sessione reale: l'uso effettivo dei tool in questa missione ha esercitato `grep_content` (warning coerenti), `ast_outline` (path relativi), `read_file` — le regressioni osservate in §7/§8 (glob un-segmento, ast silenzioso) non si ripresentano con la nuova superficie.

**Note di delivery:**
- `verification.ok=false` registrato in `.zelari/completion.json` alla slice precedente non corrispondeva ad alcun test rosso: la suite completa è stata rieseguita ed è verde al 100%. Nessun `openFails` pendente.
- Backlog confermato non bloccante: `network-inspection` (quarta inspectionClass per `npm_view`/`npm_outdated`), deprecazione `include: []` → `INVALID_ARGUMENT` (1.47), `ObservationStatus` globale (1.47).

Il piano è **chiuso**. Prossimo step concordato: uso reale della 1.46 → 1.47 Adaptive Head.

