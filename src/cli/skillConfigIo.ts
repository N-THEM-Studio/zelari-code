/**
 * Read/write SKILL.md skills for Desktop & scripts (parity with mcpConfigIo).
 *
 * Writable scopes:
 *   user:    ~/.zelari-code/skills/<name>/SKILL.md
 *   project: <cwd>/.zelari/skills/<name>/SKILL.md
 *
 * Discovery (read-only listing) also surfaces compat dirs (.claude / .opencode)
 * and built-in coding skills from @zelari/core.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import {
  listCodingSkills,
  type CodingSkillDefinition,
} from '@zelari/core/skills';
import { parseSkillMd, type ParsedSkillMd } from './skillsMd.js';
import { CODING_CATEGORIES } from './skillCategories.js';

export type SkillConfigScope = 'user' | 'project' | 'compat' | 'builtin';

export interface SkillEntryDto {
  id: string;
  name: string;
  description: string;
  category?: string;
  estimatedCost?: string;
  requiredTools?: string[];
  /** user | project | compat (.claude/.opencode) | builtin */
  scope: SkillConfigScope;
  /** Absolute path to SKILL.md, or null for builtins. */
  path: string | null;
  /** Full markdown body (user/project/compat only). */
  body?: string;
  builtin: boolean;
  /** true when this entry can be removed/edited via --set-skill / --remove-skill */
  writable: boolean;
}

export interface SkillsSnapshot {
  userSkillsDir: string;
  projectSkillsDir: string | null;
  skills: SkillEntryDto[];
}

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Side-effect imports that register built-in coding skills into the catalog. */
const BUILTIN_SKILL_MODULES = [
  '@zelari/core/skills/builtin/debugging',
  '@zelari/core/skills/builtin/docs',
  '@zelari/core/skills/builtin/git-ops',
  '@zelari/core/skills/builtin/planning',
  '@zelari/core/skills/builtin/refactoring',
  '@zelari/core/skills/builtin/review',
  '@zelari/core/skills/builtin/testing',
  '@zelari/core/skills/builtin/schema-loop',
  '@zelari/core/skills/builtin/computer-use-cua',
] as const;

let builtinsLoaded = false;

/** Best-effort load of all builtin skill modules (idempotent). */
export async function ensureBuiltinSkillsLoaded(): Promise<void> {
  if (builtinsLoaded) return;
  await Promise.all(
    BUILTIN_SKILL_MODULES.map(async (spec) => {
      try {
        await import(spec);
      } catch {
        // Optional / missing export — ignore
      }
    }),
  );
  builtinsLoaded = true;
}

/** Sync variant for CLI paths that cannot await (uses dynamic import fire-and-forget is wrong — prefer async). */
export function ensureBuiltinSkillsLoadedSync(): void {
  if (builtinsLoaded) return;
  // Dynamic import is async; for sync print we list whatever is already registered
  // and kick off loads. Callers of listSkillsSnapshot should prefer the async path.
  for (const spec of BUILTIN_SKILL_MODULES) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require?.(spec);
    } catch {
      /* ESM — fall through to async import below */
    }
  }
}

export function getUserSkillsDir(): string {
  return join(homedir(), '.zelari-code', 'skills');
}

export function getProjectSkillsDir(projectRoot: string): string {
  return join(projectRoot, '.zelari', 'skills');
}

function skillFilePath(dir: string, name: string): string {
  return join(dir, name, 'SKILL.md');
}

function classifyScope(
  skillPath: string,
  projectRoot: string | null,
): { scope: SkillConfigScope; writable: boolean } {
  const userDir = getUserSkillsDir().replace(/\\/g, '/');
  const norm = skillPath.replace(/\\/g, '/');
  if (norm.startsWith(userDir + '/') || norm === userDir) {
    return { scope: 'user', writable: true };
  }
  if (projectRoot) {
    const projDir = getProjectSkillsDir(projectRoot).replace(/\\/g, '/');
    if (norm.startsWith(projDir + '/') || norm === projDir) {
      return { scope: 'project', writable: true };
    }
  }
  return { scope: 'compat', writable: false };
}

function entryFromParsed(
  parsed: ParsedSkillMd,
  projectRoot: string | null,
): SkillEntryDto {
  const { scope, writable } = classifyScope(parsed.sourcePath, projectRoot);
  return {
    id: parsed.name,
    name: parsed.name,
    description: parsed.description,
    category: parsed.category,
    estimatedCost: parsed.estimatedCost,
    requiredTools: parsed.requiredTools,
    scope,
    path: parsed.sourcePath,
    body: parsed.body,
    builtin: false,
    writable,
  };
}

function entryFromBuiltin(skill: CodingSkillDefinition): SkillEntryDto {
  return {
    id: skill.id,
    name: skill.name || skill.id,
    description: skill.description || '',
    category: skill.category,
    estimatedCost: skill.estimatedCost,
    requiredTools: skill.requiredTools,
    scope: 'builtin',
    path: null,
    // Expose body so Desktop skill picker can expand like `/skill <id>`.
    body: skill.systemPromptFragment || undefined,
    builtin: true,
    writable: false,
  };
}

