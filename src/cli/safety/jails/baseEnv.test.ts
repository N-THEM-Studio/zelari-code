/**
 * baseEnv.test.ts — t116 (sandbox hardening): the jailed child's environment
 * is built DENY-FIRST from a minimal allowlist, with one explicit escape
 * hatch (`ZELARI_JAIL_FULL_ENV=1`).
 *
 * Red-if-reopens: the canary assertions fail the moment an unlisted variable
 * (a token, a cloud credential, any ZELARI_* secret) starts leaking into a
 * jailed child, and the escape-hatch test fails if the opt-in stops working.
 */
import { describe, it, expect } from 'vitest';
import {
  BASE_JAIL_ENV_KEYS,
  JAIL_FULL_ENV_ENV,
  baseJailEnv,
  baseJailEnvKeys,
  jailFullEnvRequested,
  pathEntries,
} from './baseEnv.js';

const CANARY = 'ZELARI_JAIL_CANARY';

describe('baseJailEnv — deny-first allowlist (t116)', () => {
  it('keeps the boot-critical variables and drops everything else', () => {
    const env: NodeJS.ProcessEnv = {
      PATH: '/usr/bin',
      HOME: '/home/u',
      USER: 'u',
      LANG: 'it_IT.UTF-8',
      LC_ALL: 'it_IT.UTF-8',
      LC_MESSAGES: 'it_IT.UTF-8',
      TERM: 'xterm-256color',
      TMPDIR: '/tmp',
      CI: '1',
      NO_COLOR: '1',
      [CANARY]: 'leak-me',
      SECRET_TOKEN: 'leak-me',
      AWS_SECRET_ACCESS_KEY: 'leak-me',
      ZELARI_SESSIONS_DIR: '/somewhere',
    };
    const out = baseJailEnv(env, { platform: 'linux' });
    for (const k of ['PATH', 'HOME', 'USER', 'LANG', 'LC_ALL', 'LC_MESSAGES', 'TERM', 'TMPDIR', 'CI', 'NO_COLOR']) {
      expect(out[k]).toBe(env[k]);
    }
    for (const k of [CANARY, 'SECRET_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'ZELARI_SESSIONS_DIR']) {
      expect(out[k]).toBeUndefined();
    }
    // never a partial copy of the input key set
    expect(Object.keys(out).sort()).toEqual(
      ['CI', 'HOME', 'LANG', 'LC_ALL', 'LC_MESSAGES', 'NO_COLOR', 'PATH', 'TERM', 'TMPDIR', 'USER'],
    );
  });

  it('win32 adds the boot-critical keys (case-insensitively) and POSIX drops them', () => {
    const env: NodeJS.ProcessEnv = {
      Path: 'C:\\bin',
      SystemRoot: 'C:\\Windows',
      ComSpec: 'C:\\Windows\\system32\\cmd.exe',
      PATHEXT: '.COM;.EXE',
      USERNAME: 'andre',
      SystemDrive: 'C:',
      WINDIR: 'C:\\Windows',
      [CANARY]: 'leak-me',
    };
    const win = baseJailEnv(env, { platform: 'win32' });
    // original casing preserved, canary still dropped
    expect(win.Path).toBe('C:\\bin');
    expect(win.SystemRoot).toBe('C:\\Windows');
    expect(win.ComSpec).toBe(env.ComSpec);
    expect(win.USERNAME).toBe('andre');
    expect(win.PATHEXT).toBe('.COM;.EXE');
    expect(win[CANARY]).toBeUndefined();
    // POSIX semantics are case-SENSITIVE: 'Path'/'SystemRoot' are not PATH/HOME
    const linux = baseJailEnv(env, { platform: 'linux' });
    expect(linux.Path).toBeUndefined();
    expect(linux.SystemRoot).toBeUndefined();
  });

  it('undefined values never materialize and the input env is never mutated', () => {
    const env: NodeJS.ProcessEnv = { PATH: '/bin', HOME: undefined, [CANARY]: 'x' };
    const out = baseJailEnv(env, { platform: 'linux' });
    expect(out).toEqual({ PATH: '/bin' });
    expect(env[CANARY]).toBe('x'); // input untouched
  });

  it('ZELARI_JAIL_FULL_ENV=1 is the ONLY escape hatch: full copy, explicit opt-in', () => {
    const env: NodeJS.ProcessEnv = { PATH: '/bin', [CANARY]: 'leak-me', TOKEN: 't', [JAIL_FULL_ENV_ENV]: '1' };
    expect(jailFullEnvRequested(env)).toBe(true);
    expect(baseJailEnv(env, { platform: 'linux' })).toEqual(env);
    // a typo never widens the jail
    expect(jailFullEnvRequested({ [JAIL_FULL_ENV_ENV]: 'true' })).toBe(false);
    expect(jailFullEnvRequested({ [JAIL_FULL_ENV_ENV]: '0' })).toBe(false);
    // full:true is the programmatic form (used by tests + future surfaces)
    expect(baseJailEnv({ OTHER: 'x' }, { platform: 'linux', full: true })).toEqual({ OTHER: 'x' });
  });

  it('the exported allowlists name every documented key', () => {
    for (const k of ['PATH', 'HOME', 'TERM', 'TMPDIR', 'TEMP']) {
      expect(BASE_JAIL_ENV_KEYS).toContain(k);
    }
    for (const k of ['SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'USERNAME', 'USERDOMAIN', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'SYSTEMDRIVE', 'WINDIR']) {
      expect(baseJailEnvKeys('win32')).toContain(k);
      expect(baseJailEnvKeys('linux')).not.toContain(k);
    }
  });
});

describe('pathEntries — platform delimiter, no drive-letter mangling', () => {
  it('uses ; on win32 and : elsewhere, dropping empty entries', () => {
    expect(pathEntries('C:\\bin;D:\\tools', 'win32')).toEqual(['C:\\bin', 'D:\\tools']);
    expect(pathEntries('/usr/bin::/bin', 'linux')).toEqual(['/usr/bin', '/bin']);
    expect(pathEntries(undefined, 'linux')).toEqual([]);
  });
});
