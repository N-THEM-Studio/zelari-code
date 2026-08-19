# Session format 2.0 — spine, verifiche, resume (alpha)

> Versione riferimento: `2.0.0-alpha.0` · ADR-0016 (ratificato), ADR-0021/0022/0023.
> Questo documento descrive il formato su disco e i contratti `@zelari/core/session`,
> `@zelari/core/verification`, `@zelari/core/mission` e la configurazione del verifier.

## 1. Log di sessione (spine)

Una sessione è una directory `.zelari/sessions/<sessionId>/` contenente:

- `events.jsonl` — append-only, una riga JSON per evento (l'unica fonte di verità);
- `writer.lock` — lock di ownership del writer attivo (creato con `flag:'wx'`).

Override location: env `ZELARI_SESSIONS_DIR` (test/CI/Desktop multi-cwd). Il
sidecar legacy `~/.tmp/zelari-code/sessions/` resta leggibile ma non viene
più scritto dalla spine.

### Envelope

```json
{"schemaVersion":1,"sessionId":"<uuid>","seq":7,"ts":1755500000000,
 "kind":"tool.result","actor":{"type":"agent","role":"kraken"},
 "data":{"callId":"c1","tool":"bash","ok":true,"output":"..."}}
```

- `seq`: monotona 1..N, senza buchi; assegnata dal writer DOPO la validazione Zod;
- `schemaVersion`: oggi `1`; le migrazioni sono meccaniche e documentate in `MIGRATION.md`;
- `kind`: vocabolario chiuso (`SESSION_EVENT_KINDS` in `packages/core/src/session/types.ts`).

### Invariante P1

> **model-visible ⟺ logged**: solo i kinds di `MODEL_SURFACE_KINDS` (`user.message`,
> `assistant.message`, `tool.call`, `tool.result`, `session.compacted`) entrano in
> `deriveMessages` — l'unico path della history del modello.

### Replay tollerante

`readSessionLog` non crasha mai su log danneggiato: righe corrotte, gap, duplicati
e mismatch di schema sono riportati come `ReplayIssue` (`corrupt-line`, `seq-gap`,
`seq-duplicate`, `seq-nonmonotonic`, `schema-mismatch`). Il replay ricostruisce la
*trajectory*, non il determinismo degli output del modello.

### Fork / resume / export

- `forkSession(store, id, {fromSeq})` — nuova sessione con la traiettoria copiata
  (re-seq 1..n) + evento `session.forked {parentSessionId, parentSeq}`;
- `resumeSession(store, id)` — riapre il log (seq continua) + `session.resumed`;
- `exportSession(store, id)` — formato macchina `zelari-session-export/1`.

## 2. Verifica deterministica (Phase 3A)

Contratto: `Criterion → VerificationResult → EvidenceRef → evento spine → tool output`.

- `Criterion {id, text, source, required, check?}` — check deterministici:
  `command` (expectExit/expectStdoutIncludes/timeout), `file-exists`,
  `file-contains`, `file-absent`, `none`;
- `VerificationResult.status ∈ {pass, fail, unknown}` — **unknown ≠ pass ovunque**;
- `EvidenceRef {seq?, tier, ref, capturedAt, digest}` — digest sha256 dell'output;
- `CompletionPolicy` (strict) → `PASS | REPAIR_REQUIRED | BLOCKED`:
  required mancante/unknown (incluso "pass senza evidence") non è mai PASS;
  `fail` → repair; solo unknown/missing → BLOCKED ("clean done senza evidence
  sufficiente bloccabile"). Gate BUILD: `strictBuildGate` (`ZELARI_STRICT_DONE=1`).
- Pack di default: `zelari-coding/v1` (tests/typecheck/build required;
  scope-discipline e verification-quality advisory).

## 3. Verifier opzionale (Phase 3B, alpha)

```ts
VerifierConfig = {
  enabled: boolean (default false),
  model: {mode:'inherit'} | {mode:'fixed', provider, model},
  progressScoring: boolean (default false),
  bon: {enabled: boolean (default false), n: 2..8 (default 3)}
}
```

- `inherit` = modello di sessione; `fixed` = provider+model dedicati (stessa
  semantica dei flag 1.49 `--verifier-provider/--verifier-model/--verifier-clear`);
- il provider/modello EFFETTIVI sono sempre nell'evento `verification.run`
  (`source: 'verifier-model'`);
- output del modello non parsed → **fallback discreto dichiarato**
  (`verdict:'unknown', fallback:'discrete'`) — mai `pass`;
- il verdict è **advisory**: NON entra mai in `CompletionPolicy` (nessun done
  basato solo sullo score, nessun bypass P2);
- progress score: etichetta `Verifier score: 0.82 · experimental`, mai "% completo";
- BoN richiede `bon.enabled` **e** `ZELARI_EXPERIMENTAL=bon`; pareggi/assenza di
  score → fallback dichiarato al primo candidato.

## 4. Mission (Phase 4, core)

`deriveMissionState(projection)` deriva fase (`design → build → verification →
done`), progress (dall'ultima verification), replan e interruzione direttamente
dal log. Interrupt = assenza di `session.ended`; resume = `resumeSession`.
Snapshot: `zelari-mission-snapshot/1`.

## 5. Flag sperimentali (Phase 5)

`ZELARI_EXPERIMENTAL=<csv>` con valori in `EXPERIMENTAL_FLAGS` (`bon`,
`remote-sandbox`, `e2b-provider`, `generated-orchestration`, `nested-delegation`).
Tutti OFF di default.

## 6. Esempio end-to-end (headless, core API)

```ts
import { createExecutionContext } from '@zelari/core/runtime';
import { VerificationEngine, codingCriteriaPack, evaluateCompletion } from '@zelari/core/verification';
import { deriveMissionState } from '@zelari/core/mission';

const handle = await createExecutionContext({ profileId: 'kraken/v1' });
const engine = new VerificationEngine(
  { shell: handle.ctx.shell, fs: handle.ctx.fs },
  { emit: handle.ctx.appendSessionEvent },
);
const pack = codingCriteriaPack({ testCommand: 'npm run test' });
const results = await engine.evaluate(pack.criteria, { packId: pack.id });
const completion = evaluateCompletion(pack.criteria, results);
if (completion.verdict !== 'PASS') {
  // niente clean done: REPAIR_REQUIRED → repair loop; BLOCKED → serve evidenza
}
const mission = deriveMissionState(await handle.store.projection(handle.ctx.sessionId));
await handle.close();
```
