/**
 * completionProof tests (harness-hardening P0.3 × ADR-0023).
 *
 * Hermetic by contract: every scenario uses a PURE StrictBuildGateEvaluation
 * literal — no registry, no env, no evaluateStrictBuildGate call. What is
 * under test is the artifact contract:
 *   - markdown carries the verdict, per-criterion evidence and advisory
 *     sections;
 *   - json IS the spine `verification.run` payload (strictGateEventPayload);
 *   - writeCompletionProof persists both files and NEVER throws.
 */
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderCompletionProof, writeCompletionProof } from './completionProof.js';
import { strictGateEventPayload, type StrictBuildGateEvaluation } from './verificationBridge.js';
import type { CompletionEvaluation, VerifierReview } from '@zelari/core/verification';

const OPEN_GATE = { total: 0, passed: 0, failedChecks: [], unknownChecks: [], blocked: false, selectionUsed: false };

function completionEvaluation(overrides: Partial<CompletionEvaluation> = {}): CompletionEvaluation {
  return {
    verdict: 'PASS',
    satisfied: [],
    unsatisfied: [],
    evidenceComplete: true,
    eventBackedEvidenceComplete: true,
    summary: 'every required criterion passes with evidence',
    ...overrides,
  };
}

function review(overrides: Partial<VerifierReview> = {}): VerifierReview {
  return {
    verdict: 'rejected',
    score: 0.2,
    rationale: 'claims a refactor that the diff does not contain',
    effectiveModel: { mode: 'fixed', provider: 'openai-compatible', model: 'verifier-x' },
    usedLogprobs: false,
    ...overrides,
  };
}

