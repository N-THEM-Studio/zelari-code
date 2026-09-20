/**
 * tools/eval/operators/fuseEditVerify.test.ts — WS7 slice 3.
 *
 * Two fixture classes, both read through the REAL tolerant reader
 * (`parseSessionLogText` → `buildProjection`, @zelari/core/session): the operator
 * is never fed a hand-made object graph, only spine text a writer could have
 * produced. Expectations are derived BY HAND from the rules in the module — if an
 * assertion moves, a rule moved, not the noise.
 *
 *   SYNTHETIC — minimal, purpose-built spines (one pattern each).
 *   REAL      — verbatim excerpts of two sessions under `.zelari/sessions`, with
 *               provenance (session id + seq window) in the fixture comments. They
 *               pin the two properties the synthetic ones cannot: the CLI's
 *               `{path, status}` reject spelling and absolute-vs-relative paths.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { buildProjection, parseSessionLogText } from '@zelari/core/session';
import { parsePromotionReceipt, PROMOTION_DECISIONS } from '../promotionReceipt.ts';
import {
  APPLY_NOTE,
  FUSE_OPERATOR_ID,
  MAX_REOPEN_CALLS,
  WRITE_TOOL_NAMES,
  proposeFusions,
  receiptFromProposals,
} from './fuseEditVerify.ts';
import { PROJECTION_LIMIT, operatorSpine, operatorSpineFromProjection, samePath, unresolvedRefs } from './operatorSpine.ts';

const SESSION = 'synthetic-fuse';
let seq = 0;

/** Every test starts from seq 1: the fixtures are quoted by seq in the assertions. */
beforeEach(() => {
  seq = 0;
});

/** One envelope line: writer-assigned seq/ts, exactly like the real spine. */
function line(kind: string, data: Record<string, unknown>, actor = 'agent'): string {
  seq += 1;
  return JSON.stringify({
    schemaVersion: 1,
    sessionId: SESSION,
    seq,
    ts: 1_700_000_000_000 + seq,
    kind,
    actor: { type: actor },
    data,
  });
}
const call = (tool: string, args: Record<string, unknown>, callId: string): string => line('tool.call', { tool, args, callId });
const result = (callId: string, ok = true): string => line('tool.result', { callId, ok }, 'tool');
const applied = (path: string): string => line('file.applied', { path, snapshotId: 'aaaa1111bbbb2222', bytes: 42 }, 'tool');
const spoke = (text = 'next'): string => line('assistant.message', { text, finishReason: 'tool_calls' });

/** Spine text → the operator's two input forms, via the real reader.
 * `seq-gap` is tolerated (a REAL excerpt is a window of a longer spine, so gaps are
 * inherent and reported, not fatal); corrupt lines / schema mismatches never are. */
function parse(lines: string[]) {
  const report = parseSessionLogText('synthetic.jsonl', lines.join('\n'));
  expect(report.issues.filter((i) => i.type !== 'seq-gap')).toEqual([]); // a fixture that is not schema-valid is not a fixture
  return { events: report.events, report, projection: buildProjection(report.events) };
}

describe('operatorSpine', () => {
  it('folds results, turn boundaries and BOTH file.rejected spellings', () => {
    const { events } = parse([
      call('edit', { path: 'src/a.ts' }, 'c1'),
      result('c1'),
      applied('/r/src/a.ts'),
      line('file.rejected', { path: '/r/src/b.ts', reason: 'stale_snapshot' }),
      line('file.rejected', { path: '/r/src/c.ts', status: 'hunk_mismatch' }), // CLI mirror spelling
      spoke(),
      line('verify.requested', { taskId: 't1' }, 'system'),
    ]);
    const spine = operatorSpine(events);
    expect(spine.calls).toHaveLength(1);
    expect(spine.calls[0]).toMatchObject({ seq: 1, callId: 'c1', tool: 'edit', path: 'src/a.ts', resultSeq: 2, ok: true });
    expect(spine.turns).toHaveLength(1);
    expect(spine.verifyRequested).toHaveLength(1);
    expect(spine.fileEvents.map((f) => f.reason)).toEqual(['', 'stale_snapshot', 'hunk_mismatch']);
    expect(spine.limits).toEqual([]); // full fidelity
  });

  it('samePath reconciles separator style + the absolute/relative gap (and refuses blanks)', () => {
    expect(samePath('src/a.ts', '/repo/src/a.ts')).toBe(true);
    expect(samePath('Z:\\repo\\src\\a.ts', 'src/a.ts')).toBe(true);
    expect(samePath('src/a.ts', 'src/b.ts')).toBe(false);
    expect(samePath('src/a.ts', '')).toBe(false);
    expect(samePath('src/a.ts', 'src/a.ts.bak')).toBe(false);
  });
});

