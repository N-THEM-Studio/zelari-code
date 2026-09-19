/**
 * tests/unit/cli-inbox.test.ts — `/inbox` "waiting on you", derived from the spine.
 *
 * Red-if-reopens: the fixtures are REAL v1 envelopes (gap-free seq, parsed by
 * the core reader), so the pending question is found exactly the way the TUI
 * spine records one — `tool.call{tool:'ask_user'}` settled by a `tool.result`
 * with the same callId. The suite pins the four honesty rules: a settled ask
 * disappears, an interrupted one stays but is marked unavailable, a corrupt
 * spine is SKIPPED (never thrown, never silently reported as answered), and the
 * kill switch reports "disabled" instead of printing a list.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  INBOX_LIMIT,
  deriveInboxQuestions,
  formatInbox,
  inboxEnabled,
  renderInbox,
  scanInbox,
  type InboxEventLike,
} from '../../src/cli/inbox.js';
import { handleSlashCommand } from '../../src/cli/slashCommands.js';

const BASE_TS = 1_755_000_000_000;

let dir: string;
let sessionsDir: string;
const ENV_KEYS = ['ZELARI_SESSIONS_DIR', 'ZELARI_INBOX'] as const;
let savedEnv: Record<string, string | undefined>;

const envelope = (sessionId: string, seq: number, kind: string, data: Record<string, unknown>): string =>
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

const ask = (sessionId: string, seq: number, callId: string, question: string, choices: string[] = ['a', 'b']): string =>
  envelope(sessionId, seq, 'tool.call', { tool: 'ask_user', callId, args: { question, choices } });

/** Pure event helper for the projection-level tests (no disk). */
const ev = (seq: number, kind: string, data?: Record<string, unknown>): InboxEventLike => ({
  kind,
  seq,
  ts: BASE_TS + seq * 1000,
  ...(data ? { data } : {}),
});

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'zelari-inbox-'));
  sessionsDir = path.join(dir, '.zelari', 'sessions');
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe('deriveInboxQuestions — the spine pairing, at the projection level', () => {
  it('keeps an ask_user call that no tool.result settled', () => {
    const [entry] = deriveInboxQuestions(
      [
        ev(1, 'user.message', { text: 'add the feature' }),
        ev(2, 'tool.call', { tool: 'ask_user', callId: 'c1', args: { question: 'Postgres or SQLite?', choices: ['pg', 'sqlite'] } }),
      ],
      { sessionId: 's1', destination: 'add the feature' },
    );
    expect(entry).toMatchObject({
      sessionId: 's1',
      destination: 'add the feature',
      question: 'Postgres or SQLite?',
      choices: ['pg', 'sqlite'],
      callId: 'c1',
      available: true,
    });
  });

  it('drops it as soon as a tool.result with the same callId exists (answer OR cancel)', () => {
    const lines = [
      ev(1, 'tool.call', { tool: 'ask_user', callId: 'c1', args: { question: 'which db?' } }),
      ev(2, 'tool.result', { callId: 'c1', output: '[ask_user] User answered:\n  A: postgres', ok: true }),
      ev(3, 'tool.call', { tool: 'ask_user', callId: 'c2', args: { question: 'and the port?' } }),
      ev(4, 'tool.result', { callId: 'c2', output: '[ask_user] User cancelled or no answer.', ok: true }),
    ];
    expect(deriveInboxQuestions(lines, { sessionId: 's1' })).toEqual([]);
    // A result for a DIFFERENT call never settles this one.
    const other = deriveInboxQuestions(
      [ev(1, 'tool.call', { tool: 'ask_user', callId: 'c1', args: { question: 'q' } }), ev(2, 'tool.result', { callId: 'zz' })],
      { sessionId: 's1' },
    );
    expect(other).toHaveLength(1);
  });

  it('keeps an interrupted ask but marks it unavailable (the run that asked is gone)', () => {
    const [entry] = deriveInboxQuestions(
      [
        ev(1, 'tool.call', { tool: 'ask_user', callId: 'c1', args: { question: 'q' } }),
        ev(2, 'tool.interrupted', { callId: 'c1' }),
      ],
      { sessionId: 's1' },
    );
    expect(entry.available).toBe(false);
    expect(entry.question).toBe('q');
  });

  it('ignores other tools, unusable payloads and asks with no callId or question', () => {
    const lines = [
      ev(1, 'tool.call', { tool: 'exec_process', callId: 'x', args: { program: 'node' } }),
      ev(2, 'tool.call', { tool: 'ask_user', args: { question: 'no callId' } }),
      ev(3, 'tool.call', { tool: 'ask_user', callId: 'c3', args: {} }),
      ev(4, 'tool.call', { tool: 'ask_user', callId: 'c4', args: 'not json' }),
    ];
    expect(deriveInboxQuestions(lines, { sessionId: 's1' })).toEqual([]);
  });

  it('accepts a JSON-string args payload (some hosts serialize tool args)', () => {
    const [entry] = deriveInboxQuestions(
      [ev(1, 'tool.call', { tool: 'ask_user', callId: 'c1', args: JSON.stringify({ question: 'serialized?' }) })],
      { sessionId: 's1' },
    );
    expect(entry.question).toBe('serialized?');
  });
});

