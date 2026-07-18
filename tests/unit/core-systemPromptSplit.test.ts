import { describe, it, expect } from 'vitest';
import {
  buildSystemPromptSplit,
  systemMessagesFromSplit,
  buildSystemPrompt,
} from '../../packages/core/src/agents/systemPromptBuilder.js';
import type { EnhancedToolDefinition } from '../../packages/core/src/types/systemTypes.js';
import { SINGLE_AGENT_IDENTITY_MODULE } from '../../packages/core/src/agents/promptModules.js';

const agent = {
  id: 'single',
  name: 'Zelari',
  codename: 'zelari',
  role: 'coder',
  color: '#000',
  avatar: 'x',
  tools: [] as string[],
  systemPrompt: 'You are stable role text.',
};

const tools: EnhancedToolDefinition[] = [];

describe('buildSystemPromptSplit', () => {
  it('keeps workspace/RAG/durable state out of stable', () => {
    const split = buildSystemPromptSplit(agent, {
      tools,
      toolNames: [],
      mode: 'agent',
      aiConfig: {
        enabledSkills: [],
        enabledTools: [],
        customPromptModules: [SINGLE_AGENT_IDENTITY_MODULE],
        agentSkillConfigs: [],
      },
      workspaceContext: 'PLAN OPS volatile-plan-xyz',
      ragContext: 'memory hit volatile-rag-abc',
      durableStateContext: 'commit deadbeef verified',
    });

    expect(split.stable).toContain('stable role text');
    expect(split.stable).not.toContain('volatile-plan-xyz');
    expect(split.stable).not.toContain('volatile-rag-abc');
    expect(split.stable).not.toContain('deadbeef');

    expect(split.volatile).toContain('volatile-plan-xyz');
    expect(split.volatile).toContain('volatile-rag-abc');
    expect(split.volatile).toContain('deadbeef');
  });

  it('stable is unchanged when only volatile inputs change', () => {
    const baseOpts = {
      tools,
      toolNames: [] as string[],
      mode: 'agent' as const,
      aiConfig: {
        enabledSkills: [] as string[],
        enabledTools: [] as string[],
        customPromptModules: [SINGLE_AGENT_IDENTITY_MODULE],
        agentSkillConfigs: [],
      },
    };
    const a = buildSystemPromptSplit(agent, {
      ...baseOpts,
      workspaceContext: 'ws-1',
    });
    const b = buildSystemPromptSplit(agent, {
      ...baseOpts,
      workspaceContext: 'ws-2-totally-different',
      durableStateContext: 'new state',
    });
    expect(a.stable).toBe(b.stable);
    expect(a.volatile).not.toBe(b.volatile);
  });

  it('systemMessagesFromSplit orders stable before volatile', () => {
    const msgs = systemMessagesFromSplit({
      stable: 'STABLE_PART',
      volatile: 'VOLATILE_PART',
    });
    expect(msgs).toHaveLength(2);
    expect(msgs[0].content).toBe('STABLE_PART');
    expect(msgs[1].content).toBe('VOLATILE_PART');
  });

  it('buildSystemPrompt concatenates with stable first', () => {
    const full = buildSystemPrompt(agent, {
      tools,
      toolNames: [],
      mode: 'agent',
      workspaceContext: 'VOL_WS',
      aiConfig: {
        enabledSkills: [],
        enabledTools: [],
        customPromptModules: [SINGLE_AGENT_IDENTITY_MODULE],
        agentSkillConfigs: [],
      },
    });
    const stableIdx = full.indexOf('stable role text');
    const volIdx = full.indexOf('VOL_WS');
    expect(stableIdx).toBeGreaterThanOrEqual(0);
    expect(volIdx).toBeGreaterThan(stableIdx);
  });
});
