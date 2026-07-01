/**
 * cli-councilSwap.test.ts — Task I.4 (v3-I)
 *
 * Tests for `swapMembers` pure helper and the `UnknownMemberError`
 * typed error from `src/agents/roles.ts`.
 *
 * Coverage:
 *   - empty swap → returns slice of input (no mutation)
 *   - single swap → target replaces source
 *   - multiple swaps → all applied
 *   - self-mapping → no-op (same AgentRole object)
 *   - unknown target id → throws UnknownMemberError
 *   - unknown source id (in swap) → throws UnknownMemberError
 *   - members without a mapping pass through unchanged
 *   - order is preserved
 *   - UnknownMemberError carries unknownId + availableIds
 */

import { describe, it, expect } from 'vitest';
import {
  swapMembers,
  UnknownMemberError,
  getCouncilAgents,
} from '../../src/agents/roles';

describe('swapMembers', () => {
  it('empty swap → returns a fresh slice (no mutation) (Task I.4.1)', () => {
    const roster = getCouncilAgents(3);
    const out = swapMembers(roster, {});
    expect(out).toEqual(roster);
    expect(out).not.toBe(roster); // fresh slice, not same array
    expect(out[0]).toBe(roster[0]); // same refs
  });

  it('single swap → target replaces source (Task I.4.2)', () => {
    const roster = getCouncilAgents(3);
    const out = swapMembers(roster, { charont: 'nettun' });
    expect(out).toHaveLength(3);
    expect(out[0].id).toBe('nettun');
    expect(out[1].id).toBe('nettun'); // prometheus was second
    expect(out[2].id).toBe('geryon');
  });

  it('multiple swaps → all applied (Task I.4.3)', () => {
    const roster = getCouncilAgents(3);
    const out = swapMembers(roster, {
      charont: 'geryon',
      geryon: 'charont',
    });
    expect(out.map((r) => r.id)).toEqual(['geryon', 'nettun', 'charont']);
  });

  it('self-mapping is a no-op (same AgentRole object) (Task I.4.4)', () => {
    const roster = getCouncilAgents(3);
    const out = swapMembers(roster, { charont: 'charont' });
    expect(out[0]).toBe(roster[0]);
  });

  it('unknown target id throws UnknownMemberError (Task I.4.5)', () => {
    const roster = getCouncilAgents(3);
    expect(() => swapMembers(roster, { charont: 'unknown-agent' })).toThrow(
      UnknownMemberError,
    );
    try {
      swapMembers(roster, { charont: 'unknown-agent' });
    } catch (err) {
      expect(err).toBeInstanceOf(UnknownMemberError);
      const e = err as UnknownMemberError;
      expect(e.unknownId).toBe('unknown-agent');
      expect(e.availableIds).toContain('charont');
      expect(e.availableIds).toContain('nettun');
      expect(e.message).toContain('"unknown-agent"');
    }
  });

  it('unknown source id (in swap map) throws UnknownMemberError (Task I.4.6)', () => {
    const roster = getCouncilAgents(3);
    expect(() =>
      swapMembers(roster, { 'not-in-roster': 'nettun' }),
    ).toThrow(UnknownMemberError);
  });

  it('members without a mapping pass through unchanged (Task I.4.7)', () => {
    const roster = getCouncilAgents(4);
    const out = swapMembers(roster, { charont: 'geryon' });
    expect(out[0].id).toBe('geryon');
    expect(out[1].id).toBe('nettun');
    expect(out[2].id).toBe('geryon'); // was hephaestus
    expect(out[3].id).toBe('pluton');
  });

  it('order is preserved (Task I.4.8)', () => {
    const roster = getCouncilAgents(6);
    const out = swapMembers(roster, { charont: 'minos', nettun: 'lucifer' });
    expect(out.map((r) => r.id)).toEqual([
      'minos',         // sisyphus → oracle
      'lucifer',       // prometheus → chairman
      'geryon',
      'pluton',
      'minos',         // was oracle
      'lucifer',       // was chairman
    ]);
  });

  it('UnknownMemberError is a proper Error subclass (Task I.4.9)', () => {
    const err = new UnknownMemberError('foo', ['bar', 'baz']);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(UnknownMemberError);
    expect(err.name).toBe('UnknownMemberError');
    expect(err.unknownId).toBe('foo');
    expect(err.availableIds).toEqual(['bar', 'baz']);
    expect(err.message).toContain('"foo"');
    expect(err.message).toContain('bar');
    expect(err.message).toContain('baz');
  });
});
