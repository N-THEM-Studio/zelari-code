/**
 * core-roles-workspaceToolsPrompt.test.ts — Council design-phase: explicit
 * workspace-tool instructions via designPhaseAddendum (mode-split prompts).
 *
 * Base role.systemPrompt stays lean (methodology only). Workspace mandatories
 * (createPlan, createDocument, …) are injected only when
 * resolveRoleSystemPrompt(role, 'design-phase') is used.
 *
 * We assert against the resolved design-phase prompt (no LLM call).
 */
import { describe, it, expect } from 'vitest';
import { AGENT_ROLES, resolveRoleSystemPrompt } from '@zelari/core/council';

describe('Council design-phase role prompts — explicit workspace-tool instructions', () => {
  const gerioneRole = AGENT_ROLES.find((r) => r.id === 'geryon')!;
  const minosseRole = AGENT_ROLES.find((r) => r.id === 'minos')!;
  const nettunoRole = AGENT_ROLES.find((r) => r.id === 'nettun')!;
  const luciferoRole = AGENT_ROLES.find((r) => r.id === 'lucifer')!;

  const gerione = resolveRoleSystemPrompt(gerioneRole, 'design-phase');
  const minosse = resolveRoleSystemPrompt(minosseRole, 'design-phase');
  const nettuno = resolveRoleSystemPrompt(nettunoRole, 'design-phase');
  const lucifero = resolveRoleSystemPrompt(luciferoRole, 'design-phase');

  it('Gerione design prompt mentions createDocument and lists 3 design-doc categories', () => {
    expect(gerione).toMatch(/createDocument/i);
    const designCategories = [
      'customer journey',
      'information architecture',
      'design tokens',
      'design system',
      'navigation',
      'taxonomy',
      'customer-journey-map',
      'information-architecture',
      'design-tokens',
    ];
    const lower = gerione.toLowerCase();
    const hits = designCategories.filter((c) => lower.includes(c));
    expect(
      hits.length,
      `Gerione design prompt should mention ≥3 design-doc categories, found: ${hits.join(', ')}`,
    ).toBeGreaterThanOrEqual(3);
  });

  it('Minosse design prompt mentions createDocument with risks and a structured template', () => {
    expect(minosse).toMatch(/createDocument/i);
    expect(minosse.toLowerCase()).toMatch(/risk/);
    const hasStructured = /^\s*[-*\d]|\b##\b|Impact|Likelihood|Mitigation/im.test(
      minosse,
    );
    expect(
      hasStructured,
      'Minosse design prompt should include a structured risks template',
    ).toBe(true);
  });

  it('Nettuno design prompt anchors batched createPlan (phases + tasks + milestone)', () => {
    expect(nettuno).toMatch(/createPlan/);
    expect(nettuno).toMatch(/Design-phase/i);
    // Worked example nested shape
    expect(nettuno).toMatch(/phases:\s*\[/);
    expect(nettuno).toMatch(/tasks:\s*\[/);
    expect(nettuno).toMatch(/milestone:\s*\{/);
    // Prefer one batch over many itemized calls
    expect(nettuno).toMatch(/createPhase|createTask/);
  });

  it('Nettuno design prompt requires fileRefs, acceptance, qa on tasks', () => {
    expect(nettuno).toMatch(/fileRefs|file refs|file references/i);
    expect(nettuno).toMatch(/acceptance/i);
    expect(nettuno).toMatch(/qa/i);
  });

  it('Nettuno design prompt enumerates plan scale (~4 phases × ~3 tasks + milestone)', () => {
    // Mode-split uses one createPlan with ~4 phases × ~3 tasks + 1 milestone
    // instead of forcing 12 separate createTask tool calls.
    expect(nettuno).toMatch(/~?4\s+phases|4 phases|~4 phases/i);
    expect(nettuno).toMatch(/~?3\s+tasks|3 tasks|×\s*~?3/i);
    expect(nettuno).toMatch(/milestone/i);
  });

  it('Lucifero design prompt mentions createDocument for synthesis and does not require list_files as deliverable', () => {
    expect(lucifero).toMatch(/createDocument/i);
    expect(lucifero.toLowerCase()).toMatch(/synthesis/);
    // Explicit: list_files is not a workspace deliverable in design-phase
    expect(lucifero).toMatch(/Do not use list_files|not.*list_files/i);
  });

  it('Gerione and Minosse role.tools arrays remain coding-only (v0.7.2 contract)', () => {
    const VAULT_TOOLS = [
      'createTask',
      'createPhase',
      'addIdea',
      'buildMindMap',
      'addNode',
      'linkNodes',
      'createDocument',
      'createPlan',
    ];
    for (const id of ['geryon', 'minos']) {
      const role = AGENT_ROLES.find((r) => r.id === id)!;
      for (const t of role.tools ?? []) {
        expect(
          VAULT_TOOLS,
          `${id} should not declare vault tool "${t}" in role.tools`,
        ).not.toContain(t);
      }
    }
  });

  it('base systemPrompt does not embed createPlan mandatories (addendum-only)', () => {
    expect(nettunoRole.systemPrompt).not.toMatch(/createPlan\(/);
    expect(nettunoRole.designPhaseAddendum).toMatch(/createPlan/);
  });
});
