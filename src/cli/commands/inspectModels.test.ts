/**
 * inspectModels.test.ts — t161 MODELS section.
 *
 * Covers: the explain priority walk (single source of truth with the
 * resolver), the defensive spine usage collector, and the /inspect
 * integration (human + --json) using the sessionsDir stub pattern from
 * inspectSession.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  __resetGeneralSubModelWarnForTests,
  explainKrakenSubModel,
  resolveKrakenSubModel,
} from '../tools/krakenModel.js';
import { buildModelsSection, collectModelUsage } from './inspectModels.js';
import { runInspect } from './inspect.js';

const env = (over: Record<string, string | undefined>) => over as NodeJS.ProcessEnv;

describe('explainKrakenSubModel — priority walk (t161a)', () => {
  beforeEach(() => __resetGeneralSubModelWarnForTests());

  it('kind-specific env wins (this is where the Desktop prefs land)', () => {
    const e = env({ ZELARI_KRAKEN_EXPLORE_MODEL: 'm-explicit' });
    expect(explainKrakenSubModel('explore', 'parent-m', e)).toEqual({
      model: 'm-explicit',
      source: 'env:kind',
    });
  });

  it('shared SUB_MODEL applies to explore/verify', () => {
    const e = env({ ZELARI_KRAKEN_SUB_MODEL: 'm-sub' });
    expect(explainKrakenSubModel('explore', 'parent-m', e).model).toBe('m-sub');
    expect(explainKrakenSubModel('verify', 'parent-m', e).source).toBe('env:sub');
  });

  it('general ignores SUB_MODEL unless GENERAL_USES_SUB=1 — and says so', () => {
    const e = env({ ZELARI_KRAKEN_SUB_MODEL: 'm-sub' });
    const ex = explainKrakenSubModel('general', 'parent-m', e, { silent: true });
    expect(ex.model).toBe('parent-m');
    expect(ex.source).toContain('GENERAL_USES_SUB=1');
    const optedIn = env({
      ZELARI_KRAKEN_SUB_MODEL: 'm-sub',
      ZELARI_KRAKEN_GENERAL_USES_SUB: '1',
    });
    expect(explainKrakenSubModel('general', 'parent-m', optedIn, { silent: true }).model).toBe(
      'm-sub',
    );
  });

  it('verify can cross provider families when candidates exist', () => {
    const ex = explainKrakenSubModel('verify', 'glm-5.3', env({}), {
      provider: 'glm',
      familyCandidates: [{ provider: 'grok', model: 'grok-4.6' }],
    });
    expect(ex.model).toBe('grok/grok-4.6');
    expect(ex.source).toBe('cross-family');
  });

  it('auto-pick selects a cheap candidate for explore/verify', () => {
    const ex = explainKrakenSubModel('explore', 'parent-m', env({}), {
      candidates: ['parent-m', 'mini-fast-model'],
    });
    expect(ex.model).toBe('mini-fast-model');
    expect(ex.source).toBe('auto-pick');
  });

  it('falls back to the parent model with source "parent"', () => {
    expect(explainKrakenSubModel('general', 'parent-m', env({}))).toEqual({
      model: 'parent-m',
      source: 'parent',
    });
  });

  it('resolveKrakenSubModel stays the .model of the explain (no drift)', () => {
    const cases: Array<[Parameters<typeof explainKrakenSubModel>[0], string]> = [
      ['explore', 'parent-m'],
      ['verify', 'parent-m'],
      ['general', 'parent-m'],
    ];
    for (const [kind, parent] of cases) {
      const e = env({ ZELARI_KRAKEN_SUB_MODEL: 'm-sub' });
      expect(resolveKrakenSubModel(kind, parent, e)).toBe(
        explainKrakenSubModel(kind, parent, e, { silent: true }).model,
      );
    }
  });
});

describe('collectModelUsage — defensive spine scan (t161b)', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'zelari-models-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const envelope = (seq: number, kind: string, data: Record<string, unknown>) => ({
    schemaVersion: 1,
    sessionId: 'sess-test',
    seq,
    ts: 1_700_000_000_000 + seq,
    kind,
    actor: { type: 'system' },
    data,
  });

  function writeSession(id: string, lines: unknown[]): string {
    const dir = path.join(root, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'events.jsonl'),
      lines.map((l) => JSON.stringify(l)).join('\n') + '\n',
      'utf8',
    );
    return dir;
  }

  it('counts lead (note agent_start) and tentacle (subagent.metrics) models', async () => {
    writeSession('00000000-0000-4000-8000-000000000001', [
      envelope(1, 'note', { note: 'agent_start', model: 'lead-a', provider: 'glm' }),
      envelope(2, 'subagent.metrics', { kind: 'explore', ok: true, model: 'tent-b' }),
      'this line is not json at all',
    ]);
    const report = await collectModelUsage(root);
    expect(report.totalSessions).toBe(1);
    expect(report.scannedSessions).toBe(1);
    expect(report.unreadableSessions).toBe(0);
    expect(report.counts).toEqual([
      { model: 'lead-a', lead: 1, tentacle: 0 },
      { model: 'tent-b', lead: 0, tentacle: 1 },
    ]);
  });

  it('skips dot-dirs, non-UUID dirs and events without a usable model', async () => {
    fs.mkdirSync(path.join(root, '.zelari'), { recursive: true }); // broken-junction stand-in
    fs.mkdirSync(path.join(root, 'not-a-uuid'), { recursive: true });
    writeSession('00000000-0000-4000-8000-000000000002', [
      envelope(1, 'note', { note: 'agent_start' }), // no model → not counted
      envelope(2, 'note', { note: 'other-note', model: 'x' }), // not agent_start → not counted
      envelope(3, 'verification.run', { status: 'UNEVALUATED' }), // no model by contract
    ]);
    const report = await collectModelUsage(root);
    expect(report.totalSessions).toBe(1);
    expect(report.counts).toEqual([]);
  });

  it('returns an empty report for a missing directory (no throw)', async () => {
    const report = await collectModelUsage(path.join(root, 'does-not-exist'));
    expect(report.totalSessions).toBe(0);
    expect(report.counts).toEqual([]);
  });

  it('buildModelsSection degrades instead of throwing (empty workspace)', async () => {
    const section = await buildModelsSection({ cwd: root });
    expect(section.perKind).toHaveLength(3);
    expect(section.usage.totalSessions).toBe(0);
    for (const k of section.perKind) {
      expect(typeof k.model).toBe('string');
      expect(k.model.length).toBeGreaterThan(0);
      expect(k.source.length).toBeGreaterThan(0);
    }
  });
});

describe('inspect MODELS section — integration (t161c)', () => {
  let root: string;
  let prevSessionsDir: string | undefined;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'zelari-inspect-models-'));
    prevSessionsDir = process.env.ZELARI_SESSIONS_DIR;
    process.env.ZELARI_SESSIONS_DIR = root; // empty spine — honest zeros
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    if (prevSessionsDir === undefined) delete process.env.ZELARI_SESSIONS_DIR;
    else process.env.ZELARI_SESSIONS_DIR = prevSessionsDir;
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('human output renders lead, per-kind routing and honest history', async () => {
    const code = await runInspect({ cwd: root });
    expect(code).toBe(0);
    const out = logSpy.mock.calls[0]?.[0] as string;
    expect(out).toContain('models:');
    expect(out).toContain('lead:');
    expect(out).toContain('explore:');
    expect(out).toContain('verify:');
    expect(out).toContain('general:');
    expect(out).toContain('(no model events yet)');
    expect(out).toContain('[0/0 sessions scanned]');
  });

  it('--json exposes the models field with 3 kinds', async () => {
    await runInspect({ json: true, cwd: root });
    const parsed = JSON.parse(logSpy.mock.calls[0]?.[0] as string) as {
      models: { perKind: unknown[]; usage: { counts: unknown[] } };
    };
    expect(parsed.models.perKind).toHaveLength(3);
    expect(Array.isArray(parsed.models.usage.counts)).toBe(true);
  });
});