describe('proposeFusions — fuse_edit_verify', () => {
  it('(a) a verify issued as a separate call in the next turn is a candidate: 1 saved call, refs verifiable', () => {
    const { events, projection } = parse([
      call('edit', { path: 'src/a.ts' }, 'c1'),
      result('c1'),
      applied('/repo/src/a.ts'),
      spoke('run the suite'),
      call('bash', { command: 'npx vitest run src' }, 'c2'),
      result('c2'),
    ]);
    const proposals = proposeFusions({ events });
    expect(proposals).toHaveLength(1);
    const p = proposals[0]!;
    expect(p.kind).toBe('fuse_edit_verify');
    expect(p.estSavedCalls).toBe(1);
    expect(p.callIds).toEqual(['c1', 'c2']);
    expect(p.tool).toBe('edit');
    expect(p.path).toBe('src/a.ts');
    expect(p.note).toContain(APPLY_NOTE);
    // The refs point at THIS spine, and nowhere else: seq/callId both resolve.
    expect(unresolvedRefs(proposals, operatorSpine(events))).toEqual([]);
    expect(p.evidence.map((e) => e.kind)).toEqual([
      'tool.call', 'tool.result', 'file.applied', 'assistant.message', 'tool.call',
    ]);
    // …and the projection form cannot see it (documented degrade, test (f) below).
    expect(proposeFusions({ projection })).toEqual([]);
  });

  it('(a2) `task agent=verify` and a shell typecheck count as verifies; the write aliases count as writes', () => {
    const verifyCases: Array<[string, Record<string, unknown>]> = [
      ['task', { agent: 'verify', prompt: 'verify it' }],
      ['bash', { command: 'npm run typecheck' }],
      ['exec_process', { program: 'npx', args: ['vitest', 'run'] }], // the executable+argv spelling
    ];
    for (const [tool, args] of verifyCases) {
      const { events } = parse([call('edit_file', { path: 'src/a.ts' }, 'c1'), result('c1'), spoke(), call(tool, args, 'c2')]);
      expect(proposeFusions({ events })).toHaveLength(1);
    }
    expect(WRITE_TOOL_NAMES).toContain('write_file');
    expect(WRITE_TOOL_NAMES).toContain('edit');
  });

  it('(a3) proposal order is deterministic and anchored on the write seq', () => {
    const { events } = parse([
      call('edit', { path: 'src/a.ts' }, 'c1'),
      result('c1'),
      spoke(),
      call('bash', { command: 'npm test' }, 'c2'),
      result('c2'),
      call('write_file', { path: 'src/b.ts' }, 'c3'),
      result('c3'),
      spoke(),
      call('bash', { command: 'vitest run' }, 'c4'),
      result('c4'),
    ]);
    const first = proposeFusions({ events });
    expect(first.map((p) => p.callIds[0])).toEqual(['c1', 'c3']);
    expect(first.map((p) => p.decisiveSeq)).toEqual([1, 6]);
    expect(proposeFusions({ events })).toEqual(first); // no clock, no randomness
  });

  it('(c) no pattern ⇒ zero proposals (no false positives)', () => {
    const { events, projection } = parse([
      line('user.message', { text: 'hi' }, 'user'),
      call('read_file', { path: 'src/a.ts' }, 'c1'),
      result('c1'),
      call('bash', { command: 'echo test' }, 'c2'), // 'test' as prose, not a verify command
      result('c2'),
      call('edit', { path: 'src/a.ts' }, 'c3'),
      result('c3'),
      spoke(),
      call('read_file', { path: 'src/a.ts' }, 'c4'), // the next turn does NOT verify
      result('c4'),
    ]);
    expect(proposeFusions({ events })).toEqual([]);
    expect(proposeFusions({ projection })).toEqual([]);
  });

  it('(d) an already-fused verify (same turn, no turn boundary) is NOT a candidate', () => {
    const { events } = parse([
      call('edit', { path: 'src/a.ts' }, 'c1'),
      applied('/repo/src/a.ts'),
      result('c1'),
      call('bash', { command: 'npx vitest run src' }, 'c2'), // same decision batch
      result('c2'),
    ]);
    expect(proposeFusions({ events })).toEqual([]);
  });

  it('(d2) a non-adjacent verify (other work between) is not credited to the write', () => {
    const { events } = parse([
      call('edit', { path: 'src/a.ts' }, 'c1'),
      result('c1'),
      spoke(),
      call('read_file', { path: 'src/a.ts' }, 'c2'),
      result('c2'),
      spoke(),
      call('bash', { command: 'npx vitest run src' }, 'c4'),
      result('c4'),
    ]);
    expect(proposeFusions({ events })).toEqual([]);
  });

  it('(c2) a REJECTED write followed by a verify is a reopen case, never a fusion base', () => {
    const { events } = parse([
      call('edit', { path: 'src/a.ts' }, 'c1'),
      line('file.rejected', { path: '/repo/src/a.ts', reason: 'stale_snapshot' }),
      result('c1', false),
      spoke(),
      call('bash', { command: 'npx vitest run src' }, 'c2'),
      result('c2'),
    ]);
    expect(proposeFusions({ events })).toEqual([]);
  });
});

