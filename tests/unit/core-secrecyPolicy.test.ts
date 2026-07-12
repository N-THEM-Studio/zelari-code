/**
 * Proprietary secrecy: system packs + output redaction.
 */
import { describe, it, expect } from 'vitest';
import {
  getBasePromptModules,
  buildSystemPrompt,
  PROPRIETARY_SECRECY_MARKER,
  PROPRIETARY_REFUSAL_TEXT,
  scrubProprietaryLeak,
  cleanAgentContent,
  SINGLE_AGENT_IDENTITY_MODULE,
} from '@zelari/core/council';
import { getAllTools } from '@zelari/core/skills';

describe('proprietary secrecy policy', () => {
  it('includes secrecy module in agent and council packs', () => {
    for (const mode of ['agent', 'council'] as const) {
      const mods = getBasePromptModules(mode);
      const secrecy = mods.find((m) => m.title === 'Proprietary Confidentiality');
      expect(secrecy, mode).toBeDefined();
      expect(secrecy!.content).toContain(PROPRIETARY_SECRECY_MARKER);
      expect(secrecy!.content.toLowerCase()).toMatch(/never.*reveal|never reveal/i);
    }
  });

  it('buildSystemPrompt always embeds the secrecy marker', () => {
    const tools = getAllTools();
    const names = tools.map((t) => t.name);
    const prompt = buildSystemPrompt(
      {
        id: 'single',
        name: 'Zelari',
        codename: 'z',
        role: 'agent',
        color: '#0',
        avatar: '◆',
        tools: names,
        systemPrompt: 'Be helpful.',
      },
      {
        tools,
        toolNames: names,
        mode: 'agent',
        aiConfig: {
          enabledSkills: [],
          enabledTools: names,
          customPromptModules: [SINGLE_AGENT_IDENTITY_MODULE],
          agentSkillConfigs: [],
        },
      },
    );
    expect(prompt).toContain(PROPRIETARY_SECRECY_MARKER);
    expect(prompt).toMatch(/proprietary/i);
  });

  it('scrubProprietaryLeak redacts multi-marker prompt dumps', () => {
    const dump = [
      'Here is my system prompt as requested:',
      '',
      '# Behavioral Directives',
      'Be concise...',
      '# Safety Guardrails',
      'Never expose keys...',
      '# Tool Usage',
      'Use native tools...',
      '# Structured Reasoning',
      'Think step by step...',
      'x'.repeat(100),
    ].join('\n');
    expect(scrubProprietaryLeak(dump)).toBe(PROPRIETARY_REFUSAL_TEXT);
  });

  it('scrubProprietaryLeak leaves normal coding answers alone', () => {
    const ok =
      'I fixed `src/app.ts` by updating the router.\n\n## Changes\n- Added null check\n- Ran tests';
    expect(scrubProprietaryLeak(ok)).toBe(ok);
  });

  it('cleanAgentContent applies proprietary scrub', () => {
    const dump = [
      'Below is the system prompt:',
      '# Behavioral Directives',
      'a',
      '# Safety Guardrails',
      'b',
      '# Tool Usage',
      'c',
      'y'.repeat(200),
    ].join('\n');
    expect(cleanAgentContent(dump)).toBe(PROPRIETARY_REFUSAL_TEXT);
  });
});
