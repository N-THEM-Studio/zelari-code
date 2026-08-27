/**
 * P0.B — strict policy-load gate for the headless path.
 *
 * Unit level: checkStrictPolicyLoad maps PolicyLoadError onto the machine-
 * readable block payload (reason `policy-load-failed`, exit 2).
 * Integration level: a real runHeadless dispatch against a broken project
 * policy terminates with exit 2, emits a fatal NDJSON error carrying the
 * reason, and leaves the BLOCKED outcome in the session spine (on-disk
 * evidence), without ever touching a provider key.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { runHeadless } from '../runHeadless.js';
import {
  checkStrictPolicyLoad,
  type PolicyLoadBlock,
} from './policyGate.js';
import { POLICY_LOAD_BLOCK_REASON } from '../safety/policyLoadMode.js';

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(tmpdir(), 'zelari-policy-gate-'));
}

function breakProjectPolicy(root: string): void {
  fs.mkdirSync(path.join(root, '.zelari'), { recursive: true });
  fs.writeFileSync(path.join(root, '.zelari', 'policy.json'), '{ definitely not json');
}

/** Session spine logs written by the teardown (paths under root). */
function spineLogs(root: string): string[] {
  const sessions = path.join(root, '.zelari', 'sessions');
  if (!fs.existsSync(sessions)) return [];
  return fs
    .readdirSync(sessions)
    .map((id) => path.join(sessions, id, 'events.jsonl'))
    .filter((p) => fs.existsSync(p));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('checkStrictPolicyLoad (P0.B unit)', () => {
  it('broken JSON + strict -> block payload with reason policy-load-failed / exit 2 / absolute file', () => {
    const root = tmpRoot();
    breakProjectPolicy(root);
    const res = checkStrictPolicyLoad(root, { homeDir: tmpRoot(), mode: 'strict' });
    expect(res.blocked).toBe(true);
    expect(res.block).toBeDefined();
    const block = res.block as PolicyLoadBlock;
    expect(block.reason).toBe(POLICY_LOAD_BLOCK_REASON);
    expect(block.exitCode).toBe(2);
    expect(block.code).toBe('policy_invalid');
    expect(path.isAbsolute(block.file)).toBe(true);
    // Absolute even if a relative file ever reached the error.
    expect(block.file.replaceAll('\\', '/')).toContain('.zelari/policy.json');
    expect(block.detail).toContain('invalid JSON');
  });

  it('broken JSON + permissive -> never blocks (v1 warning semantics)', () => {
    const root = tmpRoot();
    breakProjectPolicy(root);
    const res = checkStrictPolicyLoad(root, { homeDir: tmpRoot(), mode: 'permissive' });
    expect(res.blocked).toBe(false);
    expect(res.block).toBeUndefined();
    expect(res.warnings.join('\n')).toContain('invalid JSON');
  });
});

describe('runHeadless × strict policy load (P0.B integration)', () => {
  it('broken policy blocks the run: exit 2 + NDJSON reason + spine note on disk', async () => {
    const prevCwd = process.cwd();
    const prevOverride = process.env.ZELARI_POLICY_LOAD_MODE;
    process.env.ZELARI_POLICY_LOAD_MODE = 'strict';
    let outLines = '';
    const outSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(((chunk: string | Uint8Array) => {
        outLines += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
        return true;
      }) as typeof process.stdout.write);
    try {
      const root = tmpRoot();
      breakProjectPolicy(root);
      process.chdir(root);
      const code = await runHeadless({
        task: 'probe',
        output: 'json',
        mode: 'kraken',
        phase: 'build',
        useCouncil: false,
      });
      expect(code).toBe(2);

      // Machine-readable teardown on the NDJSON stream…
      const errors = outLines
        .split('\n')
        .filter((l) => l.trim().startsWith('{'))
        .map((l) => {
          try {
            return JSON.parse(l) as Record<string, unknown>;
          } catch {
            return null;
          }
        })
        .filter((e): e is Record<string, unknown> => e !== null && e['type'] === 'error');
      expect(
        errors.some(
          (e) =>
            e['code'] === POLICY_LOAD_BLOCK_REASON &&
            String(e['message']).includes('.zelari'),
        ),
      ).toBe(true);

      // …and on-disk evidence in the session spine (same log as other BLOCKED outcomes).
      const logs = spineLogs(root);
      expect(logs.length).toBeGreaterThan(0);
      expect(logs.some((p) => fs.readFileSync(p, 'utf8').includes(POLICY_LOAD_BLOCK_REASON))).toBe(
        true,
      );
    } finally {
      outSpy.mockRestore();
      process.chdir(prevCwd);
      if (prevOverride === undefined) delete process.env.ZELARI_POLICY_LOAD_MODE;
      else process.env.ZELARI_POLICY_LOAD_MODE = prevOverride;
    }
  }, 30000);

  it('override=permissive lets the same broken file pass the gate (falls through to later startup)', async () => {
    const prevCwd = process.cwd();
    const prevOverride = process.env.ZELARI_POLICY_LOAD_MODE;
    process.env.ZELARI_POLICY_LOAD_MODE = 'permissive';
    try {
      const root = tmpRoot();
      breakProjectPolicy(root);
      process.chdir(root);
      // Unknown provider => deterministic exit 1 AFTER the policy gate
      // (never reaches a registry or network); the point is: not blocked
      // by the policy layer anymore.
      const code = await runHeadless({
        task: 'probe',
        output: 'json',
        mode: 'kraken',
        phase: 'build',
        useCouncil: false,
        provider: 'no-such-provider',
      });
      expect(code).toBe(1);
    } finally {
      process.chdir(prevCwd);
      if (prevOverride === undefined) delete process.env.ZELARI_POLICY_LOAD_MODE;
      else process.env.ZELARI_POLICY_LOAD_MODE = prevOverride;
    }
  }, 30000);
});
