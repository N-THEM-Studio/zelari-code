/**
 * cli-osJail.test.ts — v2.17 (t28) unit coverage for the OS-jail decision
 * logic (Pilastro A). Kernel backends cannot be exercised on every dev
 * platform, so the SPAWN side is covered with injected stubs
 * (setJailBackendForTests — the test-only seam, never active by default)
 * and the darwin/linux/win32 backends are covered on their PURE code paths:
 * profile generation, argv wrapping, probe decisions. No test here runs a
 * real jailed process (that is cli-execProcess-jail.test.ts via the
 * registry, with a pass-through stub backend).
 */
import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import {
  activeJailMode,
  buildJailSpec,
  decideJailSpawn,
  defaultEnvAllowlist,
  defaultWritable,
  jailAdvisoryNotice,
  jailDenyReason,
  networkSpecFromClaimHosts,
  OS_JAIL_ENV,
  resolveJailMode,
  sanitizeEnv,
  setJailBackendForTests,
  type JailBackend,
  type JailSpec,
} from '../../src/cli/safety/osJail.js';
import { buildSeatbeltProfile, darwinBackend, darwinProbe, SANDBOX_EXEC_PATH } from '../../src/cli/safety/jails/darwin.js';
import { buildBwrapArgs, findBinaryOnPath, linuxBackend, linuxProbe } from '../../src/cli/safety/jails/linux.js';
import { win32Backend, win32Probe } from '../../src/cli/safety/jails/win32.js';
import {
  activePolicyLoadSurface,
  setActivePolicyLoadSurface,
} from '../../src/cli/safety/policyLoadMode.js';

/** Pass-through stub backend: "available", argv untouched. TESTS ONLY. */
const stubAvailable: JailBackend = {
  id: 'stub',
  probe: () => ({ backend: 'stub', available: true, reason: 'test stub (pass-through wrap)' }),
  wrap: (_spec, program, argv) => ({ program, argv: [...argv] }),
};

/** Deterministic "backend missing" — platform-independent on every dev machine. */
const forcedMissing: JailBackend = {
  id: 'missing-test',
  probe: () => ({ backend: 'missing-test', available: false, reason: 'forced-missing for tests' }),
  wrap: () => {
    throw new Error('unreachable: probe gates wrap');
  },
};

const spec: JailSpec = buildJailSpec({ root: path.join(os.tmpdir(), 'zelari-osjail-spec') });

afterEach(() => {
  setJailBackendForTests(null);
});

describe('resolveJailMode (ZELARI_OS_JAIL — resolveHookFailureMode pattern)', () => {
  it('exact overrides win: off | advisory | required (case/space-insensitive)', () => {
    expect(resolveJailMode('off', {})).toBe('off');
    expect(resolveJailMode(' advisory ', {})).toBe('advisory');
    expect(resolveJailMode('REQUIRED', {})).toBe('required');
  });

  it('invalid values are IGNORED and fall through to the surface default', () => {
    const prev = activePolicyLoadSurface();
    try {
      setActivePolicyLoadSurface('headless'); // strict ⇒ would be required
      expect(resolveJailMode('bogus', {})).toBe('required');
      setActivePolicyLoadSurface('tui'); // permissive ⇒ would be advisory
      expect(resolveJailMode('  CLOSED  ', {})).toBe('advisory');
    } finally {
      setActivePolicyLoadSurface(prev);
    }
  });

  it('default: required on headless/mission/CI, advisory on the TUI', () => {
    const prev = activePolicyLoadSurface();
    try {
      setActivePolicyLoadSurface('headless');
      expect(resolveJailMode(undefined, {})).toBe('required');
      setActivePolicyLoadSurface('mission');
      expect(resolveJailMode(undefined, {})).toBe('required');
      setActivePolicyLoadSurface('tui');
      expect(resolveJailMode(undefined, {})).toBe('advisory');
      // ambient CI tightens the TUI to the strict surface
      expect(resolveJailMode(undefined, { CI: '1' })).toBe('required');
    } finally {
      setActivePolicyLoadSurface(prev);
    }
  });

  it('activeJailMode reads OS_JAIL_ENV from the injected env', () => {
    expect(activeJailMode({ [OS_JAIL_ENV]: 'off' })).toBe('off');
    expect(activeJailMode({ [OS_JAIL_ENV]: 'required' })).toBe('required');
    // whitespace-only override falls through to the same surface default
    expect(activeJailMode({ [OS_JAIL_ENV]: '   ' })).toBe(resolveJailMode(undefined, {}));
    expect(OS_JAIL_ENV).toBe('ZELARI_OS_JAIL');
  });
});

