/**
 * Kraken skill auto-suggest — tests.
 *
 * Covers:
 *   - `slugifyLabel` produces kebab-case ids
 *   - No suggestions when the run did not converge
 *   - No suggestions when no reviewer failed
 *   - One suggestion produced for a typical FAIL→fix pattern
 *   - Suggestion contains the failure findings and the promote command
 *   - Confidence scales with the depth of evidence
 */

import { describe, it, expect } from 'vitest';
import {
  slugifyLabel,
  suggestSkillsFromRun,
  renderSuggestionCard,
} from './skillSuggest.js';
import type { ScriptRunResult, TentacleRef } from '@zelari/core';

function makeRef(over: Partial<TentacleRef> & { id: string; kind: TentacleRef['kind']; label: string; status: TentacleRef['status'] }): TentacleRef {
  return {
    scope: [],
    findings: '',
    ...over,
  };
}

function makeResult(opts: { converged: boolean; refs: TentacleRef[] }): ScriptRunResult {
  const tentaclesById = new Map<string, TentacleRef>();
  for (const r of opts.refs) tentaclesById.set(r.id, r);
  return {
    tentacles: tentaclesById,
    mergeCount: 1,
    converged: opts.converged,
    cancelled: false,
    durationMs: 1000,
    unresolvedFindings: [],
  };
}

describe('slugifyLabel', () => {
  it('converts a label to kebab-case', () => {
    expect(slugifyLabel('Acceptance Test 1')).toBe('acceptance-test-1');
  });
  it('drops punctuation and trims', () => {
    expect(slugifyLabel('  Hello, World!  ')).toBe('hello-world');
  });
  it('falls back to "kraken-skill" for empty input', () => {
    expect(slugifyLabel('')).toBe('kraken-skill');
    expect(slugifyLabel('!!!')).toBe('kraken-skill');
  });
  it('caps at 40 chars', () => {
    const long = 'a'.repeat(100);
    expect(slugifyLabel(long).length).toBeLessThanOrEqual(40);
  });
});

describe('suggestSkillsFromRun', () => {
  it('returns [] when the run did not converge', () => {
    const result = makeResult({
      converged: false,
      refs: [
        makeRef({ id: 't0001', kind: 'verify', label: 'judge', status: 'done', verdict: 'fail', findings: 'x'.repeat(200) }),
        makeRef({ id: 't0002', kind: 'fix', label: 'rework', status: 'done', findings: 'y'.repeat(200) }),
      ],
    });
    expect(suggestSkillsFromRun(result, { graphId: 'g1', goal: 'x' })).toEqual([]);
  });

  it('returns [] when no reviewer failed', () => {
    const result = makeResult({
      converged: true,
      refs: [
        makeRef({ id: 't0001', kind: 'general', label: 'do', status: 'done', findings: 'ok' }),
        makeRef({ id: 't0002', kind: 'verify', label: 'judge', status: 'done', verdict: 'pass', findings: 'ok' }),
      ],
    });
    expect(suggestSkillsFromRun(result, { graphId: 'g2', goal: 'x' })).toEqual([]);
  });

  it('returns [] when there are no fix-nodes', () => {
    const result = makeResult({
      converged: true,
      refs: [
        makeRef({ id: 't0001', kind: 'general', label: 'do', status: 'done' }),
        makeRef({ id: 't0002', kind: 'verify', label: 'judge', status: 'done', verdict: 'fail', findings: 'broken' }),
      ],
    });
    expect(suggestSkillsFromRun(result, { graphId: 'g3', goal: 'x' })).toEqual([]);
  });

  it('produces one suggestion for a FAIL→fix pattern', () => {
    const result = makeResult({
      converged: true,
      refs: [
        makeRef({ id: 't0001', kind: 'general', label: 'refactor auth', status: 'done', findings: 'wrote code' }),
        makeRef({
          id: 't0002',
          kind: 'verify',
          label: 'acceptance check',
          status: 'done',
          verdict: 'fail',
          findings: 'function `slugify` is missing from src/util.ts',
        }),
        makeRef({
          id: 't0003',
          kind: 'fix',
          label: 'rework: refactor auth',
          status: 'done',
          findings: 'added slugify, removed unused import',
        }),
      ],
    });
    const out = suggestSkillsFromRun(result, { graphId: 'g-abc', goal: 'refactor auth' });
    expect(out).toHaveLength(1);
    const s = out[0];
    expect(s.id).toMatch(/^kraken-skill-/);
    expect(s.id).toContain('g-abc');
    expect(s.title).toMatch(/acceptance check/);
    expect(s.sourceKind).toBe('verify');
    expect(s.body).toContain('slugify');
    expect(s.body).toContain('/promote-skill');
    expect(s.confidence).toBeGreaterThan(0);
  });

  it('confidence is high when findings are concrete and the goal is non-trivial', () => {
    const failure = 'function `slugify` is missing from src/util.ts: it should take a string and return a slugified version. '.repeat(5);
    const fix = 'added slugify, removed unused import, updated test to cover unicode. '.repeat(5);
    const result = makeResult({
      converged: true,
      refs: [
        makeRef({ id: 't0001', kind: 'general', label: 'do', status: 'done' }),
        makeRef({ id: 't0002', kind: 'verify', label: 'judge', status: 'done', verdict: 'fail', findings: failure }),
        makeRef({ id: 't0003', kind: 'fix', label: 'rework', status: 'done', findings: fix }),
        makeRef({ id: 't0004', kind: 'merge', label: 'merge', status: 'done' }),
      ],
    });
    const out = suggestSkillsFromRun(result, { graphId: 'g-rich', goal: 'ship a working slugify that handles unicode' });
    expect(out[0].confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('handles spec and conformance reviewers the same way as verify', () => {
    const result = makeResult({
      converged: true,
      refs: [
        makeRef({ id: 't0001', kind: 'general', label: 'do', status: 'done' }),
        makeRef({ id: 't0002', kind: 'spec', label: 'spec review', status: 'done', verdict: 'fail', findings: 'spec mismatch' }),
        makeRef({ id: 't0003', kind: 'conformance', label: 'conformance', status: 'done', verdict: 'fail', findings: 'literal mismatch' }),
        makeRef({ id: 't0004', kind: 'fix', label: 'rework', status: 'done', findings: 'fixed' }),
      ],
    });
    const out = suggestSkillsFromRun(result, { graphId: 'g-multi', goal: 'match the spec' });
    expect(out).toHaveLength(1);
    expect(out[0].sourceKind).toBe('spec'); // first reviewer fail wins
  });
});

describe('renderSuggestionCard', () => {
  it('returns the suggestion body unchanged', () => {
    const s = {
      id: 'test',
      title: 'T',
      body: 'hello',
      sourceKind: 'verify',
      failureFindings: 'broken',
      confidence: 0.5,
    };
    expect(renderSuggestionCard(s)).toBe('hello');
  });
});
