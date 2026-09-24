/**
 * core-promptAssembly.test.ts — structural invariants of the assembled system
 * prompt (2026-09-24 prompt audit).
 *
 * Pins the three assembly bugs the audit fixed and the content it added:
 *   - a `custom`-typed extra module (e.g. the Kraken delegation policy) must
 *     never drop the base modules that share the catch-all `custom` type;
 *   - a replacing module takes the slot of what it replaces, so the Kraken
 *     prompt opens on its identity (after the pinned language directive);
 *   - the lead playbook ADDS to the pack — Working Style survives it;
 *   - untrusted-content, observation-integrity and anti-circumvention rules
 *     are present; the prompt stays model/vendor-agnostic.
 */
import { describe, expect, it } from 'vitest';
import {
  buildSystemPrompt,
  getAllTools,
  KRAKEN_IDENTITY_MODULE,
  KRAKEN_LEAD_PLAYBOOK_MODULE,
} from '@zelari/core/skills';

const ROLE = {
  id: 'zelari',
  name: 'Zelari Code',
  codename: 'zelari',
  role: 'headless coding agent',
  color: '#00d9a3',
  avatar: '◆',
  tools: ['read_file', 'write_file', 'edit_file', 'bash', 'grep_content'],
  systemPrompt: '# Platform\nplatform: linux',
};

const LANGUAGE = { type: 'language-policy' as const, title: 'Response Language', priority: 5, content: '# Response Language\nReply in English.' };
const DELEGATION = { type: 'custom' as const, title: 'Kraken Delegation Policy', priority: 26, content: '# Kraken Delegation Policy\nprefer tentacles' };

function kraken(extra: unknown[] = []): string {
  return buildSystemPrompt(ROLE, {
    tools: getAllTools(),
    toolNames: ROLE.tools,
    mode: 'kraken',
    aiConfig: {
      enabledSkills: [],
      enabledTools: ROLE.tools,
      agentSkillConfigs: [],
      customPromptModules: [KRAKEN_IDENTITY_MODULE, KRAKEN_LEAD_PLAYBOOK_MODULE, LANGUAGE, ...extra] as never,
    },
  });
}

function council(): string {
  return buildSystemPrompt(ROLE, {
    tools: getAllTools(),
    toolNames: ROLE.tools,
    mode: 'council',
    aiConfig: { enabledSkills: [], enabledTools: ROLE.tools, agentSkillConfigs: [], customPromptModules: [] },
  });
}

const headings = (p: string) => p.split('\n').filter((l) => /^# /.test(l));
const BASE_KRAKEN_BLOCKS = [
  '# Instructions and Untrusted Content',
  '# Reasoning and Evidence',
  '# Working Style',
  '# Safety and Reversibility',
  '# Coding Practices',
  '# Turn Completion Contract',
  '# Output',
  '# Clarification Protocol',
  '# Tool Use',
];

describe('system prompt assembly — structure', () => {
  it('a custom-typed extra module (delegation policy) never drops base modules', () => {
    const withPolicy = headings(kraken([DELEGATION]));
    for (const block of BASE_KRAKEN_BLOCKS) {
      expect(withPolicy.some((h) => h.startsWith(block)), `${block} must survive`).toBe(true);
    }
    expect(withPolicy).toContain('# Kraken Delegation Policy');
  });

  it('opens on the language directive, then the Kraken identity', () => {
    const h = headings(kraken());
    expect(h[0]).toMatch(/^# Response Language/);
    expect(h[1]).toBe('# Identity');
    expect(kraken()).toMatch(/You are \*\*Kraken\*\*/);
  });

  it('the lead playbook adds to the pack: Working Style survives, playbook follows the base rules', () => {
    const h = headings(kraken());
    expect(h).toContain('# Working Style');
    expect(h.indexOf('# Kraken Lead Playbook')).toBeGreaterThan(h.indexOf('# Tool Use'));
  });

  it('keeps one tool block and one output block in the agent pack', () => {
    const h = headings(kraken());
    expect(h.filter((x) => /^# Tool Us/.test(x))).toHaveLength(1);
    expect(h.filter((x) => /^# Output/.test(x))).toHaveLength(1);
  });
});

describe('system prompt assembly — content', () => {
  for (const [name, build] of [['kraken', () => kraken()], ['council', council]] as const) {
    it(`${name}: tool results are data, never instructions`, () => {
      expect(build()).toMatch(/data, not instructions/);
    });

    it(`${name}: a denied action is never routed around`, () => {
      expect(build()).toMatch(/Never route around a block/);
    });

    it(`${name}: degraded observations are not evidence of absence`, () => {
      expect(build()).toMatch(/timeout[\s\S]{0,80}(error|degraded)/i);
    });

    it(`${name}: stays model- and vendor-agnostic`, () => {
      expect(build()).not.toMatch(/\b(anthropic|claude|openai|chatgpt|gpt-\d|gemini|llama|mistral|deepseek|qwen|grok)\b/i);
    });
  }

  it('kraken: carries no runtime plumbing the model cannot act on', () => {
    const p = kraken();
    expect(p).not.toMatch(/ZELARI_[A-Z_]+/);
    expect(p).not.toMatch(/ADR-\d+/);
    expect(p).not.toMatch(/exit 4/);
  });

  it('kraken: asks-or-acts by the cost of a wrong guess, with an unattended mode', () => {
    const p = kraken();
    expect(p).toMatch(/cost of a wrong guess/);
    expect(p).toMatch(/Unattended runs/);
  });

  it('kraken: forbids faking green checks', () => {
    expect(kraken()).toMatch(/Never fake green/);
  });
});
