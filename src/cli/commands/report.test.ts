/**
 * commands/report.test.ts — t115: `/report` aggregates the ACTIVE session spine.
 *
 * Red-if-reopens: the fixture is a minimal but REAL spine (v1 envelopes, gap-free
 * seq, parsed by the core reader — nothing is hand-parsed here), and the exact
 * counts are pinned: unique files with per-kind marks, tool-call histogram,
 * last verification run, tokens/cost ONLY when the spine carries them. The
 * fail-soft tests fail if a missing/empty/all-corrupt spine ever throws or
 * returns a non-zero exit code, and the legacy test fails if a pre-ADR-0033
 * spine stops being labelled as such.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildSessionReport, runReport } from './report.js';

const SID = 's-report';
const BASE_TS = 1_755_000_000_000;

let dir: string;
let sessionsDir: string;
let env: NodeJS.ProcessEnv;

const envelope = (seq: number, kind: string, data: Record<string, unknown>, sessionId = SID): string =>
  JSON.stringify({
    schemaVersion: 1,
    sessionId,
    seq,
    ts: BASE_TS + seq * 1000,
    kind,
    actor: { type: 'agent' },
    data,
  });

/** Write `<sessionsDir>/<sessionId>/events.jsonl` (raw lines, corrupt ones included). */
function writeSpine(sessionId: string, lines: readonly string[]): void {
  const target = path.join(sessionsDir, sessionId);
  mkdirSync(target, { recursive: true });
  writeFileSync(path.join(target, 'events.jsonl'), `${lines.join('\n')}\n`, 'utf-8');
}

