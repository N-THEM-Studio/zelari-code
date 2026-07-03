/**
 * skillsMd — load user-defined skills from SKILL.md files (v0.7.5).
 *
 * opencode, Hermes Agent, and Claude Code converge on the same on-disk
 * format: one directory per skill containing a `SKILL.md` with YAML
 * frontmatter (`name`, `description`) and a markdown body of instructions.
 * Supporting that format means ANY skill from those ecosystems can be
 * dropped into this project and used via `/skill <name>` unchanged.
 *
 * Discovery order (first occurrence of a name wins — project beats global):
 *   1. <project>/.zelari/skills/<name>/SKILL.md   (native)
 *   2. <project>/.claude/skills/<name>/SKILL.md   (Claude Code compat)
 *   3. <project>/.opencode/skills/<name>/SKILL.md (opencode compat)
 *   4. ~/.zelari-code/skills/<name>/SKILL.md      (global)
 *
 * The body becomes the skill's systemPromptFragment; recognized frontmatter
 * beyond name/description: `category` (one of the coding categories),
 * `tools` (list or comma string → requiredTools), `cost` (low|medium|high).
 * Unknown fields are ignored, never fatal — a malformed SKILL.md is skipped
 * with a warning entry in the returned summary.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { registerCodingSkill, type CodingSkillDefinition, type SkillCost } from '@zelari/core/skills';

/** Valid coding categories (mirror of CODING_CATEGORY values in core). */
const CODING_CATEGORIES = new Set([
  'plan', 'refactor', 'debug', 'review', 'test', 'docs', 'ops', 'git', 'db', 'maint',
]);

export interface ParsedSkillMd {
  name: string;
  description: string;
  category: string;
  requiredTools: string[];
  estimatedCost: SkillCost;
  body: string;
  sourcePath: string;
}

export interface SkillMdLoadSummary {
  loaded: string[];
  skipped: Array<{ path: string; reason: string }>;
}

/** Skill discovery roots for a project (project-local first, then global). */
export function skillMdSearchDirs(projectRoot: string = process.cwd()): string[] {
  return [
    join(projectRoot, '.zelari', 'skills'),
    join(projectRoot, '.claude', 'skills'),
    join(projectRoot, '.opencode', 'skills'),
    join(homedir(), '.zelari-code', 'skills'),
  ];
}

/**
 * Parse a SKILL.md file: YAML frontmatter subset (flat `key: value` pairs
 * and `[a, b]` inline lists — nested structures are ignored) + body.
 * Returns null with no throw on files without usable name/description.
 */
export function parseSkillMd(content: string, sourcePath: string): ParsedSkillMd | null {
  const fmMatch = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(content);
  if (!fmMatch) return null;
  const [, fmRaw = '', body = ''] = fmMatch;

  const fields: Record<string, string> = {};
  for (const line of fmRaw.split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue; // nested/indented lines from unsupported YAML — skip
    const key = (kv[1] ?? '').toLowerCase();
    let value = (kv[2] ?? '').trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    fields[key] = value;
  }

  const name = (fields['name'] ?? '').trim().toLowerCase();
  const description = (fields['description'] ?? '').trim();
  if (!name || !description) return null;
  // Same constraint opencode enforces: lowercase alphanumerics + hyphens.
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) return null;

  const rawTools = fields['tools'] ?? fields['requiredtools'] ?? fields['required_tools'] ?? '';
  const requiredTools = rawTools
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((t) => t.trim().replace(/^["']|["']$/g, ''))
    .filter((t) => t.length > 0);

  const rawCategory = (fields['category'] ?? '').trim().toLowerCase();
  const category = CODING_CATEGORIES.has(rawCategory) ? rawCategory : 'maint';

  const rawCost = (fields['cost'] ?? fields['estimatedcost'] ?? '').trim().toLowerCase();
  const estimatedCost: SkillCost =
    rawCost === 'low' || rawCost === 'high' ? rawCost : 'medium';

  const trimmedBody = body.trim();
  if (!trimmedBody) return null;

  return { name, description, category, requiredTools, estimatedCost, body: trimmedBody, sourcePath };
}

/** Adapt a parsed SKILL.md into the strict CodingSkillDefinition shape. */
export function toCodingSkillDefinition(parsed: ParsedSkillMd): CodingSkillDefinition {
  return {
    id: parsed.name,
    name: parsed.name,
    description: parsed.description,
    version: '1.0.0',
    category: parsed.category as CodingSkillDefinition['category'],
    systemPromptFragment: parsed.body,
    requiredTools: parsed.requiredTools,
    enabledByDefault: true,
    builtin: false,
    requires: [],
    examples: [],
    triggers: [],
    antiPatterns: [],
    requiredRoles: [],
    estimatedCost: parsed.estimatedCost,
    outputSchema: 'string',
    relatedSkills: [],
    tags: ['user', 'skill-md'],
  };
}

/**
 * Scan the search dirs, parse every `<dir>/<skill>/SKILL.md`, and register
 * the results in the coding-skill catalog (upsert — but a name already
 * loaded from an earlier dir in the search order is NOT overridden, and
 * builtin skills are never shadowed).
 *
 * Best-effort: any I/O or parse error skips that one skill.
 */
export function loadSkillMdSkills(
  projectRoot: string = process.cwd(),
  options: { existingIds?: ReadonlySet<string> } = {},
): SkillMdLoadSummary {
  const summary: SkillMdLoadSummary = { loaded: [], skipped: [] };
  const seen = new Set<string>(options.existingIds ?? []);

  for (const dir of skillMdSearchDirs(projectRoot)) {
    if (!existsSync(dir)) continue;
    let entries: string[];
    try {
      entries = readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const skillPath = join(dir, entry, 'SKILL.md');
      if (!existsSync(skillPath)) continue;
      try {
        const parsed = parseSkillMd(readFileSync(skillPath, 'utf8'), skillPath);
        if (!parsed) {
          summary.skipped.push({ path: skillPath, reason: 'missing/invalid frontmatter (name, description) or empty body' });
          continue;
        }
        if (seen.has(parsed.name)) {
          summary.skipped.push({ path: skillPath, reason: `name "${parsed.name}" already registered (earlier dir or builtin wins)` });
          continue;
        }
        registerCodingSkill(toCodingSkillDefinition(parsed));
        seen.add(parsed.name);
        summary.loaded.push(parsed.name);
      } catch (err) {
        summary.skipped.push({ path: skillPath, reason: err instanceof Error ? err.message : String(err) });
      }
    }
  }
  return summary;
}
