/**
 * candidateRegistry.test — Fase 3 (ADR-0020): candidate contracts.
 *   - structured parse (ok / malformed / lenient fills)
 *   - degraded evidence preserved
 *   - cap 3 per turn + reset
 *   - instructions rendering
 */
import { describe, expect, it, beforeEach } from 'vitest';
import {
  KRAKEN_CANDIDATE_CAP,
  candidateInstructions,
  getKrakenCheckResults,
  getKrakenSelection,
  isKrakenSelectionEnabled,
  krakenCandidates,
  krakenChecksPassed,
  krakenRequiredChecks,
  parseCandidateReport,
  registerCandidate,
  resetKrakenCandidates,
  reserveCandidateSlot,
  setKrakenCheckResults,
  setKrakenSelection,
} from './candidateRegistry.js';

const GOOD = [
  'Research summary: the refresh path races with the session bootstrap.',
  '<candidate-report>',
  '{',
  '  "hypothesis": "Session lost because refresh races with bootstrap",',
  '  "evidence": [',
  '    { "claim": "refresh() reads stale token", "basis": "read_file src/auth.ts:120", "degraded": false },',
  '    { "claim": "grep timed out on legacy dir", "basis": "grep_content legacy/", "degraded": true }',
  '  ],',
  '  "risks": ["bootstrap order may differ in prod"]',
  '}',
  '</candidate-report>',
].join('\n');

describe('parseCandidateReport', () => {
  it('parses a well-formed report with evidence + risks', () => {
    const r = parseCandidateReport(GOOD);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.report.hypothesis).toContain('refresh races');
      expect(r.report.evidence).toHaveLength(2);
      expect(r.report.evidence[0].degraded).toBe(false);
      expect(r.report.hasDegradedEvidence).toBe(true);
      expect(r.report.risks).toHaveLength(1);
    }
  });

  it('missing block → malformed', () => {
    const r = parseCandidateReport('just prose, no block');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/missing report block/);
  });

  it('invalid JSON → malformed with reason', () => {
    const r = parseCandidateReport('<candidate-report>{nope</candidate-report>');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/invalid JSON/);
  });

  it('lenient fills: missing/extra fields never break the parse', () => {
    const r = parseCandidateReport(
      '<candidate-report>{ "hypothesis": "h", "evidence": [ { "claim": "c" }, "junk", 5 ], "extra": 1 }</candidate-report>',
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.report.hypothesis).toBe('h');
      // "junk"/5 dropped; claim-only item kept with safe defaults
      expect(r.report.evidence).toEqual([
        { claim: 'c', basis: '', degraded: false },
      ]);
      expect(r.report.risks).toEqual([]);
      expect(r.report.hasDegradedEvidence).toBe(false);
    }
  });

  it('uses the LAST block when the model emits more than one', () => {
    const r = parseCandidateReport(
      '<candidate-report>{ "hypothesis": "first" }</candidate-report>\nmore\n<candidate-report>{ "hypothesis": "final" }</candidate-report>',
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.report.hypothesis).toBe('final');
  });
});

describe('per-turn registry', () => {
  beforeEach(() => resetKrakenCandidates());

  function reportOf(raw: string) {
    const r = parseCandidateReport(raw);
    if (!r.ok) throw new Error('fixture must parse');
    return r.report;
  }

  it('cap: the 4th slot is refused, the first 3 accepted', () => {
    expect(reserveCandidateSlot()).toEqual({ index: 1 });
    registerCandidate({ status: 'ok', description: 'a', report: reportOf(GOOD), raw: GOOD });
    expect(reserveCandidateSlot()).toEqual({ index: 2 });
    registerCandidate({ status: 'ok', description: 'b', report: reportOf(GOOD), raw: GOOD });
    expect(reserveCandidateSlot()).toEqual({ index: 3 });
    registerCandidate({ status: 'malformed', description: 'c', error: 'missing report block', raw: 'no block' });
    const fourth = reserveCandidateSlot();
    expect('error' in fourth).toBe(true);
    if ('error' in fourth) expect(fourth.error).toMatch(/cap reached \(3\)/);
    expect(krakenCandidates()).toHaveLength(3);
    expect(krakenCandidates()[2].status).toBe('malformed');
  });

  it('malformed candidates are preserved, not dropped (degraded evidence rule)', () => {
    registerCandidate({ status: 'malformed', description: 'x', error: 'invalid JSON (x)', raw: 'partial' });
    const all = krakenCandidates();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ status: 'malformed', description: 'x' });
  });

  it('reset clears the registry', () => {
    registerCandidate({ status: 'malformed', description: 'x', error: 'e', raw: '' });
    resetKrakenCandidates();
    expect(krakenCandidates()).toHaveLength(0);
  });
});

