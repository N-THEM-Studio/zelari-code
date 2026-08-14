/**
 * cli-lifecycleHooks.test.ts — process-wide hook runner cache (WS3b).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, utimesSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createLifecycleHooksFromDirs,
  resetLifecycleHookCache,
  fingerprintHookDirs,
} from '../../src/cli/safety/lifecycleHooks.js';

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
