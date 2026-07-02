/**
 * workspaceSummary — v0.7.2 build the workspace-context string the council
 * receives so its members know which project they are operating on.
 *
 * Before this, `/council` got `workspaceContext=''` and `ragContext=''`: the
 * members had no idea of the cwd, tech stack, or file layout, so they
 * projected their hardcoded AnathemaBrain identity onto whatever the user
 * asked. This module gives the council the same project awareness the
 * single-prompt path has (cwd + tool list), plus the parsed tech stack and
 * a shallow file listing.
 *
 * Pure (no React, no Ink); safe to call from the event loop. Best-effort:
 * missing package.json or unreadable dirs degrade gracefully to a shorter
 * summary rather than throwing.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { projectName, resolveWorkspaceRoot } from './paths.js';
import type { PlanFrontmatter } from './types.js';

export interface WorkspaceSummaryOptions {
  /** Max top-level entries to list. Default 30. */
  maxEntries?: number;
}

/**
 * Build a markdown workspace summary for the council system prompt.
 *
 * @param projectRoot defaults to process.cwd()
 */
export function buildWorkspaceSummary(
  projectRoot: string = process.cwd(),
  options: WorkspaceSummaryOptions = {},
): string {
  const { maxEntries = 30 } = options;
  const name = safeProjectName(projectRoot);
  const parts: string[] = [
    `# Project: ${name}`,
    `Working directory: ${projectRoot}`,
  ];

  // Tech stack from package.json (if present).
  const stack = readTechStack(projectRoot);
  if (stack) {
    parts.push('', '## Tech stack (from package.json)', stack);
  }

  // Shallow directory listing (depth 2).
  const tree = listShallow(projectRoot, maxEntries);
  if (tree.length > 0) {
    parts.push('', '## Top-level files & directories', tree.join('\n'));
  }

  // Build scripts (if present) — tells the council how to run/test/build.
  const scripts = readBuildScripts(projectRoot);
  if (scripts) {
    parts.push('', '## npm scripts', scripts);
  }

  return parts.join('\n');
}

/** Max tasks listed individually in the plan summary (rest is counted). */
const PLAN_SUMMARY_MAX_TASKS = 15;

/**
 * Build a compact markdown summary of the council plan in `.zelari/plan.json`
 * (v0.7.3 — the plan's machine-readable source of truth).
 *
 * Consumed by BOTH dispatch paths:
 *   - single-prompt system prompt, so the agent knows the plan exists and
 *     where the per-task detail files live without the user pasting paths;
 *   - `/council` workspaceContext, so a follow-up council run continues the
 *     existing plan instead of re-planning from scratch.
 *
 * Returns `null` when there is no plan (or it is empty) so callers can skip
 * the section entirely — a fresh project pays zero prompt-token cost.
 */
