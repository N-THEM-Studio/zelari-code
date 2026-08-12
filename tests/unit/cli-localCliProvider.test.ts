/**
 * cli-localCliProvider.test.ts — Slice B local-CLI provider coverage.
 *
 * Drives the pure driver (`buildClaudeInputLines`, `createClaudeStreamParser`)
 * with fixture lines, then the full ProviderStreamFn against a FAKE CLI
 * process (a small node script that records stdin and plays canned
 * stream-json events), plus the spawn-failure path.
 */
import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentMessage, ProviderDelta } from '@zelari/core/harness';
import {
  buildClaudeInputLines,
  createClaudeStreamParser,
} from '../../src/cli/provider/localCli/claudeStreamJson.js';
import { createLocalCliProvider } from '../../src/cli/provider/localCli/claudeProvider.js';

const FAKE_OUTPUT = [
  '{"type":"system","subtype":"init","cwd":"C:\\\\","session_id":"s1"}',
  '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello "}}}',
  '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"world"}}}',
  '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Hello world"},{"type":"tool_use","id":"toolu_1","name":"Bash","input":{"command":"ls"}}],"stop_reason":"tool_use"}}',
  '{"type":"result","subtype":"success","result":"Hello world","is_error":false,"usage":{"input_tokens":12,"output_tokens":5}}',
].join('\n');

describe('buildClaudeInputLines — conversation → stream-json input', () => {
  it('maps system/user/assistant-toolCalls/tool messages', () => {
    const messages: AgentMessage[] = [
      { role: 'system', content: 'You are Zelari.' },
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: 'let me check',
        toolCalls: [{ id: 'toolu_1', name: 'Bash', args: { command: 'ls' } }],
      },
      { role: 'tool', toolCallId: 'toolu_1', content: 'file1\nfile2' },
    ];
    const lines = buildClaudeInputLines(messages);
    expect(lines).toHaveLength(4);
    expect(JSON.parse(lines[0]!)).toEqual({ type: 'system', content: 'You are Zelari.' });
    const user = JSON.parse(lines[1]!) as { message: { role: string; content: unknown[] } };
    expect(user.message.role).toBe('user');
    const asst = JSON.parse(lines[2]!) as {
      message: { role: string; content: Array<{ type: string; name?: string }> };
    };
    expect(asst.message.role).toBe('assistant');
    expect(asst.message.content.find((c) => c.type === 'tool_use')?.name).toBe('Bash');
    const tool = JSON.parse(lines[3]!) as {
      message: { content: Array<{ type: string; tool_use_id?: string }> };
    };
    expect(tool.message.content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'toolu_1' });
  });
});

describe('createClaudeStreamParser — output events → deltas', () => {
  it('streams text, renders tool_use as text, emits usage + finish once', () => {
    const parser = createClaudeStreamParser();
    const deltas: ProviderDelta[] = [];
    for (const line of FAKE_OUTPUT.split('\n')) {
      deltas.push(...parser.push(line));
    }
    expect(parser.finished).toBe(true);
    expect(parser.stopReason).toBe('tool_use');
    expect(deltas.filter((d) => d.kind === 'text').map((d) => (d as { delta: string }).delta)).toEqual([
      'Hello ',
      'world',
      '\n[CLI tool] Bash {"command":"ls"}\n',
    ]);
    const usage = deltas.find((d) => d.kind === 'usage');
    expect(usage).toEqual({
      kind: 'usage',
      usage: { promptTokens: 12, completionTokens: 5, totalTokens: 17 },
    });
    expect(deltas.filter((d) => d.kind === 'finish')).toHaveLength(1);
  });

  it('tolerates garbage lines and ignores init events', () => {
    const parser = createClaudeStreamParser();
    expect(parser.push('not json at all')).toEqual([]);
    expect(parser.push('{"type":"system","subtype":"init"}')).toEqual([]);
    expect(parser.push('')).toEqual([]);
    expect(parser.finished).toBe(false);
  });

  it('emits the result text when nothing was streamed (safety net)', () => {
    const parser = createClaudeStreamParser();
    const deltas = parser.push('{"type":"result","result":"plain answer","is_error":false,"usage":{"input_tokens":1,"output_tokens":2}}');
    expect(deltas).toContainEqual({ kind: 'text', delta: 'plain answer' });
    expect(deltas.at(-1)).toEqual({ kind: 'finish', reason: 'stop' });
  });
});

