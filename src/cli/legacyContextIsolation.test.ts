/**
 * legacyContextIsolation — architectural gate for ADR-0024 (E1.5).
 *
 * Encodes the Exit-1 grep criteria as a CI test: the 1.x store and
 * sessionManager must never feed the model context on a hot path. These are
 * source-level assertions on purpose; the behavioral replay + invariant
 * coverage lives in sessionReplayInvariant.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Source-level gate: resolve against THIS file, never process.cwd() — the
// core workspace runs `vitest run --root ../..` with cwd=packages/core, and
// a cwd-relative path would ENOENT there. From src/cli (and the compiled
// dist/cli twin, same depth) `../..` is always the repo root.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function readCli(rel: string): string {
  return readFileSync(path.join(REPO_ROOT, 'src', 'cli', rel), 'utf8');
}

describe('ADR-0024 — legacy context isolation', () => {
  it('budget pipeline measures the spine-derived seed, never the raw 1.x store', () => {
    const src = readCli(path.join('hooks', 'useChatTurn.ts'));
    const builder = readCli(path.join('budget', 'modelContextBuilder.ts'));
    expect(src).not.toContain('applyBudgetPolicyAsync(getHistory()');
    expect(src).not.toContain('applyBudgetPolicyAsync(');
    expect(src.match(/await buildModelContext\(/g)).toHaveLength(2);
    expect(src).toContain('fallbackHistory: historyForModel');
    expect(src).toContain('fallbackHistory: getHistory()');
    // The shared builder owns the declared discrete fallback and always
    // prefers the session-derived projection when the spine is active.
    expect(builder).toContain('const derived = await sessionHistory(input.session)');
    expect(builder).toContain('const sourceHistory = (derived ?? [...input.fallbackHistory]).filter(');
    expect(builder).toContain('(message) => !isLegacyResourceStatus(message)');
  });

  it('headless hot path touches opts.history only via the one-shot spine import', () => {
    const src = readCli('runHeadless.ts');
    const lines = src.split(/\r?\n/);
    const optHistoryLines = lines.filter((l) => l.includes('opts.history'));
    expect(optHistoryLines.length).toBeGreaterThan(0);
    for (const line of optHistoryLines) {
      expect(line).toContain('seedHeadlessModelHistory');
    }
    // No second history brain on the headless path.
    expect(src).not.toContain('getHistory');
  });

  it('spine modules never import the 1.x sessionManager', () => {
    for (const rel of ['sessionSpine.ts', 'headlessSpine.ts']) {
      const src = readCli(rel);
      expect(src).not.toMatch(/from\s+['"][^'"]*sessionManager/);
    }
  });
});

describe('strict done gate enforcement (E2.2)', () => {
  it('headless kraken BUILD enforces the strict verdict on the run outcome', () => {
    const src = readCli('runHeadless.ts');
    expect(src).toContain('strictGateExitCode(after)');
    expect(src).toMatch(/strictExit !== 0 \? 'stopped' : 'completed'/);
    expect(src).toMatch(/if \(strictExit !== 0\) return strictExit;/);
  });

  it('the strict BUILD policy excludes verifier-llm evidence (LLM score alone is not done)', () => {
    const policy = readFileSync(
      path.join(REPO_ROOT, 'packages', 'core', 'src', 'verification', 'completionPolicy.ts'),
      'utf8',
    );
    expect(policy).toContain('export const STRICT_BUILD_POLICY');
    const tiersBlock = policy.slice(
      policy.indexOf('DETERMINISTIC_EVIDENCE_TIERS'),
      policy.indexOf('export const STRICT_BUILD_POLICY'),
    );
    expect(tiersBlock).toContain("'tool-output'");
    expect(tiersBlock).not.toContain("'verifier-llm'");
    expect(policy).toMatch(/admissibleTiers/);
    expect(policy).toMatch(/requireEventBackedEvidence:\s*true/);
  });
});
