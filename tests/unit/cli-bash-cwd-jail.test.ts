/**
 * cli-bash-cwd-jail.test.ts — v2.17 (t27) acceptance for the CLI bash path.
 *
 * The CLI registry wraps `bash` with wrapWithShellSafety, which now jails the
 * cwd argument to the workspace root (resolveSandboxedPath, symlink-safe)
 * BEFORE the builtin spawns, and injects the RESOLVED absolute cwd so the
 * child process starts inside the sandbox:
 *  1. cwd outside the root (absolute or `..` escape) ⇒ typed `[sandbox]`
 *     deny and the command never runs;
 *  2. an in-workspace relative cwd still works and executes INSIDE the
 *     injected directory;
 *  3. an ABSENT cwd defaults to the sandbox root — not to wherever the CLI
 *     was launched (ctx.cwd is ignored by construction).
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBuiltinToolRegistry } from '../../src/cli/toolRegistry.js';
import { OS_JAIL_ENV } from '../../src/cli/safety/osJail.js';

// v2.17 (t28): these tests cover the t27 CWD jail, NOT the OS jail. The OS
// jail defaults to `required` on strict surfaces (headless/mission/CI) and
// the honest win32 backend is unavailable, which would DENY these spawns on
// CI. Pin the mode explicitly OFF here — production defaults are untouched
// (the OS-jail behavior itself is covered by cli-execProcess-jail.test.ts).
let prevJailEnv: string | undefined;
beforeEach(() => {
  prevJailEnv = process.env[OS_JAIL_ENV];
  process.env[OS_JAIL_ENV] = 'off';
});
afterEach(() => {
  if (prevJailEnv === undefined) delete process.env[OS_JAIL_ENV];
  else process.env[OS_JAIL_ENV] = prevJailEnv;
});

// Spawning the real host shell can take >10s on Windows (see
// core-shellTool.test.ts) — generous per-test vitest timeouts.
const REAL_SHELL_TEST_TIMEOUT = 45_000;

interface BashValue {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  shellVia: string;
}

describe('bash cwd jail (v2.17 t27)', () => {
  it('denies a cwd outside the workspace with [sandbox] before any spawn', async () => {
    const root = mkdtempSync(join(tmpdir(), 'zelari-jail-root-'));
    const outside = mkdtempSync(join(tmpdir(), 'zelari-jail-out-'));
    try {
      const { registry } = createBuiltinToolRegistry({
        root,
        permissionPolicy: { read: 'allow', write: 'allow', execute: 'allow', network: 'allow', ui: 'allow', auto: true },
        diagnostics: false,
      });
      // Absolute escape…
      const abs = await registry.invoke<BashValue>('bash', {
        command: 'echo escape-marker',
        cwd: outside,
        timeoutMs: 5000,
      });
      expect(abs.ok).toBe(false);
      if (!abs.ok) expect(abs.error).toContain('[sandbox]');
      // …and the realistic `..` relative escape — same typed deny.
      const rel = await registry.invoke<BashValue>('bash', {
        command: 'echo escape-marker',
        cwd: '..',
        timeoutMs: 5000,
      });
      expect(rel.ok).toBe(false);
      if (!rel.ok) expect(rel.error).toContain('[sandbox]');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('runs an in-workspace relative cwd INSIDE the injected directory', { timeout: REAL_SHELL_TEST_TIMEOUT }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'zelari-jail-sub-'));
    try {
      mkdirSync(join(root, 'sub'), { recursive: true });
      const { registry } = createBuiltinToolRegistry({
        root,
        permissionPolicy: { read: 'allow', write: 'allow', execute: 'allow', network: 'allow', ui: 'allow', auto: true },
        diagnostics: false,
      });
      // `>` redirect works in POSIX sh, Git Bash AND cmd.exe — the marker
      // lands in the process cwd, proving WHERE the child actually ran.
      const res = await registry.invoke<BashValue>('bash', {
        command: 'echo in-sub > marker.txt',
        cwd: 'sub',
        timeoutMs: 30_000,
      });
      expect(res.ok).toBe(true);
      expect(existsSync(join(root, 'sub', 'marker.txt'))).toBe(true);
      expect(existsSync(join(root, 'marker.txt'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('defaults an absent cwd to the sandbox root, not to ctx.cwd', { timeout: REAL_SHELL_TEST_TIMEOUT }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'zelari-jail-def-'));
    try {
      const { registry } = createBuiltinToolRegistry({
        root,
        permissionPolicy: { read: 'allow', write: 'allow', execute: 'allow', network: 'allow', ui: 'allow', auto: true },
        diagnostics: false,
      });
      // registry.invoke passes ctx.cwd = process.cwd() (the repo checkout,
      // OUTSIDE the tmpdir sandbox). Before t27 the builtin ran there; now
      // the wrapper injects the resolved root.
      const res = await registry.invoke<BashValue>('bash', {
        command: 'echo default-jail > rootmarker.txt',
        timeoutMs: 30_000,
      });
      expect(res.ok).toBe(true);
      expect(existsSync(join(root, 'rootmarker.txt'))).toBe(true);
      expect(existsSync(join(process.cwd(), 'rootmarker.txt'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