describe('instructions + flag', () => {
  it('renders candidate index and cap', () => {
    const text = candidateInstructions(2);
    expect(text).toContain('CANDIDATE #2');
    expect(text).toContain(`at most ${KRAKEN_CANDIDATE_CAP}`);
    expect(text).toContain('<candidate-report>');
    expect(text).toContain('degraded');
  });

  it('feature flag defaults OFF and honours ZELARI_KRAKEN_SELECTION=1', () => {
    const prev = process.env.ZELARI_KRAKEN_SELECTION;
    delete process.env.ZELARI_KRAKEN_SELECTION;
    expect(isKrakenSelectionEnabled()).toBe(false);
    process.env.ZELARI_KRAKEN_SELECTION = '1';
    expect(isKrakenSelectionEnabled()).toBe(true);
    if (prev === undefined) delete process.env.ZELARI_KRAKEN_SELECTION;
    else process.env.ZELARI_KRAKEN_SELECTION = prev;
  });
});

describe('krakenRequiredChecks (ADR-0020 Fase 6)', () => {
  it('returns [] when no selection ran this turn', () => {
    resetKrakenCandidates();
    expect(krakenRequiredChecks()).toEqual([]);
  });

  it('returns [] for needs_more_evidence — checks stay advisory', () => {
    resetKrakenCandidates();
    setKrakenSelection({
      status: 'needs_more_evidence',
      winnerIndex: null,
      rationale: 'tie',
      requiredChecks: ['check that must NOT be enforced'],
      degraded: false,
      verifier: null,
      judgedBy: 'llm',
    });
    expect(krakenRequiredChecks()).toEqual([]);
  });

  it('returns the checks of a selected verdict', () => {
    resetKrakenCandidates();
    setKrakenSelection({
      status: 'selected',
      winnerIndex: 2,
      rationale: 'grounded',
      requiredChecks: ['race regression test', 'session e2e'],
      degraded: false,
      verifier: { provider: 'p', model: 'm' },
      judgedBy: 'llm',
    });
    expect(krakenRequiredChecks()).toEqual(['race regression test', 'session e2e']);
  });

  it('reset clears verdict and checks together', () => {
    setKrakenSelection({
      status: 'selected',
      winnerIndex: 1,
      rationale: 'r',
      requiredChecks: ['x'],
      degraded: false,
      verifier: null,
      judgedBy: 'deterministic',
    });
    expect(getKrakenSelection()).not.toBeNull();
    resetKrakenCandidates();
    expect(getKrakenSelection()).toBeNull();
    expect(krakenRequiredChecks()).toEqual([]);
  });
});

describe('Fase 7 — check results storage', () => {
  beforeEach(() => resetKrakenCandidates());

  it('stores and returns per-check results (defensive copy)', () => {
    setKrakenCheckResults([
      { check: 'a', status: 'pass' },
      { check: 'b', status: 'unknown', note: 'grep timed out' },
    ]);
    const first = getKrakenCheckResults();
    expect(first).toEqual([
      { check: 'a', status: 'pass' },
      { check: 'b', status: 'unknown', note: 'grep timed out' },
    ]);
    first?.push({ check: 'c', status: 'fail' });
    expect(getKrakenCheckResults()).toHaveLength(2);
  });

  it('krakenChecksPassed counts only explicit pass — unknown never counts', () => {
    setKrakenCheckResults([
      { check: 'a', status: 'pass' },
      { check: 'b', status: 'fail' },
      { check: 'c', status: 'unknown', note: 'degraded' },
    ]);
    expect(krakenChecksPassed()).toBe(1);
  });

  it('undefined before any verify report lands', () => {
    expect(getKrakenCheckResults()).toBeNull();
    expect(krakenChecksPassed()).toBeUndefined();
  });

  it('a later verify tentacle replaces earlier results', () => {
    setKrakenCheckResults([
      { check: 'a', status: 'unknown', note: 'first run degraded' },
    ]);
    setKrakenCheckResults([
      { check: 'a', status: 'pass' },
    ]);
    expect(krakenChecksPassed()).toBe(1);
  });

  it('reset clears check results together with verdict and candidates', () => {
    setKrakenCheckResults([{ check: 'a', status: 'pass' }]);
    resetKrakenCandidates();
    expect(getKrakenCheckResults()).toBeNull();
    expect(krakenChecksPassed()).toBeUndefined();
  });
});
