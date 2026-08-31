/**
 * cli-execProcess-jail.test.ts — v2.17 (t28) acceptance (a)(b)(c) through
 * the REAL CLI registry:
 *  (a) ZELARI_OS_JAIL=required + backend missing ⇒ exec_process AND bash
 *      DENIED with a typed `[jail]` error (golden rule: never warn/skip);
 *  (b) ZELARI_OS_JAIL=advisory + backend missing ⇒ ALLOWED with a VISIBLE
 *      signal (console.error line + audit entry + result meta/jailNotice);
 *  (c) env sanitation with a STUB backend (test-only injection): the child
 *      does NOT receive env outside the allowlist when the jail is active.
 *
 * Backends are injected via setJailBackendForTests (stub / forced-missing)
 * so the suite is deterministic on every platform — the real win32 backend
 * is honestly unavailable and would blur the "missing" case with the
 * "platform" case. `off` is pinned for non-jail coverage in
 * cli-bash-cwd-jail.test.ts; the production default is NOT changed here.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBuiltinToolRegistry } from '../../src/cli/toolRegistry.js';
import { AuditLogger } from '../../src/cli/safety/auditLogger.js';
import { OS_JAIL_ENV, setJailBackendForTests, type JailBackend } from '../../src/cli/safety/osJail.js';

// Spawning the real host shell can take >10s on Windows (see
// core-shellTool.test.ts) — generous per-test vitest timeouts.
const REAL_SHELL_TEST_TIMEOUT = 45_000;

interface BashValue {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  shellVia: string;
  jailNotice?: string;
}

interface ExecValue {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

/** Pass-through stub backend that RECORDS the wrap requests (tests only). */
const recordedWraps: Array<{ program: string; argv: string[] }> = [];
const stubBackend: JailBackend = {
  id: 'stub',
  probe: () => ({ backend: 'stub', available: true, reason: 'test stub (pass-through wrap)' }),
  wrap: (_spec, program, argv) => {
    recordedWraps.push({ program, argv: [...argv] });
    return { program, argv: [...argv] };
  },
};

const forcedMissing: JailBackend = {
  id: 'missing-test',
  probe: () => ({ backend: 'missing-test', available: false, reason: 'forced-missing for tests' }),
  wrap: () => {
    throw new Error('unreachable: probe gates wrap');
  },
};

let root = '';
let auditPath = '';
let prevJailEnv: string | undefined;
let prevCanary: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'zelari-exec-jail-'));
  auditPath = join(root, 'audit.jsonl');
  prevJailEnv = process.env[OS_JAIL_ENV];
  prevCanary = process.env.ZELARI_JAIL_CANARY;
});

afterEach(() => {
  setJailBackendForTests(null);
  recordedWraps.length = 0;
  if (prevJailEnv === undefined) delete process.env[OS_JAIL_ENV];
  else process.env[OS_JAIL_ENV] = prevJailEnv;
  if (prevCanary === undefined) delete process.env.ZELARI_JAIL_CANARY;
  else process.env.ZELARI_JAIL_CANARY = prevCanary;
  rmSync(root, { recursive: true, force: true });
});

function makeRegistry() {
  return createBuiltinToolRegistry({
    root,
    permissionPolicy: { read: 'allow', write: 'allow', execute: 'allow', network: 'allow', ui: 'allow', auto: true },
    diagnostics: false,
    audit: new AuditLogger(auditPath),
  }).registry;
}

function auditLines(): string {
  try {
    return readFileSync(auditPath, 'utf8');
  } catch {
    return '';
  }
}

/**
 * runTool() audit writes are fire-and-forget (serialized through the logger
 * queue) — poll briefly so assertions don't race the queue flush.
 */
async function waitForAuditLine(substr: string): Promise<string> {
  for (let i = 0; i < 50; i += 1) {
    const txt = auditLines();
    if (txt.includes(substr)) return txt;
    await new Promise((r) => setTimeout(r, 20));
  }
  return auditLines();
}

