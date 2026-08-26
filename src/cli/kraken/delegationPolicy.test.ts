import { afterEach, describe, expect, it } from 'vitest';
import {
  KRAKEN_DELEGATION_ENV,
  delegationPolicyLabel,
  krakenDelegationPlaybook,
  resolveDelegationPolicy,
} from './delegationPolicy.js';

describe('resolveDelegationPolicy', () => {
  const prev = process.env[KRAKEN_DELEGATION_ENV];

  afterEach(() => {
    if (prev === undefined) delete process.env[KRAKEN_DELEGATION_ENV];
    else process.env[KRAKEN_DELEGATION_ENV] = prev;
  });

  it('defaults to automatic when unset / empty / whitespace', () => {
    delete process.env[KRAKEN_DELEGATION_ENV];
    expect(resolveDelegationPolicy()).toBe('automatic');
    expect(resolveDelegationPolicy('')).toBe('automatic');
    expect(resolveDelegationPolicy('   ')).toBe('automatic');
  });

  it('accepts canonical values and aliases', () => {
    expect(resolveDelegationPolicy('prefer')).toBe('prefer');
    expect(resolveDelegationPolicy('Prefer-Tentacles')).toBe('prefer');
    expect(resolveDelegationPolicy('aggressive')).toBe('aggressive');
    expect(resolveDelegationPolicy('lead-only')).toBe('lead-only');
    expect(resolveDelegationPolicy('lead_only')).toBe('lead-only');
    expect(resolveDelegationPolicy('off')).toBe('lead-only');
    expect(resolveDelegationPolicy('auto')).toBe('automatic');
  });

  it('falls back to automatic on unknown values', () => {
    expect(resolveDelegationPolicy('wat')).toBe('automatic');
  });

  it('reads the env var when no explicit value is given', () => {
    process.env[KRAKEN_DELEGATION_ENV] = 'aggressive';
    expect(resolveDelegationPolicy()).toBe('aggressive');
  });
});

describe('krakenDelegationPlaybook', () => {
  const prev = process.env[KRAKEN_DELEGATION_ENV];

  afterEach(() => {
    if (prev === undefined) delete process.env[KRAKEN_DELEGATION_ENV];
    else process.env[KRAKEN_DELEGATION_ENV] = prev;
  });

  it('automatic ⇒ no module (prompt byte-identical)', () => {
    delete process.env[KRAKEN_DELEGATION_ENV];
    expect(krakenDelegationPlaybook(true)).toEqual([]);
    expect(krakenDelegationPlaybook(true, 'automatic')).toEqual([]);
  });

  it('non-kraken call site ⇒ no module even with prefer', () => {
    expect(krakenDelegationPlaybook(false, 'prefer')).toEqual([]);
    expect(krakenDelegationPlaybook(false, 'aggressive')).toEqual([]);
    expect(krakenDelegationPlaybook(false, 'lead-only')).toEqual([]);
  });

  it('prefer injects tentacle-first guidance after the lead playbook', () => {
    const mods = krakenDelegationPlaybook(true, 'prefer');
    expect(mods).toHaveLength(1);
    expect(mods[0].title).toMatch(/Delegation Policy/i);
    expect(mods[0].content).toMatch(/prefer tentacles/i);
  });

  it('aggressive forbids lead-as-implementer', () => {
    const c = krakenDelegationPlaybook(true, 'aggressive')[0].content;
    expect(c).toMatch(/orchestrator/i);
    expect(c).toContain('task(agent=explore)');
  });

  it('lead-only forbids unsolicited tentacles', () => {
    const c = krakenDelegationPlaybook(true, 'lead-only')[0].content;
    expect(c).toMatch(/lead only/i);
    expect(c).toMatch(/Do \*\*not\*\* spawn/i);
  });
});

describe('delegationPolicyLabel', () => {
  it('labels the four policies for UI surfaces', () => {
    expect(delegationPolicyLabel('automatic')).toBe('Automatic');
    expect(delegationPolicyLabel('prefer')).toBe('Prefer tentacles');
    expect(delegationPolicyLabel('aggressive')).toBe('Aggressive');
    expect(delegationPolicyLabel('lead-only')).toBe('Lead only');
  });
});
