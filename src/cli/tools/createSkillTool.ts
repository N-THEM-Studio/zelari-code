/**
 * create_skill — persist a user-defined skill as a discoverable SKILL.md.
 *
 * The companion of {@link createSkillTool} (`skill`): `skill` lazily loads a
 * skill body into the conversation, `create_skill` writes a NEW one into the
 * two WRITABLE roots that `skillsMd.loadSkillMdSkills()` already scans:
 *
 *   project → <turn cwd>/.zelari/skills/<name>/SKILL.md   (default)
 *   user    → ~/.zelari-code/skills/<name>/SKILL.md       (ZELARI_HOME aware)
 *
 * The file goes through `skillConfigIo.upsertSkill()` — the SAME single store
 * the CLI `--set-skill` flag and the Desktop skill editor use, so there is no
 * second store and no format drift: the writer round-trips its own output
 * through `parseSkillMd()` before it hits the disk.
 *
 * Immediate usability: the `skill` tool re-scans those roots on every call
 * (skillsMd.loadSkillMdSkills is on-demand), so a skill created here is
 * invocable as `/skill <name>` in the very next step — no restart, no cache.
 *
 * @since v2.40.0
 */
import { existsSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { z } from 'zod';
import { getCodingSkillById } from '@zelari/core/skills';
import {
  typedOk,
  typedErr,
  type ToolDefinition,
} from '@zelari/core/harness/tools/toolTypes';
import {
  getProjectSkillsDir,
  getUserSkillsDir,
  upsertSkill,
} from '../skillConfigIo.js';
import { loadSkillMdSkills } from '../skillsMd.js';

/**
 * Slug constraint, narrower than the one `parseSkillMd` enforces
 * (`^[a-z0-9][a-z0-9-]{0,63}$`): 2..40 chars, must START with [a-z0-9], so the
 * directory name can never contain a path separator, a drive letter or `..`.
 * Being a strict subset of the parser's rule means anything accepted here is
 * guaranteed loadable afterwards.
 */
const NAME_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;

const CreateSkillArgsSchema = z.object({
  name: z
    .string()
    .regex(NAME_RE)
    .describe(
      'Skill id/slug: 2-40 chars, lowercase letters/digits/hyphens, must start with a letter or digit.',
    ),
  description: z
    .string()
    .min(1)
    .describe(
      'One-line description shown in the skill catalog (when to use it). Collapsed to a single line.',
    ),
  instructions: z
    .string()
    .min(1)
    .describe(
      'The skill body, in markdown: goal, step-by-step procedure, exact commands, pitfalls. Becomes the loaded instructions verbatim.',
    ),
  scope: z
    .enum(['project', 'user'])
    .optional()
    .describe(
      "Where to save: 'project' (default) = <cwd>/.zelari/skills (repo-shared); 'user' = ~/.zelari-code/skills (every project).",
    ),
  overwrite: z
    .boolean()
    .optional()
    .describe('Default false: fail if a SKILL.md for that name already exists. Pass true to replace it.'),
});

export type CreateSkillArgs = z.infer<typeof CreateSkillArgsSchema>;

export interface CreateSkillResult {
  name: string;
  scope: 'project' | 'user';
  /** Absolute path of the written SKILL.md. */
  path: string;
  /** true when an existing SKILL.md at that path was replaced (overwrite=true). */
  overwritten: boolean;
  /** true when `skill <name>` resolves to THIS file right now. */
  loadable: boolean;
  /** Model-facing confirmation: what was saved, where, and how to invoke it. */
  message: string;
}

/**
 * Build the `create_skill` tool. `cwd` is the turn/project root whose
 * `.zelari/skills` directory receives project-scope skills (the registry root,
 * same convention as {@link createSkillTool}).
 */
export function createCreateSkillTool(opts?: {
  cwd?: string;
}): ToolDefinition<CreateSkillArgs, CreateSkillResult> {
  const root = opts?.cwd ?? process.cwd();

  return {
    name: 'create_skill',
    description:
      'Create a NEW reusable skill (a SKILL.md procedure) that you can invoke in later turns with the ' +
      "`skill` tool or `/skill <name>`. Use it when the user asks to save a procedure as a skill " +
      '("salva questa procedura come skill", "crea una skill per X", "make this reusable"), or when you ' +
      'just worked out a repeatable workflow worth persisting. Write `instructions` as a COMPLETE, ' +
      'self-contained markdown procedure (goal, ordered steps, exact commands, verification, pitfalls): ' +
      'it becomes the skill body verbatim. scope=project (default) saves to <cwd>/.zelari/skills and is ' +
      'shared with the repo; scope=user saves to ~/.zelari-code/skills for every project. ' +
      'Creating an existing name fails unless overwrite=true. Does not edit built-in skills.',
    permissions: ['write'],
    timeoutMs: 10_000,
    inputSchema: CreateSkillArgsSchema,
    execute: async (args) => {
      // Defense in depth: the zod gate runs upstream, but a direct execute()
      // call must not be able to write outside the two writable skill roots.
      const name = typeof args?.name === 'string' ? args.name.trim() : '';
      if (!NAME_RE.test(name)) {
        return typedErr(
          `Invalid skill name ${JSON.stringify(name)}. Use a slug of 2-40 chars: ` +
            'lowercase letters, digits and hyphens, starting with a letter or digit (e.g. "release-checklist").',
        );
      }
      // A multi-line description would corrupt the YAML frontmatter line.
      const description = (args?.description ?? '').replace(/\s+/g, ' ').trim();
      if (!description) {
        return typedErr('description is required: one line explaining when to use this skill.');
      }
      const instructions = (args?.instructions ?? '').trim();
      if (!instructions) {
        return typedErr(
          'instructions is required: the markdown body of the skill (goal, steps, commands, pitfalls).',
        );
      }
      const scope: 'project' | 'user' = args?.scope === 'user' ? 'user' : 'project';
      const overwrite = args?.overwrite === true;

      const dir = scope === 'user' ? getUserSkillsDir() : getProjectSkillsDir(root);
      const skillDir = resolve(dir, name);
      const path = resolve(skillDir, 'SKILL.md');
      // The slug regex already makes escapes impossible; this keeps the
      // containment property explicit (and survives a future regex relaxation).
      if (!path.startsWith(resolve(dir) + sep)) {
        return typedErr(
          `Refused: "${name}" would resolve outside the ${scope} skills directory (${resolve(dir)}).`,
        );
      }

      const existed = existsSync(path);
      if (existed && !overwrite) {
        return typedErr(
          `Skill "${name}" already exists at ${path} — nothing was written. ` +
            'Call create_skill again with overwrite: true to replace it, or pick another name.',
        );
      }

      const written = upsertSkill({
        scope,
        name,
        description,
        body: instructions,
        projectRoot: root,
      });
      if (!written.ok) {
        return typedErr(`Could not write SKILL.md for "${name}": ${written.error}`);
      }

      // Best-effort: register the new file NOW so the current turn's catalog
      // sees it too. The `skill` tool re-scans on demand anyway, so a failure
      // here never makes the skill unusable.
      let loadable = false;
      try {
        loadSkillMdSkills(root);
        const registered = getCodingSkillById(name);
        loadable = (registered?.systemPromptFragment ?? '').trim() === instructions;
      } catch {
        /* keep loadable=false — reported honestly below */
      }

      const verb = existed ? 'Replaced existing skill' : 'Created skill';
      const lines = [
        `${verb} "${name}" (${scope} scope).`,
        `Saved to: ${written.path}`,
      ];
      if (!loadable) {
        lines.push(
          `Note: \`${name}\` currently resolves to a DIFFERENT skill already registered from ` +
            'another root (a built-in or an earlier search dir wins), so `/skill ' +
            `${name}\` may load that one instead. The file on disk is unchanged.`,
        );
      }
      lines.push(
        `Use it now: \`/skill ${name}\` — or call the \`skill\` tool with name "${name}". ` +
          'Skills are discovered on demand, so no restart is needed.',
      );

      return typedOk({
        name,
        scope,
        path: written.path,
        overwritten: existed,
        loadable,
        message: lines.join('\n'),
      });
    },
  };
}
