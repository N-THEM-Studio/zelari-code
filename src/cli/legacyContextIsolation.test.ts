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

function readCli(rel: string): string {
  return readFileSync(path.join(process.cwd(), 'src', 'cli', rel), 'utf8');
}

describe('ADR-0024 — legacy context isolation', () => {
  it('budget pipeline measures the spine-derived seed, never the raw 1.x store', () => {
    const src = readCli(path.join('hooks', 'useChatTurn.ts'));
    expect(src).not.toContain('applyBudgetPolicyAsync(getHistory()');
    // The declared discrete fallback (degraded/disabled spine) stays the only
    // seed path that may read the 1.x store.
    const fallbackUses = src.match(/spineSeed \?\? getHistory\(\)/g) ?? [];
    expect(fallbackUses.length).toBe(1);
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
