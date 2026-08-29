/**
 * lifecycleHookRunner.test.ts — v1.32.0 acceptance:
 *  1. PreToolUse deny blocks the tool and surfaces the reason
 *  2. Hook crash/timeout does NOT block the tool (fail-open, logged)
 *  3. Matcher `Bash` and `bash` both match the `bash` tool
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LifecycleHookRunner, splitHookCommandLine } from './lifecycleHookRunner.js';
import { toolMatches, hookMatches, normalizeToolName } from './types.js';
import type { HookDefinition } from './types.js';

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'zelari-hooks-test-'));
}

function writeHook(dir: string, name: string, body: string): string {
  const p = join(dir, `${name}.json`);
  writeFileSync(p, body, 'utf8');
  return p;
}

describe('tool matching (acceptance #3)', () => {
  it('normalizes Claude-style spellings', () => {
    expect(normalizeToolName('Bash')).toBe('bash');
    expect(normalizeToolName('bash')).toBe('bash');
    expect(normalizeToolName('Read')).toBe('read_file');
    expect(normalizeToolName('read_file')).toBe('read_file');
    expect(normalizeToolName('list_dir')).toBe('list_files');
  });

  it('matches Bash and bash both for tool bash', () => {
    expect(toolMatches('Bash', 'bash')).toBe(true);
    expect(toolMatches('bash', 'bash')).toBe(true);
    expect(toolMatches('*', 'bash')).toBe(true);
    expect(toolMatches('write_file', 'bash')).toBe(false);
  });

  it('hookMatches respects events + tool patterns', () => {
    const hook: HookDefinition = {
      name: 't',
      match: { tools: ['Bash'], events: ['PreToolUse'] },
      command: 'node -e ""',
    };
    expect(hookMatches(hook, 'PreToolUse', 'bash')).toBe(true);
    expect(hookMatches(hook, 'PreToolUse', 'Bash')).toBe(true);
    expect(hookMatches(hook, 'PostToolUse', 'bash')).toBe(false);
    expect(hookMatches(hook, 'PreToolUse', 'write_file')).toBe(false);
  });
});

describe('LifecycleHookRunner fail-open + deny (acceptance #1, #2)', () => {
  it('denies via explicit JSON decision and surfaces the reason', async () => {
    const dir = makeTmpDir();
    try {
      // Node one-liner: read stdin JSON, echo a deny decision.
      writeHook(
        dir,
        'deny-rm',
        JSON.stringify({
          name: 'deny-rm',
          match: { tools: ['bash'], events: ['PreToolUse'] },
          command: 'node -e "process.stdin.once(\'data\', d => { console.log(JSON.stringify({ decision: \'deny\', reason: \'rm -rf blocked by test hook\' })); })"',
          timeoutMs: 5000,
        }),
      );
      const runner = new LifecycleHookRunner({ dirs: [dir] });
      const res = await runner.runPreToolUse('bash', { command: 'rm -rf /tmp/x' }, { cwd: '/tmp' });
      expect(res.ok).toBe(false);
      expect(res.hookName).toBe('deny-rm');
      expect(res.reason).toContain('rm -rf blocked');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('crashing hook does NOT block the tool (fail-open)', async () => {
    const dir = makeTmpDir();
    try {
      writeHook(
        dir,
        'crash',
        JSON.stringify({
          name: 'crash',
          match: { tools: ['*'], events: ['PreToolUse'] },
          command: 'node -e "process.exit(1)"',
          timeoutMs: 2000,
        }),
      );
      const logs: string[] = [];
      const runner = new LifecycleHookRunner({
        dirs: [dir],
        logger: (m) => logs.push(m),
      });
      const res = await runner.runPreToolUse('read_file', { path: 'x' }, { cwd: '/' });
      expect(res.ok).toBe(true);
      expect(logs.some((l) => l.includes('crash'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('timing-out hook does NOT block the tool (fail-open)', async () => {
    const dir = makeTmpDir();
    try {
      writeHook(
        dir,
        'slow',
        JSON.stringify({
          name: 'slow',
          match: { tools: ['*'], events: ['PreToolUse'] },
          command: 'node -e "setTimeout(() => {}, 30000)"',
          timeoutMs: 300,
        }),
      );
      const logs: string[] = [];
      const runner = new LifecycleHookRunner({
        dirs: [dir],
        logger: (m) => logs.push(m),
      });
      const res = await runner.runPreToolUse('bash', { command: 'echo hi' }, { cwd: '/' });
      expect(res.ok).toBe(true);
      expect(logs.some((l) => l.includes('timed out'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('invalid JSON response fails open with a logged warning', async () => {
    const dir = makeTmpDir();
    try {
      writeHook(
        dir,
        'garbage',
        JSON.stringify({
          name: 'garbage',
          match: { tools: ['*'], events: ['PreToolUse'] },
          command: 'node -e "console.log(\'not-json\')"',
          timeoutMs: 2000,
        }),
      );
      const logs: string[] = [];
      const runner = new LifecycleHookRunner({
        dirs: [dir],
        logger: (m) => logs.push(m),
      });
      const res = await runner.runPreToolUse('bash', { command: 'ls' }, { cwd: '/' });
      expect(res.ok).toBe(true);
      expect(logs.some((l) => l.includes('invalid JSON'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ignores non-matching hooks entirely', async () => {
    const dir = makeTmpDir();
    try {
      writeHook(
        dir,
        'only-edit',
        JSON.stringify({
          name: 'only-edit',
          match: { tools: ['edit_file'], events: ['PreToolUse'] },
          command: 'node -e "console.log(JSON.stringify({ decision: \'deny\', reason: \'nope\' }))"',
          timeoutMs: 2000,
        }),
      );
      const runner = new LifecycleHookRunner({ dirs: [dir] });
      // Tool `bash` is not matched by the edit_file-only hook → allow.
      const res = await runner.runPreToolUse('bash', { command: 'ls' }, { cwd: '/' });
      expect(res.ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('LifecycleHookRunner failureMode (t22)', () => {
  function writeCrashHook(dir: string): void {
    writeHook(
      dir,
      'crash',
      JSON.stringify({
        name: 'crash',
        match: { tools: ['*'], events: ['PreToolUse'] },
        command: 'node -e "process.exit(1)"',
        timeoutMs: 2000,
      }),
    );
  }

  function writeGarbageHook(dir: string): void {
    writeHook(
      dir,
      'garbage',
      JSON.stringify({
        name: 'garbage',
        match: { tools: ['*'], events: ['PreToolUse'] },
        command: 'node -e "console.log(\'not-json\')"',
        timeoutMs: 2000,
      }),
    );
  }

  it('fail-closed: crashing hook DENIES with reason hook-failed', async () => {
    const dir = makeTmpDir();
    try {
      writeCrashHook(dir);
      const logs: string[] = [];
      const runner = new LifecycleHookRunner({
        dirs: [dir],
        failureMode: 'fail-closed',
        logger: (m) => logs.push(m),
      });
      expect(runner.failureMode).toBe('fail-closed');
      const res = await runner.runPreToolUse('bash', { command: 'ls' }, { cwd: '/' });
      expect(res.ok).toBe(false);
      expect(res.reason).toBe('hook-failed');
      expect(logs.some((l) => l.includes('fail-closed'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fail-closed: invalid JSON response DENIES with reason hook-failed', async () => {
    const dir = makeTmpDir();
    try {
      writeGarbageHook(dir);
      const logs: string[] = [];
      const runner = new LifecycleHookRunner({
        dirs: [dir],
        failureMode: 'fail-closed',
        logger: (m) => logs.push(m),
      });
      const res = await runner.runPreToolUse('bash', { command: 'ls' }, { cwd: '/' });
      expect(res.ok).toBe(false);
      expect(res.reason).toBe('hook-failed');
      expect(logs.some((l) => l.includes('invalid JSON'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fail-closed: timing-out hook DENIES with reason hook-failed', async () => {
    const dir = makeTmpDir();
    try {
      writeHook(
        dir,
        'slow',
        JSON.stringify({
          name: 'slow',
          match: { tools: ['*'], events: ['PreToolUse'] },
          command: 'node -e "setTimeout(() => {}, 30000)"',
          timeoutMs: 300,
        }),
      );
      const runner = new LifecycleHookRunner({ dirs: [dir], failureMode: 'fail-closed' });
      const res = await runner.runPreToolUse('bash', { command: 'echo hi' }, { cwd: '/' });
      expect(res.ok).toBe(false);
      expect(res.reason).toBe('hook-failed');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fail-closed: deny without reason DENIES with reason hook-failed', async () => {
    const dir = makeTmpDir();
    try {
      writeHook(
        dir,
        'no-reason',
        JSON.stringify({
          name: 'no-reason',
          match: { tools: ['*'], events: ['PreToolUse'] },
          command: 'node -e "console.log(JSON.stringify({ decision: \'deny\' }))"',
          timeoutMs: 2000,
        }),
      );
      const runner = new LifecycleHookRunner({ dirs: [dir], failureMode: 'fail-closed' });
      const res = await runner.runPreToolUse('bash', { command: 'ls' }, { cwd: '/' });
      expect(res.ok).toBe(false);
      expect(res.reason).toBe('hook-failed');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fail-open (explicit or default) stays allow for crash + invalid JSON', async () => {
    const dir = makeTmpDir();
    try {
      writeCrashHook(dir);
      writeGarbageHook(dir);
      for (const failureMode of [undefined, 'fail-open'] as const) {
        const logs: string[] = [];
        const runner = new LifecycleHookRunner({
          dirs: [dir],
          ...(failureMode ? { failureMode } : {}),
          logger: (m) => logs.push(m),
        });
        expect(runner.failureMode).toBe('fail-open');
        const res = await runner.runPreToolUse('bash', { command: 'ls' }, { cwd: '/' });
        expect(res.ok).toBe(true);
        expect(logs.some((l) => l.includes('fail-open'))).toBe(true);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('execCommand — explicit argv, shell:false (v2.17 t27)', () => {
  it('splitHookCommandLine: metacharacters are literal tokens, quotes group', () => {
    // The acceptance example: `;` never splits a command chain.
    expect(splitHookCommandLine('echo a; rm -rf /')).toEqual(['echo', 'a;', 'rm', '-rf', '/']);
    // Quoted JS payloads survive verbatim (the shape all v1.32 hooks use).
    expect(splitHookCommandLine('node -e "console.log(\'not-json\')"')).toEqual([
      'node',
      '-e',
      "console.log('not-json')",
    ]);
    // Windows paths: backslashes survive unquoted AND inside double quotes.
    expect(splitHookCommandLine('node "C:\\tools\\my hook.mjs" --x=1')).toEqual([
      'node',
      'C:\\tools\\my hook.mjs',
      '--x=1',
    ]);
    // Single quotes group too; metachars inside quotes are plain characters.
    expect(splitHookCommandLine("echo 'a && b | c'")).toEqual(['echo', 'a && b | c']);
    expect(splitHookCommandLine('')).toEqual([]);
  });

  it('a `&&` command string is NOT chained by a shell (real spawn, behavioral)', async () => {
    const dir = makeTmpDir();
    try {
      writeHook(
        dir,
        'metachar',
        JSON.stringify({
          name: 'metachar',
          match: { tools: ['bash'], events: ['PreToolUse'] },
          // Discriminator: under the old `shell: true` spawn a shell parsed
          // this line → `echo PWNED` ran AFTER node, corrupting the JSON
          // verdict (invalid JSON → fail-open allow). With shell:false the
          // whole tail `x&&echo PWNED` reaches node as literal argv and the
          // deny verdict carries it verbatim.
          command:
            'node -e "const n=process.argv[1]||\'\';process.stdout.write(JSON.stringify({decision:\'deny\',reason:\'metachar:\'+n}))" x&&echo PWNED',
          timeoutMs: 5000,
        }),
      );
      const logs: string[] = [];
      const runner = new LifecycleHookRunner({ dirs: [dir], logger: (m) => logs.push(m) });
      const res = await runner.runPreToolUse('bash', { command: 'ls' }, { cwd: '/' });
      // The deny verdict survived intact — the JSON was not shell-corrupted.
      expect(res.ok).toBe(false);
      expect(res.reason).toBe('metachar:x&&echo');
      // The chained `echo PWNED` never ran (it would surface in the raw
      // output of the 'invalid JSON' failure log).
      expect(logs.join('\n')).not.toContain('PWNED');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
