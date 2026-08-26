/**
 * Provider-qualified model refs for Kraken cross-provider routing
 * (Desktop Settings → ZELARI_KRAKEN_*_MODEL → CLI).
 *
 * Format: "provider/model" (e.g. "glm/glm-4.7-air", "grok/grok-4").
 * Resolvers return the env value VERBATIM — the split happens at the
 * consumption points (createKrakenSubAgentContextFactory in toolRegistry.ts,
 * planner.ts resolveLlm, scriptPlanner.ts) via parseQualifiedModelRef, where
 * provider existence (credentials / base URL) can be validated with a
 * graceful fallback to the raw id.
 */
import { describe, it, expect } from 'vitest';
import {
  parseQualifiedModelRef,
  resolveKrakenPlannerModel,
  resolveKrakenSubModel,
} from '../../src/cli/tools/krakenModel.js';

describe('parseQualifiedModelRef', () => {
  it('splits a qualified ref into provider and model', () => {
    expect(parseQualifiedModelRef('glm/glm-4.7-air')).toEqual({
      provider: 'glm',
      model: 'glm-4.7-air',
    });
    expect(parseQualifiedModelRef('grok/grok-4')).toEqual({
      provider: 'grok',
      model: 'grok-4',
    });
  });

  it('returns null for unqualified ids', () => {
    expect(parseQualifiedModelRef('grok-4')).toBeNull();
    expect(parseQualifiedModelRef('deepseek-chat')).toBeNull();
    expect(parseQualifiedModelRef('')).toBeNull();
  });

  it('returns null for malformed refs (empty provider or model part)', () => {
    expect(parseQualifiedModelRef('/grok-4')).toBeNull();
    expect(parseQualifiedModelRef('grok/')).toBeNull();
    expect(parseQualifiedModelRef('   /   ')).toBeNull();
  });

  it('trims whitespace around both parts', () => {
    expect(parseQualifiedModelRef(' glm / glm-4.7-air ')).toEqual({
      provider: 'glm',
      model: 'glm-4.7-air',
    });
  });
});

describe('cross-provider env passthrough', () => {
  it('resolveKrakenSubModel returns the qualified env value verbatim', () => {
    expect(
      resolveKrakenSubModel('explore', 'lead-model', {
        ZELARI_KRAKEN_EXPLORE_MODEL: 'glm/glm-4.7-air',
      }),
    ).toBe('glm/glm-4.7-air');
  });

  it('resolveKrakenPlannerModel returns the qualified env value verbatim', () => {
    expect(
      resolveKrakenPlannerModel('lead-model', {
        ZELARI_KRAKEN_PLANNER_MODEL: 'grok/grok-4',
      }),
    ).toBe('grok/grok-4');
  });

  it('unqualified behavior is unchanged (parent inherit)', () => {
    expect(resolveKrakenSubModel('explore', 'lead-model', {})).toBe('lead-model');
    expect(resolveKrakenPlannerModel('lead-model', {})).toBe('lead-model');
  });
});