export function buildPlanSummary(projectRoot: string = process.cwd()): string | null {
  const planPath = join(resolveWorkspaceRoot(projectRoot), 'plan.json');
  if (!existsSync(planPath)) return null;
  let plan: { phases?: PlanFrontmatter[]; tasks?: PlanFrontmatter[]; milestones?: PlanFrontmatter[] };
  try {
    plan = JSON.parse(readFileSync(planPath, 'utf8'));
  } catch {
    return null;
  }
  const phases = Array.isArray(plan.phases) ? plan.phases : [];
  const tasks = Array.isArray(plan.tasks) ? plan.tasks : [];
  const milestones = Array.isArray(plan.milestones) ? plan.milestones : [];
  if (phases.length === 0 && tasks.length === 0 && milestones.length === 0) return null;

  const parts: string[] = ['# Project Plan (created by /council — lives in .zelari/)'];

  // Open (pending/in_progress/blocked) tasks first; done tasks are counted only.
  const open = tasks.filter((t) => t.status !== 'done');
  const done = tasks.length - open.length;

  for (const phase of [...phases].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))) {
    const phaseTasks = open.filter((t) => t.phaseId === phase.id);
    parts.push('', `## ${phase.order ?? '?'}. ${phase.name ?? phase.id}`);
    if (phase.description) parts.push(phase.description);
    for (const t of phaseTasks.slice(0, PLAN_SUMMARY_MAX_TASKS)) {
      parts.push(`- [${t.status ?? 'pending'}/${t.priority ?? 'medium'}] ${t.name ?? t.id} → .zelari/plan-tasks/${t.id}.md`);
    }
    if (phaseTasks.length > PLAN_SUMMARY_MAX_TASKS) {
      parts.push(`- … (+${phaseTasks.length - PLAN_SUMMARY_MAX_TASKS} more open tasks)`);
    }
    if (phaseTasks.length === 0) parts.push('_(no open tasks)_');
  }

  // Tasks without a matching phase (defensive — plan edited by hand).
  const orphans = open.filter((t) => !phases.some((p) => p.id === t.phaseId));
  if (orphans.length > 0) {
    parts.push('', '## (unassigned)');
    for (const t of orphans.slice(0, PLAN_SUMMARY_MAX_TASKS)) {
      parts.push(`- [${t.status ?? 'pending'}/${t.priority ?? 'medium'}] ${t.name ?? t.id} → .zelari/plan-tasks/${t.id}.md`);
    }
  }

  if (milestones.length > 0) {
    parts.push('', '## Milestones');
    for (const m of milestones) {
      parts.push(`- ${m.name ?? m.id}${m.targetVersion ? ` (target: ${m.targetVersion})` : ''}`);
    }
  }

  parts.push(
    '',
    `${tasks.length} task(s) total — ${open.length} open, ${done} done.`,
    'When asked to implement the plan (or a task), read the task file(s) above with read_file first, then work ONE task at a time.',
  );
  return parts.join('\n');
}

function safeProjectName(root: string): string {
  try {
    return projectName(root);
  } catch {
    return 'unknown';
  }
}

interface MinimalPkg {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
}

function readPackageJson(projectRoot: string): MinimalPkg | null {
  const p = join(projectRoot, 'package.json');
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as MinimalPkg;
  } catch {
    return null;
  }
}

/** Markdown bullet list of runtime + dev deps. */
function readTechStack(projectRoot: string): string | null {
  const pkg = readPackageJson(projectRoot);
  if (!pkg) return null;
  const fmt = (entries: Record<string, string> | undefined): string =>
    entries && Object.keys(entries).length > 0
      ? Object.entries(entries)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => `- ${k} \`${v}\``)
          .join('\n')
      : '_none_';
  return `**Runtime:**\n${fmt(pkg.dependencies)}\n\n**Dev:**\n${fmt(pkg.devDependencies)}`;
}

/** Markdown bullet list of npm scripts (name: command). */
function readBuildScripts(projectRoot: string): string | null {
  const pkg = readPackageJson(projectRoot);
  if (!pkg?.scripts) return null;
  const entries = Object.entries(pkg.scripts);
  if (entries.length === 0) return null;
  return entries
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `- \`${k}\`: ${v}`)
    .join('\n');
}

/** Shallow listing of top-level entries + one level of subdirectories. */
function listShallow(projectRoot: string, maxEntries: number): string[] {
  const out: string[] = [];
  try {
    const top = readdirSync(projectRoot, { withFileTypes: true })
      .filter((e) => !e.name.startsWith('.') && e.name !== 'node_modules' && e.name !== 'dist')
      .sort((a, b) => a.name.localeCompare(b.name));
    let count = 0;
    for (const entry of top) {
      if (count >= maxEntries) {
        out.push(`… (+${top.length - count} more)`);
        break;
      }
      const rel = relative(projectRoot, join(projectRoot, entry.name));
      if (entry.isDirectory()) {
        // Peek one level inside.
        let inner = '';
        try {
          const sub = readdirSync(join(projectRoot, entry.name), { withFileTypes: true })
            .filter((e) => !e.name.startsWith('.'))
            .slice(0, 4)
            .map((e) => e.name);
          if (sub.length > 0) inner = ` (${sub.join(', ')}${sub.length === 4 ? ', …' : ''})`;
        } catch {
          // unreadable subdir — skip the peek
        }
        out.push(`- ${rel}/${inner}`);
      } else {
        out.push(`- ${rel}`);
      }
      count++;
    }
  } catch {
    // unreadable root — return empty
  }
  return out;
}

/** Exported for tests: check whether statSync would succeed (exists helper). */
export function _isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
