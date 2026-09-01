/**
 * tools/eval/spineEvidence.test.ts — Fase 1 — evidence aggregator (report-only,
 * zero mutation). Unit tests over inline JSONL fixtures: every expected
 * finding is derived by hand from the aggregation rules in spineEvidence.ts.
 * If an assertion moves, the rule moved — not the noise.
 */

import { describe, expect, it } from 'vitest';
import { aggregateSpineEvidence, normalizeErrorKey, parseSpineLine } from './spineEvidence.ts';

let seq = 0;
function env(kind: string, data: Record<string, unknown>, sessionId = 's1'): string {
  seq += 1;
  return JSON.stringify({
    schemaVersion: 1,
    sessionId,
    seq,
    ts: 1755000000000 + seq,
    kind,
    actor: { type: 'agent' },
    data,
  });
}

function toolResult(tool: string, ok: boolean, extra: Record<string, unknown> = {}): string {
  return env('tool.result', { callId: `c${seq}`, tool, ok, ...extra });
}

describe('parseSpineLine', () => {
  it('parses a valid envelope into kind/knownKind/data', () => {
    const parsed = parseSpineLine(env('tool.result', { callId: 'c1', tool: 't', ok: true }));
    expect(parsed).toMatchObject({ malformed: false, kind: 'tool.result', knownKind: true });
    if (!parsed.malformed) expect(parsed.data).toMatchObject({ tool: 't', ok: true });
  });

  it('invalid JSON → malformed (counted, never a crash)', () => {
    expect(parseSpineLine('not json at all')).toMatchObject({ malformed: true });
    expect(parseSpineLine('[1,2,3]')).toMatchObject({ malformed: true }); // array is not an envelope
    expect(parseSpineLine('{"kind":"tool.result",')).toMatchObject({ malformed: true });
  });

  it('unknown kind → still a parsed event, knownKind:false (unknown ≠ failure)', () => {
    const parsed = parseSpineLine('{"kind":"future.kind","data":{}}');
    expect(parsed).toMatchObject({ malformed: false, kind: 'future.kind', knownKind: false });
  });
});

describe('normalizeErrorKey', () => {
  it('lowercases, collapses whitespace, truncates at 120 chars', () => {
    expect(normalizeErrorKey('  BOOM   happened  ')).toBe('boom happened');
    expect(normalizeErrorKey('a'.repeat(200))).toBe('a'.repeat(120));
  });
});

describe('aggregateSpineEvidence — tool patterns', () => {
  it('tool-misuse fires at threshold and merges unique sorted sessions', () => {
    const report = aggregateSpineEvidence([
      { sessionId: 's2', lines: [toolResult('read_file', false, { output: 'enoent' })] },
      { sessionId: 's1', lines: [toolResult('read_file', false, { output: 'enoent' }), toolResult('read_file', false, { output: 'enoent' })] },
    ]);
    expect(report.findings).toHaveLength(2); // tool-misuse (3× ok=false) + repeated-tool-error (3× same normalized error)
    const misuse = report.findings.find((f) => f.kind === 'tool-misuse')!;
    expect(misuse.id).toBe('tool-misuse:read_file');
    expect(misuse.count).toBe(3);
    expect(misuse.severity).toBe('warn');
    expect(misuse.sessions).toEqual(['s1', 's2']);
  });

  it('severity escalates to high at 2×minCount', () => {
    const report = aggregateSpineEvidence([
      { sessionId: 's1', lines: Array.from({ length: 6 }, () => toolResult('bash', false, { output: `e${seq}` })) },
    ]);
    const misuse = report.findings.find((f) => f.kind === 'tool-misuse')!;
    expect(misuse.count).toBe(6);
    expect(misuse.severity).toBe('high');
  });

  it('below threshold emits nothing (no invented evidence)', () => {
    const report = aggregateSpineEvidence([
      { sessionId: 's1', lines: [toolResult('bash', false, { output: 'e1' }), toolResult('bash', false, { output: 'e2' })] },
    ]);
    expect(report.findings).toEqual([]);
    expect(report.eventsScanned).toBe(2);
  });

  it('groups tool-misuse per tool name (distinct tools, distinct findings)', () => {
    const report = aggregateSpineEvidence([
      {
        sessionId: 's1',
        lines: [
          toolResult('grep', false, { output: 'g1' }),
          toolResult('grep', false, { output: 'g2' }),
          toolResult('grep', false, { output: 'g3' }),
          toolResult('bash', false, { output: 'b1' }),
          toolResult('bash', false, { output: 'b2' }),
          toolResult('bash', false, { output: 'b3' }),
        ],
      },
    ]);
    const misuses = report.findings.filter((f) => f.kind === 'tool-misuse');
    expect(misuses.map((f) => f.id)).toEqual(['tool-misuse:bash', 'tool-misuse:grep']); // id asc at equal severity/count
  });

  it('repeated-tool-error groups by normalized key (error field and output field converge); distinct errors do not', () => {
    const report = aggregateSpineEvidence([
      {
        sessionId: 's1',
        lines: [
          toolResult('edit_file', false, { output: '  Boom   happened ' }),
          toolResult('edit_file', false, { error: 'BOOM   happened' }),
          toolResult('edit_file', false, { error: 'boom happened' }),
          toolResult('patch', false, { error: 'conflict a' }),
          toolResult('patch', false, { error: 'conflict b' }),
          toolResult('patch', false, { error: 'conflict c' }),
        ],
      },
    ]);
    const repeated = report.findings.filter((f) => f.kind === 'repeated-tool-error');
    expect(repeated.map((f) => f.id)).toEqual(['repeated-tool-error:edit_file:boom-happened']);
    expect(repeated[0].count).toBe(3);
    expect(repeated[0].detail).toContain('boom happened');
  });

  it('errorKey truncates at 120 chars in id and detail', () => {
    const long = 'a'.repeat(200);
    const report = aggregateSpineEvidence([
      { sessionId: 's1', lines: [toolResult('t', false, { output: long }), toolResult('t', false, { output: long }), toolResult('t', false, { output: long })] },
    ]);
    const repeated = report.findings.find((f) => f.kind === 'repeated-tool-error')!;
    expect(repeated.id).toBe(`repeated-tool-error:t:${'a'.repeat(120)}`);
  });
});

