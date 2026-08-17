# ADR-0019 — Observation Integrity come clausola esplicita di P1

- **Stato**: accepted
- **Data**: 2026-08-17
- **Governance**: emendamento del manifesto ratificato ([ADR-0010](0010-first-principles-manifesto.md)) — clausola sotto P1, non nuovo principio
- **Release**: v1.46 "Ground Truth"

## Context

La release v1.46 (piano "Loud Tool Errors, Degradazione Diagnostica, Shell Read-Only in Plan") ha corretto tre classi di falsi vuoti osservate in sessioni reali: `grep_content` con glob non ricorsivo che riportava `filesInTree: 1` su alberi da 117 file, `ast_outline` silenzioso su file validi (path non risolto contro il root + quattro cause indistinguibili collassate in `[]`), assenza di shell read-only in plan. Una hardening review esterna ha chiesto di promuovere il principio sottostante a invariante: "OBSERVATION INTEGRITY".

Il metodo del manifesto (§Metodo, ADR-0010) esclude di aggiungerlo come P7: il terzo test ("non è derivabile") fallisce — l'integrità dell'osservazione discende da P1 (*non fidarti di un'asserzione non verificata — inclusa la tua*: un falso vuoto È un'asserzione non verificata). La forma giusta è una clausola esplicita sotto P1.

## Decision

1. PRINCIPLES.md P1 acquisisce un box invariante con il testo ratificato:

   ```
   OBSERVATION INTEGRITY
   A negative conclusion requires a successful and sufficiently scoped observation.
   EMPTY is evidence. DEGRADED is not evidence. ERROR is not evidence.
   TRUNCATED is partial evidence only.
   ```

2. La sezione "Come è garantito" di P1 estende la garanzia ai meccanismi v1.46: status discriminati e sentinel nei tool di osservazione (`SEARCH_EMPTY_SCOPE`/`DEPRECATED_INPUT`/`filesWalked` in grep_content; `file-not-found` con path assoluto guardato, `typescript-unavailable`, `read-error` in ast/LSP; `degraded` + `artifactsWritten` e `unsupported_project_shape` in inspect_command).

3. La regola epistemica entra nei prompt plan e kraken (explore): "negative evidence is valid only from a completed observation. Never conclude that code/symbols/files do not exist from degraded results, zero files examined, or unavailable backends."

## Consequences

- Un risultato vuoto NON è mai accettabile come prova di assenza se l'osservazione non è andata a buon fine e sufficientemente scoped: il modello deve riportare lo status degradato e ampliare l'osservazione, non concludere "il codice non esiste".
- EMPTY non viene fabbricato dal degradato: i tool devono distinguere le cause e dirle loud (sentinel + campi macchina `status`/`recoverable`/`recommendedFallback`).
- TRUNCATED vale solo come evidenza parziale: su di esso non si costruiscono conclusioni negative forti.
- Rollout globale di `ObservationStatus` su TUTTI i tool rinviato a 1.47 (ADR nel piano v1.46, §8): in 1.46 lo status discriminato vive nei soli tool toccati; i dati d'uso collezionati dai campi appena introdotti alimenteranno il futuro tool-health.

## Alternatives considered

- **P7 "Observation Integrity" come nuovo principio**: respinto — derivabile da P1 (fallisce il terzo test del metodo).
- **Solo regola prompt, senza box nel manifesto**: respinto — la review l'ha chiesta come invariante stabile tra versioni; il prompt da solo è policy revocabile, il manifesto è governance.
- **`ObservationMeta` globale su tutti i tool subito**: respinto come scope creep pre-dati-d'uso (rinviato a 1.47).