describe('proposeFusions — reopen_with_minimal_diff', () => {
  it('(b) a stale_snapshot reject followed by re-read + retry is a candidate: 1 saved call', () => {
    const { events } = parse([
      call('edit', { path: 'src/a.ts' }, 'c1'),
      line('file.rejected', { path: '/repo/src/a.ts', reason: 'stale_snapshot', hint: 're-read src/a.ts, then retry' }),
      result('c1', false),
      spoke('re-read and retry'),
      call('read_file', { path: 'src/a.ts', maxBytes: 8000 }, 'c2'),
      result('c2'),
      call('edit', { path: 'src/a.ts' }, 'c3'),
      result('c3'),
      applied('/repo/src/a.ts'),
    ]);
    const proposals = proposeFusions({ events });
    expect(proposals).toHaveLength(1);
    const p = proposals[0]!;
    expect(p.kind).toBe('reopen_with_minimal_diff');
    expect(p.estSavedCalls).toBe(1);
    expect(p.callIds).toEqual(['c2', 'c3']);
    expect(p.path).toBe('/repo/src/a.ts');
    expect(p.evidence[0]).toEqual({ kind: 'file.rejected', ref: 'seq:2' });
    expect(unresolvedRefs(proposals, operatorSpine(events))).toEqual([]);
    // The diff itself is NOT on the spine — the proposal points at the event and says so.
    expect(JSON.stringify(p)).not.toContain('@@');
    expect(p.note).toContain(APPLY_NOTE);
  });

  it('(b2) hunk_mismatch with the CLI `status` spelling is read the same way', () => {
    const { events } = parse([
      line('file.rejected', { path: 'Z:\\repo\\src\\a.ts', status: 'hunk_mismatch' }),
      call('read_file', { path: 'src/a.ts' }, 'c1'),
      result('c1'),
      call('edit', { path: 'src/a.ts' }, 'c2'),
      result('c2'),
    ]);
    const proposals = proposeFusions({ events });
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.kind).toBe('reopen_with_minimal_diff');
  });

  it('(b3) no retry / no re-read / retry past the window / other reasons ⇒ zero proposals', () => {
    const readOnly = parse([
      call('edit', { path: 'src/a.ts' }, 'c1'),
      line('file.rejected', { path: '/repo/src/a.ts', reason: 'stale_snapshot' }),
      call('read_file', { path: 'src/a.ts' }, 'c2'),
      result('c2'),
    ]);
    expect(proposeFusions({ events: readOnly.events })).toEqual([]);

    const noRead = parse([
      line('file.rejected', { path: '/repo/src/a.ts', reason: 'stale_snapshot' }),
      call('edit', { path: 'src/a.ts' }, 'c1'),
      result('c1'),
    ]);
    expect(proposeFusions({ events: noRead.events })).toEqual([]);

    const foreignReason = parse([
      line('file.rejected', { path: '/repo/src/a.ts', reason: 'file_exists' }),
      call('read_file', { path: 'src/a.ts' }, 'c1'),
      result('c1'),
      call('edit', { path: 'src/a.ts' }, 'c2'),
      result('c2'),
    ]);
    expect(proposeFusions({ events: foreignReason.events })).toEqual([]);

    const otherPath = parse([
      line('file.rejected', { path: '/repo/src/a.ts', reason: 'stale_snapshot' }),
      call('read_file', { path: 'src/unrelated.ts' }, 'c1'),
      result('c1'),
      call('edit', { path: 'src/unrelated.ts' }, 'c2'),
      result('c2'),
    ]);
    expect(proposeFusions({ events: otherPath.events })).toEqual([]);
  });

  it('(b4) a retry beyond MAX_REOPEN_CALLS is not attributed to the reject (bounded window)', () => {
    const body: string[] = [
      line('file.rejected', { path: '/repo/src/a.ts', reason: 'stale_snapshot' }),
      call('read_file', { path: 'src/a.ts' }, 'c1'),
      result('c1'),
    ];
    for (let i = 0; i < MAX_REOPEN_CALLS; i++) {
      body.push(call('read_file', { path: `src/other-${i}.ts` }, `f${i}`), result(`f${i}`));
    }
    body.push(call('edit', { path: 'src/a.ts' }, 'c2'), result('c2'));
    const { events } = parse(body);
    const spine = operatorSpine(events);
    expect(spine.calls.length).toBe(2 + MAX_REOPEN_CALLS);
    expect(proposeFusions({ events })).toEqual([]);
  });
});

