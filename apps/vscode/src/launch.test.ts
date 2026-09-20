import { describe, expect, it } from 'vitest';
import { resolveLaunchSpec } from './launch.js';

describe('launch — what the extension starts', () => {
  it('defaults to `zelari-code acp` (no shell) off Windows', () => {
    expect(resolveLaunchSpec({}, 'linux')).toEqual({
      ok: true,
      source: 'command',
      program: 'zelari-code',
      args: ['acp'],
      useShell: false,
    });
  });

  it('uses a shell on Windows only: a bare `zelari-code` is the .cmd shim', () => {
    const resolved = resolveLaunchSpec({}, 'win32');
    expect(resolved).toMatchObject({ ok: true, program: 'zelari-code', useShell: true });
  });

  it('an empty/blank command means "the default", not "an empty program"', () => {
    expect(resolveLaunchSpec({ command: '   ' }, 'win32')).toMatchObject({
      ok: true,
      program: 'zelari-code',
    });
    expect(resolveLaunchSpec({ command: '', args: ['acp', '--cwd', 'x'] }, 'linux')).toMatchObject({
      ok: true,
      program: 'zelari-code',
      args: ['acp', '--cwd', 'x'],
    });
  });

  it('cliPath wins over command and runs `<nodePath> <cliPath> <args>` with no shell', () => {
    const resolved = resolveLaunchSpec(
      { cliPath: 'C:\\work\\zelari-code\\bin\\zelari-code.js', command: 'ignored' },
      'win32',
    );
    expect(resolved).toEqual({
      ok: true,
      source: 'cliPath',
      program: 'node',
      args: ['C:\\work\\zelari-code\\bin\\zelari-code.js', 'acp'],
      useShell: false,
    });
  });

  it('honours a custom nodePath and extra args in the cliPath form', () => {
    expect(resolveLaunchSpec({ cliPath: '/srv/zelari/bin/zelari-code.js', nodePath: '/opt/node', args: ['acp', '--model', 'gpt-x'] }, 'linux')).toEqual({
      ok: true,
      source: 'cliPath',
      program: '/opt/node',
      args: ['/srv/zelari/bin/zelari-code.js', 'acp', '--model', 'gpt-x'],
      useShell: false,
    });
  });

  it('accepts shell metacharacters in cliPath: no shell means they are just characters', () => {
    const tricky = 'C:\\dev\\my (old) & new\\bin\\zelari-code.js';
    expect(resolveLaunchSpec({ cliPath: tricky }, 'win32')).toMatchObject({
      ok: true,
      program: 'node',
      args: [tricky, 'acp'],
      useShell: false,
    });
  });

  it('passed args are echoed verbatim off Windows (no shell to re-interpret them)', () => {
    const resolved = resolveLaunchSpec({ command: 'node', args: ['/opt/cli.js', 'acp'] }, 'linux');
    expect(resolved).toMatchObject({ ok: true, program: 'node', args: ['/opt/cli.js', 'acp'], useShell: false });
  });

  it('refuses a Windows command carrying shell metacharacters instead of handing it to cmd.exe', () => {
    const resolved = resolveLaunchSpec({ command: 'zelari-code & calc' }, 'win32');
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.reason).toContain('&');
    expect(resolved.reason).toContain('zelari.cliPath');
  });

  it('refuses the same metacharacters in Windows args (they would be re-interpreted too)', () => {
    const resolved = resolveLaunchSpec({ args: ['acp', '--cwd', 'C:\\x|y'] }, 'win32');
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.reason).toContain('|');
  });

  it('off Windows the same strings are allowed (nothing interprets them)', () => {
    expect(resolveLaunchSpec({ command: 'zelari-code & calc' }, 'linux')).toMatchObject({
      ok: true,
      program: 'zelari-code & calc',
      useShell: false,
    });
  });
});
