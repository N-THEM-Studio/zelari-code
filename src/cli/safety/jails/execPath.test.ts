/**
 * execPath.test.ts — t116: executable lookup by PATH scan + fs.access.
 *
 * The lookup must answer "is this binary runnable?" WITHOUT spawning
 * `which`/`where`. Two layers are pinned here:
 *   - the pure search order (injected `isExecutable`, no disk);
 *   - a REAL temp dir with a fake executable, exercised through fs.access, so
 *     the POSIX X_OK requirement and the win32 PATHEXT expansion are covered
 *     against the actual filesystem.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveExecutable, executableExists, DEFAULT_PATHEXT } from './execPath.js';

const IS_WIN = process.platform === 'win32';
const dirs: string[] = [];

function tmp(prefix = 'zelari-execpath-'): string {
  const d = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

/** Create a fake binary inside `dir` (executable bit set on POSIX). */
function fakeBin(dir: string, name: string): string {
  const p = path.join(dir, name);
  writeFileSync(p, IS_WIN ? '@echo off\n' : '#!/bin/sh\necho hi\n');
  if (!IS_WIN) chmodSync(p, 0o755);
  return p;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('resolveExecutable — search order (pure, injected probe)', () => {
  const probe = (hits: readonly string[]) => (candidate: string) => hits.includes(candidate);

  it('returns the FIRST PATH hit in PATH order', () => {
    const found = resolveExecutable('bwrap', {
      platform: 'linux',
      env: { PATH: '/a:/b:/c' },
      isExecutable: probe(['/b/bwrap', '/c/bwrap']),
    });
    expect(found).toBe('/b/bwrap');
  });

  it('null when nothing matches, and for empty/blank names', () => {
    expect(
      resolveExecutable('nope', { platform: 'linux', env: { PATH: '/a:/b' }, isExecutable: () => false }),
    ).toBeNull();
    expect(resolveExecutable('', { platform: 'linux', env: { PATH: '/a' } })).toBeNull();
    expect(resolveExecutable('   ', { platform: 'linux', env: { PATH: '/a' } })).toBeNull();
    expect(resolveExecutable('x', { platform: 'linux', env: {} })).toBeNull(); // no PATH at all
  });

  it('a name WITH a separator is probed directly, never through PATH', () => {
    const hits: string[] = [];
    const found = resolveExecutable('/opt/bin/tool', {
      platform: 'linux',
      env: { PATH: '/a:/b' },
      isExecutable: (c) => {
        hits.push(c);
        return c === '/opt/bin/tool';
      },
    });
    expect(found).toBe('/opt/bin/tool');
    expect(hits).toEqual(['/opt/bin/tool']); // no /a or /b candidate was even probed
  });

  it('win32 expands PATHEXT (upper-case entry first) and reads PATH case-insensitively', () => {
    const tried: string[] = [];
    const found = resolveExecutable('pwsh', {
      platform: 'win32',
      env: { Path: 'C:\\Program Files\\PowerShell\\7' },
      pathExt: DEFAULT_PATHEXT,
      isExecutable: (c) => {
        tried.push(c);
        return c === 'C:\\Program Files\\PowerShell\\7\\pwsh.EXE';
      },
    });
    expect(found).toBe('C:\\Program Files\\PowerShell\\7\\pwsh.EXE');
    expect(tried[0]).toBe('C:\\Program Files\\PowerShell\\7\\pwsh.COM');
    expect(tried).toContain('C:\\Program Files\\PowerShell\\7\\pwsh.EXE');
  });
});

describe('resolveExecutable — real filesystem (fs.access)', () => {
  it.skipIf(IS_WIN)('POSIX requires the executable bit (X_OK), not just existence', () => {
    const dir = tmp();
    const bin = fakeBin(dir, 'zelari-fake-bin');
    const plain = path.join(dir, 'not-executable');
    writeFileSync(plain, 'data');
    chmodSync(plain, 0o644);

    expect(resolveExecutable('zelari-fake-bin', { platform: 'linux', env: { PATH: dir } })).toBe(bin);
    expect(resolveExecutable('not-executable', { platform: 'linux', env: { PATH: dir } })).toBeNull();
    expect(executableExists('definitely-absent-xyz', { platform: 'linux', env: { PATH: dir } })).toBe(false);
  });

  it('finds a fake binary on a real PATH and reports no hit for a missing one', () => {
    const dir = tmp();
    const bin = fakeBin(dir, IS_WIN ? 'zelari-fake-bin.cmd' : 'zelari-fake-bin');
    // win32 PATHEXT expansion returns the FIRST variant that exists on a
    // case-insensitive filesystem — compare case-insensitively there.
    const found = resolveExecutable('zelari-fake-bin', { env: { PATH: dir }, platform: process.platform });
    expect(IS_WIN ? found?.toLowerCase() : found).toBe(IS_WIN ? bin.toLowerCase() : bin);
    expect(resolveExecutable('zelari-absent-xyz', { env: { PATH: dir }, platform: process.platform })).toBeNull();
  });

  it('keeps an unreadable directory from throwing (fail-soft)', () => {
    const dir = tmp();
    const sub = path.join(dir, 'not-a-dir');
    writeFileSync(sub, 'file');
    mkdirSync(path.join(dir, 'empty'));
    expect(
      resolveExecutable('anything', { platform: 'linux', env: { PATH: `${sub}:${path.join(dir, 'empty')}` } }),
    ).toBeNull();
  });
});
