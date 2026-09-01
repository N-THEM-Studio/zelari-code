/**
 * tools/eval/evolvePropose.test.ts — Fase 2.0 — proposal engine tests.
 * Covers: the closed finding→proposal mapping (incl. per-session merge),
 * dedupe fail-closed semantics, monotonic ids, tolerant store parsing,
 * determinism/order, fingerprints stable as counts grow, requiredValidation
 * per surface prefix, and the append layer (dry-run vs real, injected clock).
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  appendProposals,
  buildProposals,
  mapFinding,
  nextProposalId,
  parseProposalStore,
  requiredValidationFor,
  type EvolutionProposal,
  type StoredProposal,
} from './evolvePropose.ts';
import { type EvidenceFinding } from './spineEvidence.ts';

function finding(partial: Partial<EvidenceFinding> & { id: string; kind: string }): EvidenceFinding {
  return { severity: 'warn', count: 1, sessions: [], detail: '', hint: '', ...partial };
}

const FIXED_NOW = (): string => '2025-06-01T12:00:00.000Z';

describe('buildProposals — closed mapping', () => {
  it('tool-misuse → revise_tool_description on tool:<tool>', () => {
    const { proposals, deduped, unmapped } = buildProposals(
      [finding({ id: 'tool-misuse:read_file', kind: 'tool-misuse', count: 4, sessions: ['s1', 's2'] })],
      [],
    );
    expect(deduped).toBe(0);
    expect(unmapped).toBe(0);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toEqual({
      id: '',
      createdAt: '',
      status: 'proposed',
      operator: 'revise_tool_description',
      surface: 'tool:read_file',
      fingerprint: 'revise_tool_description|tool:read_file|read_file',
      evidence: { kinds: ['tool-misuse'], count: 4, sessions: ['s1', 's2'] },
      rationale:
        'revise_tool_description on tool:read_file: evidence tool-misuse count 4 across 2 session(s)',
      patchHint:
        'Re-read the description/zod schema of the tool; evidence: tool-misuse x4 across 2 session(s). Clarify the argument contract; do not change semantics without eval.',
      requiredValidation: ['npm run typecheck', 'npm run test:eval'],
    });
  });

  it('repeated-tool-error: two error keys, same tool → TWO proposals, same surface, different fingerprints', () => {
    const { proposals } = buildProposals(
      [
        finding({ id: 'repeated-tool-error:read_file:enoent', kind: 'repeated-tool-error', count: 3, sessions: ['s1'] }),
        finding({ id: 'repeated-tool-error:read_file:permission-denied', kind: 'repeated-tool-error', count: 2, sessions: ['s2'] }),
      ],
      [],
    );
    expect(proposals).toHaveLength(2);
    for (const p of proposals) {
      expect(p.operator).toBe('revise_tool_description');
      expect(p.surface).toBe('tool:read_file');
    }
    expect(proposals.map((p) => p.fingerprint).sort()).toEqual([
      'revise_tool_description|tool:read_file|read_file:enoent',
      'revise_tool_description|tool:read_file|read_file:permission-denied',
    ]);
  });

  it('resource-pressure across 3 sessions → ONE merged proposal: count summed, sessions unioned sorted', () => {
    const { proposals } = buildProposals(
      [
        finding({ id: 'resource-pressure:s3', kind: 'resource-pressure', count: 2, sessions: ['s3'] }),
        finding({ id: 'resource-pressure:s1', kind: 'resource-pressure', count: 3, sessions: ['s1'] }),
        finding({ id: 'resource-pressure:s2', kind: 'resource-pressure', count: 1, sessions: ['s2'] }),
      ],
      [],
    );
    expect(proposals).toHaveLength(1);
    expect(proposals[0].operator).toBe('revise_context_policy');
    expect(proposals[0].surface).toBe('policy:context-budget');
    expect(proposals[0].fingerprint).toBe('revise_context_policy|policy:context-budget|resource-pressure');
    expect(proposals[0].evidence.count).toBe(6);
    expect(proposals[0].evidence.sessions).toEqual(['s1', 's2', 's3']);
    expect(proposals[0].evidence.kinds).toEqual(['resource-pressure']);
  });

  it('compaction-pressure → revise_context_policy with its own primarySignal', () => {
    const { proposals } = buildProposals([finding({ id: 'compaction-pressure', kind: 'compaction-pressure', count: 5, sessions: ['s9'] })], []);
    expect(proposals).toHaveLength(1);
    expect(proposals[0].operator).toBe('revise_context_policy');
    expect(proposals[0].surface).toBe('policy:context-budget');
    expect(proposals[0].fingerprint).toBe('revise_context_policy|policy:context-budget|compaction-pressure');
    expect(proposals[0].patchHint).toContain('ADR-0032');
    expect(proposals[0].requiredValidation).toEqual(['npm run typecheck', 'npm run test:eval', 'npm run test']);
  });

  it('skill-low-success → revise_skill on skill:<skillId>', () => {
    const { proposals } = buildProposals([finding({ id: 'skill-low-success:write-readme', kind: 'skill-low-success', count: 5 })], []);
    expect(proposals).toHaveLength(1);
    expect(proposals[0].operator).toBe('revise_skill');
    expect(proposals[0].surface).toBe('skill:write-readme');
    expect(proposals[0].fingerprint).toBe('revise_skill|skill:write-readme|write-readme');
    expect(proposals[0].patchHint).toBe(
      "Inspect this skill's instructions/template; 5 recorded failure(s). Revise the prompt/template, then re-measure through usage.",
    );
    expect(proposals[0].requiredValidation).toEqual(['npm run test:eval']);
  });

  it('verification-unknown → needs_human_review, requiredValidation []', () => {
    const { proposals } = buildProposals([finding({ id: 'verification-unknown', kind: 'verification-unknown', count: 3, sessions: ['s1'] })], []);
    expect(proposals).toHaveLength(1);
    expect(proposals[0].operator).toBe('needs_human_review');
    expect(proposals[0].surface).toBe('verification:outcomes');
    expect(proposals[0].fingerprint).toBe('needs_human_review|verification:outcomes|unknown');
    expect(proposals[0].patchHint).toBe('No automated surface yet — human review of the evidence IS the operator.');
    expect(proposals[0].requiredValidation).toEqual([]);
  });

  it('graph-node-failures:agent → needs_human_review on agent:<agent>', () => {
    const { proposals } = buildProposals([finding({ id: 'graph-node-failures:explorer', kind: 'graph-node-failures', count: 3, sessions: ['s1'] })], []);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      operator: 'needs_human_review',
      surface: 'agent:explorer',
      fingerprint: 'needs_human_review|agent:explorer|explorer',
    });
  });

  it('unknown kind → no proposal, counted as unmapped', () => {
    const result = buildProposals([finding({ id: 'weird-finding:x', kind: 'weird-finding' })], []);
    expect(result).toEqual({ proposals: [], deduped: 0, unmapped: 1 });
    expect(mapFinding(finding({ id: 'weird-finding:x', kind: 'weird-finding' }))).toBe('stop');
  });

  it('empty findings → { proposals: [], deduped: 0, unmapped: 0 }', () => {
    expect(buildProposals([], [])).toEqual({ proposals: [], deduped: 0, unmapped: 0 });
  });
});

describe('buildProposals — dedupe (fail-closed)', () => {
  const findingA = (): EvidenceFinding => finding({ id: 'tool-misuse:bash', kind: 'tool-misuse', count: 3, sessions: ['s1'] });

  function firstProposal(): EvolutionProposal {
    const { proposals } = buildProposals([findingA()], []);
    return proposals[0];
  }

  it("existing record with status 'proposed' and same fingerprint → skipped (deduped 1)", () => {
    const existing: StoredProposal[] = [{ ...firstProposal(), id: 'p-0001', createdAt: FIXED_NOW(), status: 'proposed' }];
    const { proposals, deduped } = buildProposals([findingA()], existing);
    expect(proposals).toHaveLength(0);
    expect(deduped).toBe(1);
  });

  it("existing 'withdrawn' → re-proposed", () => {
    const existing: StoredProposal[] = [{ ...firstProposal(), id: 'p-0001', createdAt: FIXED_NOW(), status: 'withdrawn' }];
    const { proposals, deduped } = buildProposals([findingA()], existing);
    expect(proposals).toHaveLength(1);
    expect(deduped).toBe(0);
  });

  it("existing 'rejected' → skipped (fail-closed)", () => {
    const existing: StoredProposal[] = [{ ...firstProposal(), id: 'p-0001', createdAt: FIXED_NOW(), status: 'rejected' }];
    const { proposals, deduped } = buildProposals([findingA()], existing);
    expect(proposals).toHaveLength(0);
    expect(deduped).toBe(1);
  });

  it('existing UNKNOWN status string → blocking (fail-closed: under-propose rather than spam)', () => {
    const existing: StoredProposal[] = [{ ...firstProposal(), id: 'p-0001', createdAt: FIXED_NOW(), status: 'mystery-status' }];
    const { proposals, deduped } = buildProposals([findingA()], existing);
    expect(proposals).toHaveLength(0);
    expect(deduped).toBe(1);
  });
});

describe('nextProposalId', () => {
  it('empty store → p-0001', () => {
    expect(nextProposalId([])).toBe('p-0001');
  });

  it("['p-0001','p-0003'] → p-0004; non-numeric ids are ignored", () => {
    const records = [
      { id: 'p-0001', status: 'proposed' },
      { id: 'p-0003', status: 'proposed' },
      { id: 'zzz-not-numeric', status: 'proposed' },
    ] as unknown as StoredProposal[];
    expect(nextProposalId(records)).toBe('p-0004');
  });
});

describe('parseProposalStore', () => {
  it('malformed lines counted and skipped, valid kept, never throws', () => {
    const lines = [
      JSON.stringify({ id: 'p-0001', status: 'proposed', fingerprint: 'fp-1' }),
      'not-json-at-all',
      '[1, 2, 3]',
      'null',
      JSON.stringify({ status: 'proposed', fingerprint: 'no-id' }),
      JSON.stringify({ id: 'p-0002', status: 'weird-status', fingerprint: 'fp-2' }),
      '',
      '   ',
    ];
    const { records, malformed } = parseProposalStore(lines);
    expect(malformed).toBe(4); // invalid JSON, array, null, missing id
    expect(records).toHaveLength(2);
    expect(records[0].id).toBe('p-0001');
    expect(records[1].id).toBe('p-0002');
    expect(records[1].status).toBe('weird-status'); // unknown status recorded as-is
  });
});

describe('determinism and ordering', () => {
  const fixedFindings = (): EvidenceFinding[] => [
    finding({ id: 'compaction-pressure', kind: 'compaction-pressure', count: 20, sessions: ['sA'] }),
    finding({ id: 'tool-misuse:zshop', kind: 'tool-misuse', count: 9, sessions: ['sA'] }),
    finding({ id: 'tool-misuse:ashop', kind: 'tool-misuse', count: 9, sessions: ['sB'] }),
    finding({ id: 'verification-unknown', kind: 'verification-unknown', count: 4, sessions: ['sA'] }),
    finding({ id: 'skill-low-success:aaa', kind: 'skill-low-success', count: 5 }),
    finding({ id: 'skill-low-success:bbb', kind: 'skill-low-success', count: 5 }),
    finding({ id: 'graph-node-failures:explorer', kind: 'graph-node-failures', count: 2, sessions: ['sA'] }),
    finding({ id: 'tool-interrupted', kind: 'tool-interrupted', count: 2, sessions: ['sA'] }),
  ];

  it('two calls on fixed findings → identical output (pure core)', () => {
    const a = buildProposals(fixedFindings(), []);
    const b = buildProposals(fixedFindings(), []);
    expect(a).toEqual(b);
  });

  it('order rule: skill before tool before policy before review; then count desc, surface asc, primarySignal asc', () => {
    const { proposals } = buildProposals(fixedFindings(), []);
    expect(proposals.map((p) => p.fingerprint)).toEqual([
      // revise_skill (priority 0): count tie → surface asc
      'revise_skill|skill:aaa|aaa',
      'revise_skill|skill:bbb|bbb',
      // revise_tool_description (priority 1): count 9 tie → surface asc
      'revise_tool_description|tool:ashop|ashop',
      'revise_tool_description|tool:zshop|zshop',
      // revise_context_policy (priority 2): count 20 wins over the review findings below
      'revise_context_policy|policy:context-budget|compaction-pressure',
      // needs_human_review (priority 3): count desc first (4 > 2), then surface asc at count 2
      'needs_human_review|verification:outcomes|unknown',
      'needs_human_review|agent:explorer|explorer',
      'needs_human_review|tool-boundary:interrupted|interrupted',
    ]);
  });

  it('fingerprint stability: same finding with count 5 vs count 9 → same fingerprint', () => {
    const small = buildProposals([finding({ id: 'tool-misuse:bash', kind: 'tool-misuse', count: 5, sessions: ['s1'] })], []);
    const big = buildProposals([finding({ id: 'tool-misuse:bash', kind: 'tool-misuse', count: 9, sessions: ['s1'] })], []);
    expect(small.proposals[0].fingerprint).toBe(big.proposals[0].fingerprint);
    expect(small.proposals[0].evidence.count).toBe(5);
    expect(big.proposals[0].evidence.count).toBe(9);
  });
});

describe('requiredValidationFor — per surface prefix', () => {
  it('tool:/skill:/policy:/everything-else', () => {
    expect(requiredValidationFor('tool:read_file')).toEqual(['npm run typecheck', 'npm run test:eval']);
    expect(requiredValidationFor('skill:write-readme')).toEqual(['npm run test:eval']);
    expect(requiredValidationFor('policy:context-budget')).toEqual(['npm run typecheck', 'npm run test:eval', 'npm run test']);
    expect(requiredValidationFor('agent:explorer')).toEqual([]);
    expect(requiredValidationFor('verification:outcomes')).toEqual([]);
    expect(requiredValidationFor('tool-boundary:interrupted')).toEqual([]);
  });
});

describe('appendProposals', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function tmpStore(name: string): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'evolve-propose-test-'));
    dirs.push(dir);
    return path.join(dir, name);
  }

  function oneFinding(): EvidenceFinding {
    return finding({ id: 'skill-low-success:write-readme', kind: 'skill-low-success', count: 5 });
  }

  it('dryRun → file NOT created, no parent dir created, written 0, ids still assigned in place', () => {
    const store = tmpStore(path.join('nested', 'dry.jsonl'));
    const { proposals } = buildProposals([oneFinding()], []);
    const result = appendProposals(store, proposals, { dryRun: true, now: FIXED_NOW });
    expect(result).toEqual({ written: 0, path: store });
    expect(existsSync(store)).toBe(false);
    expect(existsSync(path.dirname(store))).toBe(false);
    expect(proposals[0].id).toBe('p-0001'); // assigned in memory for preview
    expect(proposals[0].createdAt).toBe(FIXED_NOW());
  });

  it('non-dry → lines parse back; ids monotonic; createdAt from the injected fixed clock', () => {
    const store = tmpStore('proposals.jsonl');
    const { proposals } = buildProposals([oneFinding(), finding({ id: 'tool-misuse:bash', kind: 'tool-misuse', count: 2, sessions: ['s1'] })], []);
    const result = appendProposals(store, proposals, { now: FIXED_NOW });
    expect(result).toEqual({ written: 2, path: store });
    const { records, malformed } = parseProposalStore(readFileSync(store, 'utf-8').split(/\r?\n/));
    expect(malformed).toBe(0);
    expect(records.map((r) => r.id)).toEqual(['p-0001', 'p-0002']);
    expect(records.map((r) => r.createdAt)).toEqual([FIXED_NOW(), FIXED_NOW()]);
    expect(records.every((r) => r.status === 'proposed')).toBe(true);
    expect(records[0].fingerprint).toBe('revise_skill|skill:write-readme|write-readme');
  });

  it('second append continues the existing store sequence (p-0003)', () => {
    const store = tmpStore('grow.jsonl');
    const first = buildProposals([oneFinding()], []).proposals;
    appendProposals(store, first, { now: FIXED_NOW });
    const second = buildProposals([finding({ id: 'tool-misuse:bash', kind: 'tool-misuse', count: 7, sessions: ['s2'] })], []).proposals;
    const result = appendProposals(store, second, { now: FIXED_NOW });
    expect(result.written).toBe(1);
    expect(second[0].id).toBe('p-0002'); // store already had p-0001
    const { records } = parseProposalStore(readFileSync(store, 'utf-8').split(/\r?\n/));
    expect(records.map((r) => r.id)).toEqual(['p-0001', 'p-0002']);
  });

  it('empty batch → nothing written, no store file', () => {
    const store = tmpStore('empty.jsonl');
    const result = appendProposals(store, [], { now: FIXED_NOW });
    expect(result).toEqual({ written: 0, path: store });
    expect(existsSync(store)).toBe(false);
  });
});
