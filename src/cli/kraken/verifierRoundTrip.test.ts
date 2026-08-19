/**
 * verifierRoundTrip — Desktop verifier round-trip smoke (Exit-3.1, plan §9).
 *
 * Locks the FULL chain the plan requires:
 *
 *   Desktop settings (applySetConfig — the real --set-config channel)
 *     → persist (provider.json)
 *     → restart/load (fresh disk read)
 *     → runtime resolution (loadVerifierModelSelection)
 *     → VerifierService.reviewCompletion
 *     → verification.run event logs the ACTUAL model used
 *
 * The three cases from the plan (§9):
 *   - Inherit:   Primary=A, Verifier=inherit   → effective verifier = A
 *   - Dedicated: Primary=A, Verifier=B         → effective verifier = B
 *   - Reset:     Dedicated B → clear override  → inherit A
 *
 * The model call is stubbed at the transport boundary (callModel), reporting
 * the provider/model the selected transport would actually use: in inherit
 * mode the session transport (A), in fixed mode the dedicated transport (B).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  VerifierService,
  VerifierConfigSchema,
  type ModelSelection,
  type VerifierModelResponse,
} from '@zelari/core/verification';
import { getKrakenVerifierOverride } from '../providerConfig.js';
import { applySetConfig, buildDesktopConfigSnapshot } from '../desktopConfig.js';
import {
  loadVerifierModelSelection,
  verifierOverrideToModelSelection,
} from './verifierResolution.js';

/** Minimal structural view of a spine event (SessionEventInput is not re-exported). */
type SpineEvent = { kind: string; data: Record<string, unknown> };

// Primary model A (the session/run model).
const PRIMARY = { provider: 'grok', model: 'grok-4.6' } as const;
// Dedicated verifier B.
const DEDICATED = { provider: 'anthropic', model: 'claude-sonnet-4-6' } as const;

let tmpDir = '';
let savedEnv: string | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'zelari-vrt-'));
  savedEnv = process.env.ANATHEMA_PROVIDER_CONFIG_FILE;
  process.env.ANATHEMA_PROVIDER_CONFIG_FILE = path.join(tmpDir, 'provider.json');
  writeFileSync(
    process.env.ANATHEMA_PROVIDER_CONFIG_FILE!,
    JSON.stringify(
      {
        activeProviderId: PRIMARY.provider,
        modelByProvider: { [PRIMARY.provider]: PRIMARY.model },
      },
      null,
      2,
    ),
    'utf-8',
  );
  delete process.env.ZELARI_KRAKEN_SELECT_PROVIDER;
  delete process.env.ZELARI_KRAKEN_SELECT_MODEL;
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env.ANATHEMA_PROVIDER_CONFIG_FILE;
  else process.env.ANATHEMA_PROVIDER_CONFIG_FILE = savedEnv;
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Enabled VerifierService from the resolved selection; captures spine events. */
function verifierFor(
  selection: ModelSelection,
  transport: { provider: string; model: string },
  emitted: SpineEvent[],
): VerifierService {
  const config = VerifierConfigSchema.parse({ enabled: true, model: selection });
  return new VerifierService({
    config,
    callModel: async (): Promise<VerifierModelResponse> => ({
      text: '{"verdict":"confirmed","score":0.9,"rationale":"round-trip smoke"}',
      provider: transport.provider,
      model: transport.model,
    }),
    emit: async (input) => {
      emitted.push(input as SpineEvent);
    },
  });
}

