import { describe, it, expect } from 'vitest';
import {
  shouldBuildViaAgent,
  shouldAllowCouncilBuild,
  resolveAgentMissionToolBudget,
  describeBuildPolicy,
} from '../../src/cli/buildPolicy.js';

describe('shouldAllowCouncilBuild', () => {
  it('is false by default', () => {
    expect(shouldAllowCouncilBuild({})).toBe(false);
  });

  it('is true only when ZELARI_COUNCIL_CAN_BUILD=1', () => {
    expect(shouldAllowCouncilBuild({ ZELARI_COUNCIL_CAN_BUILD: '1' })).toBe(true);
    expect(shouldAllowCouncilBuild({ ZELARI_COUNCIL_CAN_BUILD: '0' })).toBe(false);
    expect(shouldAllowCouncilBuild({ ZELARI_COUNCIL_CAN_BUILD: 'yes' })).toBe(false);
  });
});

describe('shouldBuildViaAgent', () => {
  it('defaults ON (experiment) when env unset', () => {
    expect(shouldBuildViaAgent({})).toBe(true);
  });

  it('is ON when ZELARI_BUILD_VIA_AGENT=1', () => {
    expect(shouldBuildViaAgent({ ZELARI_BUILD_VIA_AGENT: '1' })).toBe(true);
  });

  it('is OFF when ZELARI_BUILD_VIA_AGENT=0', () => {
    expect(shouldBuildViaAgent({ ZELARI_BUILD_VIA_AGENT: '0' })).toBe(false);
  });

  it('COUNCIL_CAN_BUILD=1 forces legacy (not via agent)', () => {
    expect(
      shouldBuildViaAgent({
        ZELARI_COUNCIL_CAN_BUILD: '1',
        ZELARI_BUILD_VIA_AGENT: '1',
      }),
    ).toBe(false);
    expect(
      shouldBuildViaAgent({
        ZELARI_COUNCIL_CAN_BUILD: '1',
      }),
    ).toBe(false);
  });
});

describe('resolveAgentMissionToolBudget', () => {
  it('defaults to 40', () => {
    expect(resolveAgentMissionToolBudget({})).toBe(40);
  });

  it('parses positive integers', () => {
    expect(resolveAgentMissionToolBudget({ ZELARI_MODE_MAX_TOOLS_AGENT: '25' })).toBe(25);
  });

  it('falls back on garbage', () => {
    expect(resolveAgentMissionToolBudget({ ZELARI_MODE_MAX_TOOLS_AGENT: 'nope' })).toBe(40);
    expect(resolveAgentMissionToolBudget({ ZELARI_MODE_MAX_TOOLS_AGENT: '0' })).toBe(40);
    expect(resolveAgentMissionToolBudget({ ZELARI_MODE_MAX_TOOLS_AGENT: '-3' })).toBe(40);
  });
});

describe('describeBuildPolicy', () => {
  it('mentions agent default', () => {
    const s = describeBuildPolicy({});
    expect(s).toMatch(/build@agent/);
    expect(s).toMatch(/plan-only|ZELARI_COUNCIL_CAN_BUILD/);
  });

  it('mentions council legacy when disabled via agent', () => {
    const s = describeBuildPolicy({ ZELARI_BUILD_VIA_AGENT: '0' });
    expect(s).toMatch(/build@council/);
  });
});
