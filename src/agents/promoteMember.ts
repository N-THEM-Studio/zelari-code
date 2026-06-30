/**
 * promoteMember — cross-schema promotion from AgentRole to CodingSkillDefinition.
 *
 * Converts a council member definition into a standalone skill that can be
 * invoked via `/skill <id>` (if registered) or persisted as a `SKILL.md`
 * file for manual loading.
 *
 * Mapping (AgentRole → CodingSkillDefinition):
 *   - id            → id (slugified)
 *   - name          → name
 *   - role          → category (e.g. "Council Director")
 *   - codename      → tag `codename:<x>`
 *   - systemPrompt  → systemPromptFragment (CLARIFICATION_PROTOCOL stripped)
 *   - tools[]       → requiredTools[]
 *   - skills[]      → relatedSkills[]
 *   - (auto)        → description, version, estimatedCost, enabledByDefault,
 *                     builtin (false), requiredRoles ([memberId]),
 *                     triggers, antiPatterns, examples (1), outputSchema, tags
 *
 * This is a PURE function — no I/O, no side effects. The caller
 * (electron/cli/app.tsx dispatcher) is responsible for persisting
 * the markdown output to disk.
 *
 * @see docs/plans/2026-06-30-anathema-coder-v3-K.md
 */

import type { AgentRole } from '../types';
import type { CodingCategory, CodingSkillDefinition } from './skills';
import { AGENT_ROLES, UnknownMemberError, getAgent } from './roles';

/**
 * Map an AgentRole.role (free string) to a CodingCategory (closed union).
 * Unknown roles fall back to 'planning' — the safest default (most council
 * methodologies begin with planning).
 */
const ROLE_TO_CATEGORY: Record<string, CodingCategory> = {
  'Council Director': 'planning',
  'Project Planner': 'planning',
  'Creative Ideator': 'planning',
  'Knowledge Architect': 'planning',
  'Quality Critic': 'review',
  'Final Synthesizer': 'planning',
};

function categoryForRole(role: string): CodingCategory {
  return ROLE_TO_CATEGORY[role] ?? 'planning';
}

export interface PromoteMemberOptions {
  /** Override the auto-derived version (default: '1.0.0'). */
  version?: string;
  /** Override the auto-derived estimated cost (default: 'medium'). */
  estimatedCost?: 'low' | 'medium' | 'high';
  /** Override the auto-derived enabledByDefault (default: true). */
  enabledByDefault?: boolean;
  /** Override the auto-derived description. */
  description?: string;
  /** Override the auto-derived triggers list. */
  triggers?: string[];
  /** Override the auto-derived antiPatterns list. */
  antiPatterns?: string[];
}

export interface PromotionResult {
  /** The constructed skill definition. */
  skill: CodingSkillDefinition;
  /** Valid SKILL.md markdown (YAML frontmatter + body). */
  markdown: string;
}

/**
 * Pure function: convert a council member into a skill definition +
 * markdown file content. Throws `UnknownMemberError` if `memberId` is
 * not a known agent.
 *
 * Examples:
 *   promoteMember('hephaestus')
 *     → { skill: { id: 'hephaestus', name: 'Hephaestus', ... }, markdown: '---\n...---\n...' }
 *   promoteMember('zaphod')  // throws UnknownMemberError
 */
export function promoteMember(
  memberId: string,
  options: PromoteMemberOptions = {},
): PromotionResult {
  const agent = getAgent(memberId);
  if (!agent) {
    throw new UnknownMemberError(memberId, AGENT_ROLES.map((r) => r.id));
  }

  const skill = buildSkillDefinition(agent, options);
  const markdown = renderSkillMarkdown(agent, skill);
  return { skill, markdown };
}

/**
 * Construct the CodingSkillDefinition from an AgentRole + options.
 * Exported for testing — production code uses `promoteMember`.
 */
export function buildSkillDefinition(
  agent: AgentRole,
  options: PromoteMemberOptions,
): CodingSkillDefinition {
  const version = options.version ?? '1.0.0';
  const estimatedCost = options.estimatedCost ?? 'medium';
  const enabledByDefault = options.enabledByDefault ?? true;
  const description =
    options.description ?? `Run the ${agent.role} methodology (${agent.codename}).`;
  const triggers =
    options.triggers ?? autoTriggers(agent);
  const antiPatterns =
    options.antiPatterns ?? [
      'Request requires direct execution rather than strategic framing.',
      'A simpler single-agent prompt would suffice — promote only when the full council methodology adds value.',
    ];

  return {
    id: slugify(agent.id),
    version,
    name: agent.name,
    description,
    category: categoryForRole(agent.role),
    requiredRoles: [agent.id],
    requiredTools: agent.tools,
    estimatedCost,
    enabledByDefault,
    builtin: false,
    triggers,
    antiPatterns,
    requires: [],
    relatedSkills: agent.skills ?? [],
    tags: buildTags(agent),
    examples: buildExamples(agent),
    outputSchema: '{ result: string }',
    systemPromptFragment: stripClarificationProtocol(agent.systemPrompt),
  };
}

