import { describe, expect, it } from 'vitest';
import { resolveWindowsProgram, type WindowsProgramDeps } from './windowsProgram.js';

const NODE = 'C:\\Program Files\\nodejs\\node.exe';
const NPM_CLI = 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js';
const NPX_CLI = 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npx-cli.js';

function deps(files: string[], over: Partial<WindowsProgramDeps> = {}): WindowsProgramDeps {
  const set = new Set(files.map((f) => f.toLowerCase()));
  return {
    platform: 'win32',
    env: { PATH: 'C:\\Program Files\\nodejs;C:\\tools', PATHEXT: '.COM;.EXE;.BAT;.CMD' },
    execPath: NODE,
    exists: (p) => set.has(p.toLowerCase()),
    ...over,
  };
}

describe('resolveWindowsProgram', () => {
  it('runs npm and npx through node + their CLI script, argv preserved', () => {
    const d = deps([NPM_CLI, NPX_CLI]);
    expect(resolveWindowsProgram('npm', ['test', '--', '-t', 'x'], d)).toEqual({
      kind: 'node-script',
      program: NODE,
      argv: [NPM_CLI, 'test', '--', '-t', 'x'],
    });
    expect(resolveWindowsProgram('npx.cmd', ['vitest', 'run'], d)).toEqual({
      kind: 'node-script',
      program: NODE,
      argv: [NPX_CLI, 'vitest', 'run'],
    });
  });

  it('finds npm next to a PATH shim when it is not beside node.exe', () => {
    const cli = 'C:\\nvm\\v20\\node_modules\\npm\\bin\\npm-cli.js';
    const d = deps([cli, 'C:\\nvm\\v20\\npm.cmd'], {
      env: { PATH: 'C:\\nvm\\v20', PATHEXT: '.COM;.EXE;.BAT;.CMD' },
    });
    expect(resolveWindowsProgram('npm', ['ci'], d)).toMatchObject({ kind: 'node-script', argv: [cli, 'ci'] });
  });

  it('refuses other .cmd shims up front (named or found on PATH)', () => {
    const d = deps(['C:\\tools\\tsc.cmd']);
    expect(resolveWindowsProgram('tsc', ['--noEmit'], d)).toEqual({ kind: 'shim', path: 'C:\\tools\\tsc.cmd' });
    expect(resolveWindowsProgram('build.bat', [], d)).toEqual({ kind: 'shim', path: 'build.bat' });
  });

  it('spawns real executables directly, and everything directly off Windows', () => {
    expect(resolveWindowsProgram('git', ['status'], deps(['C:\\tools\\git.exe']))).toEqual({ kind: 'direct' });
    expect(resolveWindowsProgram('npm', ['test'], deps([], { platform: 'linux' }))).toEqual({ kind: 'direct' });
  });
});