describe('aggregateSpineEvidence — session pressure patterns', () => {
  it('resource-pressure sums the three resource kinds per session', () => {
    const report = aggregateSpineEvidence([
      {
        sessionId: 'r1',
        lines: [env('resource.limit_reached', {}), env('resource.overrun', {}), env('resource.reserve_entered', {})],
      },
      { sessionId: 'r2', lines: [env('resource.limit_reached', {}), env('resource.overrun', {})] },
    ]);
    const findings = report.findings.filter((f) => f.kind === 'resource-pressure');
    expect(findings).toHaveLength(1);
    expect(findings[0].id).toBe('resource-pressure:r1');
    expect(findings[0].count).toBe(3);
    expect(findings[0].sessions).toEqual(['r1']);
  });

  it('compaction-pressure fires globally with unique sorted sessions', () => {
    const report = aggregateSpineEvidence([
      { sessionId: 's2', lines: [env('session.compacted', { fromSeq: 1, toSeq: 5, checkpoint: 'cp' })] },
      { sessionId: 's1', lines: [env('session.compacted', { summary: 'legacy' }), env('session.compacted', { fromSeq: 2, toSeq: 9, checkpoint: 'cp2' })] },
    ]);
    const finding = report.findings.find((f) => f.kind === 'compaction-pressure')!;
    expect(finding.id).toBe('compaction-pressure');
    expect(finding.count).toBe(3);
    expect(finding.sessions).toEqual(['s1', 's2']);
    expect(finding.severity).toBe('warn');
  });

  it('tool.interrupted counts as its own pattern', () => {
    const report = aggregateSpineEvidence([
      { sessionId: 's1', lines: [env('tool.interrupted', {}), env('tool.interrupted', {}), env('tool.interrupted', {})] },
    ]);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]).toMatchObject({ id: 'tool-interrupted', kind: 'tool-interrupted', count: 3, severity: 'warn' });
  });
});

describe('aggregateSpineEvidence — verification patterns (ADR-0023 semantics)', () => {
  it('PASS never fires; REPAIR_REQUIRED/BLOCKED → verification-failures', () => {
    const report = aggregateSpineEvidence([
      {
        sessionId: 's1',
        lines: [
          env('verification.run', { source: 'gate', verdict: 'PASS' }),
          env('verification.run', { source: 'gate', verdict: 'REPAIR_REQUIRED' }),
          env('verification.run', { source: 'gate', verdict: 'BLOCKED' }),
          env('verification.run', { source: 'gate', verdict: 'REPAIR_REQUIRED' }),
        ],
      },
    ]);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]).toMatchObject({ id: 'verification-failures', count: 3 });
  });

  it('absent or unrecognized verdict → verification-unknown, never verification-failures', () => {
    const report = aggregateSpineEvidence([
      {
        sessionId: 's1',
        lines: [
          env('verification.run', { source: 'gate', verdict: 'WEIRD' }),
          env('verification.run', { source: 'gate' }),
          env('verification.run', { source: 'gate', verdict: 'pass' }), // wrong case ≠ PASS → unknown, not failure
        ],
      },
    ]);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]).toMatchObject({ id: 'verification-unknown', kind: 'verification-unknown', count: 3 });
    expect(report.findings[0].severity).toBe('warn'); // unknown is made visible, not punished
  });
});

