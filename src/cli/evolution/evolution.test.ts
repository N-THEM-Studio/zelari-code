/**
 * evolution.test — deterministic classifier + append-only ledger + fitness +
 * proposal store + spine evidence (Fase 5 v0 / Wave 1, ADR-0036). Contracts:
 *   - classifyTask is pure and ordered (same input ⇒ same class);
 *   - the ledger is a strict no-op while ZELARI_EVOLUTION != shadow;
 *   - replay is tolerant (corrupt lines skipped, never fatal);
 *   - fitness v1 is deterministic tier-weighted arithmetic (t42, no LLM);
 *   - the proposal store view folds last-record-per-id, read-only (t43);
 *   - spine evidence maps tool.call/tool.result to tool-output refs (t44).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  appendLedgerEntry,
  evolutionMode,
  type LedgerEntry,
  LEDGER_REL,
  ledgerStats,
  ledgerPath,
  readLedger,
} from './ledger.js';
import { classifyTask } from './classifyTask.js';
import {
  evidenceRefsFromEventLines,
  MAX_EVIDENCE_REFS,
} from './evidenceFromSpine.js';
import {
  proposalsPath,
  proposalSummary,
  readProposalStore,
} from './proposals.js';

const savedEvo = process.env.ZELARI_EVOLUTION;

afterEach(() => {
  if (savedEvo === undefined) delete process.env.ZELARI_EVOLUTION;
  else process.env.ZELARI_EVOLUTION = savedEvo;
});

describe('classifyTask', () => {
  it('applies ordered bilingual rules deterministically', () => {
    expect(classifyTask({ prompt: 'fix the regression in the parser' }).taskClass).toBe('bugfix');
    expect(classifyTask({ prompt: 'aggiungi test per il modulo' }).taskClass).toBe('tests');
    expect(classifyTask({ prompt: 'update README docs' }).taskClass).toBe('docs');
    expect(classifyTask({ prompt: 'rename and extract helpers' }).taskClass).toBe('refactor');
    expect(classifyTask({ prompt: 'add a new export function' }).taskClass).toBe('feature');
    expect(classifyTask({ prompt: '' }).taskClass).toBe('chore');
  });

  it('shape heuristics kick in when the prompt has no signal', () => {
    expect(classifyTask({ prompt: 'x', fileCount: 12 }).taskClass).toBe('refactor');
    expect(classifyTask({ prompt: 'x', diffLines: 900 }).taskClass).toBe('refactor');
    expect(classifyTask({ prompt: 'x', hasTests: true }).taskClass).toBe('tests');
    expect(classifyTask({ prompt: 'x' }).taskClass).toBe('feature');
  });

  it('reports the signals that fired', () => {
    const r = classifyTask({ prompt: 'fix crash', fileCount: 10, hasTests: true });
    expect(r.signals).toContain('prompt:bugfix');
    expect(r.signals).toContain('hasTests');
    expect(r.signals).toContain('wide-diff');
  });
});

describe('ledger', () => {
  it('is a no-op while evolution is off (default)', () => {
    delete process.env.ZELARI_EVOLUTION;
    expect(evolutionMode()).toBe('0');
    const dir = mkdtempSync(path.join(tmpdir(), 'zelari-evo-'));
    try {
      const res = appendLedgerEntry(dir, {
        runId: 'r1',
        at: new Date().toISOString(),
        mode: '0',
        taskClass: 'feature',
        verdict: 'PASS',
      });
      expect(res.written).toBe(false);
      expect(res.reason).toContain('ZELARI_EVOLUTION');
      expect(readLedger(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('shadow mode appends, then replays tolerantly past a corrupt line', () => {
    process.env.ZELARI_EVOLUTION = 'shadow';
    expect(evolutionMode()).toBe('shadow');
    const dir = mkdtempSync(path.join(tmpdir(), 'zelari-evo-'));
    try {
      const r1 = appendLedgerEntry(dir, {
        runId: 'r1',
        at: '2026-01-01T00:00:00.000Z',
        mode: 'shadow',
        taskClass: 'bugfix',
        verdict: 'PASS',
        evidenceTier: 'command-output',
      });
      expect(r1.written).toBe(true);
      expect(appendLedgerEntry(dir, {
        runId: 'r2',
        at: '2026-01-02T00:00:00.000Z',
        mode: 'shadow',
        taskClass: 'docs',
        verdict: 'FAIL',
      }).written).toBe(true);

      // corrupt third line — tolerant replay must skip it
      const file = ledgerPath(dir);
      writeFileSync(file, `${readFileSync(file, 'utf8')}CORRUPT{{{\n`, 'utf8');

      const entries = readLedger(dir);
      expect(entries).toHaveLength(2);
      const stats = ledgerStats(entries);
      expect(stats.runs).toBe(2);
      expect(stats.byVerdict.PASS).toBe(1);
      expect(stats.byVerdict.FAIL).toBe(1);
      expect(stats.byClass.bugfix).toBe(1);
      expect(stats.byClass.docs).toBe(1);
      expect(stats.firstAt).toBe('2026-01-01T00:00:00.000Z');
      expect(stats.lastAt).toBe('2026-01-02T00:00:00.000Z');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ledger lives under .zelari/evolution/ (project-scoped)', () => {
    expect(LEDGER_REL).toContain(path.join('.zelari', 'evolution'));
  });
});

describe('fitness v1 (t42 — deterministic, tier-weighted)', () => {
  const e = (over: Partial<LedgerEntry>): LedgerEntry => ({
    runId: 'r',
    at: '2026-01-01T00:00:00.000Z',
    mode: 'shadow',
    taskClass: 'feature',
    verdict: 'PASS',
    ...over,
  });

  it('degrades the pass rate of runs backed only by untiered evidence', () => {
    // PASS backed by command-output (weight 1) + FAIL with no tier (weight
    // 0.25): simple passRate = 0.5, weighted = 1 / 1.25 = 0.8 — the FAIL
    // hurts less because it was never backed by traceable evidence.
    const stats = ledgerStats([
      e({ runId: 'a', evidenceTier: 'command-output', verdict: 'PASS' }),
      e({ runId: 'b', verdict: 'FAIL' }),
    ]);
    expect(stats.byClassFitness.feature!.passRate).toBe(0.5);
    expect(stats.byClassFitness.feature!.weightedPassRate).toBeCloseTo(0.8, 10);
    expect(stats.weightedPassRate).toBeCloseTo(0.8, 10);
  });

  it('excludes HOLD/UNKNOWN from the pass-rate denominator (unknown ≠ pass ≠ fail)', () => {
    const stats = ledgerStats([
      e({ runId: 'a', verdict: 'PASS', evidenceTier: 'tool-output' }),
      e({ runId: 'b', verdict: 'UNKNOWN' }),
      e({ runId: 'c', verdict: 'HOLD' }),
    ]);
    expect(stats.weightedPassRate).toBe(1); // only the rated PASS counts
    expect(stats.byVerdict.UNKNOWN).toBe(1);
  });

  it('computes behavioural + cost aggregates per class', () => {
    const stats = ledgerStats([
      e({ runId: 'a', taskClass: 'bugfix', verdict: 'FAIL', steerCount: 2, rollbackUsed: true, costUsd: 0.5, latencyMs: 100 }),
      e({ runId: 'b', taskClass: 'bugfix', verdict: 'PASS', steerCount: 0, costUsd: 0.1, latencyMs: 300 }),
    ]);
    const f = stats.byClassFitness.bugfix!;
    expect(f.rollbackRate).toBe(0.5);
    expect(f.avgSteerCount).toBe(1);
    expect(f.avgCostUsd).toBeCloseTo(0.3, 10);
    expect(f.avgLatencyMs).toBe(200);
    expect(f.passRate).toBe(0.5);
  });

  it('returns empty-but-well-formed stats for an empty ledger', () => {
    const stats = ledgerStats([]);
    expect(stats.runs).toBe(0);
    expect(stats.byClassFitness).toEqual({});
    expect(stats.weightedPassRate).toBeUndefined();
    expect(stats.rollbackRate).toBeUndefined();
  });
});

describe('proposal store view (t43 — read-only, last-record-wins)', () => {
  it('folds repeated ids to the LAST record and skips corrupt lines', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'zelari-prop-'));
    try {
      mkdirSync(path.dirname(proposalsPath(dir)), { recursive: true });
      writeFileSync(
        proposalsPath(dir),
        [
          JSON.stringify({ id: 'p-0001', status: 'proposed', operator: 'revise_skill', surface: 'skill:write-readme', evidence: { count: 12 } }),
          'CORRUPT{{{',
          JSON.stringify({ id: 'p-0001', status: 'applied', operator: 'revise_skill', surface: 'skill:write-readme', evidence: { count: 12 } }),
          JSON.stringify({ id: 'p-0002', status: 'proposed', operator: 'stop', surface: 'agent:explorer', evidence: { count: 3 } }),
        ].join('\n') + '\n',
        'utf8',
      );
      const records = readProposalStore(dir);
      expect(records).toHaveLength(2);
      const p1 = records.find((r) => r.id === 'p-0001');
      expect(p1?.status).toBe('applied'); // event-sourced: last wins
      expect(p1?.evidenceCount).toBe(12);
      const sum = proposalSummary(records);
      expect(sum.total).toBe(2);
      expect(sum.byStatus.applied).toBe(1);
      expect(sum.byStatus.proposed).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('missing store reads as empty (fail-open)', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'zelari-prop-'));
    try {
      expect(readProposalStore(dir)).toEqual([]);
      expect(proposalSummary([])).toEqual({ total: 0, byStatus: {} });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('spine evidence (t44 — tool.call/tool.result → tool-output)', () => {
  it('maps tool events to traceable refs with seq and tool:callId pointer', () => {
    const refs = evidenceRefsFromEventLines([
      JSON.stringify({ seq: 7, type: 'tool.call', at: 1700000000, data: { tool: 'edit_file', toolCallId: 'tc-1' } }),
      JSON.stringify({ seq: 8, type: 'tool.result', at: 1700000001, data: { tool: 'bash', toolCallId: 'tc-2', ok: true } }),
      JSON.stringify({ seq: 9, type: 'user.message', data: { text: 'not a tool' } }),
      'CORRUPT{{{',
    ]);
    expect(refs).toHaveLength(2);
    expect(refs[0]).toMatchObject({ tier: 'tool-output', ref: 'edit_file:tc-1', seq: 7, capturedAt: 1700000000 });
    expect(refs[1]).toMatchObject({ tier: 'tool-output', ref: 'bash:tc-2' });
  });

  it('tolerates flat payloads (data at the envelope level) and caps output', () => {
    const many = Array.from({ length: MAX_EVIDENCE_REFS + 50 }, (_, i) =>
      JSON.stringify({ seq: i + 1, type: 'tool.call', data: { tool: 'read_file' } }),
    );
    const refs = evidenceRefsFromEventLines(many);
    expect(refs).toHaveLength(MAX_EVIDENCE_REFS);
    // flat payload: tool sits on the record itself
    expect(refs[0]).toMatchObject({ tier: 'tool-output', ref: 'read_file' });
  });
});
