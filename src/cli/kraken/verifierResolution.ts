/**
 * kraken/verifierResolution.ts — Desktop verifier override → 2.0 VerifierService
 * model selection (ADR-0023 × ADR-0020 Fase 9; plan §9 / Exit-3.1).
 *
 * The Desktop "Kraken — Verification model" selector persists its choice in
 * provider.json (`krakenVerifier`): absent/null = "Same as current model"
 * (inherit — the recommended default), {provider, model} = dedicated verifier.
 *
 * This module is the ONLY place that maps the persisted override onto the
 * VerifierService `ModelSelection` contract, so the runtime resolution chain
 *
 *   Desktop settings → persist → restart/load → resolution → event logs model
 *
 * has a single, testable seam (see verifierRoundTrip.test.ts).
 */
import type { ModelSelection } from '@zelari/core/verification';
import { getKrakenVerifierOverride } from '../providerConfig.js';

/** Shape persisted by providerConfig (structurally KrakenVerifierOverride). */
export interface VerifierOverrideLike {
  provider: string;
  model: string;
}

/**
 * Override → ModelSelection. A complete, non-empty {provider, model} pair is
 * `fixed`; anything else (undefined, null, partial, blank) is `inherit` —
 * matching providerConfig, which already drops invalid overrides on load.
 */
export function verifierOverrideToModelSelection(
  override?: VerifierOverrideLike | null,
): ModelSelection {
  if (
    override &&
    typeof override.provider === 'string' &&
    typeof override.model === 'string' &&
    override.provider.trim().length > 0 &&
    override.model.trim().length > 0
  ) {
    return {
      mode: 'fixed',
      provider: override.provider.trim(),
      model: override.model.trim(),
    };
  }
  return { mode: 'inherit' };
}

/**
 * Live runtime resolution: read provider.json the way a fresh process would
 * after a Desktop restart and map it to the VerifierService model selection.
 */
export function loadVerifierModelSelection(): ModelSelection {
  return verifierOverrideToModelSelection(getKrakenVerifierOverride());
}