function writeFakeCli(): { dir: string; script: string; record: string } {
  const dir = mkdtempSync(join(tmpdir(), 'zelari-localcli-'));
  const record = join(dir, 'stdin.jsonl');
  const script = join(dir, 'fake-cli.cjs');
  const canned = FAKE_OUTPUT.split('\n')
    .map((l) => JSON.stringify(l))
    .join(',\n');
  writeFileSync(
    script,
    [
      "const fs = require('node:fs');",
      "const path = process.env.RECORD_PATH;",
      "let buf = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (c) => { buf += c; });",
      "process.stdin.on('end', () => {",
      "  if (path) fs.writeFileSync(path, buf, 'utf8');",
      "  const out = [" + canned + "].join('\\n');",
      "  process.stdout.write(out + '\\n');",
      "});",
    ].join('\n'),
  );
  return { dir, script, record };
}

describe('createLocalCliProvider — fake CLI end-to-end', () => {
  it('spawns, feeds the conversation, yields text + usage + finish', async () => {
    const { dir, script, record } = writeFakeCli();
    try {
      const provider = createLocalCliProvider({
        cli: process.execPath,
        args: [script],
        spawnFn: spawn,
        env: { ...process.env, RECORD_PATH: record },
      });
      const deltas: ProviderDelta[] = [];
      for await (const d of provider({
        messages: [
          { role: 'system', content: 'You are Zelari.' },
          { role: 'user', content: 'hi' },
        ],
        model: 'sonnet',
        provider: 'local-claude',
        tools: [],
      })) {
        deltas.push(d);
      }
      expect(deltas.filter((d) => d.kind === 'text').map((d) => (d as { delta: string }).delta)).toEqual([
        'Hello ',
        'world',
        '\n[CLI tool] Bash {"command":"ls"}\n',
      ]);
      expect(deltas.filter((d) => d.kind === 'finish')).toHaveLength(1);
      expect(deltas.some((d) => d.kind === 'usage')).toBe(true);

      const recorded = readFileSync(record, 'utf8').trim().split('\n');
      expect(recorded.length).toBeGreaterThanOrEqual(2);
      expect(JSON.parse(recorded[0]!)).toEqual({ type: 'system', content: 'You are Zelari.' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('yields an error delta when the CLI exits non-zero', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zelari-localcli-err-'));
    try {
      const script = join(dir, 'boom.cjs');
      writeFileSync(
        script,
        "process.stderr.write('kaboom\\n');\nprocess.exit(3);\n",
      );
      const provider = createLocalCliProvider({
        cli: process.execPath,
        args: [script],
        spawnFn: spawn,
      });
      const deltas: ProviderDelta[] = [];
      for await (const d of provider({
        messages: [{ role: 'user', content: 'x' }],
        model: '',
        provider: 'local-claude',
        tools: [],
      })) {
        deltas.push(d);
      }
      const err = deltas.find((d) => d.kind === 'error') as { message: string } | undefined;
      expect(err).toBeDefined();
      expect(err!.message).toContain('exited 3');
      expect(err!.message).toContain('kaboom');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('yields an error delta when the executable cannot be spawned', async () => {
    const provider = createLocalCliProvider({
      cli: 'zelari-no-such-cli-xyz',
      args: ['-p'],
      spawnFn: spawn,
    });
    const deltas: ProviderDelta[] = [];
    for await (const d of provider({
      messages: [{ role: 'user', content: 'x' }],
      model: '',
      provider: 'local-claude',
      tools: [],
    })) {
      deltas.push(d);
    }
    const err = deltas.find((d) => d.kind === 'error');
    expect(err).toBeDefined();
  });
});