describe('renderCompletionProof', () => {
  it('PASS — verdict in markdown, json equals the spine payload', () => {
    const evaluation: StrictBuildGateEvaluation = {
      gate: { ...OPEN_GATE, selectionUsed: true, total: 1, passed: 1 },
      strict: true,
      results: [
        {
          criterionId: 'check-1-session-survives-refresh',
          status: 'pass',
          source: 'verify-agent',
          evidence: [{ tier: 'tool-output', ref: 'vitest 41/41', capturedAt: 1, digest: 'd1', seq: 7 }],
          evaluatedAt: 1,
          durationMs: 5,
        },
      ],
      evaluation: completionEvaluation({ satisfied: ['check-1-session-survives-refresh'] }),
      native: null,
      blocked: false,
      summary: 'open (strict PASS): 1/1 criteria pass with evidence',
    };
    const { markdown, json } = renderCompletionProof(evaluation, { surface: 'kraken', sessionId: 'sess-1' });
    expect(markdown).toContain('**PASS**');
    expect(markdown).toContain('**Strict gate**: on');
    expect(markdown).toContain('**Turn blocked**: no');
    expect(markdown).toContain('check-1-session-survives-refresh');
    expect(markdown).toContain('tool-output · seq 7');
    expect(markdown).toContain('sess-1');
    expect(markdown).not.toContain('Advisory verifier review');
    const parsed = JSON.parse(json) as Record<string, unknown>;
    expect(parsed).toEqual(strictGateEventPayload(evaluation));
    expect(parsed.verdict).toBe('PASS');
  });

  it('REPAIR_REQUIRED — verdict and unsatisfied reasons are visible', () => {
    const evaluation: StrictBuildGateEvaluation = {
      gate: { ...OPEN_GATE, selectionUsed: true, total: 1, passed: 0, failedChecks: ['typecheck clean'], blocked: true },
      strict: true,
      results: [
        {
          criterionId: 'check-1-typecheck-clean',
          status: 'fail',
          source: 'verify-agent',
          evidence: [{ tier: 'tool-output', ref: 'tsc exit 2', capturedAt: 2, digest: 'd2', seq: 9 }],
          evaluatedAt: 2,
          durationMs: 5,
          detail: 'exit 2 — 3 diagnostics',
        },
      ],
      evaluation: completionEvaluation({
        verdict: 'REPAIR_REQUIRED',
        evidenceComplete: false,
        eventBackedEvidenceComplete: false,
        unsatisfied: [{ id: 'check-1-typecheck-clean', status: 'fail', reason: 'exit 2 — 3 diagnostics' }],
        summary: '1 required criterion failed',
      }),
      native: null,
      blocked: true,
      summary: 'blocked (strict REPAIR_REQUIRED): 0/1 legacy-pass, evidence incomplete',
    };
    const { markdown, json } = renderCompletionProof(evaluation);
    expect(markdown).toContain('**REPAIR_REQUIRED**');
    expect(markdown).toContain('Unsatisfied');
    expect(markdown).toContain('exit 2 — 3 diagnostics');
    expect(markdown).toContain('fail');
    expect(JSON.parse(json).verdict).toBe('REPAIR_REQUIRED');
  });

  it('BLOCKED without evidence — a pass without a note is honestly unknown', () => {
    const evaluation: StrictBuildGateEvaluation = {
      gate: { ...OPEN_GATE, selectionUsed: true, total: 1, passed: 1, unknownChecks: ['tests pass'], blocked: true },
      strict: true,
      results: [
        {
          criterionId: 'check-1-tests-pass',
          status: 'pass',
          source: 'verify-agent',
          evidence: [], // the false-done guard: no note ⇒ no evidence
          evaluatedAt: 3,
          durationMs: 1,
        },
      ],
      evaluation: completionEvaluation({
        verdict: 'BLOCKED',
        evidenceComplete: false,
        eventBackedEvidenceComplete: false,
        unsatisfied: [{ id: 'check-1-tests-pass', status: 'unknown', reason: 'no admissible evidence' }],
        summary: 'pass without evidence',
      }),
      native: null,
      blocked: true,
      summary: 'blocked (strict BLOCKED): 1/1 legacy-pass, evidence incomplete',
    };
    const { markdown } = renderCompletionProof(evaluation);
    expect(markdown).toContain('**BLOCKED**');
    expect(markdown).toContain('no admissible evidence');
    expect(markdown).toContain('unknown');
    expect(markdown).toContain('—'); // empty evidence cell
  });

  it('BLOCKED with exhausted criteria — every explicit fail is listed', () => {
    const evaluation: StrictBuildGateEvaluation = {
      gate: { ...OPEN_GATE, blocked: true },
      strict: true,
      results: [
        {
          criterionId: 'correctness.error-signals',
          status: 'fail',
          source: 'deterministic-engine',
          evidence: [{ tier: 'command-output', ref: 'npm run typecheck → exit 2', capturedAt: 4, digest: 'dd', seq: 11 }],
          evaluatedAt: 4,
          durationMs: 9000,
          detail: 'exit 2 (expected 0) — stderr: 3 errors',
        },
        {
          criterionId: 'correctness.specification',
          status: 'fail',
          source: 'deterministic-engine',
          evidence: [{ tier: 'command-output', ref: 'npm run test → exit 1', capturedAt: 5, digest: 'de', seq: 12 }],
          evaluatedAt: 5,
          durationMs: 30000,
          detail: 'exit 1 — 2 failing tests',
        },
      ],
      evaluation: null,
      native: {
        packId: 'zelari-coding/v1',
        criteria: [
          {
            id: 'correctness.error-signals',
            text: 'Static checks (typecheck) pass with no new errors.',
            source: 'criteria-pack',
            required: true,
            check: { kind: 'command', command: 'npm run typecheck' },
          },
          {
            id: 'correctness.specification',
            text: 'The test suite passes — behavior matches the specification.',
            source: 'criteria-pack',
            required: true,
            check: { kind: 'command', command: 'npm run test' },
          },
        ],
        results: [
          {
            criterionId: 'correctness.error-signals',
            status: 'fail',
            source: 'deterministic-engine',
            evidence: [{ tier: 'command-output', ref: 'npm run typecheck → exit 2', capturedAt: 4, digest: 'dd', seq: 11 }],
            evaluatedAt: 4,
            durationMs: 9000,
            detail: 'exit 2 (expected 0) — stderr: 3 errors',
          },
          {
            criterionId: 'correctness.specification',
            status: 'fail',
            source: 'deterministic-engine',
            evidence: [{ tier: 'command-output', ref: 'npm run test → exit 1', capturedAt: 5, digest: 'de', seq: 12 }],
            evaluatedAt: 5,
            durationMs: 30000,
            detail: 'exit 1 — 2 failing tests',
          },
        ],
      },
      blocked: true,
      summary: 'blocked (strict n/a)',
    };
    const { markdown, json } = renderCompletionProof(evaluation);
    expect(markdown).toContain('**BLOCKED**');
    // native section: commands, exit details, criterion texts
    expect(markdown).toContain('zelari-coding/v1');
    expect(markdown).toContain('npm run typecheck');
    expect(markdown).toContain('npm run test');
    expect(markdown).toContain('exit 2 (expected 0)');
    expect(markdown).toContain('Static checks (typecheck) pass with no new errors.');
    expect(JSON.parse(json).engine).toBe('kraken-legacy+completion-policy+criteria-pack');
  });

  it('PASS with advisory verifier REJECTED — advisory section present, verdict stays PASS', () => {
    const evaluation: StrictBuildGateEvaluation = {
      gate: { ...OPEN_GATE, selectionUsed: true, total: 1, passed: 1 },
      strict: true,
      results: [
        {
          criterionId: 'check-1-build-green',
          status: 'pass',
          source: 'verify-agent',
          evidence: [{ tier: 'tool-output', ref: 'npm run build → exit 0', capturedAt: 6, digest: 'd6', seq: 21 }],
          evaluatedAt: 6,
          durationMs: 2,
        },
      ],
      evaluation: completionEvaluation({ satisfied: ['check-1-build-green'] }),
      native: null,
      review: review(),
      blocked: false,
      summary: 'open (strict PASS): 1/1 criteria pass with evidence',
    };
    const { markdown, json } = renderCompletionProof(evaluation);
    expect(markdown).toContain('**PASS**'); // advisory never changes the gate
    expect(markdown).toContain('Advisory verifier review');
    expect(markdown).toContain('rejected');
    expect(markdown).toContain('claims a refactor that the diff does not contain');
    expect(markdown).toContain('cannot change the gate verdict');
    const parsed = JSON.parse(json) as { verifier: { verdict: string; advisory: boolean } | null };
    expect(parsed.verifier).toMatchObject({ verdict: 'rejected', advisory: true });
  });

  it('deterministic — identical input renders identical markdown (no internal clock)', () => {
    const evaluation: StrictBuildGateEvaluation = {
      gate: { ...OPEN_GATE },
      strict: false,
      evaluation: null,
      native: null,
      blocked: false,
      summary: 'open',
    };
    const a = renderCompletionProof(evaluation);
    const b = renderCompletionProof(evaluation);
    expect(a.markdown).toBe(b.markdown);
    expect(a.json).toBe(b.json);
    // generatedAt (when passed) is the only allowed time signal
    const stamped = renderCompletionProof(evaluation, { generatedAt: 1700000000000 });
    expect(stamped.markdown).toContain('2023-11-14T22:13:20.000Z');
    expect(a.markdown).not.toContain('2023-');
  });
});

