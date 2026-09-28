import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProviderDelta } from '@zelari/core/harness';
import { createLocalCliProvider } from '../../src/cli/provider/localCli/claudeProvider.js';
import {
  messagesForClaudeTurn,
  peekClaudeCodeSession,
  resetClaudeCodeSessionsForTests,
} from '../../src/cli/provider/localCli/claudeSession.js';
import {
  cliJsFromShim,
  resolveClaudeExecutable,
} from '../../src/cli/provider/localCli/resolveClaudeExecutable.js';
import { createClaudeStreamParser } from '../../src/cli/provider/localCli/claudeStreamJson.js';

afterEach(() => {
  resetClaudeCodeSessionsForTests();
});

describe('resolveClaudeExecutable', () => {
  it('returns a win32 .exe without unwrapping', () => {
    const exe = 'C:\\npm\\claude.EXE';
    const resolved = resolveClaudeExecutable('claude', {
      platform: 'win32',
      env: { PATH: 'C:\\npm', PATHEXT: '.EXE;.CMD' },
      isExecutable: (candidate) => candidate === exe,
      execPath: 'C:\\node\\node.exe',
    });
    expect(resolved).toEqual({
      ok: true,
      program: exe,
      argvPrefix: [],
      resolvedPath: exe,
    });
  });

  it('unwraps claude.cmd to node + the sibling cli.js and never returns the shim', () => {
    const shim = 'C:\\npm\\claude.CMD';
    const cli = 'C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js';
    const node = 'C:\\npm\\node.exe';
    const resolved = resolveClaudeExecutable('claude', {
      platform: 'win32',
      env: { PATH: 'C:\\npm', PATHEXT: '.CMD' },
      isExecutable: (candidate) => candidate === shim || candidate === 'C:\\npm\\claude.cmd',
      exists: (candidate) => candidate === cli || candidate === node,
      execPath: 'C:\\node\\node.exe',
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.program).toBe(node);
    expect(resolved.argvPrefix).toEqual([cli]);
    expect(resolved.program.toLowerCase().endsWith('.cmd')).toBe(false);
  });

  it('reads a shim that points at cli.js outside the npm sibling layout', () => {
    const shim = 'C:\\npm\\claude.cmd';
    const cli = 'C:\\tools\\claude-code\\cli.js';
    const resolved = resolveClaudeExecutable(shim, {
      platform: 'win32',
      isExecutable: (candidate) => candidate === shim,
      exists: (candidate) => candidate === cli,
      readFile: () => `node "${cli}" %*\r\n`,
      execPath: 'C:\\node\\node.exe',
    });
    expect(resolved).toMatchObject({ ok: true, program: 'C:\\node\\node.exe', argvPrefix: [cli] });
  });

  it('refuses a shim it cannot unwrap instead of spawning it', () => {
    const shim = 'C:\\npm\\claude.cmd';
    const resolved = resolveClaudeExecutable(shim, {
      platform: 'win32',
      isExecutable: () => true,
      exists: () => false,
      readFile: () => '@echo off\r\n',
    });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.reason).toContain('no shell');
  });

  it('reports a missing binary without throwing', () => {
    const resolved = resolveClaudeExecutable('claude', {
      platform: 'linux',
      env: { PATH: '/usr/bin' },
      isExecutable: () => false,
    });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.reason).toContain('was not found');
    expect(resolved.reason).toContain('auth login');
  });
});

describe('cliJsFromShim', () => {
  it('expands %dp0% to the shim directory', () => {
    const text = '"%_prog%" "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*';
    expect(cliJsFromShim(text, 'C:\\npm', 'win32')).toBe(
      'C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js',
    );
  });
});

describe('messagesForClaudeTurn', () => {
  it('sends the full transcript on the first turn and only new user input after', () => {
    const first = [
      { role: 'system' as const, content: 'sys' },
      { role: 'user' as const, content: 'hi' },
    ];
    expect(messagesForClaudeTurn(first, 0)).toEqual(first);
    const second = [
      ...first,
      { role: 'assistant' as const, content: 'hello' },
      { role: 'user' as const, content: 'again' },
    ];
    expect(messagesForClaudeTurn(second, first.length)).toEqual([
      { role: 'user', content: 'again' },
    ]);
  });
});

describe('createClaudeStreamParser session id', () => {
  it('captures session_id without emitting a delta, and names cache hits cachedPromptTokens', () => {
    const parser = createClaudeStreamParser();
    expect(parser.push('{"type":"system","subtype":"init","session_id":"s1"}')).toEqual([]);
    expect(parser.sessionId).toBe('s1');
    const deltas = parser.push(
      '{"type":"result","result":"x","usage":{"input_tokens":3,"output_tokens":1,"cache_read_input_tokens":2}}',
    );
    expect(deltas).toContainEqual({
      kind: 'usage',
      usage: { promptTokens: 3, completionTokens: 1, totalTokens: 4, cachedPromptTokens: 2 },
    });
  });
});

