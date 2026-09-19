/**
 * statuslineCustom.test.ts — t114: the `custom` status-line item runs a USER
 * SCRIPT with a fixed protocol and must NEVER be able to break the TUI.
 *
 * Red-if-reopens: the script is spawned directly (no `shell: true` + args) with
 * the documented JSON payload on stdin; output is reduced to ONE line, ANSI/OSC
 * escapes stripped, capped at 120 chars; a hang is killed after the configured
 * timeout (1500 ms by default → asserted behaviorally, not just as a constant);
 * non-zero exit / empty output / missing binary all resolve to `null` (= item
 * hidden) instead of throwing, hanging or leaking a partial chip.
 *
 * The scripts are `node -e` programs injected through the `invocation` test
 * seam, so the suite is shell-free and identical on win32 / linux / darwin.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { STATUSLINE_MAX_TEXT_CHARS } from './statuslineConfig.js';
import {
  customItemPayload,
  normalizeStatusLineText,
  previewStatusLineCustomItem,
  runStatusLineCustomItem,
  shellInvocation,
  type ShellInvocation,
} from './statuslineCustom.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'zelari-statusline-custom-'));
});

afterEach(() => {
  // A killed child can still hold `dir` as its cwd for a few ms (Windows
  // refuses to delete it → EPERM/EBUSY): retry instead of failing a green test.
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

/** The test seam: run the script with THIS node, no shell, no quoting. */
const viaNode = (src: string): ShellInvocation => ({ program: process.execPath, args: ['-e', src] });

const ECHO_STDIN = [
  'let d="";',
  'process.stdin.setEncoding("utf8");',
  'process.stdin.on("data",(c)=>{d+=c;});',
  'process.stdin.on("end",()=>{const p=JSON.parse(d);',
  'process.stdout.write("model="+p.model+" todos="+p.pendingTodos+" sid="+p.sessionId+" turn="+p.turn+" cwd="+p.cwd);});',
].join('');

describe('normalizeStatusLineText — what may reach the bar (t114)', () => {
  it('keeps the FIRST line only and strips ANSI/OSC escapes', () => {
    expect(normalizeStatusLineText('\u001b[31mred\u001b[0m ok\u001b]0;title\u0007\u001b[2K\nsecond line')).toBe('red ok');
    expect(normalizeStatusLineText('one\ntwo')).toBe('one');
  });

  it('clamps to 120 chars and trims trailing whitespace', () => {
    const long = normalizeStatusLineText('x'.repeat(500));
    expect(long).toHaveLength(STATUSLINE_MAX_TEXT_CHARS);
    expect(STATUSLINE_MAX_TEXT_CHARS).toBe(120);
    expect(normalizeStatusLineText('spaced   \n')).toBe('spaced');
  });

  it('is null for unusable input (never an empty chip)', () => {
    for (const raw of [null, undefined, '', '   ', '\n\n', '\u001b[31m\u001b[0m']) {
      expect(normalizeStatusLineText(raw)).toBeNull();
    }
  });
});

