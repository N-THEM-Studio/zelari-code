/**
 * workspace/agentsMd.ts — AGENTS.MD auto-maintenance.
 *
 * Reads `.zelari/` artifacts and updates the project-root `AGENTS.MD`
 * file in place using marker-delimited sections. Sections outside
 * markers (e.g. "Overview") are NEVER touched. Sections inside
 * markers are auto-curated from workspace artifacts.
 *
 * Idempotency: if the generated section content matches what's already
 * in the file, no write happens → no spurious git diff.
 *
 * Fail-safe: if AGENTS.MD has been manually edited and the markers are
 * missing, the entire file is treated as manual and no auto-update
 * is performed. The user can re-enable by re-adding the markers.
 *
 * @see docs/plans/2026-07-01-council-workspace-cli-stubs.md
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { Storage } from './storage.js';
import { projectName as deriveProjectName } from './paths.js';
import type { WorkspaceContext } from './types.js';

/** Sections of AGENTS.MD that are auto-curated. */
export type AutoSectionId =
  | 'tech-stack'
  | 'decisions'
  | 'conventions'
  | 'build'
  | 'open-questions';

/** All auto-managed section ids in canonical order. */
export const AUTO_SECTIONS: AutoSectionId[] = [
  'tech-stack',
  'decisions',
  'conventions',
  'build',
  'open-questions',
];

/** A section as parsed from AGENTS.MD. */
export interface Section {
  id: AutoSectionId;
  startMarker: string;
  endMarker: string;
  content: string;
}

/** Result of an AGENTS.MD update. */
export interface UpdateResult {
  changed: boolean;
  sections: AutoSectionId[];
  reason?: string;
}

// ── Markers ───────────────────────────────────────────────────────────

const MARKER_OPEN = (id: string) => `<!-- zelari:auto:start section="${id}" -->`;
const MARKER_CLOSE = (id: string) => `<!-- zelari:auto:end section="${id}" -->`;

// ── Section content generators ────────────────────────────────────────

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
}