describe('aggregateSpineEvidence — graph patterns', () => {
  it('graph-node-failures grouped by agent; ok missing or cancelled-only never counts', () => {
    const report = aggregateSpineEvidence([
      {
        sessionId: 's1',
        lines: [
          env('graph.node_ended', { nodeId: 'n1', agent: 'nettuno', ok: false }),
          env('graph.node_ended', { nodeId: 'n2', agent: 'nettuno', ok: false, cancelled: false }),
          env('graph.node_ended', { nodeId: 'n3', agent: 'nettuno', ok: false }),
          env('graph.node_ended', { nodeId: 'n4', agent: 'nettuno', cancelled: true }), // no ok claim
          env('graph.node_ended', { nodeId: 'n5', ok: false }), // agent missing → 'unknown' bucket (below threshold)
          env('graph.node_ended', { nodeId: 'n6', agent: 'plutone', ok: true }),
        ],
      },
    ]);
    const findings = report.findings.filter((f) => f.kind === 'graph-node-failures');
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ id: 'graph-node-failures:nettuno', count: 3 });
  });
});

describe('aggregateSpineEvidence — fail-closed accounting', () => {
  it('malformed lines and unknown kinds are counted, skipped, and never become failure findings', () => {
    const report = aggregateSpineEvidence([
      {
        sessionId: 's1',
        lines: ['not json', '[1,2]', env('mission.phase', { phase: 'x' }), '{"kind":"future.kind","actor":{"type":"agent"},"data":{}}'],
      },
    ]);
    expect(report.malformedLines).toBe(2);
    expect(report.unknownKindEvents).toBe(1);
    expect(report.eventsScanned).toBe(2);
    expect(report.findings).toEqual([]);
  });

  it('ok:true is never a failure even in bulk; blank lines are not events', () => {
    const report = aggregateSpineEvidence([
      {
        sessionId: 's1',
        lines: [
          '',
          toolResult('bash', true, { output: 'fine' }),
          toolResult('bash', true),
          '   ',
          env('tool.interrupted', {}),
          env('tool.interrupted', {}),
          env('tool.interrupted', {}),
        ],
      },
    ]);
    expect(report.eventsScanned).toBe(5);
    expect(report.malformedLines).toBe(0);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0].kind).toBe('tool-interrupted');
  });
});

describe('aggregateSpineEvidence — deterministic output', () => {
  it('orders findings: high first, then count desc, then id asc; empty input → honest zero report', () => {
    const report = aggregateSpineEvidence([
      {
        sessionId: 's1',
        lines: [
          ...Array.from({ length: 7 }, () => toolResult('bb', false, { output: 'x' })),
          ...Array.from({ length: 3 }, () => toolResult('aa', false, { output: `y${seq}` })),
          env('session.compacted', {}),
          env('session.compacted', {}),
          env('session.compacted', {}),
        ],
      },
    ]);
    expect(report.findings.map((f) => [f.severity, f.count, f.id])).toEqual([
      ['high', 7, 'repeated-tool-error:bb:x'],
      ['high', 7, 'tool-misuse:bb'],
      ['warn', 3, 'compaction-pressure'],
      ['warn', 3, 'tool-misuse:aa'],
    ]);
    const empty = aggregateSpineEvidence([]);
    expect(empty).toEqual({
      sessionsScanned: 0,
      eventsScanned: 0,
      malformedLines: 0,
      unknownKindEvents: 0,
      findings: [],
    });
  });

  it('respects an explicit minCount override (severity scales with it)', () => {
    const report = aggregateSpineEvidence(
      [{ sessionId: 's1', lines: [toolResult('bash', false, { output: 'e' }), toolResult('bash', false, { output: 'e' })] }],
      { minCount: 1 },
    );
    const misuse = report.findings.find((f) => f.kind === 'tool-misuse')!;
    expect(misuse.count).toBe(2);
    expect(misuse.severity).toBe('high'); // 2 >= 2*minCount(1)
  });
});