describe('JailSpec construction + env sanitation', () => {
  it('default allowlist is the spec set, widened on win32 with boot-critical vars', () => {
    expect(defaultEnvAllowlist('linux')).toEqual(['PATH', 'HOME', 'USER', 'LANG', 'CI', 'TERM', 'NO_COLOR']);
    const win = defaultEnvAllowlist('win32');
    for (const k of ['PATH', 'HOME', 'USER', 'LANG', 'CI', 'TERM', 'NO_COLOR', 'SystemRoot', 'ComSpec', 'MSYSTEM']) {
      expect(win).toContain(k);
    }
  });

  it('writable = root + tmpdir + ~/.zelari-code, deduped (host path semantics)', () => {
    const w = defaultWritable('/ws', '/home/u', '/tmp', 'linux');
    expect(w).toHaveLength(3);
    expect(w[0]).toBe(path.resolve('/ws'));
    expect(w).toContain(path.join('/home/u', '.zelari-code'));
    // tmp == root collapses (case-folded comparison on win32)
    const w2 = defaultWritable('C:\\ws', 'C:\\Users\\u', 'C:\\WS', 'win32');
    expect(w2).toHaveLength(2);
    expect(w2[0]).toBe(path.resolve('C:\\ws'));
  });

  it('sanitizeEnv keeps ONLY allowlisted vars; case-insensitive on win32 preserving casing', () => {
    const env = { PATH: '/bin', HOME: '/h', SECRET_TOKEN: 'leak', CANARY: 'x' };
    expect(sanitizeEnv(env, ['PATH', 'HOME'], 'linux')).toEqual({ PATH: '/bin', HOME: '/h' });
    // win32: process.env uses 'Path' — the fold must keep the ORIGINAL key.
    expect(sanitizeEnv({ Path: 'C:\\bin', CanarY: 'x' }, ['PATH'], 'win32')).toEqual({ Path: 'C:\\bin' });
    expect(sanitizeEnv({ Path: 'C:\\bin' }, ['PATH'], 'linux')).toEqual({});
    // undefined values never materialize.
    expect(sanitizeEnv({ PATH: undefined, HOME: '/h' }, ['PATH', 'HOME'], 'linux')).toEqual({ HOME: '/h' });
  });
});

describe('decideJailSpawn — the golden rule', () => {
  const canaryEnv = { PATH: '/bin', ZELARI_JAIL_CANARY: 'leak-me' };

  it('off ⇒ plain spawn, env untouched, no notice', () => {
    const d = decideJailSpawn(spec, { program: 'x', argv: [], env: canaryEnv, mode: 'off' });
    expect(d).toMatchObject({ action: 'spawn-plain', env: canaryEnv });
    expect(d).not.toHaveProperty('notice');
  });

  it('required + backend missing ⇒ DENY (never warn/skip/upgrade)', () => {
    setJailBackendForTests(forcedMissing);
    const d = decideJailSpawn(spec, { program: 'x', argv: [], env: canaryEnv, mode: 'required' });
    expect(d.action).toBe('deny');
    if (d.action === 'deny') {
      expect(jailDenyReason({ backend: 'missing-test', available: false, reason: 'r' }, 'required')).toContain('DENIED');
      expect(d.reason).toContain('DENIED');
      expect(d.reason).toContain('required');
    }
  });

  it('advisory + backend missing ⇒ visible fail-open: plain spawn + notice + sanitized env', () => {
    setJailBackendForTests(forcedMissing);
    const d = decideJailSpawn(spec, { program: 'x', argv: [], env: canaryEnv, mode: 'advisory' });
    expect(d.action).toBe('spawn-plain');
    if (d.action === 'spawn-plain') {
      expect(d.notice).toContain('UNJAILED');
      expect(jailAdvisoryNotice({ backend: 'b', available: false, reason: 'r' })).toContain('UNJAILED');
      expect(d.env.ZELARI_JAIL_CANARY).toBeUndefined(); // env allowlist still applies on fail-open
      expect(d.env.PATH).toBe('/bin');
    }
  });

  it('backend available ⇒ spawn-jailed with wrapped argv + sanitized env', () => {
    setJailBackendForTests(stubAvailable);
    const d = decideJailSpawn(spec, {
      program: 'sh',
      argv: ['-c', 'echo hi'],
      env: canaryEnv,
      envExtras: { CI: '1' },
      mode: 'required',
    });
    expect(d.action).toBe('spawn-jailed');
    if (d.action === 'spawn-jailed') {
      expect(d.program).toBe('sh');
      expect(d.argv).toEqual(['-c', 'echo hi']); // stub wrap is a pass-through
      expect(d.env.ZELARI_JAIL_CANARY).toBeUndefined();
      expect(d.env.CI).toBe('1');
      expect(d.probe.backend).toBe('stub');
    }
  });

  it('networkSpecFromClaimHosts: no allowed hosts ⇒ deny; allowed ⇒ allow-list (deduped)', () => {
    expect(networkSpecFromClaimHosts(undefined)).toEqual({ mode: 'deny' });
    expect(networkSpecFromClaimHosts([])).toEqual({ mode: 'deny' });
    expect(networkSpecFromClaimHosts(['api.example.com', 'api.example.com'])).toEqual({
      mode: 'allow-list',
      hosts: ['api.example.com'],
    });
  });
});

