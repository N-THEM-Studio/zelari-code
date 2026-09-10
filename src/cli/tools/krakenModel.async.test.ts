/**
 * krakenModel async routing — the production path used by
 * `createKrakenSubAgentContextFactory` (toolRegistry.ts).
 *
 * These tests exercise `resolveKrakenSubModelAsync` against a REAL discovery
 * cache read from disk: no module mock — `ANATHEMA_MODELS_FILE` points at a
 * temp `models.json` (same isolation trick as tests/unit/v3-U-modelDiscovery).
 * That proves both routing options are actually live (cheap auto-pick for
 * explore/verify, cross-family pick for verify) and that the fail-open path —
 * missing/damaged registry → parent model — is untouched.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  familyCandidatesFromRegistry,
  parseQualifiedModelRef,
  resolveKrakenSubModel,
  resolveKrakenSubModelAsync,
} from './krakenModel.js';
import { AuditLogger } from '../safety/auditLogger.js';
import { setApiKey } from '../keyStore.js';
import { createKrakenSubAgentContextFactory } from '../toolRegistry.js';

let dir: string;
let modelsFile: string;
/** Env vars touched by this file → previous value (restored after each test). */
const savedEnv: Record<string, string | undefined> = {};

beforeEach(async () => {
  dir = path.join(os.tmpdir(), `zelari-kraken-async-${Date.now()}-${Math.random()}`);
  modelsFile = path.join(dir, 'models.json');
  await fs.mkdir(dir, { recursive: true });
  // Isolate EVERY bit of ambient state the production factory reads — discovery
  // cache, keystore, provider config and the API-key env vars. Without the
  // explicit API keys the E2E below would silently depend on the developer's
  // real ~/.zelari-code (or on a GROK/GLM_API_KEY in the shell) and flip in a
  // sanitized/CI environment.
  const overrides: Record<string, string> = {
    ANATHEMA_MODELS_FILE: modelsFile,
    ANATHEMA_KEYSTORE_FILE: path.join(dir, 'keys.json'),
    ANATHEMA_PROVIDER_CONFIG_FILE: path.join(dir, 'provider.json'),
    GROK_API_KEY: 'test-key-grok',
    GLM_API_KEY: 'test-key-glm',
  };
  for (const [key, value] of Object.entries(overrides)) {
    savedEnv[key] = process.env[key];
    process.env[key] = value;
  }
  setApiKey('grok', 'test-key-grok');
  setApiKey('glm', 'test-key-glm');
});

