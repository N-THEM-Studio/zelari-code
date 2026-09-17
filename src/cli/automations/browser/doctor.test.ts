/**
 * doctor.test.ts — pure parsing/classification + seam-injected runDoctor.
 * Never launches Chromium and never touches real processes.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  matchProfileProcesses,
  parsePsOutput,
  parseWindowsJson,
  runDoctor,
} from './doctor.js';

describe('parsePsOutput', () => {
  it('parses pid + command lines and skips junk', () => {
    const raw = ['  123 /usr/lib/chrome --user-data-dir=/home/u/.zelari-code/browser-profiles/x', 'garbage line', '  456 ps -eo'].join(
      '\n',
    );
    expect(parsePsOutput(raw)).toEqual([
      { pid: 123, cmd: '/usr/lib/chrome --user-data-dir=/home/u/.zelari-code/browser-profiles/x' },
      { pid: 456, cmd: 'ps -eo' },
    ]);
  });
});

describe('parseWindowsJson', () => {
  it('tolerates empty, single object, and array payloads', () => {
    expect(parseWindowsJson('')).toEqual([]);
    expect(parseWindowsJson('{"ProcessId":1,"CommandLine":"x"}')).toEqual([{ pid: 1, cmd: 'x' }]);
    expect(parseWindowsJson('[{"ProcessId":1,"CommandLine":"a"},{"ProcessId":2,"CommandLine":"b"}]')).toEqual([
      { pid: 1, cmd: 'a' },
      { pid: 2, cmd: 'b' },
    ]);
  });
});

describe('matchProfileProcesses', () => {
  it('keeps only OUR profile pids and extracts the channel', () => {
    const ours = { pid: 10, cmd: 'chrome --user-data-dir=C:\\u\\.zelari-code\\browser-profiles\\facebook' };
    const personal = { pid: 11, cmd: 'chrome --user-data-dir=C:\\Users\\me\\AppData\\Chrome' };
    const [m] = matchProfileProcesses([ours, personal]);
    expect(m).toBeDefined();
    expect(m.pid).toBe(10);
    expect(m.channel).toBe('facebook');
    expect(matchProfileProcesses([personal])).toEqual([]);
  });

  it('never matches a command line without the .zelari-code marker', () => {
    expect(matchProfileProcesses([{ pid: 1, cmd: 'chrome browser-profiles/x' }])).toEqual([]);
  });
});

describe('runDoctor (seams injected)', () => {
  const noProcs = vi.fn(async () => ({ stdout: '[]' }));

  it('is ok when the environment is healthy and no profile is locked', async () => {
    const r = await runDoctor({ run: noProcs, now: () => '2026-01-01T00:00:00.000Z' });
    expect(r.ok).toBe(true);
    expect(r.processes).toEqual([]);
    expect(r.checks.some((c) => c.id === 'playwright' && c.status === 'ok')).toBe(true);
  });

  it('reports zombie profile holders as a warning with the --kill remedy', async () => {
    const run = vi.fn(async () => ({
      stdout: JSON.stringify([{ ProcessId: 77, CommandLine: 'chrome --user-data-dir=C:\\u\\.zelari-code\\browser-profiles\\x' }]),
    }));
    const r = await runDoctor({ run, now: () => '2026-01-01T00:00:00.000Z' });
    expect(r.ok).toBe(true); // warning, not failure
    expect(r.processes.map((p) => p.pid)).toEqual([77]);
    expect(r.checks.some((c) => c.id === 'profile-lock' && c.detail.includes('--kill'))).toBe(true);
  });

  it('--kill terminates ONLY the matched profile pids', async () => {
    const run = vi.fn(async () => ({
      stdout: JSON.stringify([
        { ProcessId: 77, CommandLine: 'chrome --user-data-dir=C:\\u\\.zelari-code\\browser-profiles\\x' },
        { ProcessId: 99, CommandLine: 'chrome --user-data-dir=C:\\Users\\me\\personal' },
      ]),
    }));
    const killer = vi.fn(async () => undefined);
    const r = await runDoctor({ run, killer, kill: true, now: () => '2026-01-01T00:00:00.000Z' });
    expect(killer).toHaveBeenCalledTimes(1);
    expect(killer).toHaveBeenCalledWith(77);
    expect(r.killed).toEqual([77]);
  });

  it('--sessions surfaces the cookie login state per channel', async () => {
    const sessions = vi.fn(async (ch: string) => ({ loggedIn: ch === 'facebook' }));
    const r = await runDoctor({ run: noProcs, withSessions: true, sessions, now: () => '2026-01-01T00:00:00.000Z' });
    const fb = r.checks.find((c) => c.id === 'session:facebook');
    const x = r.checks.find((c) => c.id === 'session:x');
    expect(fb?.status).toBe('ok');
    expect(x?.status).toBe('warn');
    expect(x?.detail).toBe('relogin_required');
  });
});
