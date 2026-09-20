/**
 * commands/replay.test.ts — WS7 slice 2: `zelari-code replay`.
 *
 * Red-if-reopens: the fixture is a REAL closed spine written by the core
 * SessionLogWriter (single writer, seq assigned there, read back by the core
 * tolerant reader — nothing is hand-parsed here) and the report is asserted on
 * exact counts: tool calls + per-tool tally, verify debt (open AND cleared),
 * verify runs, and every decision event.
 *
 * The READ-ONLY test is the load-bearing one: replay must leave the log it
 * reads byte-identical (no append, no cache, no state file) — a replay that
 * mutates the spine is not a replay.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SessionLogWriter, type SessionEventInput } from '@zelari/core/session';
import { parseReplayFlags, runReplayCommand } from './replay.js';
import { newestSpineSessionId, resolveSpineSession } from './spineSession.js';

const SID = 's-replay';
const BASE_TS = 1_755_000_000_000;

let dir: string;
let sessionsDir: string;
let spinePath: string;
let savedDir: string | undefined;

/** Run one command capturing both streams (the command owns stdout/stderr). */
async function capture(run: () => Promise<number>): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const out = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation(((chunk: unknown) => {
      stdout += String(chunk);
      return true;
    }) as never);
  const err = vi
    .spyOn(process.stderr, 'write')
    .mockImplementation(((chunk: unknown) => {
      stderr += String(chunk);
      return true;
    }) as never);
  try {
    const code = await run();
    return { code, stdout, stderr };
  } finally {
    out.mockRestore();
    err.mockRestore();
  }
}

/** A closed spine carrying every decision kind plus tool calls and debt. */
async function writeFixture(): Promise<void> {
  sessionsDir = path.join(dir, '.zelari', 'sessions');
  let tick = 0;
  const writer = await SessionLogWriter.open(path.join(sessionsDir, SID), SID, 1, {
    now: () => BASE_TS + (tick += 1),
  });
  spinePath = writer.path;
  const events: SessionEventInput[] = [
    { kind: 'session.started', actor: { type: 'system' } },
    { kind: 'user.message', actor: { type: 'user' }, data: { text: 'wire the bridge' } },
    { kind: 'tool.call', actor: { type: 'agent' }, data: { callId: 'c1', tool: 'read_file', args: {} } },
    { kind: 'tool.result', actor: { type: 'tool' }, data: { callId: 'c1', tool: 'read_file', ok: true } },
    { kind: 'tool.call', actor: { type: 'agent' }, data: { callId: 'c2', tool: 'read_file', args: {} } },
    { kind: 'tool.result', actor: { type: 'tool' }, data: { callId: 'c2', tool: 'read_file', ok: true } },
    {
      kind: 'permission.asked',
      actor: { type: 'system', role: 'permissions' },
      data: { tool: 'write_file', effect: 'ask', matchedRuleId: 'no-secrets', source: 'project' },
    },
    { kind: 'auto_approve.granted', actor: { type: 'system', role: 'permissions' }, data: { tool: 'read_file', source: 'default' } },
    { kind: 'jail.blocked', actor: { type: 'system', role: 'jail' }, data: { tool: 'bash', backend: 'win32-restricted-token', mode: 'required', reason: 'no backend' } },
    { kind: 'ask_user.fired', actor: { type: 'agent' }, data: { question: 'cap at 20?', callId: 'c9' } },
    { kind: 'tool.call', actor: { type: 'agent' }, data: { callId: 'c3', tool: 'bash', args: {} } },
    { kind: 'tool.result', actor: { type: 'tool' }, data: { callId: 'c3', tool: 'bash', ok: true } },
    { kind: 'verify.debt_open', actor: { type: 'system' }, data: { taskId: 't-bridge', description: 'wire the bridge' } },
    { kind: 'verify.debt_cleared', actor: { type: 'system' }, data: { taskId: 't-bridge' } },
    { kind: 'verify.debt_open', actor: { type: 'system' }, data: { taskId: 't-docs', description: 'update the docs' } },
    { kind: 'verify.requested', actor: { type: 'system', role: 'strict-done' }, data: { taskId: 't-docs', criterionIds: ['typecheck'] } },
    {
      kind: 'verification.run',
      actor: { type: 'system' },
      data: { strict: true, complete: false, results: [{ criterionId: 'typecheck', status: 'unknown', evidence: [] }] },
    },
    { kind: 'session.ended', actor: { type: 'system' }, data: { reason: 'completed' } },
  ];
  try {
    for (const e of events) await writer.append(e);
  } finally {
    await writer.close();
  }
}

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'zelari-cli-replay-'));
  savedDir = process.env.ZELARI_SESSIONS_DIR;
  await writeFixture();
  process.env.ZELARI_SESSIONS_DIR = sessionsDir;
});

afterEach(() => {
  if (savedDir === undefined) delete process.env.ZELARI_SESSIONS_DIR;
  else process.env.ZELARI_SESSIONS_DIR = savedDir;
  rmSync(dir, { recursive: true, force: true });
});

