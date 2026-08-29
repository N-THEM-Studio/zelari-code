/**
 * verifierSettings — Fase 9 settings tests (ADR-0020 §57/§64).
 *
 * Coverage required by the plan:
 *   - old provider.json (no krakenVerifier field) → verifier inherit
 *   - inherit → follows the current run model (parent identity)
 *   - explicit custom verifier → fixed model (survives parent changes)
 *   - missing/invalid custom verifier → parent model fallback
 *   - save/reload round-trip persists the override
 *   - --set-config flag parsing (verifier-provider/model/clear)
 *   - applySetConfig + snapshot exposure (Desktop save/reload)
 *
 * All file I/O is redirected to a temp file via ANATHEMA_PROVIDER_CONFIG_FILE.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  getProviderConfig,
  getKrakenVerifierOverride,
  setKrakenVerifier,
  clearKrakenVerifier,
} from '../providerConfig.js';
import {
  parseSetConfigFlags,
  applySetConfig,
  buildDesktopConfigSnapshot,
} from '../desktopConfig.js';
import { resolveKrakenVerifier } from './verifier.js';

let tmpDir = '';
let savedEnv: string | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'zelari-vf-'));
  savedEnv = process.env.ANATHEMA_PROVIDER_CONFIG_FILE;
  process.env.ANATHEMA_PROVIDER_CONFIG_FILE = path.join(tmpDir, 'provider.json');
  delete process.env.ZELARI_KRAKEN_SELECT_PROVIDER;
  delete process.env.ZELARI_KRAKEN_SELECT_MODEL;
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env.ANATHEMA_PROVIDER_CONFIG_FILE;
  else process.env.ANATHEMA_PROVIDER_CONFIG_FILE = savedEnv;
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Write a provider.json blob (as an old or hand-edited file would look). */
function writeConfigFile(raw: Record<string, unknown>): void {
  writeFileSync(
    process.env.ANATHEMA_PROVIDER_CONFIG_FILE!,
    JSON.stringify(raw, null, 2),
    'utf-8',
  );
}

const OLD_FILE = {
  activeProviderId: 'grok',
  modelByProvider: { grok: 'grok-4.6' },
};

const PARENT = { provider: 'grok', model: 'grok-4.6' };

describe('providerConfig.krakenVerifier', () => {
  it('old provider.json without the field → override undefined (inherit)', () => {
    writeConfigFile(OLD_FILE);
    expect(getKrakenVerifierOverride()).toBeUndefined();
    // inherit resolution: exact parent model, no LLM-config surprise
    expect(resolveKrakenVerifier(PARENT)).toEqual(PARENT);
  });

  it('inherit → follows the current run model', () => {
    writeConfigFile(OLD_FILE);
    const otherParent = { provider: 'glm', model: 'glm-4.6' };
    // no override + no env → whatever model the run resolved wins
    expect(resolveKrakenVerifier(otherParent)).toEqual(otherParent);
  });

  it('explicit custom verifier → fixed model, independent of parent', () => {
    writeConfigFile(OLD_FILE);
    setKrakenVerifier('anthropic', 'claude-sonnet-4-6');
    const override = getKrakenVerifierOverride();
    expect(override).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4-6' });
    // parent changed → verifier stays fixed (the tool passes the persisted
    // override as `explicit` — see krakenSelectTool wiring)
    expect(
      resolveKrakenVerifier(
        { provider: 'grok', model: 'grok-4.6' },
        process.env,
        getKrakenVerifierOverride(),
      ),
    ).toEqual({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
    });
  });

  it('save/reload round-trip: persisted override survives a fresh read', () => {
    writeConfigFile(OLD_FILE);
    setKrakenVerifier('minimax', 'MiniMax-M2.5');
    const reloaded = getProviderConfig();
    expect(reloaded.krakenVerifier).toEqual({ provider: 'minimax', model: 'MiniMax-M2.5' });
  });

  it('invalid overrides on disk are dropped → parent fallback', () => {
    // partial (provider only)
    writeConfigFile({ ...OLD_FILE, krakenVerifier: { provider: 'grok' } });
    expect(getKrakenVerifierOverride()).toBeUndefined();
    // unknown provider
    writeConfigFile({
      ...OLD_FILE,
      krakenVerifier: { provider: 'nope', model: 'm' },
    });
    expect(getKrakenVerifierOverride()).toBeUndefined();
    // empty model
    writeConfigFile({
      ...OLD_FILE,
      krakenVerifier: { provider: 'grok', model: '   ' },
    });
    expect(getKrakenVerifierOverride()).toBeUndefined();
    // non-object garbage
    writeConfigFile({ ...OLD_FILE, krakenVerifier: 'grok' });
    expect(getKrakenVerifierOverride()).toBeUndefined();
    // in every case resolution falls back to the exact parent model
    expect(resolveKrakenVerifier(PARENT)).toEqual(PARENT);
  });

  it('clearKrakenVerifier → back to inherit (no-op when already inherit)', () => {
    writeConfigFile(OLD_FILE);
    setKrakenVerifier('grok', 'grok-4.6');
    clearKrakenVerifier();
    expect(getKrakenVerifierOverride()).toBeUndefined();
    expect(() => clearKrakenVerifier()).not.toThrow();
  });

  it('setKrakenVerifier validates provider and model', () => {
    writeConfigFile(OLD_FILE);
    expect(() => setKrakenVerifier('nope', 'm')).toThrow(/Unknown provider id/);
    expect(() => setKrakenVerifier('grok', '  ')).toThrow(/cannot be empty/);
  });

  it('env override still wins when no persisted config exists', () => {
    writeConfigFile(OLD_FILE);
    const resolved = resolveKrakenVerifier(PARENT, {
      ZELARI_KRAKEN_SELECT_PROVIDER: 'deepseek',
      ZELARI_KRAKEN_SELECT_MODEL: 'deepseek-v4-pro',
    } as NodeJS.ProcessEnv);
    expect(resolved).toEqual({ provider: 'deepseek', model: 'deepseek-v4-pro' });
  });

  it('persisted override is passed as `explicit` → beats env', () => {
    writeConfigFile(OLD_FILE);
    setKrakenVerifier('glm', 'glm-4.6');
    const resolved = resolveKrakenVerifier(
      PARENT,
      {
        ZELARI_KRAKEN_SELECT_PROVIDER: 'deepseek',
        ZELARI_KRAKEN_SELECT_MODEL: 'deepseek-v4-pro',
      } as NodeJS.ProcessEnv,
      getKrakenVerifierOverride(),
    );
    expect(resolved).toEqual({ provider: 'glm', model: 'glm-4.6' });
  });
});

