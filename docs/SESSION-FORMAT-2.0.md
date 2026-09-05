# Session format 2.0 - spine, verification, resume (alpha)

> Reference version: `2.0.0-alpha.0` - ADR-0016 (ratified), ADR-0021/0022/0023.
> This document describes the on-disk format and the `@zelari/core/session`,
> `@zelari/core/verification`, `@zelari/core/mission` contracts and the
> verifier configuration.

## 1. Session log (spine)

A session is a directory `.zelari/sessions/<sessionId>/` containing:

- `events.jsonl` - append-only, one JSON line per event (the single source of
  truth);
- `writer.lock` - ownership lock of the active writer (created with
  `flag:'wx'`).

Location override: env `ZELARI_SESSIONS_DIR` (tests/CI/Desktop multi-cwd).
The legacy sidecar `~/.tmp/zelari-code/sessions/` stays readable but is no
longer written by the spine.

### Envelope

```json
{"schemaVersion":1,"sessionId":"<uuid>","seq":7,"ts":1755500000000,
 "kind":"tool.result","actor":{"type":"agent","role":"kraken"},
 "data":{"callId":"c1","tool":"bash","ok":true,"output":"..."}}
```

- `seq`: monotonic 1..N, no gaps; assigned by the writer AFTER Zod validation;
- `schemaVersion`: today `1`; migrations are mechanical and documented in
  `MIGRATION.md`;
- `kind`: closed vocabulary (`SESSION_EVENT_KINDS` in
  `packages/core/src/session/types.ts`).

### P1 invariant

> **model-visible ? logged**: only the kinds in `MODEL_SURFACE_KINDS`
> (`user.message`, `assistant.message`, `tool.call`, `tool.result`,
> `session.compacted`) enter `deriveMessages` - the only path of the model
> history.
>
> **Compact the projection, never the ledger.** A `session.compacted` with
> `{fromSeq,toSeq,checkpoint}` **shadows** the closed interval in the model
> surface (the raw events stay in the JSONL). A later compact covering the
> seq of a previous checkpoint replaces it (chaining). The legacy `{summary}`
> payload without a range stays additive.

### `session.compacted` v2 contract

A durable checkpoint keeps the replaced range, the model surface and the
deterministic state needed to continue:

```json
{
  "fromSeq": 12,
  "toSeq": 80,
  "checkpoint": {"role": "user", "content": "<compaction-state>..."},
  "strategy": "extractive",
  "sourceEventSeqs": [12, 13, 80],
  "retainedCriterionIds": ["tests"],
  "retainedEvidenceRefs": [{"seq": 76, "tier": "command-output"}],
  "retainedState": {
    "unresolvedIssueIds": ["tests"],
    "affectedFiles": ["src/a.ts"],
    "missionStateRef": "phase:verification"
  },
  "inputTokens": 18000,
  "outputTokens": 3200,
  "savedTokens": 14800,
  "recompactionRate": 0,
  "summaryStrategy": "extractive"
}
```

For LLM checkpoints `provider` and `model` are also recorded. The invariants
require a valid range preceding the compact event, existing endpoints and
source seqs, a valid user/system checkpoint, resolvable EvidenceRefs and a
boundary that neither separates a tool call from its result nor includes a
still-active call.

`ModelContextBuilder` is the common path of TUI, council and headless
(Desktop and companion `serve` delegate to headless): it derives from the
spine, measures, compacts, persists, flushes, re-reads the durable projection
and measures again before invoking `AgentHarness`. The
`<compaction-state version="1">` block keeps required criteria, open
failures, latest verification, EvidenceRefs, affected files, user constraints
and mission state; the LLM/extractive narrative is appended after this block.

JSONL telemetry uses `kind:"compaction"` records with counts, input/output
and saved tokens, recompaction rate, summary strategy and restore failures.

### Tolerant replay

`readSessionLog` never crashes on a damaged log: corrupt lines, gaps,
duplicates and schema mismatches are reported as `ReplayIssue`
(`corrupt-line`, `seq-gap`, `seq-duplicate`, `seq-nonmonotonic`,
`schema-mismatch`). Replay reconstructs the *trajectory*, not the determinism
of the model outputs.

### Fork / resume / export

- `forkSession(store, id, {fromSeq})` - new session with the trajectory
  copied (re-seq 1..n) + `session.forked {parentSessionId, parentSeq}` event;
- `resumeSession(store, id)` - reopens the log (seq continues) +
  `session.resumed`;
- `exportSession(store, id)` - machine format `zelari-session-export/1`.

## 2. Deterministic verification (Phase 3A)

Contract: `Criterion -> VerificationResult -> EvidenceRef -> spine event ->
tool output`.

- `Criterion {id, text, source, required, check?}` - deterministic checks:
  `command` (expectExit/expectStdoutIncludes/timeout), `file-exists`,
  `file-contains`, `file-absent`, `none`;
- `VerificationResult.status ? {pass, fail, unknown}` - **unknown != pass
  everywhere**;
- `EvidenceRef {seq?, tier, ref, capturedAt, digest}` - sha256 digest of the
  output;
- `CompletionPolicy` (strict) -> `PASS | REPAIR_REQUIRED | BLOCKED`:
  a missing/unknown required criterion (including "pass without evidence")
  is never PASS; `fail` -> repair; only unknown/missing -> BLOCKED ("clean
  done without sufficient evidence is blockable"). BUILD gate:
  `strictBuildGate` (`ZELARI_STRICT_DONE=1`).
- Default pack: `zelari-coding/v1` (tests/typecheck/build required;
  scope-discipline and verification-quality advisory).

## 3. Optional verifier (Phase 3B, alpha)

```ts
VerifierConfig = {
  enabled: boolean (default false),
  model: {mode:'inherit'} | {mode:'fixed', provider, model},
  progressScoring: boolean (default false),
  bon: {enabled: boolean (default false), n: 2..8 (default 3)}
}
```

- `inherit` = session model; `fixed` = dedicated provider+model (same
  semantics as the 1.49 flags
  `--verifier-provider/--verifier-model/--verifier-clear`);
- the EFFECTIVE provider/model are always in the `verification.run` event
  (`source: 'verifier-model'`);
- unparsed model output -> **declared discrete fallback**
  (`verdict:'unknown', fallback:'discrete'`) - never `pass`;
- the verdict is **advisory**: it NEVER enters `CompletionPolicy` (no
  done based only on the score, no P2 bypass);
- progress score: label `Verifier score: 0.82 - experimental`, never "%
  complete";
- BoN requires `bon.enabled` **and** `ZELARI_EXPERIMENTAL=bon`; ties/missing
  score -> declared fallback to the first candidate.

## 4. Mission (Phase 4, core)

`deriveMissionState(projection)` derives the phase (`design -> build ->
verification -> done`), progress (from the latest verification), replan and
interruption directly from the log. Interrupt = absence of `session.ended`;
resume = `resumeSession`. Snapshot: `zelari-mission-snapshot/1`.

## 5. Experimental flags (Phase 5)

`ZELARI_EXPERIMENTAL=<csv>` with values in `EXPERIMENTAL_FLAGS` (`bon`,
`remote-sandbox`, `e2b-provider`, `generated-orchestration`,
`nested-delegation`). All OFF by default.

## 6. End-to-end example (headless, core API)

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
  // no clean done: REPAIR_REQUIRED -> repair loop; BLOCKED -> evidence needed
}
const mission = deriveMissionState(await handle.store.projection(handle.ctx.sessionId));
await handle.close();
```