describe('projection degrade (honest, never a guess)', () => {
  it('(f) a projection cannot carry the call order: 0 proposals + the stated limit', () => {
    const { events, projection } = parse([
      call('edit', { path: 'src/a.ts' }, 'c1'),
      result('c1'),
      applied('/repo/src/a.ts'),
      spoke(),
      call('bash', { command: 'npx vitest run src' }, 'c2'),
      result('c2'),
    ]);
    expect(proposeFusions({ events })).toHaveLength(1); // full fidelity sees it
    expect(proposeFusions({ projection })).toEqual([]); // the projection does not…
    const degraded = operatorSpineFromProjection(projection);
    expect(degraded.calls).toEqual([]);
    expect(degraded.fileEvents).toEqual([]);
    expect(degraded.limits).toEqual([PROJECTION_LIMIT]);
    expect(PROJECTION_LIMIT).toContain('never projects file.read/applied/rejected');
    expect(degraded.turns.length).toBeGreaterThan(0); // …the turn boundaries ARE projected
  });
});

describe('receiptFromProposals — proposer proposes, gate decides (ADR-0036)', () => {
  const fixtures = [
    call('edit', { path: 'src/a.ts' }, 'c1'),
    result('c1'),
    applied('/repo/src/a.ts'),
    spoke(),
    call('bash', { command: 'npx vitest run src' }, 'c2'),
    result('c2'),
  ];
  const withProposals = parse(fixtures);

  it('(e) defaults to hold, carries the proposal evidence, and never auto-promotes', () => {
    const proposals = proposeFusions({ events: withProposals.events });
    const receipt = receiptFromProposals(proposals, { subject: SESSION, at: '2026-01-01T00:00:00.000Z', operator: 't-eval' });
    expect(receipt.decision).toBe('hold');
    expect(receipt.v).toBe(1);
    expect(receipt.subject).toBe(SESSION);
    expect(receipt.source).toBe('decision');
    expect(receipt.status).toBe('proposed');
    expect(receipt.operator).toBe('t-eval');
    expect(receipt.evidence.length).toBe(proposals[0]!.evidence.length);
    expect(receipt.evidence[0]).toEqual({ kind: 'fuse_edit_verify:tool.call', ref: 'call:c1' });
    expect(receipt.requiredValidation).toHaveLength(1);
    expect(receipt.reasons.join(' ')).toContain('held until the gate re-derives them');
    expect(parsePromotionReceipt(receipt).receipt).toEqual(receipt);
  });

  it('(e2) NO request can produce `promote` from here — canary/hold/reject pass, promote is capped', () => {
    const proposals = proposeFusions({ events: withProposals.events });
    const decisions = PROMOTION_DECISIONS.map((request) => receiptFromProposals(proposals, { request }).decision);
    expect(decisions).not.toContain('promote');
    expect(decisions).toEqual(['hold', 'canary', 'hold', 'reject']);
    const capped = receiptFromProposals(proposals, { request: 'promote' });
    expect(capped.decision).toBe('hold');
    expect(capped.reasons.join(' ')).toContain('proposer, not the judge');
  });

  it('(e3) an empty proposal list still yields a valid hold — nothing to promote', () => {
    const empty = parse([line('user.message', { text: 'no work' }, 'user')]);
    const receipt = receiptFromProposals(proposeFusions({ events: empty.events }));
    expect(receipt.decision).toBe('hold');
    expect(receipt.subject).toBe(FUSE_OPERATOR_ID);
    expect(receipt.evidence).toEqual([]);
    expect(receipt.reasons.join(' ')).toContain('no fusion derived from this spine');
    expect(parsePromotionReceipt(receipt).error).toBeUndefined();
  });
});

