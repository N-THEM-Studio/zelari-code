/**
 * cli-lifecycleHooks.test.ts — process-wide hook runner cache (WS3b).
 * t22: plus the hook failure-mode resolver (ZELARI_HOOKS_FAILURE over the
 * active policy load mode) and its wiring into the cached runner.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, utimesSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createLifecycleHooksFromDirs,
  resetLifecycleHookCache,
  fingerprintHookDirs,
  resolveHookFailureMode,
  HOOKS_FAILURE_ENV,
} from '../../src/cli/safety/lifecycleHooks.js';
import {
  activePolicyLoadSurface,
  setActivePolicyLoadSurface,
  type PolicyLoadSurface,
} from '../../src/cli/safety/policyLoadMode.js';

function tmpHooks(): string {
  return mkdtempSync(join(tmpdir(), 'zelari-hooks-cache-'));
}

function writeHook(dir: string, name: string, body = 'allow'): string {
  const p = join(dir, `${name}.json`);
  writeFileSync(
    p,
    JSON.stringify({
      name,
      match: { tools: ['*'], events: ['PreToolUse'] },
      command: `node -e "process.stdout.write(JSON.stringify({decision:'${body}'}))"`,
    }),
    'utf8',
  );
  return p;
}

describe('lifecycle hook runner cache', () => {
  const dirs: string[] = [];
  afterEach(() => {
    resetLifecycleHookCache();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  it('reuses the same runner while hook files are unchanged', () => {
    const dir = tmpHooks();
    dirs.push(dir);
    writeHook(dir, 'one');
    const a = createLifecycleHooksFromDirs([dir]);
    const b = createLifecycleHooksFromDirs([dir]);
    expect(a).toBe(b);
    expect(a.listHooks()).toHaveLength(1);
  });

  it('reloads when a hook file is added', () => {
    const dir = tmpHooks();
    dirs.push(dir);
    writeHook(dir, 'one');
    const a = createLifecycleHooksFromDirs([dir]);
    writeHook(dir, 'two');
    const b = createLifecycleHooksFromDirs([dir]);
    expect(b).not.toBe(a);
    expect(b.listHooks().map((h) => h.name).sort()).toEqual(['one', 'two']);
  });

  it('reloads when a hook file mtime changes', () => {
    const dir = tmpHooks();
    dirs.push(dir);
    const file = writeHook(dir, 'one');
    const a = createLifecycleHooksFromDirs([dir]);
    const st = statSync(file);
    utimesSync(file, st.atime, new Date(st.mtimeMs + 2_000));
    expect(fingerprintHookDirs([dir])).not.toBe(`${file}:${st.mtimeMs}:${st.size}`);
    const b = createLifecycleHooksFromDirs([dir]);
    expect(b).not.toBe(a);
  });
});

describe('hook failure mode resolver (t22)', () => {
  let prevSurface: PolicyLoadSurface;
  let prevEnv: string | undefined;

  beforeEach(() => {
    prevSurface = activePolicyLoadSurface();
    prevEnv = process.env[HOOKS_FAILURE_ENV];
    delete process.env[HOOKS_FAILURE_ENV];
    resetLifecycleHookCache();
  });

  afterEach(() => {
    setActivePolicyLoadSurface(prevSurface);
    if (prevEnv === undefined) delete process.env[HOOKS_FAILURE_ENV];
    else process.env[HOOKS_FAILURE_ENV] = prevEnv;
    resetLifecycleHookCache();
  });

  it('env ZELARI_HOOKS_FAILURE wins over the policy mode', () => {
    setActivePolicyLoadSurface('headless'); // strict ⇒ would resolve fail-closed
    expect(resolveHookFailureMode('fail-open', {})).toBe('fail-open');
    setActivePolicyLoadSurface('tui'); // permissive ⇒ would resolve fail-open
    expect(resolveHookFailureMode('fail-closed', {})).toBe('fail-closed');
  });

  it('derives from activePolicyLoadMode: strict ⇒ fail-closed, tui ⇒ fail-open', () => {
    setActivePolicyLoadSurface('headless');
    expect(resolveHookFailureMode(undefined, {})).toBe('fail-closed');
    setActivePolicyLoadSurface('mission');
    expect(resolveHookFailureMode(undefined, {})).toBe('fail-closed');
    setActivePolicyLoadSurface('tui');
    expect(resolveHookFailureMode(undefined, {})).toBe('fail-open');
  });

  it('invalid env values are ignored (fall through to the policy mode)', () => {
    setActivePolicyLoadSurface('headless');
    expect(resolveHookFailureMode('  CLOSED  ', {})).toBe('fail-closed');
    setActivePolicyLoadSurface('tui');
    expect(resolveHookFailureMode('bogus', {})).toBe('fail-open');
  });

  it('createLifecycleHooksFromDirs wires the resolved mode into the runner', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zelari-hooks-mode-'));
    const prevLoadMode = process.env.ZELARI_POLICY_LOAD_MODE;
    try {
      writeHook(dir, 'one');
      setActivePolicyLoadSurface('tui');
      // Ambient CI would legitimately tighten the TUI to strict — pin the
      // policy mode explicitly so both branches are deterministic here.
      process.env.ZELARI_POLICY_LOAD_MODE = 'permissive';
      const permissive = createLifecycleHooksFromDirs([dir]);
      expect(permissive.failureMode).toBe('fail-open');
      process.env.ZELARI_POLICY_LOAD_MODE = 'strict';
      const strict = createLifecycleHooksFromDirs([dir]);
      expect(strict).not.toBe(permissive); // mode is part of the cache key
      expect(strict.failureMode).toBe('fail-closed');
    } finally {
      if (prevLoadMode === undefined) delete process.env.ZELARI_POLICY_LOAD_MODE;
      else process.env.ZELARI_POLICY_LOAD_MODE = prevLoadMode;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
