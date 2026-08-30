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
import { runHeadless, dispatchHeadlessTurn } from '../runHeadless.js';
import type { ProviderStreamFn } from '@zelari/core/harness';
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
    // H10-fix2 regression: NO process.chdir — the run must be steered to
    // `root` via `cwd:` alone, and the spine teardown must land under
    // root/.zelari/sessions (NOT under the process cwd).
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
      const procSpineBefore = new Set(spineLogs(process.cwd()));
      const code = await runHeadless({
        task: 'probe',
        output: 'json',
        mode: 'kraken',
        phase: 'build',
        useCouncil: false,
        cwd: root,
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

      // H10-fix2: the blocked-session spine must NOT leak under the process
      // cwd — before the fix, recordPolicyLoadBlockedOnSpine hardcoded
      // `workspace: process.cwd()` and wrote there without any chdir.
      const leaked = spineLogs(process.cwd())
        .filter((p) => !procSpineBefore.has(p))
        .filter((p) => fs.readFileSync(p, 'utf8').includes(POLICY_LOAD_BLOCK_REASON));
      expect(leaked).toEqual([]);
    } finally {
      outSpy.mockRestore();
      if (prevOverride === undefined) delete process.env.ZELARI_POLICY_LOAD_MODE;
      else process.env.ZELARI_POLICY_LOAD_MODE = prevOverride;
    }
  }, 30000);

  it('override=permissive lets the same broken file pass the gate (falls through to later startup)', async () => {
    const prevOverride = process.env.ZELARI_POLICY_LOAD_MODE;
    process.env.ZELARI_POLICY_LOAD_MODE = 'permissive';
    try {
      const root = tmpRoot();
      breakProjectPolicy(root);
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
        cwd: root,
      });
      expect(code).toBe(1);
    } finally {
      if (prevOverride === undefined) delete process.env.ZELARI_POLICY_LOAD_MODE;
      else process.env.ZELARI_POLICY_LOAD_MODE = prevOverride;
    }
  }, 30000);
});

describe('headless one-shot × policy warning dedupe (H10-fix3)', () => {
  it('one-shot emits the [policy] warning EXACTLY once (no dispatch re-run)', async () => {
    // runHeadless() gates BEFORE key resolution AND dispatchHeadlessTurn
    // gates again per turn for the sidecar. On the one-shot path the second
    // gate saw the identical input — before the fix the same warning hit
    // stderr twice. No process-global memoization allowed: the skip must be
    // scoped to this single invocation (`policyGateDone` marker).
    const prevOverride = process.env.ZELARI_POLICY_LOAD_MODE;
    process.env.ZELARI_POLICY_LOAD_MODE = 'permissive';
    let errLines = '';
    const errSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(((chunk: string | Uint8Array) => {
        errLines += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
        return true;
      }) as typeof process.stderr.write);
    try {
      const root = tmpRoot();
      breakProjectPolicy(root);
      const code = await runHeadless({
        task: 'probe',
        output: 'json',
        mode: 'kraken',
        phase: 'build',
        useCouncil: false,
        provider: 'no-such-provider', // deterministic exit 1 after the gate
        cwd: root,
      });
      expect(code).toBe(1);
      const policyLines = errLines.split('\n').filter((l) => l.includes('[policy]'));
      expect(policyLines).toHaveLength(1);
      expect(policyLines[0]).toContain('invalid JSON');
    } finally {
      errSpy.mockRestore();
      if (prevOverride === undefined) delete process.env.ZELARI_POLICY_LOAD_MODE;
      else process.env.ZELARI_POLICY_LOAD_MODE = prevOverride;
    }
  }, 30000);

  it('sidecar turns still gate inside dispatchHeadlessTurn (no one-shot marker)', async () => {
    // The ~line-284 gate call must stay intact: serve/harnessServer never
    // passes `policyGateDone`, so a strict-blocked policy still stops the
    // turn (exit 2) — and the spine evidence lands under opts.cwd.
    const prevOverride = process.env.ZELARI_POLICY_LOAD_MODE;
    process.env.ZELARI_POLICY_LOAD_MODE = 'strict';
    let outLines = '';
    const outSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(((chunk: string | Uint8Array) => {
        outLines += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
        return true;
      }) as typeof process.stdout.write);
    let errLines = '';
    const errSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(((chunk: string | Uint8Array) => {
        errLines += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
        return true;
      }) as typeof process.stderr.write);
    try {
      const root = tmpRoot();
      breakProjectPolicy(root);
      const unreachableStream = (() => {
        throw new Error('provider stream must not be reached before the policy gate');
      }) as unknown as ProviderStreamFn;
      const code = await dispatchHeadlessTurn(
        {
          task: 'probe',
          output: 'json',
          mode: 'kraken',
          phase: 'build',
          useCouncil: false,
          provider: 'no-such-provider',
          cwd: root,
        },
        'no-such-provider',
        'test-model',
        unreachableStream,
        // NO one-shot marker — this is exactly what the sidecar passes.
      );
      expect(code).toBe(2);
      expect(errLines).toContain(POLICY_LOAD_BLOCK_REASON);
      const logs = spineLogs(root);
      expect(logs.length).toBeGreaterThan(0);
      expect(logs.some((p) => fs.readFileSync(p, 'utf8').includes(POLICY_LOAD_BLOCK_REASON))).toBe(
        true,
      );
      expect(outLines).toContain(POLICY_LOAD_BLOCK_REASON);
    } finally {
      outSpy.mockRestore();
      errSpy.mockRestore();
      if (prevOverride === undefined) delete process.env.ZELARI_POLICY_LOAD_MODE;
      else process.env.ZELARI_POLICY_LOAD_MODE = prevOverride;
    }
  }, 30000);
});
