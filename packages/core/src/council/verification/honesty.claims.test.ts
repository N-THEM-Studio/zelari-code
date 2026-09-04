/**
 * honesty.claims.test — claim-level evidence matching (Fase 4, ADR-0023/P1).
 * Contract under test:
 *   - only traceable tiers (tool/command/fs) can clear a claim;
 *   - advisory tiers (verifier-llm, human) never clear a claim;
 *   - legacy whole-text behaviour is unchanged when no evidence is passed.
 *
 * Documented legacy quirks (behaviour preserved, NOT bugs we fix here):
 *   - an isolated '✓' is not a claim (`\b✓\b` can never match);
 *   - EVIDENCE_MARKERS_RE matches `evidence:x` only with NO space after the
 *     colon (`\bevidence:\b` needs a word char right after ':').
 */
import { describe, expect, it } from 'vitest';
import type { EvidenceRef, EvidenceRefTier } from '../../verification/types.js';
import { extractVerificationClaims, lintSynthesisHonesty, matchClaimsToEvidence } from './honesty.js';

const ev = (ref: string, tier: EvidenceRefTier = 'fs-observation'): EvidenceRef => ({
  tier,
  ref,
  capturedAt: 0,
});

describe('extractVerificationClaims', () => {
  it('extracts only the sentences that assert verification', () => {
    const claims = extractVerificationClaims(
      'Ho modificato due file. I test sono verificati e verdi. Nessuna regressione.',
    );
    expect(claims).toHaveLength(2);
  });

  it('returns [] for clean text and empty input', () => {
    expect(extractVerificationClaims('Ho aggiunto una funzione.')).toEqual([]);
    expect(extractVerificationClaims(undefined)).toEqual([]);
    expect(extractVerificationClaims('   ')).toEqual([]);
  });

  it('an isolated ✓ is not a claim (legacy \\b behaviour, preserved)', () => {
    expect(extractVerificationClaims('Fatto tutto. ✓')).toEqual([]);
  });
});

describe('matchClaimsToEvidence', () => {
  it('clears a claim when a traceable EvidenceRef shares a concrete token', () => {
    const claims = matchClaimsToEvidence(
      ['Test verificati su src/cli/paths.ts.'],
      [ev('bash: vitest run src/cli/paths.ts', 'command-output')],
    );
    expect(claims[0]?.matched).toBe(true);
    expect(claims[0]?.tier).toBe('command-output');
  });

  it('sentence-final punctuation does not break token matching', () => {
    const claims = matchClaimsToEvidence(
      ['Verificato con build di src/app.ts.'],
      [ev('bash: tsc -p src/app.ts', 'command-output')],
    );
    expect(claims[0]?.matched).toBe(true);
  });

  it('advisory tiers never clear a claim (verifier-llm)', () => {
    const claims = matchClaimsToEvidence(['Nessuna regressione'], [ev('verifier says ok', 'verifier-llm')]);
    expect(claims[0]?.matched).toBe(false);
    expect(claims[0]?.tier).toBe('claimed');
  });

  it('prose-only claims with unrelated evidence stay claimed', () => {
    const claims = matchClaimsToEvidence(['Tutto verificato'], [ev('bash: npm run build', 'command-output')]);
    expect(claims[0]?.matched).toBe(false);
    expect(claims[0]?.tier).toBe('claimed');
  });
});

describe('lintSynthesisHonesty', () => {
  it('flags claims without traceable evidence when evidence is provided', () => {
    const res = lintSynthesisHonesty('Tutto verificato e confermato.', [ev('bash: npm test', 'command-output')]);
    expect(res).toHaveLength(1);
    expect(res[0]?.id).toBe('synthesis.honesty');
    expect(res[0]?.ok).toBe(false);
  });

  it('passes when every claim is backed by traceable evidence', () => {
    const res = lintSynthesisHonesty(
      'Verificato con build di src/app.ts.',
      [ev('bash: tsc -p src/app.ts', 'command-output')],
    );
    expect(res).toEqual([]);
  });

  it('legacy mode (no evidence) is unchanged', () => {
    expect(lintSynthesisHonesty('Fatto tutto. Verificato.')).toHaveLength(1);
    // 'evidence:bash' (no space) hits the legacy marker; 'evidence: bash' does not.
    expect(lintSynthesisHonesty('Fatto tutto.\nevidence:bash npm test Verificato.')).toEqual([]);
    expect(lintSynthesisHonesty('Fatto tutto.')).toEqual([]);
    expect(lintSynthesisHonesty(undefined)).toEqual([]);
  });
});
