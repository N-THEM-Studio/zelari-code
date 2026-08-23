/**
 * headlessSessionEvent — Exit-1/E1.4 desktop resume-from-spine contract.
 *
 * Proves the `session_started` NDJSON event advertised by every headless
 * dispatch mode carries the spine session id hosts (Desktop) must replay
 * via `--resume`: turn 1 announces a fresh id, turn 2 resumes the SAME id
 * (seq continues), and the kill-switch announces `disabled` so hosts know
 * the spine will not back the conversation.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  openHeadlessSpine,
  sessionStartedEvent,
} from './headlessSpine.js';
import { readSessionLog, resolveSessionsDir } from '@zelari/core/session';

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'zelari-session-event-'));
});

afterEach(async () => {
  delete process.env.ZELARI_SESSION_SPINE;
  // Windows: a recursive rmdir can race with an in-flight append chain —
  // retry instead of failing the suite with ENOTEMPTY (Node default is 0).
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function eventsPath(sessionId: string): string {
  return path.join(resolveSessionsDir({ baseDir: tmp }), sessionId, 'events.jsonl');
}

describe('sessionStartedEvent (E1.4)', () => {
  it('advertises the spine session id with status ok', async () => {
    const handle = await openHeadlessSpine({
      sessionId: 'desk-turn-1',
      baseDir: tmp,
      quiet: true,
    });
    expect(sessionStartedEvent(handle)).toEqual({
      type: 'session_started',
      sessionId: 'desk-turn-1',
      spine: 'active',
    });
    await handle.close('turn-1-done');
  });

  it('round-trips: resuming the advertised id continues the same log (seq)', async () => {
    // Turn 1: host captures the advertised session id.
    const turn1 = await openHeadlessSpine({
      sessionId: 'desk-conversation',
      baseDir: tmp,
      quiet: true,
    });
    const announced = sessionStartedEvent(turn1);
    turn1.userMessage('build the login form');
    await turn1.close('turn-1-done');

    // Turn 2: host replays the same id (--resume semantics: adopt, not new).
    const turn2 = await openHeadlessSpine({
      sessionId: announced.sessionId,
      baseDir: tmp,
      quiet: true,
    });
    expect(sessionStartedEvent(turn2).sessionId).toBe(announced.sessionId);
    turn2.userMessage('procedi');
    await turn2.close('turn-2-done');

    // The spine log is ONE conversation: user turns in order, seq continues.
    const report = await readSessionLog(eventsPath(announced.sessionId));
    const events = report.events;
    const userTurns = events
      .filter((e) => e.kind === 'user.message')
      .map((e) => (e.data as { text?: string }).text);
    expect(userTurns).toEqual(['build the login form', 'procedi']);
    const seqs = events.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });

  it('announces disabled under the kill-switch (host keeps history fallback)', async () => {
    process.env.ZELARI_SESSION_SPINE = '0';
    const handle = await openHeadlessSpine({
      sessionId: 'desk-killswitch',
      baseDir: tmp,
      quiet: true,
    });
    expect(sessionStartedEvent(handle)).toEqual({
      type: 'session_started',
      sessionId: 'desk-killswitch',
      spine: 'disabled',
    });
  });
});