describe('zelari-code replay (WS7 slice 2)', () => {
  it('prints tool calls, verify debt and every decision event, exit 0', async () => {
    const { code, stdout, stderr } = await capture(() => runReplayCommand(['replay', SID]));
    expect(stderr).toBe('');
    expect(code).toBe(0);
    expect(stdout).toContain(`replay — session ${SID}`);
    expect(stdout).toContain('spine OK');
    expect(stdout).toContain('tool calls: 3  results: 3');
    expect(stdout).toMatch(/read_file\s+2 call\(s\) \/ 2 result\(s\)/);
    expect(stdout).toMatch(/bash\s+1 call\(s\) \/ 1 result\(s\)/);
    expect(stdout).toContain('verify debt: 1 open / 1 cleared');
    expect(stdout).toMatch(/OPEN\s+t-docs — update the docs/);
    expect(stdout).toContain('cleared t-bridge — wire the bridge');
    expect(stdout).toContain('verify runs: 1');
    expect(stdout).toContain('decision events: 5');
    for (const kind of [
      'permission.asked',
      'auto_approve.granted',
      'jail.blocked',
      'ask_user.fired',
      'verify.requested',
    ]) {
      expect(stdout).toContain(kind);
    }
    expect(stdout).toContain('cap at 20?');
  });

  it('--json prints the whole projection, machine-readable', async () => {
    const { code, stdout } = await capture(() => runReplayCommand(['replay', SID, '--json']));
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout) as {
      schemaVersion: number;
      sessionId: string;
      ok: boolean;
      projection: {
        toolCallBreakdown: Array<{ tool: string; calls: number; results: number }>;
        decisionEvents: Array<{ kind: string; seq: number }>;
        verifyDebts: Array<{ taskId: string; clearedSeq?: number }>;
      };
    };
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.sessionId).toBe(SID);
    expect(parsed.ok).toBe(true);
    expect(parsed.projection.toolCallBreakdown[0]).toEqual({ tool: 'read_file', calls: 2, results: 2 });
    expect(parsed.projection.decisionEvents.map((d) => d.kind)).toEqual([
      'permission.asked',
      'auto_approve.granted',
      'jail.blocked',
      'ask_user.fired',
      'verify.requested',
    ]);
    expect(parsed.projection.verifyDebts.map((d) => [d.taskId, d.clearedSeq])).toEqual([
      ['t-bridge', 14],
      ['t-docs', undefined],
    ]);
  });

  it('replay is READ-ONLY: the spine it reads is untouched (bytes, mtime, listing)', async () => {
    const before = {
      bytes: readFileSync(spinePath),
      stat: statSync(spinePath),
      listing: readdirSync(path.join(sessionsDir, SID)).sort(),
    };
    const human = await capture(() => runReplayCommand(['replay', SID]));
    const json = await capture(() => runReplayCommand(['replay', SID, '--json']));
    expect(human.code).toBe(0);
    expect(json.code).toBe(0);
    const after = {
      bytes: readFileSync(spinePath),
      stat: statSync(spinePath),
      listing: readdirSync(path.join(sessionsDir, SID)).sort(),
    };
    expect(after.bytes.equals(before.bytes)).toBe(true);
    expect(after.stat.mtimeMs).toBe(before.stat.mtimeMs);
    expect(after.stat.size).toBe(before.stat.size);
    expect(after.listing).toEqual(before.listing);
    expect(after.listing).toEqual(['events.jsonl']);
  });

  it('--help exits 0 without touching the sessions dir', async () => {
    const { code, stdout, stderr } = await capture(() => runReplayCommand(['replay', '--help']));
    expect(code).toBe(0);
    expect(stderr).toBe('');
    expect(stdout).toContain('zelari-code replay');
    expect(stdout).toContain('zelari-code replay [<sessionId>] [--json]');
    expect(stdout).toContain('read-only');
  });

  it('an unknown session id is an error (exit 1), never a silent empty replay', async () => {
    const { code, stdout, stderr } = await capture(() => runReplayCommand(['replay', 'nope']));
    expect(code).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain('no session spine at');
  });

  it('flags: the leading token is optional and --cwd never becomes the session id', () => {
    expect(parseReplayFlags(['replay', SID, '--json'])).toEqual({ json: true, sessionId: SID });
    expect(parseReplayFlags(['--cwd', '/tmp/x', SID])).toEqual({ json: false, cwd: '/tmp/x', sessionId: SID });
    expect(parseReplayFlags(['replay', '--cwd', '/tmp/x'])).toEqual({ json: false, cwd: '/tmp/x' });
  });

  it('session resolution: explicit id wins, unknown id is refused, newest is pickable', () => {
    const resolved = resolveSpineSession({ sessionId: SID });
    expect('error' in resolved).toBe(false);
    if (!('error' in resolved)) expect(resolved.eventsPath).toBe(spinePath);
    expect(resolveSpineSession({ sessionId: 'ghost' })).toEqual({
      error: expect.stringContaining('no session spine at'),
    });
    expect(newestSpineSessionId(sessionsDir)).toBe(SID);
  });
});
