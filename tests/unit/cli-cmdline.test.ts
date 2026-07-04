/**
 * cli-cmdline.test.ts — win32 command-line quoting helpers (v0.7.9).
 *
 * These exist because Node 24 deprecated `spawn(cmd, args, { shell: true })`
 * (DEP0190): call sites that still need a shell on Windows (npm/npx/uvx .cmd
 * shims) now build a single pre-quoted command string instead.
 */
import { describe, it, expect } from 'vitest';
import { quoteCmdArg, buildCmdLine } from '../../src/cli/utils/cmdline.js';

describe('quoteCmdArg', () => {
  it('passes plain tokens through unquoted', () => {
    expect(quoteCmdArg('install')).toBe('install');
    expect(quoteCmdArg('-g')).toBe('-g');
    expect(quoteCmdArg('zelari-code@latest')).toBe('zelari-code@latest');
  });

  it('quotes whitespace and cmd metacharacters', () => {
    expect(quoteCmdArg('C:\\Program Files\\x')).toBe('"C:\\Program Files\\x"');
    expect(quoteCmdArg('a&b')).toBe('"a&b"');
    expect(quoteCmdArg('a|b')).toBe('"a|b"');
    expect(quoteCmdArg('a>b')).toBe('"a>b"');
  });

  it('doubles embedded quotes and handles the empty string', () => {
    expect(quoteCmdArg('say "hi"')).toBe('"say ""hi"""');
    expect(quoteCmdArg('')).toBe('""');
  });
});

describe('buildCmdLine', () => {
  it('joins command and args with per-token quoting', () => {
    expect(buildCmdLine('npm', ['install', '-g', 'zelari-code@latest'])).toBe(
      'npm install -g zelari-code@latest',
    );
    expect(buildCmdLine('npx', ['-y', 'some server'])).toBe('npx -y "some server"');
  });

  it('quotes a command path containing spaces', () => {
    expect(buildCmdLine('C:\\My Tools\\srv.cmd', ['--port', '1234'])).toBe(
      '"C:\\My Tools\\srv.cmd" --port 1234',
    );
  });
});
