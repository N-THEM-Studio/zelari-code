/**
 * M2.1/R4b lock — a mission `success` claim must be EVENT-BACKED.
 *
 * The strict gate (ADR-0025) is opt-out-able (ZELARI_MISSION_STRICT=0 /
 * --no-strict-done). Before M2.1 that turned the mission claim site into a
 * narration pass-through: `state.status === 'success'` exited 0 even when
 * the session spine carried ZERO `verification.evidence` events. The lock:
 *
 * - case 1: zero evidence + strict off → exit 4 + note mission-event-back-missing;
 * - case 2: the same run with ≥1 evidence event → exit 0 (unchanged);
 * - case 3: zero evidence + ZELARI_ALLOW_UNVERIFIED=1 → exit 0 (the hatch).
 *
 * Drives the REAL production pieces minus the provider stream (the
 * strictOverlayTurn / runOneTurn.strictExit discipline): a real
 * openHeadlessSpine over a real NDJSON session log, plus the pure
 * `missionClaimExitCode` decision the claim site consumes. Source-level
 * guards pin the runHeadless.ts wiring (legacyContextIsolation pattern).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs, readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openHeadlessSpine } from './headlessSpine.js';
import {
  missionClaimExitCode,
  strictEnvOverlay,
  STRICT_DONE_EXIT_CODE,
} from './kraken/verificationBridge.js';

const cliDir = path.dirname(fileURLToPath(import.meta.url));
const readCli = (rel: string): string => readFileSync(path.join(cliDir, rel), 'utf8');

/** Hermetic strict-off overlay — exactly what the claim site passes through. */
const strictOffOverlay = strictEnvOverlay({}, { ZELARI_MISSION_STRICT: '0' });

/** Same event shape the strict gate emits (verificationBridge anchoring). */
const evidenceEvent = (command: string) => ({
  kind: 'verification.evidence' as const,
  actor: { type: 'system' as const, role: 'verification' },
  data: { observation: 'command', command, exitCode: 0 },
});

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'zelari-m21-'));
}

const SAVED_ENV = ['ZELARI_SESSION_SPINE', 'ZELARI_ALLOW_UNVERIFIED', 'ZELARI_MISSION_STRICT', 'ZELARI_STRICT_DONE'] as const;
const savedEnv = new Map<string, string | undefined>();

beforeEach(() => {
  for (const k of SAVED_ENV) savedEnv.set(k, process.env[k]);
  process.env.ZELARI_SESSION_SPINE = '1'; // spine ON — the counter needs a log
  delete process.env.ZELARI_ALLOW_UNVERIFIED; // hatch off unless a test sets it
});

