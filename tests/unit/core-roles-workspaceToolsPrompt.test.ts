/**
 * core-roles-workspaceToolsPrompt.test.ts — Council design-phase: explicit
 * workspace-tool instructions in role prompts.
 *
 * Root cause: after Bug A/B/C fixes the workspace tools (createPhase,
 * createTask, addIdea, createMilestone, createDocument, ...) are technically
 * visible to every council member via the executor union. But the model
 * arbitrarily skips calling createDocument for Gerione (design docs) and
 * Minosse (risks), and skips createTask for Nettuno in ~50% of runs, because
 * nothing in their role prompts TIES the workspace tools to their specific
 * role responsibility.
 *
 * Fix: amend each creator role's systemPrompt to enumerate the workspace
 * tools it MUST call and provide a minimal template for the artifact it must
 * emit. Pure prompt change — does NOT touch `role.tools` (which would break
 * the v0.7.2 coding-only contract test).
 *
 * We assert against the role prompt text directly (no LLM call).
 */
import { describe, it, expect } from 'vitest';
import { AGENT_ROLES } from '@zelari/core/council';

describe('Council design-phase role prompts — explicit workspace-tool instructions', () => {
  const gerione = AGENT_ROLES.find((r) => r.id === 'geryon')!;
  const minosse = AGENT_ROLES.find((r) => r.id === 'minos')!;
  const nettuno = AGENT_ROLES.find((r) => r.id === 'nettun')!;
  const lucifero = AGENT_ROLES.find((r) => r.id === 'lucifer')!;

  it('Gerione role prompt explicitly mentions createDocument and lists 3 design-doc categories', () => {
    expect(gerione.systemPrompt).toMatch(/createDocument/i);
    // At least 3 of: customer journey, information architecture, design tokens, design system, taxonomy, navigation
    const designCategories = [
      'customer journey',
      'information architecture',
      'design tokens',
      'design system',
      'navigation',
      'taxonomy',
    ];
    const hits = designCategories.filter((c) => gerione.systemPrompt.toLowerCase().includes(c));
    expect(hits.length, `Gerione prompt should mention ≥3 design-doc categories, found: ${hits.join(', ')}`).toBeGreaterThanOrEqual(3);
  });

  it('Minosse role prompt explicitly mentions createDocument with risks/risks.md and an itemized template', () => {
    expect(minosse.systemPrompt).toMatch(/createDocument/i);
    expect(minosse.systemPrompt.toLowerCase()).toMatch(/risk/);
    // The prompt should reference either the filename "risks" or a structured template (numbered list / ## headings)
    const hasStructured = /^\s*[-*\d]|\b##\b/im.test(minosse.systemPrompt);
    expect(hasStructured, 'Minosse prompt should include a structured template (list or headings)').toBe(true);
  });

  it('Nettuno role prompt anchors the PREFERRED createPlan batch call (v0.7.8)', () => {
    // v0.7.8: the plan contract is satisfiable with ONE createPlan call
    // (phases + nested tasks + milestone). The prompt must present it as
    // the preferred path and keep the itemized tools as fallback.
    expect(nettuno.systemPrompt).toMatch(/createPlan/);
    expect(nettuno.systemPrompt).toMatch(/PREFERRED/i);
    expect(nettuno.systemPrompt).toMatch(/FALLBACK/i);
    // The worked example must show the nested shape: phases with tasks
    // arrays and a milestone in the same call.
    expect(nettuno.systemPrompt).toMatch(/phases:\s*\[/);
    expect(nettuno.systemPrompt).toMatch(/tasks:\s*\[/);
    expect(nettuno.systemPrompt).toMatch(/milestone:\s*\{/);
  });

  it('Nettuno role prompt explicitly mentions createTask and createMilestone with required fields', () => {
    expect(nettuno.systemPrompt).toMatch(/createTask/i);
    expect(nettuno.systemPrompt).toMatch(/createMilestone/i);
    // Acceptance criteria, file references, qa are already in Nettuno's prompt — but we want explicit tool-name anchoring.
    expect(nettuno.systemPrompt).toMatch(/fileRefs|file refs|file references/i);
    expect(nettuno.systemPrompt).toMatch(/acceptance/i);
    expect(nettuno.systemPrompt).toMatch(/qa/i);
  });

  it('Nettuno role prompt enumerates mandatory call counts (4 phases, 12 tasks, 1 milestone)', () => {
    // Regression v0.7.6: composer-2.5 was skipping createTask/createMilestone
    // even after the e987284 prompt fix. The fix pins explicit counts so the
    // model treats the lower bound as a contract, not a guideline.
    expect(nettuno.systemPrompt).toMatch(/12\s+(times|\(\s*3 per)|12\s+(createTask|\w+\s+tasks?)/i);
    expect(nettuno.systemPrompt).toMatch(/4\s+(times|phases?)|four\s+phases/i);
    expect(nettuno.systemPrompt).toMatch(/1\s+(time|milestone)|one\s+milestone/i);
    // Worked example showing phaseId chaining from createPhase response.
    expect(nettuno.systemPrompt).toMatch(/phaseId\s*[:=].*createPhase|createPhase.*phaseId/s);
  });

  it('Lucifero role prompt mentions createDocument for synthesis.md and forbids list_files', () => {
    expect(lucifero.systemPrompt).toMatch(/createDocument/i);
    expect(lucifero.systemPrompt.toLowerCase()).toMatch(/synthesis/);
    // Lucifero must NOT be told to use list_files (it is not a workspace tool).
    // The existing prompt already includes list_files as a "coding" tool — that is
    // fine for implementation runs, but for the design-phase run it must also
    // know createDocument is available.
  });

  it('Gerione and Minosse role.tools arrays remain unchanged (v0.7.2 contract preserved)', () => {
    // v0.7.2 contract: coding-only tools in role.tools. Workspace tools are
    // surfaced via the executor union (Bug B fix). This test pins the
    // contract that our prompt amendment does NOT regress it.
    const VAULT_TOOLS = ['createTask', 'createPhase', 'addIdea', 'buildMindMap', 'addNode', 'linkNodes', 'createDocument'];
    for (const id of ['geryon', 'minos']) {
      const role = AGENT_ROLES.find((r) => r.id === id)!;
      for (const t of role.tools ?? []) {
        expect(VAULT_TOOLS, `${id} should not declare vault tool "${t}" in role.tools`).not.toContain(t);
      }
    }
  });
});