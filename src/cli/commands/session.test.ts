/**
 * commands/session.test.ts — WS7 slice 2: `zelari-code session validate`.
 *
 * `replay` reports and exits 0; THIS is the command that gates. The test pins
 * both halves: a clean spine exits 0 and says so, and a spine with a corrupt
 * line / seq gap exits 1 with the ReplayIssues the tolerant reader collected
 * — line + seq + reason — in text and in `--json`.
 *
 * The spine is written RAW here on purpose: a malformed line cannot be produced
 * by the writer (it validates every envelope), so this is the one fixture that
 * must be assembled by hand — exactly the input the tolerant reader exists for.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseSessionFlags, runSessionCommand } from './session.js';

const SID = 's-validate';
const BASE_TS = 1_755_000_000_000;

let dir: string;
let sessionsDir: string;
let spinePath: string;
let savedDir: string | undefined;

const envelope = (seq: number, kind: string, data: Record<string, unknown> = {}): string =>
  JSON.stringify({
    schemaVersion: 1,
    sessionId: SID,
    seq,
    ts: BASE_TS + seq,
    kind,
    actor: { type: 'system' },
    data,
  });

function writeSpine(lines: readonly string[]): void {
  mkdirSync(path.join(sessionsDir, SID), { recursive: true });
  spinePath = path.join(sessionsDir, SID, 'events.jsonl');
  writeFileSync(spinePath, `${lines.join('\n')}\n`, 'utf-8');
}

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

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'zelari-cli-session-'));
  sessionsDir = path.join(dir, '.zelari', 'sessions');
  savedDir = process.env.ZELARI_SESSIONS_DIR;
  process.env.ZELARI_SESSIONS_DIR = sessionsDir;
});

afterEach(() => {
  if (savedDir === undefined) delete process.env.ZELARI_SESSIONS_DIR;
  else process.env.ZELARI_SESSIONS_DIR = savedDir;
  rmSync(dir, { recursive: true, force: true });
});

describe('zelari-code session validate (WS7 slice 2)', () => {
  it('a clean spine validates: exit 0, reports the counts', async () => {
    writeSpine([
      envelope(1, 'session.started'),
      envelope(2, 'tool.call', { tool: 'read_file', callId: 'c1' }),
      envelope(3, 'ask_user.fired', { question: 'ok?' }),
    ]);
    const { code, stdout, stderr } = await capture(() => runSessionCommand(['session', 'validate', SID]));
    expect(stderr).toBe('');
    expect(code).toBe(0);
    expect(stdout).toContain(`session validate — ${SID}`);
    expect(stdout).toContain('events: 3  last seq: 3');
    expect(stdout).toContain('OK — every line parsed, seq 1..n gap-free');
  });

  it('reports every ReplayIssue with line + seq + reason and exits 1', async () => {
    writeSpine([
      envelope(1, 'session.started'),
      'NOT JSON {',
      envelope(3, 'tool.result', { tool: 'read_file', callId: 'c1' }),
      envelope(3, 'note'),
      JSON.stringify({ ...JSON.parse(envelope(4, 'note')), schemaVersion: 99 }),
    ]);
    const { code, stdout } = await capture(() => runSessionCommand(['session', 'validate', SID]));
    expect(code).toBe(1);
    expect(stdout).toContain('ISSUES: 4');
    expect(stdout).toMatch(/line\s+2\s+corrupt-line/);
    // The reader walks the lines in order: gap (expected 2, saw 3), then the
    // same seq again (duplicate), then an envelope it does not understand.
    expect(stdout).toMatch(/line\s+3\s+seq-gap\s+seq=3/);
    expect(stdout).toMatch(/line\s+4\s+seq-duplicate\s+seq=3/);
    expect(stdout).toMatch(/line\s+5\s+schema-mismatch/);
  });

  it('--json prints the issues machine-readably', async () => {
    writeSpine([envelope(1, 'session.started'), 'NOT JSON {', envelope(2, 'decision.future_kind')]);
    const { code, stdout } = await capture(() =>
      runSessionCommand(['session', 'validate', SID, '--json']),
    );
    expect(code).toBe(1);
    const parsed = JSON.parse(stdout) as {
      schemaVersion: number;
      sessionId: string;
      ok: boolean;
      eventCount: number;
      lastSeq: number;
      issues: Array<{ type: string; line: number; seq?: number; detail?: string }>;
    };
    expect(parsed).toMatchObject({
      schemaVersion: 1,
      sessionId: SID,
      ok: false,
      eventCount: 1,
      lastSeq: 1,
    });
    expect(parsed.issues).toEqual([
      { type: 'corrupt-line', line: 2 },
      // The unknown kind is a schema mismatch, carrying the zod reason.
      expect.objectContaining({ type: 'schema-mismatch', line: 3 }),
    ]);
  });

  it('is READ-ONLY as well: validating a dirty spine leaves it byte-identical', async () => {
    writeSpine([envelope(1, 'session.started'), 'NOT JSON {', envelope(3, 'note')]);
    const before = { bytes: readFileSync(spinePath), stat: statSync(spinePath) };
    const first = await capture(() => runSessionCommand(['session', 'validate', SID]));
    const second = await capture(() => runSessionCommand(['session', 'validate', SID, '--json']));
    expect(first.code).toBe(1);
    expect(second.code).toBe(1);
    const bytes = readFileSync(spinePath);
    expect(bytes.equals(before.bytes)).toBe(true);
    expect(statSync(spinePath).mtimeMs).toBe(before.stat.mtimeMs);
  });

  it('usage surface: --help exits 0, a missing/unknown subcommand exits 1', async () => {
    const help = await capture(() => runSessionCommand(['session', '--help']));
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('zelari-code session — inspect one session spine (read-only)');
    expect(help.stdout).toContain('session validate [<sessionId>] [--json]');

    const bare = await capture(() => runSessionCommand(['session']));
    expect(bare.code).toBe(1);
    expect(bare.stderr).toContain('missing subcommand');

    const unknown = await capture(() => runSessionCommand(['session', 'frobnicate']));
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain("unknown subcommand 'frobnicate'");

    const missing = await capture(() => runSessionCommand(['session', 'validate', 'ghost']));
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('no session spine at');
  });

  it('flags: the leading token is optional and --cwd never becomes the session id', () => {
    expect(parseSessionFlags(['session', 'validate', SID, '--json'])).toEqual({
      json: true,
      sessionId: SID,
    });
    expect(parseSessionFlags(['validate', '--cwd', '/tmp/x', SID])).toEqual({
      json: false,
      cwd: '/tmp/x',
      sessionId: SID,
    });
  });
});