describe('runStatusLineCustomItem — the script protocol (t114)', () => {
  it('hands the JSON payload to the script on stdin and shows its first line', async () => {
    const text = await runStatusLineCustomItem({
      command: 'ignored (invocation injected)',
      invocation: viaNode(ECHO_STDIN),
      cwd: dir,
      payload: { model: 'grok-4.5', sessionId: 's-1', turn: 7, pendingTodos: 3 },
    });
    expect(text).toBe(`model=grok-4.5 todos=3 sid=s-1 turn=7 cwd=${dir}`);
  });

  it('fills every documented payload field even when the caller passes none', () => {
    expect(customItemPayload()).toEqual({
      cwd: process.cwd(),
      model: '',
      sessionId: '',
      turn: 0,
      pendingTodos: 0,
    });
  });

  it('strips escapes and takes the first line of a real script', async () => {
    const src = 'process.stdout.write("\\u001b[32mgreen\\u001b[0m\\u001b]0;t\\u0007\\nIGNORED");';
    expect(await runStatusLineCustomItem({ command: 'x', invocation: viaNode(src), cwd: dir })).toBe('green');
  });

  it('truncates to 120 chars and hides an empty/whitespace-only output', async () => {
    const long = await runStatusLineCustomItem({
      command: 'x',
      invocation: viaNode('process.stdout.write("y".repeat(300));'),
      cwd: dir,
    });
    expect(long).toBe('y'.repeat(STATUSLINE_MAX_TEXT_CHARS));
    expect(await runStatusLineCustomItem({ command: 'x', invocation: viaNode(''), cwd: dir })).toBeNull();
  });

  it('a script that never reads stdin does not surface EPIPE as a failure', async () => {
    expect(
      await runStatusLineCustomItem({ command: 'x', invocation: viaNode('process.stdout.write("ok");'), cwd: dir }),
    ).toBe('ok');
  });

  it('hides the item on a non-zero exit (fail-soft, no throw)', async () => {
    const src = 'process.stdout.write("this must not show"); process.exit(1);';
    expect(await runStatusLineCustomItem({ command: 'x', invocation: viaNode(src), cwd: dir })).toBeNull();
  });

  it('kills a hanging script after the configured timeout', async () => {
    const started = Date.now();
    // NOTE: no `cwd: dir` here — a killed child would keep the temp dir as its
    // cwd for a few ms and Windows refuses to delete it in afterEach.
    const text = await runStatusLineCustomItem({
      command: 'x',
      invocation: viaNode('setTimeout(()=>{},10000);'),
      timeoutMs: 300,
    });
    const elapsed = Date.now() - started;
    expect(text).toBeNull();
    expect(elapsed).toBeGreaterThanOrEqual(200);
    expect(elapsed).toBeLessThan(1500); // killed, not awaited to completion
  });

  it('applies the 1500 ms DEFAULT timeout when the caller sets none', async () => {
    const started = Date.now();
    const text = await runStatusLineCustomItem({
      command: 'x',
      invocation: viaNode('setTimeout(()=>{},60000);'),
    });
    const elapsed = Date.now() - started;
    expect(text).toBeNull();
    expect(elapsed).toBeGreaterThanOrEqual(1400);
    expect(elapsed).toBeLessThan(2500); // fired at ~1.5s, NOT the 60s the script asked for
  });

  it('hides the item when the binary does not exist (spawn error, no rejection)', async () => {
    const invocation: ShellInvocation = { program: path.join(dir, 'no-such-binary'), args: [] };
    await expect(runStatusLineCustomItem({ command: 'x', invocation, cwd: dir })).resolves.toBeNull();
  });
});

describe('previewStatusLineCustomItem — the SYNC probe used by /statusline (t114)', () => {
  it('runs the same protocol and returns the same first line', () => {
    expect(
      previewStatusLineCustomItem({
        command: 'x',
        invocation: viaNode(ECHO_STDIN),
        cwd: dir,
        payload: { model: 'm', sessionId: 's', turn: 1, pendingTodos: 0 },
      }),
    ).toBe(`model=m todos=0 sid=s turn=1 cwd=${dir}`);
  });

  it('is null on timeout, non-zero exit and missing binary (never throws)', () => {
    const opts = { command: 'x', cwd: dir };
    expect(previewStatusLineCustomItem({ ...opts, invocation: viaNode('setTimeout(()=>{},10000);'), timeoutMs: 300 })).toBeNull();
    expect(previewStatusLineCustomItem({ ...opts, invocation: viaNode('process.exit(2);') })).toBeNull();
    expect(previewStatusLineCustomItem({ ...opts, invocation: { program: path.join(dir, 'nope'), args: [] } })).toBeNull();
  });
});

describe('shellInvocation — resolved shell, explicit argv (t114)', () => {
  it('always returns a program plus the command as one argv element (never shell:true)', () => {
    const command = 'echo zelari-statusline';
    const invocation = shellInvocation(command);
    expect(invocation.program.length).toBeGreaterThan(0);
    expect(invocation.args.length).toBeGreaterThan(0);
    expect(invocation.args[invocation.args.length - 1]).toBe(command);
  });
});