describe('Desktop verifier round-trip (Exit-3.1)', () => {
  it('Inherit: Primary=A, Verifier=inherit → effective verifier = A, event logs A', async () => {
    // (1) Desktop settings: no override (the recommended default).
    // (2) Restart/load: fresh disk read → inherit.
    expect(getKrakenVerifierOverride()).toBeUndefined();
    // UI reload leg: the snapshot exposes null = inherit.
    expect(buildDesktopConfigSnapshot().krakenVerifier).toBeNull();
    // (3) Runtime resolution.
    const selection = loadVerifierModelSelection();
    expect(selection).toEqual({ mode: 'inherit' });
    // (4)+(5) Review + spine event: the session transport reports the primary model.
    const emitted: SpineEvent[] = [];
    const verifier = verifierFor(selection, PRIMARY, emitted);
    const review = await verifier.reviewCompletion({
      summary: 'round-trip smoke: all checks green',
      results: [],
      session: { provider: PRIMARY.provider, model: PRIMARY.model },
    });
    expect(review.effectiveModel).toEqual({ mode: 'inherit', ...PRIMARY });
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.kind).toBe('verification.run');
    const data = emitted[0]!.data;
    expect(data.source).toBe('verifier-model');
    expect(data.selectionMode).toBe('inherit');
    expect(data.provider).toBe(PRIMARY.provider);
    expect(data.model).toBe(PRIMARY.model);
  });

  it('Dedicated: Primary=A, Verifier=B → effective verifier = B, event logs B', async () => {
    // (1) Desktop settings → persist through the real --set-config channel.
    const applied = applySetConfig({
      verifierProvider: DEDICATED.provider,
      verifierModel: DEDICATED.model,
    });
    expect(applied.ok).toBe(true);
    // UI reload leg: the snapshot exposes the dedicated override.
    expect(buildDesktopConfigSnapshot().krakenVerifier).toEqual(DEDICATED);
    // (2) Restart/load: fresh disk read.
    expect(getKrakenVerifierOverride()).toEqual(DEDICATED);
    // (3) Runtime resolution.
    const selection = loadVerifierModelSelection();
    expect(selection).toEqual({ mode: 'fixed', ...DEDICATED });
    // (4)+(5) Review + spine: the dedicated transport reports B even though the
    // session model is A — this is the "event logs actual model" lock.
    const emitted: SpineEvent[] = [];
    const verifier = verifierFor(selection, DEDICATED, emitted);
    const review = await verifier.reviewCompletion({
      summary: 'round-trip smoke: all checks green',
      results: [],
      session: { provider: PRIMARY.provider, model: PRIMARY.model },
    });
    expect(review.effectiveModel).toEqual({ mode: 'fixed', ...DEDICATED });
    const data = (emitted[0] as SpineEvent).data;
    expect(data.selectionMode).toBe('fixed');
    expect(data.provider).toBe(DEDICATED.provider);
    expect(data.model).toBe(DEDICATED.model);
  });

  it('Reset: Dedicated B → clear override → inherit A', async () => {
    // Start dedicated, then reset through the real channel.
    const set = applySetConfig({
      verifierProvider: DEDICATED.provider,
      verifierModel: DEDICATED.model,
    });
    expect(set.ok).toBe(true);
    const cleared = applySetConfig({ verifierClear: true });
    expect(cleared.ok).toBe(true);
    // UI reload leg: back to null (inherit).
    expect(buildDesktopConfigSnapshot().krakenVerifier).toBeNull();
    // Restart/load + resolution.
    expect(getKrakenVerifierOverride()).toBeUndefined();
    const selection = loadVerifierModelSelection();
    expect(selection).toEqual({ mode: 'inherit' });
    // Review + spine: back to the primary model A.
    const emitted: SpineEvent[] = [];
    const verifier = verifierFor(selection, PRIMARY, emitted);
    const review = await verifier.reviewCompletion({
      summary: 'round-trip smoke: all checks green',
      results: [],
      session: { provider: PRIMARY.provider, model: PRIMARY.model },
    });
    expect(review.effectiveModel).toEqual({ mode: 'inherit', ...PRIMARY });
    const data = (emitted[0] as SpineEvent).data;
    expect(data.selectionMode).toBe('inherit');
    expect(data.model).toBe(PRIMARY.model);
  });

  it('verifierOverrideToModelSelection: partial/blank overrides degrade to inherit', () => {
    expect(verifierOverrideToModelSelection(undefined)).toEqual({ mode: 'inherit' });
    expect(verifierOverrideToModelSelection(null)).toEqual({ mode: 'inherit' });
    expect(verifierOverrideToModelSelection({ provider: 'grok', model: '   ' })).toEqual({ mode: 'inherit' });
    expect(verifierOverrideToModelSelection({ provider: '', model: 'm' })).toEqual({ mode: 'inherit' });
    // Complete overrides are fixed, trimmed.
    expect(verifierOverrideToModelSelection({ provider: ' grok ', model: ' grok-4.6 ' })).toEqual({
      mode: 'fixed',
      provider: 'grok',
      model: 'grok-4.6',
    });
  });
});