describe('osJail through the registry (v2.17 t28)', () => {
  it('(a) required + missing backend ⇒ exec_process DENIED with [jail] before any spawn', async () => {
    process.env[OS_JAIL_ENV] = 'required';
    setJailBackendForTests(forcedMissing);
    const registry = makeRegistry();
    const res = await registry.invoke<ExecValue>('exec_process', {
      program: process.execPath,
      args: ['-e', 'process.stdout.write("should-not-run")'],
      timeoutMs: 20_000,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('[jail]');
    expect(recordedWraps).toHaveLength(0); // deny is pre-spawn by construction
  });

  it('(a) required + missing backend ⇒ bash DENIED with [jail] + audited jail_denied', { timeout: REAL_SHELL_TEST_TIMEOUT }, async () => {
    process.env[OS_JAIL_ENV] = 'required';
    setJailBackendForTests(forcedMissing);
    const registry = makeRegistry();
    const res = await registry.invoke<BashValue>('bash', {
      command: 'echo should-not-run',
      timeoutMs: 30_000,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('[jail]');
    expect(recordedWraps).toHaveLength(0);
    // The deny is visible in the audit trail, not just in the tool result.
    expect(auditLines()).toContain('jail_denied');
  });

  it('(b) advisory + missing backend ⇒ exec_process ALLOWED with visible signals', async () => {
    process.env[OS_JAIL_ENV] = 'advisory';
    setJailBackendForTests(forcedMissing);
    const registry = makeRegistry();
    const errors: string[] = [];
    const origError = console.error;
    console.error = (msg?: unknown, ...rest: unknown[]) => {
      errors.push(`${String(msg)} ${rest.map(String).join(' ')}`);
    };
    try {
      const res = await registry.invoke<ExecValue>('exec_process', {
        program: process.execPath,
        args: ['-e', 'process.stdout.write("advisory-ok")'],
        timeoutMs: 20_000,
      });
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.value.stdout).toContain('advisory-ok');
      // P3: the fail-open is NEVER silent — console line + result warning.
      expect(errors.some((e) => e.includes('[os-jail]') && e.includes('UNJAILED'))).toBe(true);
      expect(res.meta?.warnings?.some((w) => w.includes('os-jail:'))).toBe(true);
      // …and the audit summary carries the same signal (t28 evidence seam).
      expect(await waitForAuditLine('os-jail:')).toContain('os-jail:');
    } finally {
      console.error = origError;
    }
  });

  it('(b) advisory + missing backend ⇒ bash ALLOWED unjailed with jailNotice + audit', { timeout: REAL_SHELL_TEST_TIMEOUT }, async () => {
    process.env[OS_JAIL_ENV] = 'advisory';
    setJailBackendForTests(forcedMissing);
    const registry = makeRegistry();
    const errors: string[] = [];
    const origError = console.error;
    console.error = (msg?: unknown, ...rest: unknown[]) => {
      errors.push(`${String(msg)} ${rest.map(String).join(' ')}`);
    };
    try {
      const res = await registry.invoke<BashValue>('bash', {
        command: 'echo advisory-bash-ok',
        timeoutMs: 30_000,
      });
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.value.stdout).toContain('advisory-bash-ok');
        expect(res.value.jailNotice).toContain('UNJAILED');
      }
      expect(errors.some((e) => e.includes('[os-jail]'))).toBe(true);
      expect(await waitForAuditLine('[os-jail]')).toContain('[os-jail]');
    } finally {
      console.error = origError;
    }
  });

  it('(c) required + STUB backend ⇒ child env sanitized to the allowlist (no canary leak)', async () => {
    process.env[OS_JAIL_ENV] = 'required';
    process.env.ZELARI_JAIL_CANARY = 'leak-me';
    setJailBackendForTests(stubBackend);
    const registry = makeRegistry();
    const res = await registry.invoke<ExecValue>('exec_process', {
      program: process.execPath,
      args: [
        '-e',
        'process.stdout.write(JSON.stringify({ canary: process.env.ZELARI_JAIL_CANARY ?? null, hasPath: !!process.env.PATH || !!process.env.Path, ci: process.env.CI ?? null }))',
      ],
      timeoutMs: 20_000,
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const parsed = JSON.parse(res.value.stdout) as { canary: string | null; hasPath: boolean; ci: string | null };
      expect(parsed.canary).toBeNull(); // NOT in the allowlist → dropped
      expect(parsed.hasPath).toBe(true); // PATH survives the sanitation
      expect(parsed.ci).not.toBeNull(); // CI fast-fail flag always propagated
    }
    expect(recordedWraps.length).toBeGreaterThan(0); // the spawn went through the jailed path
  });
});
