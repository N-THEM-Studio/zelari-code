/**
 * F3 (ADR-0023 §5) — event-backed EvidenceRef lock tests.
 *
 * Chain under test:
 *   VerificationEngine observation → `verification.evidence` spine event
 *   → assigned seq anchors EvidenceRef → CompletionPolicy can REQUIRE the
 *   anchor (requireEventBackedEvidence). A narrated note with no session
 *   anchor is not traceable evidence.
 */
import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { VerificationEngine } from './engine.js';
import {
  evaluateCompletion,
  STRICT_BUILD_POLICY,
  type CompletionPolicy,
} from './completionPolicy.js';
import {
  EVENT_BACKED_EVIDENCE_TIERS,
  isEventBackedEvidence,
  type Criterion,
  type EvidenceRef,
  type VerificationResult,
} from './types.js';
import { SessionLogWriter } from '../session/writer.js';
import { readSessionLog } from '../session/replay.js';
import { isModelSurfaceEvent } from '../session/modelSurface.js';

const shell = {
  async exec(command: string) {
    return { exitCode: command.includes('bad') ? 1 : 0, stdout: 'ok', stderr: '' };
  },
};

const cmdCriterion = (id: string, command: string): Criterion => ({
  id,
  text: id,
  source: 'criteria-pack',
  required: true,
  check: { kind: 'command', command },
});

describe('isEventBackedEvidence', () => {
  it('advisory tiers never require a session anchor', () => {
    expect(isEventBackedEvidence({ tier: 'verifier-llm', ref: 'llm', capturedAt: 1 })).toBe(true);
    expect(isEventBackedEvidence({ tier: 'human', ref: 'user', capturedAt: 1 })).toBe(true);
  });

  it('event-backed tiers require a positive seq', () => {
    for (const tier of EVENT_BACKED_EVIDENCE_TIERS) {
      expect(isEventBackedEvidence({ tier, ref: 'x', capturedAt: 1 })).toBe(false);
      expect(isEventBackedEvidence({ tier, ref: 'x', capturedAt: 1, seq: 3 })).toBe(true);
    }
  });
});

describe('VerificationEngine evidence anchoring', () => {
  it('emits verification.evidence and anchors EvidenceRef.seq to it', async () => {
    const emitted: Array<{ kind: string; data: Record<string, unknown> }> = [];
    let nextSeq = 4;
    const engine = new VerificationEngine(
      { shell },
      {
        emit: async (input) => {
          emitted.push({ kind: input.kind, data: input.data ?? {} });
          return { seq: nextSeq++ };
        },
      },
    );
    const results = await engine.evaluate([cmdCriterion('t', 'echo ok')]);
    expect(results[0].status).toBe('pass');
    // One observation event + one run event, in order.
    expect(emitted.map((e) => e.kind)).toEqual(['verification.evidence', 'verification.run']);
    const obs = emitted[0].data as { observation: string; command: string; digest: string };
    expect(obs.observation).toBe('command');
    expect(obs.command).toBe('echo ok');
    expect(typeof obs.digest).toBe('string');
    expect(results[0].evidence[0].seq).toBe(4);
    // The run payload carries the anchor too.
    const run = emitted[1].data as { results: Array<{ evidence: Array<{ seq?: number }> }> };
    expect(run.results[0].evidence[0].seq).toBe(4);
  });

  it('a failing spine emitter degrades to unanchored — verification still completes', async () => {
    const engine = new VerificationEngine(
      { shell },
      { emit: async () => { throw new Error('spine degraded'); } },
    );
    const results = await engine.evaluate([cmdCriterion('t', 'echo ok')]);
    expect(results[0].status).toBe('pass');
    expect(results[0].evidence[0].seq).toBeUndefined();
    expect(isEventBackedEvidence(results[0].evidence[0])).toBe(false);
  });

  it('no emitter → legacy unanchored evidence', async () => {
    const engine = new VerificationEngine({ shell });
    const results = await engine.evaluate([cmdCriterion('t', 'echo ok')]);
    expect(results[0].status).toBe('pass');
    expect(results[0].evidence[0].seq).toBeUndefined();
  });
});

describe('CompletionPolicy.requireEventBackedEvidence', () => {
  const criterion: Criterion = { id: 'a', text: 'a', source: 'task', required: true };
  const evidence = (seq?: number): EvidenceRef[] => [
    { tier: 'command-output', ref: 'npm test', capturedAt: 1, ...(seq ? { seq } : {}) },
  ];
  const result = (ev: EvidenceRef[]): VerificationResult => ({
    criterionId: 'a',
    status: 'pass',
    source: 'deterministic-engine',
    evidence: ev,
    evaluatedAt: 1,
    durationMs: 0,
  });
  const strictEventBacked: CompletionPolicy = {
    ...STRICT_BUILD_POLICY,
    requireEventBackedEvidence: true,
  };

  it('anchored pass → PASS, eventBackedEvidenceComplete=true', () => {
    const evaluation = evaluateCompletion([criterion], [result(evidence(7))], strictEventBacked);
    expect(evaluation.verdict).toBe('PASS');
    expect(evaluation.eventBackedEvidenceComplete).toBe(true);
  });

  it('unanchored pass + flag on → BLOCKED with event-backed reason', () => {
    const evaluation = evaluateCompletion([criterion], [result(evidence())], strictEventBacked);
    expect(evaluation.verdict).toBe('BLOCKED');
    expect(evaluation.unsatisfied[0].reason).toContain('event-backed');
    expect(evaluation.eventBackedEvidenceComplete).toBe(false);
  });

  it('flag off (alpha default) → unanchored pass still PASS, but the metric reports it', () => {
    const evaluation = evaluateCompletion([criterion], [result(evidence())], STRICT_BUILD_POLICY);
    expect(evaluation.verdict).toBe('PASS');
    expect(evaluation.eventBackedEvidenceComplete).toBe(false);
  });

  it('LLM note as pseudo tool-output (no seq) cannot pass the anchored gate', () => {
    const narrated: EvidenceRef[] = [{ tier: 'tool-output', ref: 'verify says tests pass', capturedAt: 1 }];
    const evaluation = evaluateCompletion([criterion], [result(narrated)], strictEventBacked);
    expect(evaluation.verdict).toBe('BLOCKED');
  });
});

describe('verification.evidence on the session spine', () => {
  it('round-trips through the log and is NOT model-surface', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'zelari-f3-'));
    try {
      const writer = await SessionLogWriter.open(dir, 's1', 1);
      const appended = await writer.append({
        kind: 'verification.evidence',
        actor: { type: 'system', role: 'verification' },
        data: { observation: 'command', command: 'npm test', exitCode: 0, digest: 'd' },
      });
      await writer.close();
      expect(appended.seq).toBe(1);
      const report = await readSessionLog(path.join(dir, 'events.jsonl'));
      expect(report.ok).toBe(true);
      expect(report.events).toHaveLength(1);
      expect(report.events[0].kind).toBe('verification.evidence');
      expect(isModelSurfaceEvent(report.events[0])).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