/** The line of the report that mentions `needle` (for per-file mark assertions). */
const lineWith = (markdown: string, needle: string): string =>
  markdown.split('\n').find((l) => l.includes(needle)) ?? '';

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'zelari-report-'));
  sessionsDir = path.join(dir, '.zelari', 'sessions');
  env = { ZELARI_SESSIONS_DIR: sessionsDir };
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('buildSessionReport — aggregation from the spine (t115)', () => {
  const aPath = (): string => path.join(dir, 'src', 'a.ts');
  const bPath = (): string => path.join(dir, 'src', 'b.ts');

  function fullSpine(): void {
    writeSpine(SID, [
      envelope(1, 'session.started', { cwd: dir }),
      envelope(2, 'tool.call', { tool: 'exec_process', args: { program: 'node' } }),
      envelope(3, 'tool.call', { tool: 'exec_process', args: {} }),
      envelope(4, 'tool.call', { tool: 'read_file', args: { path: aPath() } }),
      envelope(5, 'file.read', { path: aPath() }),
      envelope(6, 'file.read', { path: aPath() }),
      envelope(7, 'file.applied', { path: aPath() }),
      envelope(8, 'file.rejected', { path: bPath() }),
      envelope(9, 'tool.result', { tool: 'read_file', ok: true, output: 'x' }),
      envelope(10, 'verification.run', {
        complete: true,
        results: [
          { criterionId: 'eq-1', status: 'pass', evidence: [{}, {}] },
          { criterionId: 'eq-2', status: 'fail', evidence: [] },
        ],
      }),
      envelope(11, 'session.compacted', { inputTokens: 100, outputTokens: 40, savedTokens: 10 }),
      envelope(12, 'assistant.message', { text: 'hi', usage: { inputTokens: 5, outputTokens: 6, costUsd: 0.02 } }),
      envelope(13, 'session.ended', {}),
      '{"this is not json"',
    ]);
  }

  it('aggregates files, tool calls, verify, tokens and cost with exact counts', () => {
    fullSpine();
    const report = buildSessionReport({ sessionId: SID, cwd: dir, env });
    expect(report.ok).toBe(true);
    expect(report.sessionId).toBe(SID);
    const md = report.markdown;

    expect(md).toContain(`# session report — ${SID}`);
    expect(md).toContain('events: 13  tool calls: 3  results: 1');
    expect(md).toContain(`started: ${new Date(BASE_TS + 1000).toISOString()}`);
    expect(md).toContain(`ended:   ${new Date(BASE_TS + 13000).toISOString()}`);

    // files — unique paths, per-kind marks, and the source is NAMED
    expect(md).toContain('## files touched — 2 unique (file.* spine events (ADR-0033))');
    expect(lineWith(md, 'a.ts')).toContain('read×2 write×1');
    expect(lineWith(md, 'b.ts')).toContain('rejected×1');

    // tool histogram, most used first
    expect(md.indexOf('2  exec_process')).toBeLessThan(md.indexOf('1  read_file'));

    // verify — last run only, pass/fail split + per-criterion evidence count
    expect(md).toContain('runs: 1  last:');
    expect(md).toContain('1 pass / 1 fail (complete)');
    expect(md).toContain('pass     eq-1 (evidence 2)');
    expect(md).toContain('fail     eq-2 (evidence 0)');

    // tokens/cost come ONLY from what the spine already recorded
    expect(md).toContain('## tokens / cost (as recorded on the spine)');
    expect(md).toContain('compaction tokens: in 105 / out 46 / saved 10');
    expect(md).toContain('cost: $0.0200');

    // the corrupt line is reported, never fatal
    expect(md).toContain('spine issues: 1 (corrupt-line×1)');
  });

  it('omits the tokens/cost section when the spine carries neither', () => {
    writeSpine(SID, [envelope(1, 'session.started', {}), envelope(2, 'tool.call', { tool: 'read_file' })]);
    const md = buildSessionReport({ sessionId: SID, cwd: dir, env }).markdown;
    expect(md).not.toContain('## tokens / cost');
    expect(md).toContain('## verify');
    expect(md).toContain('(no verification.run events on this spine)');
  });

  it('a pre-ADR-0033 spine falls back to tool.call args and SAYS SO', () => {
    writeSpine(SID, [
      envelope(1, 'session.started', {}),
      envelope(2, 'tool.call', { tool: 'write_file', args: { path: aPath() } }),
      envelope(3, 'tool.call', { tool: 'edit', args: { path: aPath() } }),
      envelope(4, 'tool.call', { tool: 'exec_process', args: { program: 'node' } }),
    ]);
    const md = buildSessionReport({ sessionId: SID, cwd: dir, env }).markdown;
    expect(md).toContain('tool.call args (legacy spine: no file.* events)');
    expect(md).toContain('## files touched — 1 unique');
    expect(lineWith(md, 'a.ts')).toContain('write×2');
  });

  it('a spine with no file/tool activity still renders the empty sections', () => {
    writeSpine(SID, [envelope(1, 'session.started', {})]);
    const md = buildSessionReport({ sessionId: SID, cwd: dir, env }).markdown;
    expect(md).toContain('## files touched — 0 unique');
    expect(md).toContain('(none)');
    expect(md).toContain('## tool calls');
  });

  it('an unknown session id falls back to the NEWEST spine on disk', () => {
    writeSpine('older', [envelope(1, 'session.started', {}, 'older')]);
    writeSpine('newer', [
      envelope(1, 'session.started', {}, 'newer'),
      envelope(2, 'session.ended', {}, 'newer'),
    ]);
    const report = buildSessionReport({ sessionId: 'ghost-session', cwd: dir, env });
    expect(report.ok).toBe(true);
    expect(report.sessionId).toBe('newer');
  });
});

describe('buildSessionReport — fail-soft on a missing / unusable spine (t115)', () => {
  it('a missing sessions dir is a clear message, not an error', () => {
    const report = buildSessionReport({ sessionId: SID, cwd: dir, env });
    expect(report.ok).toBe(false);
    expect(report.markdown).toContain('no session spine found under');
    expect(report.markdown).toContain('this is not an error');
  });

  it('a spine whose every line is corrupt reports "no readable events"', () => {
    writeSpine(SID, ['nope', '{', '{"schemaVersion":99}']);
    const report = buildSessionReport({ sessionId: SID, cwd: dir, env });
    expect(report.ok).toBe(false);
    expect(report.markdown).toContain('holds no readable events');
    expect(report.markdown).toContain('issue');
  });

  it('runReport always exits 0, printing the failure message on stdout', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(runReport({ sessionId: SID, cwd: dir, env })).toBe(0);
      expect(log).toHaveBeenCalledTimes(1);
      expect(String(log.mock.calls[0]?.[0])).toContain('no session spine found under');
    } finally {
      log.mockRestore();
    }
  });
});