describe('(f) REAL spine excerpts (verbatim, `.zelari/sessions`)', () => {
  // Provenance: session 070ddfeb-c7ef-4465-b023-4a806c1187f8, seq 311..316.
  // `args.oldString`/`args.newString` (multi-KB) and `tool.result.output` are elided
  // — the operator never reads them; seq, ts, kind, actor, callId, path, ok and text
  // are verbatim.
  const REAL_FUSE = [
    '{"schemaVersion":1,"sessionId":"070ddfeb-c7ef-4465-b023-4a806c1187f8","seq":311,"ts":1788940732805,"kind":"tool.call","actor":{"type":"agent"},"data":{"tool":"edit","args":{"oldString":"<elided>","newString":"<elided>","path":"src/cli/kraken/strictGatePackIndependence.test.ts","replaceAll":false,"snapshotId":"42b6e52fefb62a45"},"callId":"call_14649b648fcb4df981add529"}}',
    '{"schemaVersion":1,"sessionId":"070ddfeb-c7ef-4465-b023-4a806c1187f8","seq":313,"ts":1788940733224,"kind":"tool.result","actor":{"type":"tool"},"data":{"callId":"call_14649b648fcb4df981add529","output":"{\\"path\\":\\"<elided>\\",\\"applied\\":true,\\"occurrencesReplaced\\":1,\\"snapshotId\\":\\"21c95089c8733048\\",\\"bytesWritten\\":5905}","ok":true,"durationMs":414}}',
    '{"schemaVersion":1,"sessionId":"070ddfeb-c7ef-4465-b023-4a806c1187f8","seq":314,"ts":1788940733230,"kind":"file.applied","actor":{"type":"agent"},"data":{"path":"Z:\\\\EasyPeasy\\\\zelari-code\\\\src\\\\cli\\\\kraken\\\\strictGatePackIndependence.test.ts","snapshotId":"21c95089c8733048","occurrencesReplaced":1}}',
    '{"schemaVersion":1,"sessionId":"070ddfeb-c7ef-4465-b023-4a806c1187f8","seq":315,"ts":1788940733231,"kind":"assistant.message","actor":{"type":"agent"},"data":{"text":"Pressione critica (8 chiamate). Chirurgico: aggiorno i due test di `strictGatePackIndependence` alla nuova semantica M1.2 (UNVERIFIED + escape hatch), poi rerun compatto per identificare le altre 2 failure.","messageId":"fc32c49f-c86d-4901-bf45-084717baf187","finishReason":"tool_calls"}}',
    '{"schemaVersion":1,"sessionId":"070ddfeb-c7ef-4465-b023-4a806c1187f8","seq":316,"ts":1788940742823,"kind":"tool.call","actor":{"type":"agent"},"data":{"tool":"bash","args":{"command":"npx vitest run src/cli/kraken 2>&1 | Select-String -Pattern \'FAIL |Test Files |      Tests \' | ForEach-Object { $_.Line }","cwd":"Z:\\\\EasyPeasy\\\\zelari-code","timeoutMs":300000},"callId":"call_06da9e6324d548a7814cfac6"}}',
  ];

  // Provenance: session 515d9bce-bb0c-45bf-ac1f-f535285921d7, seq 157..164 — the
  // reject (CLI spelling `status`), the re-read, the retry. `tool.result.output`
  // is elided to a stub for size; every other field is verbatim.
  const REAL_REOPEN = [
    '{"schemaVersion":1,"sessionId":"515d9bce-bb0c-45bf-ac1f-f535285921d7","seq":157,"ts":1788549713073,"kind":"file.rejected","actor":{"type":"agent"},"data":{"path":"Z:\\\\EasyPeasy\\\\zelari-code\\\\docs\\\\EVALS.md","status":"stale_snapshot"}}',
    '{"schemaVersion":1,"sessionId":"515d9bce-bb0c-45bf-ac1f-f535285921d7","seq":158,"ts":1788549713074,"kind":"assistant.message","actor":{"type":"agent"},"data":{"text":"Verificato tutto (`/evolve`, `--evolve-status`, `--permissions strict|standard|yolo`, provenance). Ora le scritture — prima **t53** (README core) e **t51** (EVALS, nota BLOCKED onesta) in parallelo:","messageId":"c027925e-beee-41b3-9514-ab702f11291f","finishReason":"tool_calls"}}',
    '{"schemaVersion":1,"sessionId":"515d9bce-bb0c-45bf-ac1f-f535285921d7","seq":159,"ts":1788549721540,"kind":"tool.call","actor":{"type":"agent"},"data":{"tool":"read_file","args":{"endLine":66,"maxBytes":2500,"path":"docs/EVALS.md","startLine":46},"callId":"call_453257be9fed41fda83a5f79"}}',
    '{"schemaVersion":1,"sessionId":"515d9bce-bb0c-45bf-ac1f-f535285921d7","seq":161,"ts":1788549721546,"kind":"tool.result","actor":{"type":"tool"},"data":{"callId":"call_453257be9fed41fda83a5f79","output":"{\\"path\\":\\"Z:\\\\\\\\EasyPeasy\\\\\\\\zelari-code\\\\\\\\docs\\\\\\\\EVALS.md\\",\\"content\\":\\"<elided, irrelevant to the operator>\\"}","ok":true}}',
    '{"schemaVersion":1,"sessionId":"515d9bce-bb0c-45bf-ac1f-f535285921d7","seq":162,"ts":1788549721546,"kind":"file.read","actor":{"type":"agent"},"data":{"path":"Z:\\\\EasyPeasy\\\\zelari-code\\\\docs\\\\EVALS.md","snapshotId":"9db47e2717275fcf"}}',
    '{"schemaVersion":1,"sessionId":"515d9bce-bb0c-45bf-ac1f-f535285921d7","seq":163,"ts":1788549721547,"kind":"assistant.message","actor":{"type":"agent"},"data":{"text":"README core OK. EVALS.md ha snapshot stalo: rileggo la regione e riprovo.","messageId":"4229429b-ffbd-4551-8418-4a058ef5751f","finishReason":"tool_calls"}}',
    '{"schemaVersion":1,"sessionId":"515d9bce-bb0c-45bf-ac1f-f535285921d7","seq":164,"ts":1788549727517,"kind":"tool.call","actor":{"type":"agent"},"data":{"tool":"edit","args":{"newString":"<elided>","oldString":"> **No snapshot is published yet.** The harness exists and runs in CI","path":"docs/EVALS.md","replaceAll":false,"snapshotId":"9db47e2717275fcf"},"callId":"call_7913da9438da424f9a58afb7"}}',
  ];

  it('detects the real edit → turn → `npx vitest` verification (edit 311 → bash 316)', () => {
    const { events } = parse(REAL_FUSE);
    const proposals = proposeFusions({ events });
    expect(proposals).toHaveLength(1);
    const p = proposals[0]!;
    expect(p.kind).toBe('fuse_edit_verify');
    expect(p.callIds).toEqual(['call_14649b648fcb4df981add529', 'call_06da9e6324d548a7814cfac6']);
    expect(p.estSavedCalls).toBe(1);
    expect(p.path).toBe('src/cli/kraken/strictGatePackIndependence.test.ts');
    expect(p.decisiveSeq).toBe(311);
    expect(p.evidence).toContainEqual({ kind: 'file.applied', ref: 'seq:314' });
    expect(p.evidence).toContainEqual({ kind: 'assistant.message', ref: 'seq:315' });
    expect(unresolvedRefs(proposals, operatorSpine(events))).toEqual([]);
  });

  it('detects the real stale_snapshot → re-read → retry recovery (EVALS.md 157 → 159 → 164)', () => {
    const { events } = parse(REAL_REOPEN);
    const proposals = proposeFusions({ events });
    expect(proposals).toHaveLength(1);
    const p = proposals[0]!;
    expect(p.kind).toBe('reopen_with_minimal_diff');
    expect(p.path ?? '').toContain('docs\\EVALS.md'); // absolute on the spine, verbatim
    expect(p.callIds).toEqual(['call_453257be9fed41fda83a5f79', 'call_7913da9438da424f9a58afb7']);
    expect(p.decisiveSeq).toBe(157);
    expect(unresolvedRefs(proposals, operatorSpine(events))).toEqual([]);
    expect(receiptFromProposals(proposals).decision).toBe('hold');
  });
});
