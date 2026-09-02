# ADR-0033 — Edit ancorato: snapshot file-level, apply esatto, errore strutturato

Status: accepted (implementazione in corso — slice t72+t73+t74+t78)
Date: 2026-08-30

Relazioni: estende ADR-0016/0021/0024 (spine), ADR-0022 (profiles), ADR-0023/0025/0027 (strict done);
sostituisce il comportamento best-effort di `edit_file`/`apply_diff` sulla superficie modello Kraken.

## Context (verificato sul disco)

- `read_file` (`packages/core/src/core/tools/builtin/filesystem.ts`): nessun hash/snapshot nel result — il modello non ha ancora modo di dichiarare "scrivo sulla versione che ho letto".
- `edit_file` (stesso file): oldString/newString, nessun snapshot, no-match restituito in prosa. Il retry LF/CRLF (`replaceFileString`) è deterministico e position-preserving — si tiene.
- `apply_diff` (`packages/core/src/core/tools/builtin/diff.ts`): atomico, ma **riclocante di default**: gli hunk con numeri di riga "drifted" vengono rilocati via context matching. `fuzzyMatch` (tolleranza whitespace) è già opt-in.
- Tre superfici di scrittura verso il modello (`write_file`, `edit_file`, `apply_diff`); `write_file` sovrascrive file esistenti senza guardie.
- Seam hook già presente: `ToolRegistry.setLifecycleHooks` + `packages/core/src/core/hooks/`.
- Gate AST riusabile: `parseFileSymbolsDiag` (`src/cli/ast/engine.ts`) discrimina già `parse-error`, `unsupported-extension`, `typescript-unavailable`.
- Misura in casa: `eval/` + `eval:measured` + `evidence:report` (package.json).
- Strict-done: `strictDoneEnabled('kraken')` è già default ON (ADR-0027, opt-out `ZELARI_STRICT_DONE=0`); il gate `general ⇒ verify` nel task tool è però ancora un hint testuale (`verifyHintForGeneral`, soft).

## Decision — tre vincoli non negoziabili

1. **SNAPSHOT FILE-LEVEL, DAY 1.** Un solo `snapshotId` per read: `sha256(contenuto del file completo).slice(0,16)` (hex), calcolato lato runtime e restituito nel result di `read_file`. Niente hash per-riga: follow-up opzionale solo se il bench mostra che il modello cheap non sa puntare la regione senza.
2. **ZERO RELOCATE NELL'ENGINE DI DEFAULT.** Match esatto sulla regione, sempre. Nessun tool fuzzy nel catalogo Kraken v1; "relocate dietro flag" è respinto. Regola: l'engine può normalizzare i byte (LF/CRLF), **mai spostare la regione**. I test che oggi certificano la rilocazione si ribaltano in reject-test.
3. **ERRORE STRUTTURATO È DELIVERABLE DEL PUNTO 1.** Schema Zod day-1 su ogni path di fallimento; nessun reject in prosa.

## Protocollo

- Non si scrive ciò che non si è letto (con hash): `edit` richiede `snapshotId`; `write_file` intero solo per file nuovi (file esistente → reject `file_exists`; la guardia atterra con il switch di catalogo t77 per non rompere i caller legacy a metà slice — lo schema però definisce `file_exists` da day 1).
- Superficie modello: **un tool di scrittura (`edit`)** + `write_file` limitato. `edit_file`/`apply_diff` restano esportati per un ciclo di deprecazione ma escono dal catalogo Kraken default (t77, ~15 siti).
- Engine unico, due gate in serie:
  1. `expectedHash !== hash(contenuto attuale)` → `stale_snapshot`, NESSUN apply.
  2. match esatto della regione (unica tolleranza: normalizzazione LF/CRLF deterministica) → altrimenti `hunk_mismatch` + `minimalDiff`, nessuna scrittura.
- Schema `WriteReject` (day 1):
  ```
  { ok: false,
    status: 'stale_snapshot' | 'hunk_mismatch' | 'parse_error' | 'file_exists',
    path: string,
    expectedHash?: string, actualHash?: string,
    span?: { startLine: number, endLine: number },
    minimalDiff: string,          // unified corto, solo il conflitto
    next: { action: 're-read', path: string } }   // azione macchina, non un saggio
  ```
- Gate AST post-apply via hook `PostToolUse` (stesso seam del done-gate): TS/JS → `parseFileSymbolsDiag`; `parse-error` → revert automatico + `parse_error`; Python → ruff; altri linguaggi/backend mancante → `ast: unavailable` LOUD nel result. Mai silenzio, mai finto pass.
- Eventi spine `file.read` / `file.applied` / `file.rejected` (envelope, replay-tolerant). `SESSION_SCHEMA_VERSION` resta 1 solo se il kind-enum è open; se chiuso → bump con replay tolerante (da confermare in t75).
- **DONE COMPILATO, CO-RELEASE VINCOLATA:** `general ⇒ verify` forzato dal runtime (non hint), rework ≤ 1 stesso worktree/acceptance[], exit 4 di default senza flag da ricordare. Edit ancorato senza done compilato = writer che mente sul finito; done su apply rilocante = giudice su disco sporco. Atterrano insieme o non atterrano.

## Measurement gate (KPI)

`eval:measured`, stesso modello cheap, 3 run, 200 patch TS/Python, baseline = comportamento attuale.
Pass-rate primo colpo, token, corruzioni. Se il delta non è positivo, l'ADR è sbagliato.
I punteggi di review comparativa restano prioritizzazione, non KPI.

## Consequences

**Positive:** reject puliti; lock ottimista fra tentacoli via hash; catalogo/prefisso più magro; done dimostrabile su disco pulito.
**Negative:** più reject → più re-read (mitigato da `next` + `minimalDiff`); pass-rate short-term più basso sui contesti driftati (accettato: fallimento pulito > successo sul punto sbagliato); breaking per profili legacy (un ciclo di deprecazione).

## Alternatives rifiutate

Hash per-riga al day 1 · relocate dietro flag · `expectedContent` intero al posto dell'hash · un quarto formato di patch.

## Implementazione (stato)

| Task | Contenuto | Stato |
|---|---|---|
| t72 | `WriteReject` zod + `snapshotId` in `read_file` | questo slice |
| t73 | engine unico (gate hash → exact), tool `edit` | questo slice |
| t74 | kill relocate in `apply_diff` + `minimalDiff`, test ribaltati | questo slice |
| t75 | eventi spine `file.read/applied/rejected` | pending |
| t76 | `PostToolUse` write: AST gate + auto-revert, loud skip | pending |
| t77 | catalogo Kraken: un tool di scrittura (+ guardia `file_exists` su `write_file`) | pending |
| t78 | done compilato: `general⇒verify` hard, rework ≤1, exit 4 | questo slice |
| t79 | bench: 200 patch, cheap model, 3 run, JSON raw | pending |

## Out of scope (ADR separati, stessi seam)

Diag LSP iniettate su ogni apply (seam = hook t76) · prefix/cache fan-out (`cacheReuseExpected`, hit-rate pubblico) · desktop spine-projection.