/** Read package.json from the project root. */
async function readPackageJson(projectRoot: string): Promise<PackageJson | null> {
  const path = join(projectRoot, 'package.json');
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

/** Generate the tech-stack section from package.json. */
async function genTechStack(ctx: WorkspaceContext): Promise<string> {
  const pkg = await readPackageJson(ctx.projectRoot);
  if (!pkg) return '_No package.json found._';
  const runtime = Object.entries(pkg.dependencies ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `- ${k} \`${v}\``)
    .join('\n');
  const dev = Object.entries(pkg.devDependencies ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `- ${k} \`${v}\``)
    .join('\n');
  return [
    '<!-- Auto-derived from package.json -->',
    '',
    '**Runtime:**',
    runtime || '_none_',
    '',
    '**Dev:**',
    dev || '_none_',
    '',
  ].join('\n');
}

/** Generate the decisions section from `.zelari/decisions/`. */
async function genDecisions(ctx: WorkspaceContext): Promise<string> {
  const decisionsDir = join(ctx.rootDir, 'decisions');
  if (!existsSync(decisionsDir)) return '_No ADRs yet._';
  const files = ctx.storage.listMarkdown(decisionsDir).sort();
  const accepted: string[] = [];
  const proposed: string[] = [];
  for (const file of files) {
    const doc = ctx.storage.readIfExists<{ id: string; status?: string; date?: string }>(file);
    if (!doc?.meta) continue;
    const line = `- **${doc.meta.id}** _(${doc.meta.status ?? 'proposed'})_`;
    if (doc.meta.status === 'accepted') accepted.push(line);
    else proposed.push(line);
  }
  if (accepted.length === 0 && proposed.length === 0) return '_No ADRs yet._';
  return [
    'See `.zelari/decisions/` for full ADRs (context/decision/consequences).',
    '',
    '**Accepted:**',
    ...(accepted.length ? accepted : ['_none yet_']),
    '',
    '**Proposed:**',
    ...(proposed.length ? proposed : ['_none_']),
    '',
  ].join('\n');
}

/**
 * Generate the conventions section.
 * v1: extract from existing CLAUDE.MD / README.md if present; otherwise generic.
 * Future: infer from code patterns via Caronte + Nettuno observations.
 */
async function genConventions(ctx: WorkspaceContext): Promise<string> {
  const lines: string[] = [];
  // Try to detect from CLAUDE.md
  const claudeMd = join(ctx.projectRoot, 'CLAUDE.MD');
  if (existsSync(claudeMd)) {
    const content = readFileSync(claudeMd, 'utf8');
    const match = content.match(/## Architecture rules[\s\S]+?(?=\n## |\n*$)/);
    if (match) {
      lines.push('<!-- Extracted from CLAUDE.MD "Architecture rules" -->');
      lines.push('');
      lines.push(match[0].trim());
      lines.push('');
    }
  }
  // Generic Zelari Code conventions
  lines.push('<!-- Zelari Code defaults -->');
  lines.push('');
  lines.push('- One tool definition per file in `src/main/core/tools/builtin/`');
  lines.push('- Async-first; never block the event loop');
  lines.push('- Zod schemas for all LLM tool args');
  lines.push('- Single-task atomic commits; no batching');
  lines.push('- Zero new heavy deps (lodash, immer, etc.) — use std lib');
  lines.push('- Files ≤ 300 LOC preferred for new modules');
  lines.push('');
  return lines.join('\n');
}

/** Generate the build section from package.json scripts. */
async function genBuild(ctx: WorkspaceContext): Promise<string> {
  const pkg = await readPackageJson(ctx.projectRoot);
  if (!pkg?.scripts) return '_No scripts defined._';
  const scriptLines = Object.entries(pkg.scripts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `\`npm run ${k}\` — ${v.length > 80 ? v.slice(0, 77) + '…' : v}`)
    .join('\n');
  return [
    '<!-- Auto-derived from package.json scripts -->',
    '',
    scriptLines,
    '',
  ].join('\n');
}

/** Generate the open-questions section from `.zelari/risks.md` info-level items. */
async function genOpenQuestions(ctx: WorkspaceContext): Promise<string> {
  const path = join(ctx.rootDir, 'risks.md');
  if (!existsSync(path)) return '_No open questions._';
  const content = readFileSync(path, 'utf8');
  // Extract items that look like info-level questions
  const lines = content.split('\n');
  const questions: string[] = [];
  let currentTitle = '';
  let inInfo = false;
  for (const line of lines) {
    if (line.startsWith('## ')) {
      currentTitle = line.slice(3).trim();
      inInfo = currentTitle.toLowerCase().includes('info');
    } else if (inInfo && line.startsWith('- ')) {
      questions.push(line);
    }
  }
  if (questions.length === 0) return '_No open questions._';
  return [
    '<!-- Auto-derived from `.zelari/risks.md` info-level items -->',
    '',
    ...questions,
    '',
  ].join('\n');
}

/** Map section id to its generator. */
const GENERATORS: Record<AutoSectionId, (ctx: WorkspaceContext) => Promise<string>> = {
  'tech-stack': genTechStack,
  'decisions': genDecisions,
  'conventions': genConventions,
  'build': genBuild,
  'open-questions': genOpenQuestions,
};

// ── File parser / writer ─────────────────────────────────────────────

/** Parse AGENTS.MD into manual content + per-section content. */
export function parseAgentsMd(content: string): {
  manualBlocks: { before: string; after: string };
  sections: Map<AutoSectionId, Section>;
} {
  const sections = new Map<AutoSectionId, Section>();
  let cursor = 0;

  for (const id of AUTO_SECTIONS) {
    const startMarker = MARKER_OPEN(id);
    const endMarker = MARKER_CLOSE(id);
    const startIdx = content.indexOf(startMarker, cursor);
    if (startIdx < 0) continue;
    const endIdx = content.indexOf(endMarker, startIdx);
    if (endIdx < 0) continue;
    const innerStart = startIdx + startMarker.length;
    const innerContent = content.slice(innerStart, endIdx).replace(/^\n/, '').replace(/\n$/, '');
    sections.set(id, {
      id,
      startMarker,
      endMarker,
      content: innerContent,
    });
    cursor = endIdx + endMarker.length;
  }

  // Manual content = the file minus all auto-managed sections.
  // We rebuild it by walking through and replacing each section block.
  let manual = content;
  for (const section of sections.values()) {
    const block = `${section.startMarker}\n${section.content}\n${section.endMarker}`;
    manual = manual.replace(block, '');
  }
  return {
    manualBlocks: { before: '', after: manual },
    sections,
  };
}

/** Serialize AGENTS.MD from manual content + auto sections. */
export function serializeAgentsMd(
  manualContent: string,
  sections: Map<AutoSectionId, string>,
): string {
  // Insert each section into the manual content at its original position
  // if possible; otherwise append at the end.
  const out: string[] = [];
  const lines = manualContent.split('\n');
  let cursor = 0;

  // Find a good insertion point: after the first heading + first paragraph.
  // For v1: just append sections at the end of the file.
  out.push(...lines);

  for (const id of AUTO_SECTIONS) {
    const content = sections.get(id);
    if (!content) continue;
    out.push('');
    out.push(`## ${titleCase(id)}`);
    out.push('');
    out.push(MARKER_OPEN(id));
    out.push(content);
    out.push(MARKER_CLOSE(id));
  }

  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

function titleCase(id: string): string {
  return id.split('-').map((w) => w[0]!.toUpperCase() + w.slice(1)).join(' ');
}

// ── Public API ────────────────────────────────────────────────────────

/**
 * Update AGENTS.MD based on current workspace state.
 * Returns whether the file was actually changed (idempotent).
 */
export async function updateAgentsMd(ctx: WorkspaceContext, projectRoot: string): Promise<UpdateResult> {
  const agentsPath = join(projectRoot, 'AGENTS.MD');

  // Fail-safe: if AGENTS.MD exists but no markers at all → manual file, skip.
  if (existsSync(agentsPath)) {
    const content = readFileSync(agentsPath, 'utf8');
    const hasAnyMarker = AUTO_SECTIONS.some((id) => content.includes(MARKER_OPEN(id)));
    if (!hasAnyMarker) {
      return {
        changed: false,
        sections: [],
        reason: 'AGENTS.MD exists without zelari markers — treating as manual file, skipping auto-update.',
      };
    }
  }

  // Generate content for all sections.
  const newSections = new Map<AutoSectionId, string>();
  for (const id of AUTO_SECTIONS) {
    newSections.set(id, await GENERATORS[id](ctx));
  }

  // Parse existing manual content (if file exists).
  let manualContent = '';
  if (existsSync(agentsPath)) {
    const { manualBlocks } = parseAgentsMd(readFileSync(agentsPath, 'utf8'));
    manualContent = manualBlocks.after;
  } else {
    // First-time creation: build a minimal skeleton.
    const projectName = deriveProjectName(projectRoot);
    manualContent = [
      `# AGENTS.MD — ${projectName}`,
      '',
      '> Auto-curated by Zelari Code council. Run `/council` to refresh.',
      '> See `.zelari/` for raw decision log.',
      '',
      '## Overview',
      '',
      '_Free-form project description. This section is manual and preserved across updates._',
      '',
    ].join('\n');
  }

  // Check idempotency: compare each section's hash.
  const oldContent = existsSync(agentsPath) ? readFileSync(agentsPath, 'utf8') : '';
  const { sections: oldSections } = parseAgentsMd(oldContent);
  const changedSections: AutoSectionId[] = [];
  for (const id of AUTO_SECTIONS) {
    const oldHash = oldSections.get(id)?.content ? hash(oldSections.get(id)!.content) : null;
    const newHash = hash(newSections.get(id)!);
    if (oldHash !== newHash) changedSections.push(id);
  }

  if (changedSections.length === 0) {
    return { changed: false, sections: [] };
  }

  // Serialize and write.
  const newContent = serializeAgentsMd(manualContent, newSections);
  writeFileSync(agentsPath, newContent, 'utf8');
  return { changed: true, sections: changedSections };
}

/** Hash a string to detect changes. */
function hash(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 16);
}