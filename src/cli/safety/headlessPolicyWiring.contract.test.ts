/**
 * S1 (2.32 honest defaults) — headless wiring contract.
 *
 * The headless entry points must build their permission policy through
 * `defaultPermissionPolicy()` (preset + env aware, ask fails closed without
 * a UI handler) instead of a hardcoded allow-all literal. Before S1 the four
 * headless sites overrode the policy with `{ network: 'allow', ui: 'allow',
 * auto: true }`, which made "ask by default" marketing on every non-TUI
 * surface (CI, --once, Desktop graph) and silently ignored the documented
 * `ZELARI_AUTO` / `ZELARI_PERMISSION_*` escapes.
 *
 * The category semantics themselves are covered by toolPermissions.presets
 * .test.ts (standard ⇒ execute/network ask) and by policyEngine.test.ts
 * (ask without onPermissionAsk ⇒ fail closed). This file pins the missing
 * link: the wiring. It is a source contract on purpose — the behavioral
 * chain "headless standard ⇒ exec deny" only holds if these call sites
 * keep using the shared policy builder.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HEADLESS_SITES = [
  '../headless/runOneTurn.ts',
  '../runHeadless.ts',
] as const;

function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
}

describe('S1: headless permission wiring (2.32)', () => {
  it.each(HEADLESS_SITES)('%s builds its policy via defaultPermissionPolicy', (rel) => {
    const text = src(rel);
    expect(text).toContain('defaultPermissionPolicy(');
  });

  it.each(HEADLESS_SITES)('%s has no hardcoded allow-all literal left', (rel) => {
    const text = src(rel);
    expect(text).not.toMatch(/network:\s*'allow',\s*\r?\n\s*ui:\s*'allow',\s*\r?\n\s*auto:\s*true/);
  });

  it('runHeadless graph + mission registries also use the shared builder', () => {
    const text = src('../runHeadless.ts');
    // three call sites: graph parentPolicy, main registry, mission-slice registry
    expect(text.match(/defaultPermissionPolicy\(/g)?.length).toBeGreaterThanOrEqual(3);
  });
});