afterEach(async () => {
  for (const [key, previous] of Object.entries(savedEnv)) {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
});

/** Write a FLAT registry (provider id → discovered models) to the temp file. */
async function writeRegistry(entries: Record<string, string[]>): Promise<void> {
  const registry: Record<string, unknown> = {};
  for (const [provider, models] of Object.entries(entries)) {
    registry[provider] = {
      models: models.map((id) => ({ id })),
      fetchedAt: Date.now(),
      baseUrl: 'https://example.invalid/v1',
    };
  }
  await fs.mkdir(path.dirname(modelsFile), { recursive: true });
  await fs.writeFile(modelsFile, JSON.stringify(registry, null, 2), 'utf-8');
}

describe('familyCandidatesFromRegistry', () => {
  it('flattens the flat registry into provider/model pairs (order preserved)', () => {
    expect(
      familyCandidatesFromRegistry({
        grok: { models: [{ id: 'grok-4' }, { id: 'grok-3-mini' }] },
        glm: { models: [{ id: 'glm-4.6' }] },
      }),
    ).toEqual([
      { provider: 'grok', model: 'grok-4' },
      { provider: 'grok', model: 'grok-3-mini' },
      { provider: 'glm', model: 'glm-4.6' },
    ]);
  });

  it('accepts bare string ids (hand-edited models.json)', () => {
    expect(familyCandidatesFromRegistry({ grok: { models: ['grok-4'] } })).toEqual([
      { provider: 'grok', model: 'grok-4' },
    ]);
  });

  it('skips malformed entries instead of throwing (fail-open)', () => {
    expect(familyCandidatesFromRegistry(null)).toEqual([]);
    expect(familyCandidatesFromRegistry('not-a-registry')).toEqual([]);
    expect(
      familyCandidatesFromRegistry({
        '': { models: [{ id: 'grok-4' }] },
        noModels: {},
        badModels: { models: 'grok-4' },
        blankId: { models: [{ id: '   ' }, { id: 42 }] },
        ok: { models: [{ id: 'glm-4.6' }] },
      }),
    ).toEqual([{ provider: 'ok', model: 'glm-4.6' }]);
  });
});

describe('resolveKrakenSubModelAsync — cheap auto-pick (explore)', () => {
  it('explore picks the cheap model of the active provider', async () => {
    await writeRegistry({ grok: ['grok-4', 'grok-3-mini'] });
    expect(
      await resolveKrakenSubModelAsync('explore', 'grok-4', {}, { provider: 'grok' }),
    ).toBe('grok-3-mini');
  });

  it('general stays on the parent model (strong writer)', async () => {
    await writeRegistry({ grok: ['grok-4', 'grok-3-mini'] });
    expect(
      await resolveKrakenSubModelAsync('general', 'grok-4', {}, { provider: 'grok' }),
    ).toBe('grok-4');
  });

  it('explore keeps the parent when the active provider has no cheap model', async () => {
    // No cheap-looking id at all (no mini/flash/lite/…) → no auto-pick.
    await writeRegistry({ grok: ['grok-4'] });
    expect(
      await resolveKrakenSubModelAsync('explore', 'grok-4', {}, { provider: 'grok' }),
    ).toBe('grok-4');
  });

  it("explore never switches provider: another provider's cheap model is ignored", async () => {
    await writeRegistry({ grok: ['grok-4'], glm: ['glm-4.6-air'] });
    const picked = await resolveKrakenSubModelAsync('explore', 'grok-4', {}, {
      provider: 'grok',
    });
    expect(picked).toBe('grok-4');
    expect(parseQualifiedModelRef(picked)).toBeNull();
  });

  it('ZELARI_KRAKEN_AUTO_MODEL=0 → always the parent model', async () => {
    await writeRegistry({ grok: ['grok-4', 'grok-3-mini'] });
    const env = { ZELARI_KRAKEN_AUTO_MODEL: '0' };
    expect(
      await resolveKrakenSubModelAsync('explore', 'grok-4', env, { provider: 'grok' }),
    ).toBe('grok-4');
    expect(
      await resolveKrakenSubModelAsync('verify', 'grok-4', env, { provider: 'grok' }),
    ).toBe('grok-4');
  });
});

describe('resolveKrakenSubModelAsync — cross-family verify', () => {
  it('verify resolves a QUALIFIED cross-family ref from a second provider', async () => {
    await writeRegistry({ grok: ['grok-4', 'grok-3-mini'], glm: ['glm-4.6'] });
    const picked = await resolveKrakenSubModelAsync('verify', 'grok-4', {}, {
      provider: 'grok',
    });
    expect(picked).toBe('glm/glm-4.6');
    expect(parseQualifiedModelRef(picked)).toEqual({ provider: 'glm', model: 'glm-4.6' });
  });

  it('verify stays on the parent when every discovered provider shares the family', async () => {
    await writeRegistry({ grok: ['grok-4'], 'openai-compatible': ['grok-4-fast'] });
    expect(
      await resolveKrakenSubModelAsync('verify', 'grok-4', {}, { provider: 'grok' }),
    ).toBe('grok-4');
  });

  it('explore never gets a cross-family ref (verify-only feature)', async () => {
    await writeRegistry({ grok: ['grok-4'], glm: ['glm-4.6'] });
    const picked = await resolveKrakenSubModelAsync('explore', 'grok-4', {}, {
      provider: 'grok',
    });
    expect(picked).toBe('grok-4');
    expect(parseQualifiedModelRef(picked)).toBeNull();
  });

  it('ZELARI_KRAKEN_CROSS_MODEL=0 opts out (auto-pick keeps working)', async () => {
    await writeRegistry({ grok: ['grok-4', 'grok-3-mini'], glm: ['glm-4.6'] });
    expect(
      await resolveKrakenSubModelAsync('verify', 'grok-4', { ZELARI_KRAKEN_CROSS_MODEL: '0' }, {
        provider: 'grok',
      }),
    ).toBe('grok-3-mini');
  });

  it('both kill-switches off → parent model', async () => {
    await writeRegistry({ grok: ['grok-4', 'grok-3-mini'], glm: ['glm-4.6'] });
    expect(
      await resolveKrakenSubModelAsync(
        'verify',
        'grok-4',
        { ZELARI_KRAKEN_CROSS_MODEL: '0', ZELARI_KRAKEN_AUTO_MODEL: '0' },
        { provider: 'grok' },
      ),
    ).toBe('grok-4');
  });

  it('cross-family works from the parent model id alone (no provider hint)', async () => {
    await writeRegistry({ glm: ['glm-4.6'] });
    expect(await resolveKrakenSubModelAsync('verify', 'grok-4', {})).toBe('glm/glm-4.6');
    // …but without a provider hint there is no candidate list for explore.
    expect(await resolveKrakenSubModelAsync('explore', 'grok-4', {})).toBe('grok-4');
  });

  it('explicit kind-specific env still wins over discovery', async () => {
    await writeRegistry({ grok: ['grok-4', 'grok-3-mini'], glm: ['glm-4.6'] });
    expect(
      await resolveKrakenSubModelAsync(
        'verify',
        'grok-4',
        { ZELARI_KRAKEN_VERIFY_MODEL: 'glm/glm-5' },
        { provider: 'grok' },
      ),
    ).toBe('glm/glm-5');
  });
});

describe('resolveKrakenSubModelAsync — fail-open (no registry)', () => {
  it('missing registry file → parent, bit-identical to the sync resolver', async () => {
    // modelsFile was never written: loadModelsRegistry() → {}.
    for (const agent of ['explore', 'verify', 'general'] as const) {
      const viaAsync = await resolveKrakenSubModelAsync(agent, 'lead-model', {}, {
        provider: 'grok',
      });
      expect(viaAsync).toBe(resolveKrakenSubModel(agent, 'lead-model', {}));
      expect(viaAsync).toBe('lead-model');
    }
  });

  it('damaged registry file → parent (fail-open)', async () => {
    await fs.mkdir(path.dirname(modelsFile), { recursive: true });
    await fs.writeFile(modelsFile, '{ not json', 'utf-8');
    expect(
      await resolveKrakenSubModelAsync('verify', 'grok-4', {}, { provider: 'grok' }),
    ).toBe('grok-4');
    expect(
      await resolveKrakenSubModelAsync('explore', 'grok-4', {}, { provider: 'grok' }),
    ).toBe('grok-4');
  });

  it('empty registry object → parent even with auto-pick enabled', async () => {
    await writeRegistry({});
    expect(
      await resolveKrakenSubModelAsync(
        'explore',
        'grok-4',
        { ZELARI_KRAKEN_AUTO_MODEL: '1' },
        { provider: 'grok' },
      ),
    ).toBe('grok-4');
  });
});

/**
 * End-to-end through the REAL production wiring (toolRegistry): proves the
 * routing options are actually passed, i.e. a tentacle no longer always runs
 * on the lead's flagship model.
 */
describe('production call-site — createKrakenSubAgentContextFactory', () => {
  const factory = () =>
    createKrakenSubAgentContextFactory({
      root: dir,
      audit: new AuditLogger(path.join(dir, 'audit.jsonl')),
      sessionId: 'kraken-routing-e2e',
      provider: 'grok',
      model: 'grok-4.6',
    });

  it('explore → cheap model, verify → cross-family provider, general → lead model', async () => {
    await writeRegistry({ grok: ['grok-4.6', 'grok-3-mini'], glm: ['glm-4.6'] });
    const create = factory();

    const explore = await create({ agent: 'explore', cwd: dir });
    expect(explore?.model).toBe('grok-3-mini');
    expect(explore?.provider).toBe('grok');

    const verify = await create({ agent: 'verify', cwd: dir });
    expect(verify?.provider).toBe('glm');
    expect(verify?.model).toBe('glm-4.6');
    // Fallback (404 retry / fail-open) still points at the lead model.
    expect(verify?.fallback?.model).toBe('grok-4.6');

    const general = await create({ agent: 'general', cwd: dir });
    expect(general?.model).toBe('grok-4.6');
    expect(general?.provider).toBe('grok');
  });

  it('no registry → every tentacle keeps the lead model and no fallback override', async () => {
    const create = factory();
    for (const agent of ['explore', 'verify', 'general'] as const) {
      const ctx = await create({ agent, cwd: dir });
      expect(ctx?.model).toBe('grok-4.6');
      expect(ctx?.provider).toBe('grok');
      expect(ctx?.fallback).toBeUndefined();
    }
  });

  it('kill-switches are honored through the real call-site', async () => {
    await writeRegistry({ grok: ['grok-4.6', 'grok-3-mini'], glm: ['glm-4.6'] });
    process.env.ZELARI_KRAKEN_AUTO_MODEL = '0';
    process.env.ZELARI_KRAKEN_CROSS_MODEL = '0';
    try {
      const create = factory();
      for (const agent of ['explore', 'verify'] as const) {
        const ctx = await create({ agent, cwd: dir });
        expect(ctx?.model).toBe('grok-4.6');
        expect(ctx?.provider).toBe('grok');
      }
    } finally {
      delete process.env.ZELARI_KRAKEN_AUTO_MODEL;
      delete process.env.ZELARI_KRAKEN_CROSS_MODEL;
    }
  });
});
