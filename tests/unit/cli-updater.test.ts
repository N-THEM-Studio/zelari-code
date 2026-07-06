/**
 * updater tests — npm registry self-update mechanism (Task N.3, v3-N).
 */

import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  getCurrentVersion,
  compareSemver,
  fetchLatestVersion,
  checkForUpdate,
  performUpdate,
  resolveBundledNpmCli,
  REGISTRY_URL,
} from '../../src/cli/updater';
import type { spawn as SpawnType } from 'node:child_process';

/** Build a fake ChildProcess that emits the given output then closes. */
function fakeChild(chunk: string, code: number, stream: 'stdout' | 'stderr' = 'stdout') {
  const fake = new EventEmitter() as unknown as ReturnType<typeof SpawnType> & {
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
  fake.stdout = new EventEmitter();
  fake.stderr = new EventEmitter();
  setImmediate(() => {
    (stream === 'stdout' ? fake.stdout : fake.stderr).emit('data', Buffer.from(chunk));
    fake.emit('close', code);
  });
  return fake;
}

describe('getCurrentVersion', () => {
  it('reads version from bundled package.json', () => {
    const version = getCurrentVersion();
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
    expect(version).not.toBe('0.0.0');
  });
});

describe('compareSemver', () => {
  it('returns 0 for equal versions', () => {
    expect(compareSemver('1.0.0', '1.0.0')).toBe(0);
    expect(compareSemver('0.5.12', '0.5.12')).toBe(0);
  });

  it('returns -1 when a < b on patch', () => {
    expect(compareSemver('1.0.0', '1.0.1')).toBe(-1);
  });

  it('returns -1 when a < b on minor', () => {
    expect(compareSemver('1.0.5', '1.1.0')).toBe(-1);
  });

  it('returns -1 when a < b on major', () => {
    expect(compareSemver('1.9.9', '2.0.0')).toBe(-1);
  });

  it('returns 1 when a > b', () => {
    expect(compareSemver('2.0.0', '1.9.9')).toBe(1);
    expect(compareSemver('0.5.12', '0.5.11')).toBe(1);
  });

  it('treats pre-release as lower than release', () => {
    expect(compareSemver('1.0.0-beta.1', '1.0.0')).toBe(-1);
    expect(compareSemver('1.0.0', '1.0.0-beta.1')).toBe(1);
  });

  it('compares pre-release tags lexically', () => {
    expect(compareSemver('1.0.0-alpha', '1.0.0-beta')).toBe(-1);
  });
});

describe('fetchLatestVersion', () => {
  it('returns version from successful registry response', async () => {
    const fakeFetcher = async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({ version: '1.2.3' }),
      }) as unknown as Response;

    const result = await fetchLatestVersion(fakeFetcher as unknown as typeof fetch);
    expect(result).toEqual({ version: '1.2.3' });
  });

  it('returns error on non-OK response', async () => {
    const fakeFetcher = async () =>
      ({
        ok: false,
        status: 404,
        json: async () => ({}),
      }) as unknown as Response;

    const result = await fetchLatestVersion(fakeFetcher as unknown as typeof fetch);
    expect(result).toHaveProperty('error');
    expect((result as { error: string }).error).toContain('404');
  });

  it('returns error on missing version field', async () => {
    const fakeFetcher = async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({}),
      }) as unknown as Response;

    const result = await fetchLatestVersion(fakeFetcher as unknown as typeof fetch);
    expect(result).toHaveProperty('error');
  });

  it('returns error on network failure', async () => {
    const fakeFetcher = async () => {
      throw new Error('ECONNREFUSED');
    };

    const result = await fetchLatestVersion(fakeFetcher as unknown as typeof fetch);
    expect(result).toEqual({ error: 'ECONNREFUSED' });
  });

  it('uses default REGISTRY_URL when not overridden', () => {
    expect(REGISTRY_URL).toBe('https://registry.npmjs.org/zelari-code/latest');
  });
});

describe('checkForUpdate', () => {
  it('returns updateAvailable=true when latest > current', async () => {
    const fakeFetcher = async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({ version: '999.0.0' }),
      }) as unknown as Response;

    const result = await checkForUpdate(fakeFetcher as unknown as typeof fetch);
    expect(result.updateAvailable).toBe(true);
    expect(result.latestVersion).toBe('999.0.0');
  });

  it('returns updateAvailable=false when current === latest', async () => {
    const fakeFetcher = async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({ version: getCurrentVersion() }),
      }) as unknown as Response;

    const result = await checkForUpdate(fakeFetcher as unknown as typeof fetch);
    expect(result.updateAvailable).toBe(false);
  });

  it('returns updateAvailable=false on registry error', async () => {
    const fakeFetcher = async () => {
      throw new Error('network down');
    };

    const result = await checkForUpdate(fakeFetcher as unknown as typeof fetch);
    expect(result.updateAvailable).toBe(false);
    expect(result.error).toBe('network down');
    expect(result.latestVersion).toBe(result.currentVersion);
  });
});

