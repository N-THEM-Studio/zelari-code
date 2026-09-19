/**
 * skillsCheck — the static validator behind `zelari-code skills:check`.
 *
 * PURE STATIC: every skill content is READ and parsed as text. Nothing from a
 * SKILL.md is ever executed, imported, sourced or interpreted — the only I/O
 * is existsSync/readdirSync/readFileSync, and the checks below mirror what
 * `skillsMd.parseSkillMd` / `loadSkillMdSkills` (the real loader) actually
 * require, so a green report means "the CLI will load this".
 *
 * The loader's rules, restated as checks:
 *   - a skill is `<root>/<name>/SKILL.md`; roots come from `skillMdSearchDirs`
 *     (project .zelari/.claude/.opencode + user-global), earlier dir wins on a
 *     duplicate name;
 *   - frontmatter block `--- … ---`, flat `key: value` pairs;
 *   - `name` required, lowercased, `/^[a-z0-9][a-z0-9-]{0,63}$/`;
 *   - `description` required and non-empty;
 *   - a non-empty markdown body;
 *   - unknown keys and bad `category`/`cost` values are TOLERATED by the
 *     loader (ignored / defaulted) → warnings here, never errors.
 *
 * Report shape: { ok, lines: [{ level: 'error' | 'warn' | 'info', what }] },
 * with the file path always inside `what`. `ok` is false when any line is an
 * error — that is the CI exit code (1) of the command.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { skillMdSearchDirs } from './skillsMd.js';

export type SkillsCheckLevel = 'error' | 'warn' | 'info';

export interface SkillsCheckLine {
  level: SkillsCheckLevel;
  /** Human line, always prefixed with the file (or directory) it is about. */
  what: string;
}

export interface SkillsCheckReport {
  /** False iff at least one line is an error. */
  ok: boolean;
  lines: SkillsCheckLine[];
}

/** Sane cap for one SKILL.md, in characters. A procedure is prose, not a dataset. */
export const SKILL_MD_MAX_CHARS = 256 * 1024;

/** The slug the loader enforces (opencode/Claude-compatible): lowercase + hyphens. */
export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Frontmatter + body capture — the loader's own regex (skillsMd.parseSkillMd). */
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
const KV_RE = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/;

/** Fields the loader consumes; anything else is ignored (warned, not fatal). */
const KNOWN_FIELDS = new Set([
  'name',
  'description',
  'category',
  'tools',
  'requiredtools',
  'required_tools',
  'cost',
  'estimatedcost',
]);

/** Valid `category` values (mirror of CODING_CATEGORIES in skillsMd.ts). */
const CATEGORIES = new Set([
  'plan', 'refactor', 'debug', 'review', 'test', 'docs', 'ops', 'git', 'db', 'maint',
]);

const COSTS = new Set(['low', 'medium', 'high']);

export interface ParsedFrontmatter {
  fields: Record<string, string>;
  body: string;
}

/**
 * Parse exactly like the loader does (flat `key: value`, quotes stripped,
 * nested YAML lines skipped). Returns null when the frontmatter block is
 * absent — the loader's "this file is not a skill" verdict.
 */