describe('scanInbox — local sessions, most recent first, capped', () => {
  it('collects pending questions across sessions and reads the session handle', () => {
    writeSpine('s-old', [
      envelope('s-old', 1, 'user.message', { text: 'old task' }),
      ask('s-old', 2, 'c-old', 'which db?'),
    ]);
    writeSpine('s-new', [
      envelope('s-new', 1, 'user.message', { text: 'new task' }),
      ask('s-new', 2, 'c-new', 'which port?'),
      envelope('s-new', 3, 'tool.result', { callId: 'c-new', output: 'answered', ok: true }),
    ]);
    const scan = scanInbox({ sessionsDir });
    expect(scan.sessions).toBe(2);
    expect(scan.skipped).toBe(0);
    expect(scan.entries).toHaveLength(1);
    expect(scan.entries[0]).toMatchObject({ sessionId: 's-old', destination: 'old task', question: 'which db?' });
  });

  it('skips unreadable/empty/corrupt spines without throwing and counts them', () => {
    writeSpine('s-good', [ask('s-good', 1, 'c1', 'still waiting?')]);
    writeSpine('s-corrupt', ['{ not json', '', 'also not json']);
    mkdirSync(path.join(sessionsDir, 's-empty'), { recursive: true }); // dir without events.jsonl
    const scan = scanInbox({ sessionsDir });
    expect(scan.sessions).toBe(1);
    expect(scan.skipped).toBe(1);
    expect(scan.entries).toHaveLength(1);
  });

  it('caps at INBOX_LIMIT and reports truncation', () => {
    const l: string[] = [];
    for (let i = 1; i <= INBOX_LIMIT + 3; i++) l.push(ask('s-many', i, `c${i}`, `question ${i}`));
    writeSpine('s-many', l);
    const scan = scanInbox({ sessionsDir });
    expect(scan.entries).toHaveLength(INBOX_LIMIT);
    expect(scan.truncated).toBe(true);
    expect(scan.entries[0].question).toBe(`question ${INBOX_LIMIT + 3}`); // newest first
    expect(scanInbox({ sessionsDir, limit: 2 }).entries).toHaveLength(2);
  });

  it('an empty or missing sessions dir is a clean empty scan, never a throw', () => {
    const missing = scanInbox({ sessionsDir: path.join(dir, 'nope') });
    expect(missing).toMatchObject({ sessions: 0, skipped: 0, entries: [], truncated: false });
    mkdirSync(sessionsDir, { recursive: true });
    expect(scanInbox({ sessionsDir }).entries).toEqual([]);
  });
});

describe('formatInbox / renderInbox — the /inbox surface', () => {
  it('lists destination + question + the resume hint, and an empty state when none', () => {
    expect(formatInbox(scanInbox({ sessionsDir: path.join(dir, 'nope') }))).toContain('no local sessions under');
    writeSpine('s-1', [envelope('s-1', 1, 'user.message', { text: 'wire the inbox' }), ask('s-1', 2, 'c1', 'cap at 20?')]);
    const text = formatInbox(scanInbox({ sessionsDir }));
    expect(text).toContain('[inbox] 1 question(s) waiting on you (1 session(s) scanned)');
    expect(text).toContain('Q: cap at 20?');
    expect(text).toContain('→ /resume s-1');
    expect(text).toContain('"wire the inbox"');

    writeSpine('s-2', [envelope('s-2', 1, 'user.message', { text: 'answered already' }), ask('s-2', 2, 'c9', 'q'), envelope('s-2', 3, 'tool.result', { callId: 'c9', ok: true })]);
    rmSync(path.join(sessionsDir, 's-1'), { recursive: true, force: true });
    const empty = formatInbox(scanInbox({ sessionsDir }));
    expect(empty).toContain('nothing waiting on you');
    expect(empty).not.toContain('/resume');
  });

  it('marks an interrupted question with the re-ask hint', () => {
    writeSpine('s-1', [ask('s-1', 1, 'c1', 'still relevant?'), envelope('s-1', 2, 'tool.interrupted', { callId: 'c1' })]);
    const text = formatInbox(scanInbox({ sessionsDir }));
    expect(text).toContain('→ /resume s-1 (the run that asked was interrupted — re-ask after resuming)');
  });
});

describe('kill switch — ZELARI_INBOX=0', () => {
  it('is ON by default and OFF only for the exact "0"', () => {
    expect(inboxEnabled({})).toBe(true);
    expect(inboxEnabled({ ZELARI_INBOX: '1' })).toBe(true);
    expect(inboxEnabled({ ZELARI_INBOX: '0' })).toBe(false);
  });

  it('answers "disabled" and reads no session at all', () => {
    writeSpine('s-1', [ask('s-1', 1, 'c1', 'should be hidden')]);
    const env = { ZELARI_INBOX: '0', ZELARI_SESSIONS_DIR: sessionsDir };
    const text = renderInbox({ env, sessionsDir });
    expect(text).toContain('[inbox] disabled — ZELARI_INBOX=0');
    expect(text).not.toContain('should be hidden');
  });
});

describe('/inbox — the slash command surface', () => {
  it('is handled, prints the pending question of the local sessions dir', () => {
    process.env.ZELARI_SESSIONS_DIR = sessionsDir;
    writeSpine('s-1', [ask('s-1', 1, 'c1', 'pending via slash')]);
    const result = handleSlashCommand('/inbox', []);
    expect(result).toMatchObject({ handled: true, kind: 'inbox' });
    expect(result.message).toContain('pending via slash');
    expect(result.message).toContain('/resume s-1');
  });

  it('reports the kill switch instead of a list', () => {
    process.env.ZELARI_SESSIONS_DIR = sessionsDir;
    process.env.ZELARI_INBOX = '0';
    writeSpine('s-1', [ask('s-1', 1, 'c1', 'hidden via slash')]);
    const result = handleSlashCommand('/inbox', []);
    expect(result.message).toContain('disabled');
    expect(result.message).not.toContain('hidden via slash');
  });

  it('advertises itself in /help', () => {
    const help = handleSlashCommand('/help', []);
    expect(help.message).toContain('/inbox');
  });
});