describe('parseSetConfigFlags — verifier flags', () => {
  it('valid: --verifier-provider + --verifier-model together', () => {
    const res = parseSetConfigFlags([
      '--set-config',
      '--verifier-provider',
      'anthropic',
      '--verifier-model',
      'claude-sonnet-4-6',
    ]);
    expect(res.error).toBeUndefined();
    expect(res.request?.verifierProvider).toBe('anthropic');
    expect(res.request?.verifierModel).toBe('claude-sonnet-4-6');
    expect(res.request?.verifierClear).toBeUndefined();
  });

  it('valid: --verifier-clear alone', () => {
    const res = parseSetConfigFlags(['--set-config', '--verifier-clear']);
    expect(res.error).toBeUndefined();
    expect(res.request?.verifierClear).toBe(true);
    expect(res.request?.verifierProvider).toBeUndefined();
  });

  it('provider without model → error', () => {
    const res = parseSetConfigFlags(['--set-config', '--verifier-provider', 'grok']);
    expect(res.request).toBeNull();
    expect(res.error).toMatch(/must be used together/);
  });

  it('model without provider → error', () => {
    const res = parseSetConfigFlags(['--set-config', '--verifier-model', 'm']);
    expect(res.request).toBeNull();
    expect(res.error).toMatch(/must be used together/);
  });

  it('clear + provider/model → conflict error', () => {
    const res = parseSetConfigFlags([
      '--set-config',
      '--verifier-clear',
      '--verifier-provider',
      'grok',
      '--verifier-model',
      'm',
    ]);
    expect(res.request).toBeNull();
    expect(res.error).toMatch(/conflicts/);
  });

  it('empty values → error', () => {
    const a = parseSetConfigFlags([
      '--set-config',
      '--verifier-provider',
      ' ',
      '--verifier-model',
      'm',
    ]);
    expect(a.error).toMatch(/cannot be empty/);
    const b = parseSetConfigFlags([
      '--set-config',
      '--verifier-provider',
      'grok',
      '--verifier-model',
      '',
    ]);
    expect(b.error).toMatch(/cannot be empty/);
  });

  it('no flags at all → still an error (same as before)', () => {
    const res = parseSetConfigFlags(['--set-config']);
    expect(res.request).toBeNull();
    expect(res.error).toMatch(/at least one of/);
  });
});

describe('applySetConfig + snapshot — verifier persistence', () => {
  it('set via flags → persisted → snapshot exposes it', () => {
    writeConfigFile(OLD_FILE);
    const res = applySetConfig({
      verifierProvider: 'anthropic',
      verifierModel: 'claude-sonnet-4-6',
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.message).toContain('verifier=anthropic/claude-sonnet-4-6');

    const snap = buildDesktopConfigSnapshot();
    expect(snap.krakenVerifier).toEqual({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
    });
    // save/reload equality (Desktop round-trip)
    expect(getKrakenVerifierOverride()).toEqual(snap.krakenVerifier);
  });

  it('unknown verifier provider → explicit error, nothing persisted', () => {
    writeConfigFile(OLD_FILE);
    const res = applySetConfig({ verifierProvider: 'nope', verifierModel: 'm' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/unknown verifier provider/);
    expect(getKrakenVerifierOverride()).toBeUndefined();
  });

  it('clear via flags → snapshot back to null (inherit)', () => {
    writeConfigFile(OLD_FILE);
    setKrakenVerifier('grok', 'grok-4.6');
    const res = applySetConfig({ verifierClear: true });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.message).toContain('verifier=inherit');
    expect(buildDesktopConfigSnapshot().krakenVerifier).toBeNull();
  });

  it('fresh install (no file) → snapshot krakenVerifier null, inherit default', () => {
    // no config file written in this tmp dir
    const snap = buildDesktopConfigSnapshot();
    expect(snap.krakenVerifier).toBeNull();
  });
});
