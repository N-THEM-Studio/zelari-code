/**
 * userSettings.test — layered zelari.config.json resolution (Fase 3, B12).
 * Covers: defaults, user<project file precedence, env override, invalid-layer
 * fail-open, overrides/report surfaces.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  printSettingsReport,
  resolveUserSettings,
  SETTINGS_FILE_NAME,
  settingsOverrides,
} from './userSettings.js';

const MANAGED_ENV = [
  'ZELARI_HOOKS_FAILURE',
  'ZELARI_STRICT_DONE',
  'ZELARI_MISSION_STRICT',
  'ZELARI_MEMORY',
  'ZELARI_MAX_TOOL_LOOP_HARD',
  'ZELARI_MODE_MAX_TOOLS_AGENT',
  'ZELARI_PERMISSION_EXECUTE',
  'ZELARI_PERMISSION_NETWORK',
  'ZELARI_EVOLUTION',
] as const;

let home: string;
let cwd: string;
const savedEnv = new Map<string, string | undefined>();
const savedHome = process.env.ZELARI_HOME;

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'zelari-settings-home-'));
  cwd = mkdtempSync(path.join(tmpdir(), 'zelari-settings-cwd-'));
  process.env.ZELARI_HOME = home;
  for (const k of MANAGED_ENV) {
    savedEnv.set(k, process.env[k]);
    delete process.env[k];
  }
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
  if (savedHome === undefined) delete process.env.ZELARI_HOME;
  else process.env.ZELARI_HOME = savedHome;
  for (const [k, v] of savedEnv) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  savedEnv.clear();
});

describe('resolveUserSettings', () => {
  it('falls back to documented defaults when no layer exists', () => {
    const r = resolveUserSettings({ cwd });
    expect(r.entries.evolution?.value).toBe('0');
    expect(r.entries.permissionExecute?.value).toBe('ask');
    expect(r.entries.hooksFailure?.value).toBe('fail-open');
    expect(r.entries.memory?.value).toBeUndefined();
    expect(r.warnings).toEqual([]);
  });

  it('applies the user file, then lets the project file win', () => {
    writeFileSync(path.join(home, SETTINGS_FILE_NAME), JSON.stringify({ hooksFailure: 'fail-closed', strictDone: true }), 'utf8');
    mkdirSync(path.join(cwd, '.zelari'), { recursive: true });
    writeFileSync(path.join(cwd, '.zelari', SETTINGS_FILE_NAME), JSON.stringify({ hooksFailure: 'fail-open', strictDone: false }), 'utf8');
    const r = resolveUserSettings({ cwd });
    expect(r.entries.hooksFailure?.origin).toBe('project');
    expect(r.entries.hooksFailure?.value).toBe('fail-open');
    expect(r.entries.strictDone?.origin).toBe('project');
    expect(r.entries.strictDone?.value).toBe(false);
  });

  it('env beats both files', () => {
    writeFileSync(path.join(home, SETTINGS_FILE_NAME), JSON.stringify({ evolution: 'shadow' }), 'utf8');
    process.env.ZELARI_EVOLUTION = '0';
    const r = resolveUserSettings({ cwd });
    expect(r.entries.evolution?.origin).toBe('env');
    expect(r.entries.evolution?.value).toBe('0');
  });

  it('invalid JSON in a layer: warning + layer ignored (fail-open)', () => {
    writeFileSync(path.join(home, SETTINGS_FILE_NAME), '{not json', 'utf8');
    const r = resolveUserSettings({ cwd });
    expect(r.warnings.length).toBeGreaterThan(0);
    expect(r.entries.hooksFailure?.origin).toBe('default');
  });

  it('schema-invalid values are rejected, unknown keys stripped', () => {
    writeFileSync(
      path.join(home, SETTINGS_FILE_NAME),
      JSON.stringify({ hooksFailure: 'sometimes', totallyUnknown: 1 }),
      'utf8',
    );
    const r = resolveUserSettings({ cwd });
    expect(r.warnings.join('\n')).toContain('schema validation failed');
    expect(r.entries.hooksFailure?.origin).toBe('default');
  });
});

describe('settingsOverrides / printSettingsReport', () => {
  it('overrides expose only non-default values', () => {
    process.env.ZELARI_STRICT_DONE = '0';
    const r = resolveUserSettings({ cwd });
    expect(settingsOverrides(r)).toEqual({ strictDone: false });
  });

  it('report shows every leaf with its origin and the layer paths', () => {
    process.env.ZELARI_STRICT_DONE = '0';
    const report = printSettingsReport({ cwd });
    expect(report).toContain('ZELARI_STRICT_DONE');
    expect(report).toContain('evolution');
    expect(report).toContain(SETTINGS_FILE_NAME);
    expect(report).toContain('default < user < project < env');
  });
});
