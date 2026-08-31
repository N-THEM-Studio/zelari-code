/**
 * skill — lazy-load a coding skill body into the conversation (OpenCode-style).
 *
 * The system prompt lists only skill names + short descriptions; the model
 * calls this tool when it needs the full instructions. Avoids bloating every
 * turn with all skill bodies.
 *
 * @since v1.21.0
 */
import { z } from 'zod';
import {
  getCodingSkillById,
  listCodingSkills,
} from '@zelari/core/skills';
import {
  typedOk,
  typedErr,
  type ToolDefinition,
} from '@zelari/core/harness/tools/toolTypes';
import { loadSkillMdSkills } from '../skillsMd.js';
import {
  filterSkillCatalogByBand,
  type RetrievalPressureBand,
} from '../budget/retrievalPolicy.js';

const SkillArgsSchema = z.object({
  name: z
    .string()
    .min(1)
    .describe('Skill id/name to load (from the available skills list).'),
});

type SkillArgs = z.infer<typeof SkillArgsSchema>;

/**
 * Build the catalog text for system prompts / tool description.
 * With `pressureBand: 'high'`, high-cost skills are hidden from the advertised
 * catalog (budget-aware retrieval, T4 follow-up) but stay loadable by name
 * via the tool's execute path.
 */
export function formatAvailableSkillsCatalog(
  cwd: string = process.cwd(),
  opts?: { pressureBand?: RetrievalPressureBand },
): string {
  // Ensure project SKILL.md skills are registered once per process path.
  try {
    loadSkillMdSkills(cwd);
  } catch {
    /* ignore load failures — catalog still has builtins */
  }
  const band = opts?.pressureBand;
  const all = listCodingSkills();
  if (all.length === 0) {
    return 'No skills registered.';
  }
  const gated = band ? filterSkillCatalogByBand(all, band) : all;
  const hidden = all.length - gated.length;
  const lines = gated.slice(0, 80).map((s) => {
    const desc = (s.description || s.id).replace(/\s+/g, ' ').trim().slice(0, 160);
    return `- ${s.id}: ${desc}`;
  });
  if (hidden > 0) {
    lines.push(
      `(plus ${hidden} high-cost skill(s) hidden under context pressure — still loadable by name if truly needed)`,
    );
  }
  return lines.join('\n');
}

export function createSkillTool(opts?: {
  cwd?: string;
  pressureBand?: RetrievalPressureBand;
}): ToolDefinition<SkillArgs, { name: string; content: string }> {
  const cwd = opts?.cwd ?? process.cwd();
  const catalog = formatAvailableSkillsCatalog(cwd, {
    pressureBand: opts?.pressureBand,
  });

  return {
    name: 'skill',
    description:
      'Load the full instructions for a named coding skill into this turn. ' +
      'Call when a skill matches the current task. Available skills:\n' +
      catalog,
    permissions: ['read'],
    timeoutMs: 10_000,
    inputSchema: SkillArgsSchema,
    execute: async (args) => {
      try {
        loadSkillMdSkills(cwd);
      } catch {
        /* continue with already-registered */
      }
      const id = args.name.trim();
      const skill =
        getCodingSkillById(id) ??
        listCodingSkills().find(
          (s) => s.id.toLowerCase() === id.toLowerCase() || s.name?.toLowerCase() === id.toLowerCase(),
        );
      if (!skill) {
        const known = listCodingSkills()
          .map((s) => s.id)
          .slice(0, 40)
          .join(', ');
        return typedErr(
          `Unknown skill "${id}". Known: ${known || '(none)'}. Use /skill or pick from the list.`,
        );
      }
      const body =
        skill.systemPromptFragment?.trim() ||
        skill.description ||
        `(skill ${skill.id} has no body)`;
      const header = `# Skill: ${skill.id}\n${skill.description ? `> ${skill.description}\n\n` : ''}`;
      return typedOk({
        name: skill.id,
        content: header + body,
      });
    },
  };
}