function writeSessionCli(): { dir: string; script: string; record: string } {
  const dir = mkdtempSync(join(tmpdir(), 'zelari-claude-session-'));
  const record = join(dir, 'turns.jsonl');
  const script = join(dir, 'fake-cli.cjs');
  writeFileSync(
    script,
    [
      "const fs = require('node:fs');",
      'let buf = "";',
      "process.stdin.on('data', (c) => { buf += c; });",
      "process.stdin.on('end', () => {",
      '  fs.appendFileSync(process.env.RECORD_PATH, JSON.stringify({ argv: process.argv.slice(2), stdin: buf }) + "\\n");',
      '  const lines = [',
      '    JSON.stringify({ type: "system", subtype: "init", session_id: "sess-1" }),',
      '    JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "ok" } } }),',
      '    JSON.stringify({ type: "result", result: "ok", is_error: false, session_id: "sess-1", usage: { input_tokens: 1, output_tokens: 1 } }),',
      '  ];',
      "  process.stdout.write(lines.join('\\n') + '\\n');",
      '});',
    ].join('\n'),
  );
  return { dir, script, record };
}

describe('createLocalCliProvider long session', () => {
  it('resumes the official session and does not replay the first turn', async () => {
    const { dir, script, record } = writeSessionCli();
    try {
      const provider = createLocalCliProvider({
        cli: 'claude',
        phase: 'plan',
        spawnFn: spawn,
        env: { ...process.env, RECORD_PATH: record },
        resolveCli: () => ({
          ok: true,
          program: process.execPath,
          argvPrefix: [script],
          resolvedPath: script,
        }),
      });
      const first = [
        { role: 'system' as const, content: 'You are Zelari.' },
        { role: 'user' as const, content: 'hi' },
      ];
      const deltas: ProviderDelta[] = [];
      for await (const delta of provider({
        messages: first,
        model: 'sonnet',
        provider: 'local-cli',
        tools: [],
        conversationId: 'conv-1',
      })) {
        deltas.push(delta);
      }
      expect(deltas.some((delta) => delta.kind === 'text')).toBe(true);
      expect(peekClaudeCodeSession('conv-1')?.claudeSessionId).toBe('sess-1');

      const second = [
        ...first,
        { role: 'assistant' as const, content: 'ok' },
        { role: 'user' as const, content: 'continue' },
      ];
      for await (const _delta of provider({
        messages: second,
        model: 'sonnet',
        provider: 'local-cli',
        tools: [],
        conversationId: 'conv-1',
      })) {
        // drain
      }

      const turns = readFileSync(record, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as {
        argv: string[];
        stdin: string;
      });
      expect(turns).toHaveLength(2);
      expect(turns[0]!.argv).toContain('--permission-mode');
      expect(turns[0]!.argv).toContain('plan');
      expect(turns[0]!.argv).not.toContain('--resume');
      expect(turns[0]!.stdin).toContain('hi');
      expect(turns[1]!.argv).toContain('--resume');
      expect(turns[1]!.argv).toContain('sess-1');
      expect(turns[1]!.argv).not.toContain('acceptEdits');
      expect(turns[1]!.stdin).toContain('continue');
      expect(turns[1]!.stdin).not.toContain('You are Zelari.');
      expect(turns[1]!.stdin).not.toContain('"hi"');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uses acceptEdits in build and yields an error when the binary is missing', async () => {
    const missing = createLocalCliProvider({
      cli: 'claude',
      resolveCli: () => ({ ok: false, reason: '[local-cli] missing binary' }),
    });
    const errors: ProviderDelta[] = [];
    for await (const delta of missing({
      messages: [{ role: 'user', content: 'x' }],
      model: '',
      provider: 'local-cli',
      tools: [],
    })) {
      errors.push(delta);
    }
    expect(errors[0]).toMatchObject({ kind: 'error', message: expect.stringContaining('missing binary') });

    const { dir, script, record } = writeSessionCli();
    try {
      const provider = createLocalCliProvider({
        cli: 'claude',
        phase: 'build',
        spawnFn: spawn,
        env: { ...process.env, RECORD_PATH: record },
        resolveCli: () => ({
          ok: true,
          program: process.execPath,
          argvPrefix: [script],
          resolvedPath: script,
        }),
      });
      for await (const _delta of provider({
        messages: [{ role: 'user', content: 'build' }],
        model: 'sonnet',
        provider: 'local-cli',
        tools: [],
        conversationId: 'conv-build',
      })) {
        // drain
      }
      const turn = JSON.parse(readFileSync(record, 'utf8').trim().split('\n')[0]!) as { argv: string[] };
      const modeAt = turn.argv.indexOf('--permission-mode');
      expect(turn.argv[modeAt + 1]).toBe('acceptEdits');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