/**
 * Render the skill definition as a valid SKILL.md file (YAML frontmatter +
 * markdown body). Exported for testing.
 */
export function renderSkillMarkdown(
  agent: AgentRole,
  skill: CodingSkillDefinition,
): string {
  const frontmatter = [
    '---',
    `id: ${skill.id}`,
    `version: ${skill.version}`,
    `name: ${skill.name}`,
    `category: ${skill.category}`,
    `estimatedCost: ${skill.estimatedCost}`,
    `enabledByDefault: ${String(skill.enabledByDefault)}`,
    `builtin: ${String(skill.builtin)}`,
    `tags: [${skill.tags.map((t) => `"${t}"`).join(', ')}]`,
    `requiredRoles: [${skill.requiredRoles.map((r) => `"${r}"`).join(', ')}]`,
    `requiredTools: [${skill.requiredTools.map((r) => `"${r}"`).join(', ')}]`,
    `relatedSkills: [${skill.relatedSkills.map((r) => `"${r}"`).join(', ')}]`,
    '---',
  ].join('\n');

  const body = [
    '',
    `# ${skill.name} — ${agent.codename}`,
    '',
    `> ${skill.description}`,
    '',
    '## Methodology',
    '',
    skill.systemPromptFragment.trim(),
    '',
    '## Triggers',
    '',
    ...skill.triggers.map((t) => `- ${t}`),
    '',
    '## Anti-patterns',
    '',
    ...skill.antiPatterns.map((a) => `- ${a}`),
    '',
    '## Example',
    '',
    ...formatExamples(skill.examples),
    '',
    '## Output',
    '',
    `\`\`\`ts`,
    skill.outputSchema,
    `\`\`\``,
    '',
  ].join('\n');

  return frontmatter + body;
}

// ---------- helpers (private) ----------

/** Slugify: lowercase, replace underscores/spaces with hyphens. */
export function slugify(s: string): string {
  return s.trim().toLowerCase().replace(/[_\s]+/g, '-');
}

/**
 * Strip the CLARIFICATION_PROTOCOL block from an AgentRole systemPrompt.
 * Looks for the trailing block starting with a line that contains only
 * `WHEN TO ASK THE USER` or `Rules for clarifications:`.
 */
export function stripClarificationProtocol(systemPrompt: string): string {
  const idx = systemPrompt.indexOf('\nWHEN TO ASK THE USER');
  if (idx === -1) return systemPrompt;
  return systemPrompt.slice(0, idx).trimEnd();
}

/** Build the tag list from codename + role + category slug. */
function buildTags(agent: AgentRole): string[] {
  const categorySlug = slugify(agent.role);
  return [
    `codename:${agent.codename.toLowerCase()}`,
    `role:${agent.id}`,
    `category:${categorySlug}`,
    'promoted',
    'council-member',
  ];
}

/** Auto-derived triggers from the agent's role description. */
function autoTriggers(agent: AgentRole): string[] {
  return [
    `The task benefits from the ${agent.role} methodology (${agent.codename}).`,
    `A complex, multi-step request that matches ${agent.name}'s specialty.`,
    `The user explicitly invokes the ${agent.name} methodology.`,
  ];
}

/** Build one minimal example for the skill markdown. */
function buildExamples(agent: AgentRole): CodingSkillDefinition['examples'] {
  return [
    {
      input: `Apply ${agent.name} (${agent.codename}) to: "Frame this request before delegating."`,
      output: {
        framing: `${agent.codename} framing follows the methodology in the system prompt fragment.`,
        delegation: 'Output identifies the relevant specialists and what they should deliver.',
        constraints: 'Cross-cutting risks and ordering constraints are called out explicitly.',
      },
    },
  ];
}

/** Format examples as markdown bullet lines. */
function formatExamples(
  examples: CodingSkillDefinition['examples'],
): string[] {
  const lines: string[] = [];
  for (const ex of examples) {
    lines.push(`**Input:** ${ex.input}`);
    lines.push('');
    lines.push('**Output:**');
    lines.push('```json');
    lines.push(JSON.stringify(ex.output, null, 2));
    lines.push('```');
    lines.push('');
  }
  return lines;
}