afterEach(() => {
  for (const k of SAVED_ENV) {
    const v = savedEnv.get(k);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('M2.1 countVerificationEvidence — real spine session log', () => {
  it('a fresh run with zero evidence events counts 0 — the narration-only claim → exit 4', async () => {
    const base = await tmpDir();
    const spine = await openHeadlessSpine({
      sessionId: randomUUID(),
      mode: 'zelari',
      workspace: base,
      baseDir: base,
    });
    try {
      const count = await spine.countVerificationEvidence();
      expect(count).toBe(0); // 0, never a fake UNKNOWN — the log is readable
      // The exact decision the claim site takes on this count (strict off):
      expect(missionClaimExitCode(count, strictOffOverlay)).toBe(STRICT_DONE_EXIT_CODE);
    } finally {
      await spine.close('test');
    }
  }, 15000);

  it('events appended this run count up (flush-before-read) — the same claim stays exit 0', async () => {
    const base = await tmpDir();
    const spine = await openHeadlessSpine({
      sessionId: randomUUID(),
      mode: 'zelari',
      workspace: base,
      baseDir: base,
    });
    try {
      // "The engine ran a command": the emit the gate/pack writes through.
      await spine.appendEvent(evidenceEvent('npm run build --workspace=@zelari/core'));
      await spine.appendEvent(evidenceEvent('npx vitest run'));
      const count = await spine.countVerificationEvidence();
      expect(count).toBe(2);
      expect(missionClaimExitCode(count, strictOffOverlay)).toBe(0);
    } finally {
      await spine.close('test');
    }
  }, 15000);

  it('a disabled spine reads as UNKNOWN (-1) — the gate is skipped, never a fake zero', async () => {
    process.env.ZELARI_SESSION_SPINE = '0';
    const base = await tmpDir();
    const spine = await openHeadlessSpine({
      sessionId: randomUUID(),
      mode: 'zelari',
      workspace: base,
      baseDir: base,
    });
    try {
      const count = await spine.countVerificationEvidence();
      expect(count).toBe(-1);
      expect(missionClaimExitCode(count, strictOffOverlay)).toBe(0); // infra failure ≠ blocked
    } finally {
      await spine.close('test');
    }
  }, 15000);
});

describe('M2.1 missionClaimExitCode — the pure claim-site decision', () => {
  it('case 1 (the red case): zero evidence + strict off → 4', () => {
    expect(strictOffOverlay.ZELARI_MISSION_STRICT).toBe('0'); // strict genuinely off
    expect(missionClaimExitCode(0, strictOffOverlay)).toBe(4);
    expect(missionClaimExitCode(0, strictOffOverlay)).toBe(STRICT_DONE_EXIT_CODE);
  });

  it('case 2: at least one verification.evidence event → 0 (real missions unchanged)', () => {
    expect(missionClaimExitCode(1, strictOffOverlay)).toBe(0);
    expect(missionClaimExitCode(7, strictOffOverlay)).toBe(0);
  });

  it('negative count = UNKNOWN (spine I/O failure) → 0 — never block on infrastructure', () => {
    expect(missionClaimExitCode(-1, strictOffOverlay)).toBe(0);
  });

  it('case 3: the --allow-unverified / ZELARI_ALLOW_UNVERIFIED=1 hatch waives mission-side', () => {
    expect(missionClaimExitCode(0, { ZELARI_ALLOW_UNVERIFIED: '1' })).toBe(0);
    expect(missionClaimExitCode(0, { ZELARI_ALLOW_UNVERIFIED: 'true' })).toBe(0);
    // Rides the SAME overlay seam the claim site passes (strictEnvOverlay).
    expect(
      missionClaimExitCode(0, strictEnvOverlay({}, { ZELARI_ALLOW_UNVERIFIED: '1', ZELARI_MISSION_STRICT: '0' })),
    ).toBe(0);
  });
});

describe('M2.1 claim-site wiring (source-level, legacyContextIsolation pattern)', () => {
  it('runHeadless composes the counter + decision AFTER the blocked branch, with the overlay seam intact', () => {
    const src = readCli('runHeadless.ts');
    expect(src).toContain('countVerificationEvidence()');
    expect(src).toContain('missionClaimExitCode(');
    expect(src).toContain("'mission-event-back-missing'");
    // Order invariant: the pre-existing strict-blocked branch stays FIRST.
    expect(src.indexOf("'mission-strict-blocked'")).toBeLessThan(src.indexOf("'mission-event-back-missing'"));
    // H10-fix1 pin (shared with strictOverlayTurn.test.ts): the gate's env.
    expect(src).toContain('env: strictEnvOverlay(opts),');
    // plan-phase missions are design-only — the only phase discriminant here.
    expect(src).toContain("opts.phase !== 'plan'");
  });

  it('headlessSpine exposes the evidence counter over the same log lastVerificationRun reads', () => {
    const src = readCli('headlessSpine.ts');
    // interface member + handle impl + module-level reader.
    expect(src.match(/countVerificationEvidence/g)?.length).toBeGreaterThanOrEqual(3);
    expect(src).toContain("e.kind === 'verification.evidence'");
    expect(src).toContain('events.jsonl');
  });
});