export function parseFrontmatter(content: string): ParsedFrontmatter | null {
  const fm = FRONTMATTER_RE.exec(content);
  if (!fm) return null;
  const [, fmRaw = '', body = ''] = fm;
  const fields: Record<string, string> = {};
  for (const line of fmRaw.split(/\r?\n/)) {
    const kv = KV_RE.exec(line);
    if (!kv) continue;
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
  return { fields, body };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Validate ONE SKILL.md's text. Pure: no filesystem, no execution. */
export function checkSkillMd(path: string, content: string): SkillsCheckLine[] {
  const lines: SkillsCheckLine[] = [];
  const push = (level: SkillsCheckLevel, detail: string): void => {
    lines.push({ level, what: `${path}: ${detail}` });
  };

  if (content.length === 0) {
    push('error', 'file is empty (the loader requires frontmatter AND a body)');
    return lines;
  }
  if (content.length > SKILL_MD_MAX_CHARS) {
    push(
      'error',
      `too large: ${content.length} chars > cap ${SKILL_MD_MAX_CHARS} (keep a skill a procedure, not a dataset)`,
    );
  }

  const parsed = parseFrontmatter(content);
  if (!parsed) {
    push(
      'error',
      'missing YAML frontmatter (expected `---`, `name:`, `description:`, `---`, then the body) — the loader skips this file',
    );
    return lines;
  }

  const { fields, body } = parsed;
  const name = (fields['name'] ?? '').trim();
  const description = (fields['description'] ?? '').trim();

  if (!name) {
    push('error', 'frontmatter is missing `name` — the loader skips this file');
  } else if (!SKILL_NAME_RE.test(name.toLowerCase())) {
    push(
      'error',
      `invalid name "${name}": expected a slug (lowercase letters/digits/hyphens, start alphanumeric, max 64 chars) — the loader rejects the file`,
    );
  } else if (name !== name.toLowerCase()) {
    push('warn', `name "${name}" is not lowercase; the loader stores it as "${name.toLowerCase()}"`);
  }

  if (!description) push('error', 'frontmatter is missing `description` — the loader skips this file');
  if (!body.trim()) push('error', 'body is empty — the loader requires markdown instructions after the frontmatter');

  for (const key of Object.keys(fields)) {
    if (!KNOWN_FIELDS.has(key)) push('warn', `unknown frontmatter field \`${key}\` (ignored by the loader)`);
  }

  const category = (fields['category'] ?? '').trim().toLowerCase();
  if (category && !CATEGORIES.has(category)) {
    push('warn', `unknown category "${category}" (the loader falls back to "maint")`);
  }

  const cost = (fields['cost'] ?? fields['estimatedcost'] ?? '').trim().toLowerCase();
  if (cost && !COSTS.has(cost)) {
    push('warn', `unknown cost "${cost}" (the loader falls back to "medium")`);
  }

  if (!lines.some((l) => l.level === 'error')) {
    push('info', `valid (${body.trim().length} chars of body)`);
  }
  return lines;
}

export interface SkillsCheckOptions {
  /** Project root for `<root>/.zelari/skills` (default: process.cwd()). */
  projectRoot?: string;
  /** Roots to scan instead of the loader's discovery dirs (tests/fixtures). */
  roots?: readonly string[];
}

/**
 * Validate every discovered SKILL.md. Discovery mirrors the loader (including
 * the "earlier directory wins" duplicate rule, reported as a warning) and is
 * read-only: the report is the only output.
 */
export function checkSkillFiles(options: SkillsCheckOptions = {}): SkillsCheckReport {
  const roots = options.roots ?? skillMdSearchDirs(options.projectRoot ?? process.cwd());
  const lines: SkillsCheckLine[] = [];
  const ownerByName = new Map<string, string>();
  let existingRoots = 0;
  let skillsChecked = 0;

  for (const root of roots) {
    if (!existsSync(root)) continue; // the loader skips missing dirs silently
    existingRoots += 1;

    let entries: string[];
    try {
      entries = readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort(); // deterministic report (the loader itself takes readdir order)
    } catch (err) {
      lines.push({ level: 'error', what: `${root}: unreadable skills directory — ${messageOf(err)}` });
      continue;
    }

    for (const entry of entries) {
      const dir = join(root, entry);
      const path = join(dir, 'SKILL.md');
      if (!existsSync(path)) {
        lines.push({ level: 'warn', what: `${dir}: no SKILL.md inside this skills directory (ignored by the loader)` });
        continue;
      }

      let content: string;
      try {
        content = readFileSync(path, 'utf8');
      } catch (err) {
        lines.push({ level: 'error', what: `${path}: unreadable — ${messageOf(err)}` });
        continue;
      }

      skillsChecked += 1;
      lines.push(...checkSkillMd(path, content));

      const name = (parseFrontmatter(content)?.fields['name'] ?? '').trim().toLowerCase();
      if (!name) continue;
      const owner = ownerByName.get(name);
      if (owner) {
        lines.push({
          level: 'warn',
          what: `${path}: name "${name}" is already provided by ${owner} (earlier directory wins; this file is skipped)`,
        });
      } else {
        ownerByName.set(name, path);
      }
    }
  }

  if (existingRoots === 0) {
    lines.push({ level: 'info', what: `no skills directory found (checked: ${roots.join(', ')})` });
  }
  lines.push({
    level: 'info',
    what: `${skillsChecked} SKILL.md file(s) checked in ${existingRoots} directory(ies) — static only, nothing was executed`,
  });

  return { ok: !lines.some((l) => l.level === 'error'), lines };
}

/** Render the report for a terminal / CI log. */
export function formatSkillsCheckReport(report: SkillsCheckReport): string {
  const label: Record<SkillsCheckLevel, string> = {
    error: 'ERROR',
    warn: 'WARN ',
    info: 'INFO ',
  };
  const count = (level: SkillsCheckLevel): number =>
    report.lines.filter((l) => l.level === level).length;
  const out = report.lines.map((l) => `${label[l.level]} ${l.what}`);
  out.push(
    `${report.ok ? 'OK' : 'FAILED'}: ${count('error')} error(s), ${count('warn')} warning(s), ${count('info')} info`,
  );
  return out.join('\n');
}