describe('writeCompletionProof', () => {
  const evaluation: StrictBuildGateEvaluation = {
    gate: { ...OPEN_GATE, selectionUsed: true, total: 1, passed: 1 },
    strict: true,
    evaluation: completionEvaluation({ satisfied: ['check-1-x'] }),
    native: null,
    blocked: false,
    summary: 'open (strict PASS)',
  };

  it('writes .zelari/completion-proof.{md,json} under baseDir', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'kraken-proof-'));
    try {
      const paths = await writeCompletionProof(evaluation, {
        baseDir: dir,
        meta: { surface: 'kraken', sessionId: 'sess-proof', generatedAt: 1700000000000 },
      });
      expect(paths).not.toBeNull();
      expect(paths!.markdownPath).toBe(path.join(dir, '.zelari', 'completion-proof.md'));
      expect(paths!.jsonPath).toBe(path.join(dir, '.zelari', 'completion-proof.json'));
      const md = await readFile(paths!.markdownPath, 'utf8');
      const json = await readFile(paths!.jsonPath, 'utf8');
      expect(md).toContain('**PASS**');
      expect(md).toContain('sess-proof');
      expect(JSON.parse(json).verdict).toBe('PASS');
      const overwrite = await writeCompletionProof(
        { ...evaluation, blocked: true, summary: 'blocked later' },
        { baseDir: dir },
      );
      expect(overwrite).not.toBeNull();
      const md2 = await readFile(overwrite!.markdownPath, 'utf8');
      expect(md2).toContain('blocked later'); // artifact reflects the LAST evaluation
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('NEVER throws — an unwritable baseDir returns null', async () => {
    // A regular file as baseDir makes mkdir(<file>/.zelari) fail with ENOTDIR.
    const blocker = path.join(os.tmpdir(), `kraken-proof-blocker-${process.pid}`);
    await writeFile(blocker, 'not a directory', 'utf8');
    try {
      const result = await writeCompletionProof(evaluation, { baseDir: blocker });
      expect(result).toBeNull();
      await expect(
        writeCompletionProof(evaluation, { baseDir: path.join(blocker, 'deeper', 'still', 'bad') }),
      ).resolves.toBeNull();
    } finally {
      await rm(blocker, { force: true });
    }
  });

  it('default baseDir is process.cwd() and the artifacts land beside .zelari/', async () => {
    // Scoped to the repo's own .zelari (already part of the workflow dir).
    const paths = await writeCompletionProof(evaluation, { meta: { surface: 'kraken' } });
    expect(paths).not.toBeNull();
    expect(paths!.markdownPath).toBe(path.join(process.cwd(), '.zelari', 'completion-proof.md'));
    const info = await stat(paths!.jsonPath);
    expect(info.isFile()).toBe(true);
  });
});
