/**
 * F3 (ADR-0023 §5) — CLI wiring lock tests: the native criteria pack forwards
 * its engine observations onto the session spine (`verification.evidence`),
 * the assigned seq anchors the EvidenceRefs, and the spine payload carries
 * the anchors. §5 target: "VerificationResult → EvidenceRef → session seq →
 * actual tool/result" — the note is never the tool output.
 */
import { describe, expect, it } from 'vitest';
import { evaluateNativePack } from './nativeVerification.js';
import { strictGateEventPayload, type StrictBuildGateEvaluation } from './verificationBridge.js';
import type { ShellProvider } from '@zelari/core/runtime';
import type { SessionEventInput } from '@zelari/core/session';

const okShell: ShellProvider = {
  async exec() {
    return { exitCode: 0, stdout: 'ok', stderr: '', durationMs: 1, timedOut: false };
  },
};

const packEnv = {
  ZELARI_VERIFY_PACK: '1',
  ZELARI_VERIFY_TYPECHECK_CMD: 'echo ok',
  ZELARI_VERIFY_TEST_CMD: '',
  ZELARI_VERIFY_BUILD_CMD: '',
};

describe('evaluateNativePack evidence anchoring', () => {
  it('emits verification.evidence first, anchors evidence[0].seq to it', async () => {
    const emitted: SessionEventInput[] = [];
    let nextSeq = 10;
    const evaluation = await evaluateNativePack({
      env: packEnv,
      shell: okShell,
      cwd: process.cwd(),
      emit: async (input) => {
        emitted.push(input);
        return { seq: nextSeq++ };
      },
    });
    expect(evaluation).not.toBeNull();
    // 1 command-backed criterion + optional advisories (honest `unknown`, no check).
    const cmdResult = evaluation!.results.find((r) => r.evidence.length > 0);
    expect(cmdResult).toBeDefined();
    // Order: observation event, then the verification.run summary.
    expect(emitted.map((e) => e.kind)).toEqual(['verification.evidence', 'verification.run']);
    const obs = emitted[0].data as Record<string, unknown>;
    expect(obs.observation).toBe('command');
    expect(obs.command).toBe('echo ok');
    expect(obs.exitCode).toBe(0);
    const run = emitted[1].data as { results: Array<{ evidence: Array<{ seq?: number }> }> };
    const runCmd = run.results.find((r) => r.evidence.length > 0);
    expect(runCmd!.evidence[0].seq).toBe(10);
    // And the returned VerificationResult anchors too.
    expect(cmdResult!.evidence[0].seq).toBe(10);
    expect(cmdResult!.evidence[0].tier).toBe('command-output');
    expect(typeof cmdResult!.evidence[0].digest).toBe('string');
  });

  it('without emit the evidence stays unanchored (legacy behaviour)', async () => {
    const evaluation = await evaluateNativePack({
      env: packEnv,
      shell: okShell,
      cwd: process.cwd(),
    });
    const anchored = evaluation!.results.find((r) => r.evidence.length > 0);
    expect(anchored!.evidence[0].seq).toBeUndefined();
  });
});

describe('strictGateEventPayload carries the anchors', () => {
  it('native evidence seq survives the spine payload', () => {
    const evaluation: StrictBuildGateEvaluation = {
      gate: { total: 0, passed: 0, failedChecks: [], unknownChecks: [], blocked: false, selectionUsed: false },
      strict: true,
      evaluation: null,
      native: {
        packId: 'test-pack',
        criteria: [],
        results: [
          {
            criterionId: 'typecheck',
            status: 'pass',
            source: 'deterministic-engine',
            evidence: [{ tier: 'command-output', ref: 'npm run typecheck → exit 0', capturedAt: 1, digest: 'd0', seq: 42 }],
            evaluatedAt: 1,
            durationMs: 5,
          },
        ],
      },
      blocked: false,
      summary: 'open',
    };
    const payload = strictGateEventPayload(evaluation);
    const native = payload.native as {
      results: Array<{ evidence: Array<{ tier: string; seq?: number; digest?: string }> }>;
    };
    expect(native.results[0].evidence[0].seq).toBe(42);
    expect(native.results[0].evidence[0].digest).toBe('d0');
  });
});