describe('darwin backend (pure code paths)', () => {
  it('probe: darwin + sandbox-exec present ⇒ available; missing binary/platform ⇒ unavailable', () => {
    expect(darwinProbe('darwin', (p) => p === SANDBOX_EXEC_PATH).available).toBe(true);
    const missing = darwinProbe('darwin', () => false);
    expect(missing.available).toBe(false);
    expect(missing.reason).toContain(SANDBOX_EXEC_PATH);
    expect(darwinProbe('win32', () => true).available).toBe(false);
  });

  it('profile: deny writes outside writable roots; network follows the spec (limitation stated)', () => {
    const s = buildJailSpec({ root: '/ws', network: { mode: 'deny' }, writable: ['/ws', '/tmp'] });
    const denyProfile = buildSeatbeltProfile(s);
    expect(denyProfile).toContain('(deny file-write*)');
    expect(denyProfile).toContain('(subpath "/ws")');
    expect(denyProfile).toContain('(subpath "/tmp")');
    expect(denyProfile).toContain('(deny network*)');
    const allowList = buildSeatbeltProfile({ ...s, network: { mode: 'allow-list', hosts: ['api.example.com'] } });
    expect(allowList).toContain('NOT kernel-filtered');
    expect(allowList).toContain('(allow network*)');
  });

  it('wrap prefixes [sandbox-exec, -p, profile] and keeps the child argv intact', () => {
    const s = buildJailSpec({ root: '/ws' });
    const wrapped = darwinBackend.wrap(s, 'sh', ['-c', 'ls']); // pure argv/profile builder
    expect(wrapped.program).toBe(SANDBOX_EXEC_PATH);
    expect(wrapped.argv[0]).toBe('-p');
    expect(wrapped.argv[1]).toBe(buildSeatbeltProfile(s));
    expect(wrapped.argv.slice(-3)).toEqual(['sh', '-c', 'ls']);
  });
});

describe('linux backend (pure code paths)', () => {
  it('probe: linux + bwrap on PATH ⇒ available; missing ⇒ unavailable with the landlock note', () => {
    const ok = linuxProbe('linux', '/usr/bin:/bin', (p) => p === '/usr/bin/bwrap');
    expect(ok.available).toBe(true);
    const missing = linuxProbe('linux', '/usr/bin:/bin', () => false);
    expect(missing.available).toBe(false);
    expect(missing.reason).toMatch(/bwrap.*not found|landlock/);
    expect(linuxProbe('darwin', '/usr/bin', () => true).available).toBe(false);
  });

  it('findBinaryOnPath scans PATH dirs and returns null when absent', () => {
    expect(findBinaryOnPath('bwrap', '/a:/b', (p) => p === '/b/bwrap')).toBe('/b/bwrap');
    expect(findBinaryOnPath('bwrap', '/a:/b', () => false)).toBeNull();
  });

  it('args: ro-bind /, bind-try writables, --unshare-net on deny, child argv after --', () => {
    const s = buildJailSpec({ root: '/ws', network: { mode: 'deny' }, writable: ['/ws', '/nope-tmp'] });
    const args = buildBwrapArgs(s, 'sh', ['-c', 'ls']);
    expect(args.slice(0, 2)).toEqual(['--ro-bind', '/']);
    expect(args).toContain('--unshare-net');
    expect(args).toContain('--bind-try');
    const sep = args.indexOf('--');
    expect(args.slice(sep + 1)).toEqual(['sh', '-c', 'ls']);
    // allow/allow-list degrades WITHOUT fake flags (all-or-nothing namespaces).
    const allowArgs = buildBwrapArgs({ ...s, network: { mode: 'allow-list', hosts: ['h'] } }, 'sh', []);
    expect(allowArgs).not.toContain('--unshare-net');
    // the backend wraps with the launcher binary it probed for.
    expect(linuxBackend.wrap(s, 'sh', ['-c', 'ls']).program).toBe('bwrap');
  });
});

describe('win32 backend — HONEST unavailable (no fake containment)', () => {
  it('probe is ALWAYS unavailable on win32 and on any other platform', () => {
    expect(win32Probe('win32').available).toBe(false);
    expect(win32Probe('win32').reason).toMatch(/native|Node/i);
    expect(win32Probe('linux').available).toBe(false);
    // the exported backend agrees — this is what makes required⇒DENY on Windows
    setJailBackendForTests(null);
    expect(win32Backend.probe().available).toBe(false);
  });

  it('wrap throws instead of pretending to jail', () => {
    expect(() => win32Backend.wrap(spec, 'sh', [])).toThrow(/unavailable/);
  });
});
