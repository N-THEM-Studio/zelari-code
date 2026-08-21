/**
 * headlessSpine + parseHeadlessFlags 2.0 host wiring.
 *
 * Covers: profile defaults, flag parse/validation, dual-write user.message,
 * interrupt without session.ended, resume seq continuation, portable export.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseHeadlessFlags, defaultProfileForMode } from './headless.js';
import {
  openHeadlessSpine,
  resolveHeadlessProfileId,
  exportSessionById,
  missionStateFromSpine,
} from './headlessSpine.js';
import { readSessionLog } from '@zelari/core/session';

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'zelari-headless-spine-'));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('defaultProfileForMode / resolveHeadlessProfileId', () => {
  it('maps mode → profile and lets an explicit id win', () => {
    expect(defaultProfileForMode('kraken')).toBe('kraken/v1');
    expect(defaultProfileForMode('council')).toBe('council/v1');
    expect(defaultProfileForMode('zelari')).toBe('mission/v1');
    expect(resolveHeadlessProfileId('kraken')).toBe('kraken/v1');
    expect(resolveHeadlessProfileId('kraken', 'minimal/v1')).toBe('minimal/v1');
  });

  it('throws on an unknown explicit profile', () => {
    expect(() => resolveHeadlessProfileId('kraken', 'nope/v9')).toThrow(/Unknown profile/);
  });
});

describe('parseHeadlessFlags 2.0 flags', () => {
  it('accepts --profile / --resume / --export-session / --strict-done', () => {
    const res = parseHeadlessFlags([
      '--headless',
      '--task',
      'do the thing',
      '--profile',
      'minimal/v1',
      '--resume',
      'sess-abc',
      '--export-session',
      '-',
      '--strict-done',
    ]);
    expect(res.error).toBeUndefined();
    expect(res.options).toMatchObject({
      task: 'do the thing',
      profile: 'minimal/v1',
      resumeSessionId: 'sess-abc',
      exportSessionPath: '-',
      strictDone: true,
    });
  });

  it('rejects an unknown --profile at parse time', () => {
    const res = parseHeadlessFlags(['--headless', '--task', 'x', '--profile', 'ghost/v1']);
    expect(res.options).toBeNull();
    expect(res.error).toMatch(/Unknown profile/);
  });

  it('--resume without an id is a user error', () => {
    const res = parseHeadlessFlags(['--headless', '--task', 'x', '--resume']);
    expect(res.options).toBeNull();
    expect(res.error).toMatch(/--resume requires/);
  });

  it('accepts --gauntlet and --no-gauntlet', () => {
    const on = parseHeadlessFlags(['--headless', '--task', 'x', '--gauntlet']);
    expect(on.error).toBeUndefined();
    expect(on.options?.gauntlet).toBe(true);
    const off = parseHeadlessFlags(['--headless', '--task', 'x', '--gauntlet', '--no-gauntlet']);
    expect(off.options?.gauntlet).toBeUndefined();
  });
});

describe('openHeadlessSpine', () => {
  it('records profile + user.message and closes with session.ended', async () => {
    const handle = await openHeadlessSpine({
      sessionId: 'h-a',
      mode: 'kraken',
      profile: 'minimal/v1',
      workspace: tmp,
      baseDir: tmp,
      quiet: true,
    });
    expect(handle.profileId).toBe('minimal/v1');
    handle.userMessage('write a test');
    handle.observe({
      type: 'message_delta',
      messageId: 'm1',
      delta: 'ok',
      id: 'e1',
      ts: 1,
      sessionId: 'h-a',
    });
    handle.observe({
      type: 'message_end',
      messageId: 'm1',
      totalLength: 2,
      finishReason: 'stop',
      id: 'e2',
      ts: 2,
      sessionId: 'h-a',
    });
    await handle.close('completed');
    const report = await readSessionLog(path.join(tmp, 'h-a', 'events.jsonl'));
    const kinds = report.events.map((e) => e.kind);
    expect(kinds[0]).toBe('session.started');
    expect(kinds).toContain('user.message');
    expect(kinds).toContain('assistant.message');
    expect(kinds.at(-1)).toBe('session.ended');
    expect(report.events[0].data.profile).toBe('minimal/v1');
  });

  it('interrupt releases the lock WITHOUT session.ended (resumable)', async () => {
    const handle = await openHeadlessSpine({
      sessionId: 'h-b',
      mode: 'zelari',
      baseDir: tmp,
      quiet: true,
    });
    handle.userMessage('long mission');
    handle.missionPhase('build', 'impl-1');
    await handle.interrupt('SIGINT');
    const report = await readSessionLog(path.join(tmp, 'h-b', 'events.jsonl'));
    expect(report.events.some((e) => e.kind === 'session.ended')).toBe(false);
    expect(report.events.some((e) => e.kind === 'mission.phase')).toBe(true);

    const state = await missionStateFromSpine('h-b', tmp);
    expect(state).not.toBeNull();
    expect(state!.interrupted).toBe(true);
    expect(state!.phase).toBe('build');

    const resumed = await openHeadlessSpine({
      sessionId: 'h-b',
      mode: 'zelari',
      baseDir: tmp,
      quiet: true,
    });
    resumed.userMessage('continue');
    await resumed.close('completed');
    const again = await readSessionLog(path.join(tmp, 'h-b', 'events.jsonl'));
    expect(again.events.some((e) => e.kind === 'session.resumed')).toBe(true);
    again.events.forEach((e, i) => expect(e.seq).toBe(i + 1));
  });

  it('exportSessionById produces zelari-session-export/1', async () => {
    const handle = await openHeadlessSpine({
      sessionId: 'h-c',
      mode: 'council',
      baseDir: tmp,
      quiet: true,
    });
    handle.userMessage('design this');
    await handle.close('completed');
    const exported = await exportSessionById('h-c', tmp);
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    const parsed = JSON.parse(exported.json) as { format: string; version: number; sessionId: string };
    expect(parsed.format).toBe('zelari-session-export');
    expect(parsed.version).toBe(1);
    expect(parsed.sessionId).toBe('h-c');
  });
});
