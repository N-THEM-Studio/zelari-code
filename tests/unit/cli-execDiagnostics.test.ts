/**
 * cli-execDiagnostics.test.ts — 2.21 (t31, HARNESS-10 §6.6) acceptance:
 * bash and exec_process runs that touch claimed SOURCE paths get
 * post-execute diagnostics on the SAME channel as the edit loop
 * (`value.diagnostics`), with the injected diagnosticsRunner as the spy.
 *
 * Locks:
 *  - exec_process running a script that writes a .ts ⇒ the checker runs on
 *    the claimed source path AFTER the execution (the file exists by then);
 *  - bash with the same shape ⇒ same loop (claims come from the process
 *    claim of the command string);
 *  - a claimed path OUTSIDE the root is never checked (containment filter);
 *  - `diagnostics: false` (ZELARI_DIAGNOSTICS=0) disables the execute loop;
 *  - a clean checker appends no `diagnostics` field.
 *
 * OS_JAIL_ENV is pinned to `off` for determinism — the diagnostics loop is
 * orthogonal to the jail posture (same pattern as cli-bash-cwd-jail.test.ts).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createBuiltinToolRegistry } from '../../src/cli/toolRegistry.js';
import { OS_JAIL_ENV } from '../../src/cli/safety/osJail.js';
import type { Runner } from '../../src/cli/diagnostics/engine.js';

// Spawning the real host shell can take >10s on Windows — generous timeouts.
const REAL_SHELL_TEST_TIMEOUT = 45_000;

interface ExecValue {
  exitCode: number;
  stdout: string;
  stderr: string;
  diagnostics?: string;
}

interface BashValue {
  stdout: string;
  exitCode: number;
  diagnostics?: string;
}

let root = '';
let outside = '';
let prevJailEnv: string | undefined;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'zelari-exec-diag-'));
  outside = mkdtempSync(path.join(tmpdir(), 'zelari-exec-diag-out-'));
  prevJailEnv = process.env[OS_JAIL_ENV];
  process.env[OS_JAIL_ENV] = 'off';
});

afterEach(() => {
  if (prevJailEnv === undefined) delete process.env[OS_JAIL_ENV];
  else process.env[OS_JAIL_ENV] = prevJailEnv;
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

/** Editor script: writes argv[2] (a .ts path) — the "edit" the tool executes. */
const EDITOR_SRC =
  "import { writeFileSync } from 'node:fs';\n" +
  "writeFileSync(process.argv[2] ?? '', 'const x = 1;\\n');\n";

/** Runner spy: records every checked file; reports one eslint error per call. */
function spyRunner(calls: string[][]): Runner {
  return async (_cmd, args) => {
    calls.push([...args]);
    const file = args[args.length - 1] ?? '';
    return {
      code: 1,
      stdout: JSON.stringify([
        {
          filePath: file,
          messages: [
            { ruleId: 'no-unused-vars', severity: 2, message: "'x' is defined but never used", line: 1 },
          ],
        },
      ]),
      stderr: '',
    };
  };
}

function makeRegistry(runner: Runner) {
  return createBuiltinToolRegistry({
    root,
    diagnostics: true,
    diagnosticsRunner: runner,
  }).registry;
}

function checkedFiles(calls: string[][]): string[] {
  return calls.map((a) => a[a.length - 1] ?? '');
}

describe('post-execute diagnostics on claimed source paths (t31 §6.6)', () => {
  it(
    'exec_process editing a .ts ⇒ diagnostics appended on the claimed source path',
    async () => {
      writeFileSync(path.join(root, 'touch.mjs'), EDITOR_SRC);
      const calls: string[][] = [];
      const registry = makeRegistry(spyRunner(calls));
      const res = await registry.invoke<ExecValue>('exec_process', {
        program: process.execPath,
        args: ['touch.mjs', 'gen.ts'],
        timeoutMs: 20_000,
      });
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.value.exitCode).toBe(0);
        expect(res.value.diagnostics).toMatch(/no-unused-vars/);
        expect(res.value.diagnostics).toMatch(/1 error/);
      }
      // The execution wrote the claimed file BEFORE diagnostics ran.
      expect(readFileSync(path.join(root, 'gen.ts'), 'utf8')).toContain('const x');
      // The checker ran on the CLAIMED path — not on program/flags.
      expect(checkedFiles(calls).some((f) => f.endsWith('gen.ts'))).toBe(true);
      expect(checkedFiles(calls).some((f) => f.endsWith(process.execPath))).toBe(false);
    },
    REAL_SHELL_TEST_TIMEOUT,
  );

  it(
    'bash editing a .ts ⇒ diagnostics appended post-execute (same loop)',
    { timeout: REAL_SHELL_TEST_TIMEOUT },
    async () => {
      writeFileSync(path.join(root, 'touch.mjs'), EDITOR_SRC);
      const calls: string[][] = [];
      const registry = makeRegistry(spyRunner(calls));
      const res = await registry.invoke<BashValue>('bash', {
        command: 'node touch.mjs gen.ts',
        timeoutMs: 30_000,
      });
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.value.diagnostics).toMatch(/no-unused-vars/);
      expect(readFileSync(path.join(root, 'gen.ts'), 'utf8')).toContain('const x');
      expect(checkedFiles(calls).some((f) => f.endsWith('gen.ts'))).toBe(true);
    },
  );

  it('a claimed source path OUTSIDE the root is never checked', async () => {
    const outsideTs = path.join(outside, 'elsewhere.ts');
    writeFileSync(outsideTs, 'const y = 2;\n');
    writeFileSync(path.join(root, 'touch.mjs'), EDITOR_SRC);
    const calls: string[][] = [];
    const registry = makeRegistry(spyRunner(calls));
    const res = await registry.invoke<ExecValue>('exec_process', {
      program: process.execPath,
      args: ['touch.mjs', outsideTs],
      timeoutMs: 20_000,
    });
    // The run itself succeeds — diagnostics never gate the tool…
    expect(res.ok).toBe(true);
    // …and the child DID overwrite the outside file (the tool is not
    // sandboxing argv): its content is now the editor's payload.
    expect(readFileSync(outsideTs, 'utf8')).toContain('const x');
    // The OUTSIDE path is never checked (containment filter) — only the
    // in-root editor script itself is a legitimate claim.
    expect(checkedFiles(calls).some((f) => f.endsWith('elsewhere.ts'))).toBe(false);
    if (res.ok) {
      expect(res.value.diagnostics ?? '').not.toMatch(/elsewhere\.ts/);
    }
  });

  it('diagnostics:false (ZELARI_DIAGNOSTICS=0) disables the execute loop', async () => {
    writeFileSync(path.join(root, 'touch.mjs'), EDITOR_SRC);
    const calls: string[][] = [];
    const { registry } = createBuiltinToolRegistry({
      root,
      diagnostics: false,
      diagnosticsRunner: spyRunner(calls),
    });
    const res = await registry.invoke<ExecValue>('exec_process', {
      program: process.execPath,
      args: ['touch.mjs', 'gen.ts'],
      timeoutMs: 20_000,
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.diagnostics).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it('a clean checker appends no diagnostics field', async () => {
    writeFileSync(path.join(root, 'touch.mjs'), EDITOR_SRC);
    const runner: Runner = async () => ({ code: 0, stdout: '[]', stderr: '' });
    const registry = makeRegistry(runner);
    const res = await registry.invoke<ExecValue>('exec_process', {
      program: process.execPath,
      args: ['touch.mjs', 'gen.ts'],
      timeoutMs: 20_000,
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.diagnostics).toBeUndefined();
  });
});
