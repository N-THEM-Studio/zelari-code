/**
 * tests/unit/gauge-inventory.test.ts - locks the P1 rule the F0 report rests on.
 *
 * A `verification.run` with reason=strict-off is the runtime honestly saying
 * it never evaluated. Counting it as a label would be a false empty: it would
 * let the F0 -> F1 gate read GO on 106 non-verdicts. The inventory must
 * separate them, and the gate must stay NO-GO.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const SCRIPT = path.resolve(__dirname, '../../scripts/gauge-inventory.mjs');

function envelope(seq: number, kind: string, data: unknown): string {
  return JSON.stringify({
    schemaVersion: 1,
    sessionId: 'test-session',
    seq,
    ts: 1700000000000 + seq,
    kind,
    actor: { type: 'system' },
    data,
  });
}

function sessionDir(root: string, id: string, lines: string[]): string {
  const dir = path.join(root, id);
  return fs.mkdir(dir, { recursive: true }).then(() => fs.writeFile(path.join(dir, 'events.jsonl'), lines.join('\n') + '\n'));
}

function run(root: string): any {
  const out = execFileSync(process.execPath, [SCRIPT, '--sessions', root, '--json'], {
    encoding: 'utf8',
  });
  return JSON.parse(out);
}

let root: string;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'gauge-inv-'));

  // A session that looks rich but evaluated nothing.
  await sessionDir(root, 'strict-off', [
    envelope(1, 'user.message', { text: 'add a feature' }),
    envelope(2, 'assistant.message', { text: 'Done, the feature is implemented.' }),
    envelope(3, 'verification.run', {
      status: 'UNEVALUATED',
      verdict: null,
      strict: false,
      reason: 'strict-off',
    }),
    envelope(4, 'verification.run', {
      status: 'UNEVALUATED',
      verdict: null,
      strict: false,
      reason: 'strict-off',
    }),
  ]);

  // A session that really produced a verdict.
  await sessionDir(root, 'evaluated', [
    envelope(1, 'user.message', { text: 'fix the test' }),
    envelope(2, 'verification.run', { status: 'BLOCKED', verdict: 'BLOCKED', strict: true }),
    envelope(3, 'verification.evidence', { ref: 'OBSERVATION ref=#1' }),
  ]);

  // A corrupt line must degrade, never throw.
  await sessionDir(root, 'corrupt', [
    envelope(1, 'user.message', { text: 'hi' }),
    '{not json',
    envelope(2, 'assistant.message', { text: 'complete' }),
  ]);
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('gauge-inventory', () => {
  it('counts sessions, not user.message events', async () => {
    const r = run(root);
    expect(r.sessions).toBe(3);
    expect(r.sessionsWithUserMessage).toBe(3);
    // The strict-off session holds one user message but must add exactly 1.
    expect(r.sessionsWithUserMessage).toBeLessThanOrEqual(r.sessions);
  });

  it('never counts an unevaluated run as a label', async () => {
    const r = run(root);
    // 3 runs total: 2 strict-off in the first session, 1 real verdict in the second.
    expect(r.verification.runs).toBe(3);
    expect(r.verification.unevaluated).toBe(2);
    expect(r.verification.unevaluatedReasons['strict-off']).toBe(2);
    expect(r.verification.verdicts.BLOCKED).toBe(1);
    // The two strict-off runs are excluded from the hard label count.
    expect(r.labels.claim_supported_hard).toBe(1);
  });

  it('keeps the F0 -> F1 gate NO-GO on non-verdicts', async () => {
    const r = run(root);
    expect(r.labels.claim_supported_hard).toBeLessThan(r.gate.minSamples);
    expect(r.gate.go).toBe(false);
  });

  it('treats a claim as a candidate, never as a label', async () => {
    const r = run(root);
    // Both sessions contain a "done"-shaped assistant turn.
    expect(r.claimPoints).toBeGreaterThan(0);
    // ...and that number is not what feeds the calibrator.
    expect(r.labels.claim_supported_hard).toBe(1);
  });

  it('degrades on a corrupt line instead of throwing', async () => {
    const r = run(root);
    expect(r.corruptLines).toBe(1);
    expect(r.events).toBeGreaterThan(0);
  });

  it('exits 1 on a missing sessions directory', async () => {
    let code = 0;
    try {
      execFileSync(process.execPath, [SCRIPT, '--sessions', path.join(root, 'nope')], { stdio: 'pipe' });
    } catch (e: any) {
      code = e.status;
    }
    expect(code).toBe(1);
  });
});
