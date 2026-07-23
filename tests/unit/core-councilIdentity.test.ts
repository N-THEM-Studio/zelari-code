/**
 * core-councilIdentity.test.ts — v0.7.2 de-brand + tool-swap regression.
 *
 * Pins the contract that the council is no longer AnathemaBrain-branded and
 * that roles declare coding tools (not planner/vault tools). This was the
 * root cause of the live-test failure where `/council` produced an
 * "AnathemaBrain Landing Page" milestone + Obsidian ideas for an unrelated
 * ecommerce-of-bags task.
 */
import { describe, it, expect } from 'vitest';
import { AGENT_ROLES, getCouncilAgents, buildSystemPrompt, getBasePromptModules } from '@zelari/core/council';

const BANNED_IDENTITY_TERMS = ['AnathemaBrain', 'Obsidian', 'Knowledge Vault', 'wikilink'];

describe('Council identity — de-branded (v0.7.2)', () => {
  it('the base-identity module contains no AnathemaBrain/Obsidian/Vault terms', () => {
    const identity = getBasePromptModules('council').find((m) => m.type === 'base-identity');
    expect(identity, 'base-identity module must exist').toBeDefined();
    for (const term of BANNED_IDENTITY_TERMS) {
      expect(identity!.content, `should not mention "${term}"`).not.toContain(term);
    }
  });

  it('the identity is coding-oriented (mentions codebase/files)', () => {
    const identity = getBasePromptModules('council').find((m) => m.type === 'base-identity');
    expect(identity!.content).toMatch(/codebase|software|files/i);
  });

  it('both agent and council packs include clarification; agent keeps coding practices', () => {
    const council = getBasePromptModules('council')
      .map((m) => m.content)
      .join('\n');
    const agent = getBasePromptModules('kraken')
      .map((m) => m.content)
      .join('\n');
    expect(council).toMatch(/---QUESTION---/);
    expect(agent).toMatch(/---QUESTION---/);
    expect(agent).toMatch(/Coding Practices|Read before edit/i);
    // Agent still has no council collab noise
    expect(agent).not.toMatch(/downstream agents or the Lucifero/i);
  });
});

describe('Council roles — coding tools (v0.7.2 tool swap)', () => {
  const VAULT_TOOLS = ['createTask', 'createPhase', 'addIdea', 'buildMindMap', 'addNode', 'linkNodes', 'createDocument'];
  const CODING_TOOLS = ['read_file', 'write_file', 'edit_file', 'bash', 'grep_content', 'list_files'];

  it('no role declares vault/planner tools', () => {
    for (const role of AGENT_ROLES) {
      for (const t of role.tools ?? []) {
        expect(VAULT_TOOLS, `${role.name} should not declare vault tool "${t}"`).not.toContain(t);
      }
    }
  });

  it('Lucifero (synthesizer) declares implementation tools: write_file, edit_file, bash', () => {
    const lucifer = AGENT_ROLES.find((r) => r.id === 'lucifer')!;
    expect(lucifer.tools).toEqual(expect.arrayContaining(['read_file', 'write_file', 'edit_file', 'bash']));
  });

  it('Caronte + Nettuno + Plutone declare read/explore coding tools', () => {
    for (const id of ['charont', 'nettun', 'pluton']) {
      const role = AGENT_ROLES.find((r) => r.id === id)!;
      // Every declared tool is a coding tool (no vault tools leak in).
      for (const t of role.tools ?? []) {
        expect(CODING_TOOLS, `${id} should only declare coding tools, got "${t}"`).toContain(t);
      }
      // At least read_file is present for the explore-oriented roles.
      expect(role.tools).toContain('read_file');
    }
  });

  it('Minosse (critic) has read-only tools (grounded critique, never mutates)', () => {
    const minos = AGENT_ROLES.find((r) => r.id === 'minos')!;
    expect(minos.tools).toEqual(
      expect.arrayContaining(['read_file', 'list_files', 'grep_content']),
    );
    for (const t of minos.tools ?? []) {
      expect(['read_file', 'list_files', 'grep_content', 'searchDocuments']).toContain(t);
    }
  });
});

describe('buildSystemPrompt — custom module override (v0.7.2)', () => {
  it('a customPromptModules entry with the same type as a base module REPLACES it', () => {
    const agent = getCouncilAgents(3)[0]!;
    const customIdentity = {
      type: 'base-identity' as const,
      title: 'Custom',
      priority: 5,
      content: '# MY CUSTOM BRAND\nYou are a member of FooBar Council.',
    };
    const prompt = buildSystemPrompt(agent, {
      tools: [],
      toolNames: [],
      aiConfig: {
        customPromptModules: [customIdentity],
        agentSkillConfigs: [],
        enabledSkills: [],
        enabledTools: [],
      } as never,
    });
    // Custom identity wins; builtin AnathemaBrain one is suppressed.
    expect(prompt).toContain('MY CUSTOM BRAND');
    // The builtin identity heading (now generic, not AnathemaBrain) must NOT
    // also appear — only one identity block.
    const builtinHeading = '# AI Council';
    const occurrences = prompt.split(builtinHeading).length - 1;
    // Case-insensitive check that the builtin brand wording isn't duplicated.
    expect(prompt.toLowerCase().match(/# ai council/g)?.length ?? 0).toBeLessThanOrEqual(0);
    void occurrences;
  });
});