/** Scan one skills root directory for SKILL.md files. */
function scanSkillsDir(
  dir: string,
  projectRoot: string | null,
  seen: Set<string>,
  out: SkillEntryDto[],
): void {
  if (!existsSync(dir)) return;
  let entries: string[];
  try {
    entries = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return;
  }
  for (const entry of entries) {
    const skillPath = skillFilePath(dir, entry);
    if (!existsSync(skillPath)) continue;
    try {
      const parsed = parseSkillMd(readFileSync(skillPath, 'utf8'), skillPath);
      if (!parsed) continue;
      if (seen.has(parsed.name)) continue;
      seen.add(parsed.name);
      out.push(entryFromParsed(parsed, projectRoot));
    } catch {
      // skip unreadable
    }
  }
}

/**
 * List skills: project .zelari → .claude → .opencode → user global → builtins.
 * First id wins (same order as loadSkillMdSkills).
 */
export function listSkillsSnapshot(projectRoot?: string | null): SkillsSnapshot {
  const root =
    projectRoot && projectRoot.trim() ? projectRoot.trim() : null;
  const userSkillsDir = getUserSkillsDir();
  const projectSkillsDir = root ? getProjectSkillsDir(root) : null;

  const skills: SkillEntryDto[] = [];
  const seen = new Set<string>();

  if (root) {
    scanSkillsDir(join(root, '.zelari', 'skills'), root, seen, skills);
    scanSkillsDir(join(root, '.claude', 'skills'), root, seen, skills);
    scanSkillsDir(join(root, '.opencode', 'skills'), root, seen, skills);
  }
  scanSkillsDir(userSkillsDir, root, seen, skills);

  // Builtins already registered in this process (may be empty if modules not imported).
  for (const s of listCodingSkills()) {
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    if (s.builtin) {
      skills.push(entryFromBuiltin(s));
    }
  }

  skills.sort((a, b) => {
    const order = (s: SkillConfigScope) =>
      s === 'project' ? 0 : s === 'user' ? 1 : s === 'compat' ? 2 : 3;
    const d = order(a.scope) - order(b.scope);
    if (d !== 0) return d;
    return a.id.localeCompare(b.id);
  });

  return { userSkillsDir, projectSkillsDir, skills };
}

/** Async list that also loads builtin modules first. */
export async function listSkillsSnapshotAsync(
  projectRoot?: string | null,
): Promise<SkillsSnapshot> {
  await ensureBuiltinSkillsLoaded();
  return listSkillsSnapshot(projectRoot);
}

export function serializeSkillMd(opts: {
  name: string;
  description: string;
  body: string;
  category?: string;
  tools?: string[];
  cost?: string;
}): string {
  const name = opts.name.trim().toLowerCase();
  const description = opts.description.trim();
  const body = opts.body.trim();
  const lines = ['---', `name: ${name}`, `description: ${description}`];
  const cat = (opts.category ?? '').trim().toLowerCase();
  if (cat && CODING_CATEGORIES.has(cat)) {
    lines.push(`category: ${cat}`);
  }
  if (opts.tools && opts.tools.length > 0) {
    lines.push(`tools: [${opts.tools.map((t) => t.trim()).filter(Boolean).join(', ')}]`);
  }
  const cost = (opts.cost ?? '').trim().toLowerCase();
  if (cost === 'low' || cost === 'medium' || cost === 'high') {
    lines.push(`cost: ${cost}`);
  }
  lines.push('---', '', body, '');
  return lines.join('\n');
}

export function upsertSkill(opts: {
  scope: 'user' | 'project';
  name: string;
  description: string;
  body: string;
  category?: string;
  tools?: string[];
  cost?: string;
  projectRoot?: string | null;
}): { ok: true; path: string } | { ok: false; error: string } {
  const name = opts.name.trim().toLowerCase();
  if (!name || !NAME_RE.test(name)) {
    return {
      ok: false,
      error:
        'Invalid skill name (use lowercase letters, digits, hyphens; max 64 chars)',
    };
  }
  const description = opts.description.trim();
  if (!description) {
    return { ok: false, error: 'description is required' };
  }
  const body = opts.body.trim();
  if (!body) {
    return { ok: false, error: 'body is required' };
  }

  let dir: string;
  if (opts.scope === 'user') {
    dir = getUserSkillsDir();
  } else {
    const root = opts.projectRoot?.trim();
    if (!root) {
      return {
        ok: false,
        error: 'projectRoot required for project scope (Open Folder first)',
      };
    }
    dir = getProjectSkillsDir(root);
  }

  const path = skillFilePath(dir, name);
  const content = serializeSkillMd({
    name,
    description,
    body,
    category: opts.category,
    tools: opts.tools,
    cost: opts.cost,
  });
  // Validate round-trip
  const parsed = parseSkillMd(content, path);
  if (!parsed) {
    return { ok: false, error: 'Generated SKILL.md failed validation' };
  }

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
  return { ok: true, path };
}

export function removeSkill(opts: {
  scope: 'user' | 'project';
  name: string;
  projectRoot?: string | null;
}): { ok: true; path: string } | { ok: false; error: string } {
  const name = opts.name.trim().toLowerCase();
  if (!name) {
    return { ok: false, error: 'name is required' };
  }
  let dir: string;
  if (opts.scope === 'user') {
    dir = getUserSkillsDir();
  } else {
    const root = opts.projectRoot?.trim();
    if (!root) {
      return { ok: false, error: 'projectRoot required for project scope' };
    }
    dir = getProjectSkillsDir(root);
  }
  const skillDir = join(dir, name);
  const path = skillFilePath(dir, name);
  if (!existsSync(path) && !existsSync(skillDir)) {
    return { ok: false, error: `Skill "${name}" not found in ${dir}` };
  }
  try {
    rmSync(skillDir, { recursive: true, force: true });
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  return { ok: true, path };
}