describe('performUpdate', () => {
  it('spawns npm install -g zelari-code@latest and captures exit code 0', async () => {
    // Fake spawn: emits a stdout chunk + exits 0.
    // v0.7.9 (DEP0190 fix): on win32 performUpdate passes a single
    // pre-quoted command string + shell:true; on POSIX command + args array.
    // Normalize both shapes before asserting.
    const fakeSpawn = ((cmd: string, args: string[] | object) => {
      const argv = Array.isArray(args) ? [cmd, ...args] : cmd.split(' ');
      expect(argv).toEqual(['npm', 'install', '-g', 'zelari-code@latest']);

      const fake = new EventEmitter() as unknown as ReturnType<typeof SpawnType> & {
        stdout: EventEmitter;
        stderr: EventEmitter;
      };
      fake.stdout = new EventEmitter();
      fake.stderr = new EventEmitter();
      // Schedule emissions
      setImmediate(() => {
        fake.stdout.emit('data', Buffer.from('added 1 package in 2s'));
        fake.emit('close', 0);
      });
      return fake;
    }) as unknown as typeof SpawnType;

    const result = await performUpdate('zelari-code', fakeSpawn);
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('added 1 package');
  });

  it('returns ok=false on npm exit code != 0', async () => {
    const fakeSpawn = (() => {
      const fake = new EventEmitter() as unknown as ReturnType<typeof SpawnType> & {
        stdout: EventEmitter;
        stderr: EventEmitter;
      };
      fake.stdout = new EventEmitter();
      fake.stderr = new EventEmitter();
      setImmediate(() => {
        fake.stderr.emit('data', Buffer.from('EACCES: permission denied'));
        fake.emit('close', 1);
      });
      return fake;
    }) as unknown as typeof SpawnType;

    const result = await performUpdate('zelari-code', fakeSpawn);
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.error).toContain('exited with code 1');
    expect(result.output).toContain('EACCES');
  });

  it('does NOT retry a real npm failure (EACCES / exit 1) via bundled npm', async () => {
    let calls = 0;
    const fakeSpawn = ((..._a: unknown[]) => {
      calls += 1;
      return fakeChild('EACCES: permission denied', 1, 'stderr');
    }) as unknown as typeof SpawnType;
    // Resolver returns a path, but the failure is exit 1 (not a broken shim),
    // so the fallback must not fire.
    const result = await performUpdate('zelari-code', fakeSpawn, () => '/fake/npm-cli.js');
    expect(calls).toBe(1);
    expect(result.ok).toBe(false);
    expect(result.output).not.toContain('bundled npm');
  });

  it('falls back to bundled npm on a broken-shim failure (exit 127) and succeeds', async () => {
    const seen: Array<{ cmd: string; args: unknown }> = [];
    let calls = 0;
    const fakeSpawn = ((cmd: string, args: unknown) => {
      seen.push({ cmd, args });
      calls += 1;
      // Attempt 1: broken Volta shim. Attempt 2 (bundled): success.
      return calls === 1
        ? fakeChild('Shim target not found: npm.cmd', 127, 'stderr')
        : fakeChild('added 1 package in 2s', 0);
    }) as unknown as typeof SpawnType;

    const result = await performUpdate('zelari-code', fakeSpawn, () => '/fake/npm-cli.js');

    expect(calls).toBe(2);
    expect(result.ok).toBe(true);
    // Second attempt must invoke `node <npm-cli.js> install -g ...` directly.
    expect(seen[1].cmd).toBe(process.execPath);
    expect(seen[1].args).toEqual(['/fake/npm-cli.js', 'install', '-g', 'zelari-code@latest']);
    // Output should record that the fallback was taken.
    expect(result.output).toContain('bundled npm');
    expect(result.output).toContain('added 1 package');
  });

  it('does not attempt the fallback when no bundled npm is found', async () => {
    let calls = 0;
    const fakeSpawn = ((..._a: unknown[]) => {
      calls += 1;
      return fakeChild('Shim target not found: npm.cmd', 127, 'stderr');
    }) as unknown as typeof SpawnType;
    const result = await performUpdate('zelari-code', fakeSpawn, () => null);
    expect(calls).toBe(1);
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(127);
  });
});

describe('resolveBundledNpmCli', () => {
  it('finds npm-cli.js in the Windows layout next to node.exe', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'npmcli-win-'));
    try {
      const binDir = path.join(dir, 'node_modules', 'npm', 'bin');
      mkdirSync(binDir, { recursive: true });
      writeFileSync(path.join(binDir, 'npm-cli.js'), '// npm');
      const resolved = resolveBundledNpmCli(path.join(dir, 'node.exe'));
      expect(resolved).toBe(path.join(binDir, 'npm-cli.js'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('finds npm-cli.js in the POSIX <prefix>/lib layout', () => {
    const prefix = mkdtempSync(path.join(tmpdir(), 'npmcli-posix-'));
    try {
      const binDir = path.join(prefix, 'lib', 'node_modules', 'npm', 'bin');
      mkdirSync(binDir, { recursive: true });
      writeFileSync(path.join(binDir, 'npm-cli.js'), '// npm');
      const resolved = resolveBundledNpmCli(path.join(prefix, 'bin', 'node'));
      expect(resolved).toBe(path.join(binDir, 'npm-cli.js'));
    } finally {
      rmSync(prefix, { recursive: true, force: true });
    }
  });

  it('returns null when no bundled npm is present', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'npmcli-none-'));
    try {
      expect(resolveBundledNpmCli(path.join(dir, 'node'))).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});