/**
 * workspace/planDriftCheck.ts — deterministic drift check between
 * `.zelari/plan.json` and the canonical plan doc
 * (`.zelari/docs/plan-canonical*.md`).
 *
 * Why (v0.10 post-mortem): repeated council runs re-emitted the same
 * concepts under new phase-id slugs (p0-parit-*, p0-safety-gate-*,
 * p0-hook-lifecycle-*, …), multiplying phases/tasks/milestones in
 * plan.json without ever consolidating. This check runs after every
 * council run (postCouncilHook Step 2b) and reports drift instead of
 * silently accumulating it.
 *
 * Checks:
 *  - DUPLICATE_MILESTONE (error): >1 milestone targeting the same version.
 *  - PHASE_IN_CANONICAL_BLOCKLIST (error) / TASK_IN_CANONICAL_BLOCKLIST
 *    (error): id matches a prefix the canonical doc marked as duplicate
 *    or descope (`` `p0-parit-*` `` style).
 *  - CANONICAL_PHASE_MISSING (error): canonical phase absent from plan.json.
 *  - DUPLICATE_TASK_TITLE (warning): same normalized title on >1 task.
 *  - TASK_IN_UNKNOWN_PHASE (warning): task.phaseId not in phases.
 *
 * Contract: fail-open — corrupt/missing inputs return `{ ran: false }`
 * and never throw. A JSON report lands in `.zelari/drift-report.json`.
 * Disable with ZELARI_DRIFT_CHECK=0.
 *
 * @since v1.15.0
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Single drift signal surfaced to the CLI / report. */
export interface DriftFinding {
  code:
    | 'DUPLICATE_MILESTONE'
    | 'PHASE_IN_CANONICAL_BLOCKLIST'
    | 'TASK_IN_CANONICAL_BLOCKLIST'
    | 'CANONICAL_PHASE_MISSING'
    | 'DUPLICATE_TASK_TITLE'
    | 'TASK_IN_UNKNOWN_PHASE';
  severity: 'error' | 'warning';
  message: string;
}

/** Result of the plan drift-check step. */
export interface PlanDriftResult {
  ran: boolean;
  ok?: boolean;
  findings?: DriftFinding[];
  /** Canonical doc basename used for the cross-check, if any. */
  canonicalDoc?: string;
  reportPath?: string;
  reason?: string;
}

/** Newest `plan-canonical*.md` under `<rootDir>/docs`, if present. */
function findCanonicalDoc(rootDir: string): string | null {
  const docsDir = join(rootDir, 'docs');
  if (!existsSync(docsDir)) return null;
  const candidates = readdirSync(docsDir)
    .filter((f) => /^plan-canonical.*\.md$/i.test(f))
    .map((f) => ({ f, mtime: statSync(join(docsDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return candidates.length > 0 ? candidates[0].f : null;
}

/** Phase ids come from `` ### … `p0-…` `` headings; blocklist prefixes from `` `p0-…-*` `` tokens. */
function parseCanonicalDoc(
  text: string,
): { activePhases: Set<string>; blockedPrefixes: Set<string> } {
  const activePhases = new Set<string>();
  const blockedPrefixes = new Set<string>();
  const headingPhase = /^#{2,6}[^\n]*?`([a-z0-9][a-z0-9-]*)`/gm;
  for (const m of text.matchAll(headingPhase)) activePhases.add(m[1]);
  const blocked = /`([a-z0-9][a-z0-9-]*)-\*`/g;
  for (const m of text.matchAll(blocked)) blockedPrefixes.add(`${m[1]}-`);
  return { activePhases, blockedPrefixes };
}

/** Lowercase, accent-stripped, punctuation-collapsed comparison key. */
function normalizeTitle(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Milestone grouping key: version token ("v0.10.0" ≡ "0.10.0"). */
function versionKey(value: unknown): string {
  if (typeof value !== 'string') return '';
  const m = value.toLowerCase().match(/v?\d+(?:\.\d+)*/);
  return m ? m[0].replace(/^v/, '') : value.trim().toLowerCase();
}

function firstString(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v : null;
}

/** Read a file, returning null instead of throwing (fail-open). */
function readFileSyncSafe(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

interface PlanShape {
  phases?: Array<{ id?: unknown }>;
  tasks?: Array<Record<string, unknown>>;
  milestones?: Array<{ id?: unknown; name?: unknown; targetVersion?: unknown }>;
}

/**
 * Run the drift check against `<rootDir>/plan.json`. Never throws:
 * errors are captured into `reason` (fail-open, audit-style).
 */
export async function runPlanDriftCheck(rootDir: string): Promise<PlanDriftResult> {
  if (process.env['ZELARI_DRIFT_CHECK'] === '0') {
    return { ran: false, reason: 'ZELARI_DRIFT_CHECK=0 (disabled)' };
  }
  const planPath = join(rootDir, 'plan.json');
  if (!existsSync(planPath)) {
    return { ran: false, reason: '.zelari/plan.json missing (not design-phase)' };
  }
  let plan: PlanShape;
  try {
    plan = JSON.parse(readFileSync(planPath, 'utf8')) as PlanShape;
  } catch {
    return { ran: false, reason: '.zelari/plan.json corrupt' };
  }

  const findings: DriftFinding[] = [];
  const phases = Array.isArray(plan.phases) ? plan.phases : [];
  const tasks = Array.isArray(plan.tasks) ? plan.tasks : [];
  const milestones = Array.isArray(plan.milestones) ? plan.milestones : [];
  const phaseIds = new Set(phases.map((p) => (typeof p.id === 'string' ? p.id : '')).filter(Boolean));

  // ── Canonical cross-check ────────────────────────────────────────────
  const canonicalName = findCanonicalDoc(rootDir);
  const canonicalText = canonicalName
    ? readFileSyncSafe(join(rootDir, 'docs', canonicalName))
    : null;
  if (canonicalText !== null) {
    const { activePhases, blockedPrefixes } = parseCanonicalDoc(canonicalText);
    for (const id of activePhases) {
      if (!phaseIds.has(id)) {
        findings.push({
          code: 'CANONICAL_PHASE_MISSING',
          severity: 'error',
          message: `canonical phase \`${id}\` (${canonicalName}) is missing from plan.json`,
        });
      }
    }
    for (const id of phaseIds) {
      const hit = [...blockedPrefixes].find((p) => id.startsWith(p));
      if (hit) {
        findings.push({
          code: 'PHASE_IN_CANONICAL_BLOCKLIST',
          severity: 'error',
          message: `phase \`${id}\` matches canonical duplicate/descope prefix \`${hit}*\``,
        });
      }
    }
    for (const t of tasks) {
      const id = typeof t.id === 'string' ? t.id : '';
      const hit = id ? [...blockedPrefixes].find((p) => id.startsWith(p)) : undefined;
      if (hit) {
        findings.push({
          code: 'TASK_IN_CANONICAL_BLOCKLIST',
          severity: 'error',
          message: `task \`${id}\` matches canonical duplicate/descope prefix \`${hit}*\``,
        });
      }
    }
  }

  // ── Structural checks (canonical-independent) ────────────────────────
  const byVersion = new Map<string, string[]>();
  for (const m of milestones) {
    const key = versionKey(m.targetVersion);
    if (!key) continue;
    const id = typeof m.id === 'string' ? m.id : '(no id)';
    byVersion.set(key, [...(byVersion.get(key) ?? []), id]);
  }
  for (const [version, ids] of byVersion) {
    if (ids.length > 1) {
      findings.push({
        code: 'DUPLICATE_MILESTONE',
        severity: 'error',
        message: `${ids.length} milestones target ${version}: ${ids.join(', ')} — keep exactly one canonical`,
      });
    }
  }

  const byTitle = new Map<string, string[]>();
  for (const t of tasks) {
    const title = normalizeTitle(
      firstString(t.title) ?? firstString(t.name) ?? firstString(t.description),
    );
    const id = typeof t.id === 'string' ? t.id : '(no id)';
    if (title) byTitle.set(title, [...(byTitle.get(title) ?? []), id]);
    const phaseId = firstString(t.phaseId);
    if (phaseId && !phaseIds.has(phaseId)) {
      findings.push({
        code: 'TASK_IN_UNKNOWN_PHASE',
        severity: 'warning',
        message: `task \`${id}\` references unknown phaseId \`${phaseId}\``,
      });
    }
  }
  for (const [title, ids] of byTitle) {
    if (ids.length > 1) {
      findings.push({
        code: 'DUPLICATE_TASK_TITLE',
        severity: 'warning',
        message: `duplicate task title "${title.slice(0, 60)}": ${ids.join(', ')}`,
      });
    }
  }

  const ok = findings.every((f) => f.severity !== 'error');
  const canonicalParsed = canonicalName !== null && canonicalText !== null;
  let reportPath: string | undefined;
  try {
    reportPath = join(rootDir, 'drift-report.json');
    writeFileSync(
      reportPath,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          ok,
          canonicalDoc: canonicalName ?? null,
          counts: { phases: phases.length, tasks: tasks.length, milestones: milestones.length },
          findings,
        },
        null,
        2,
      ) + '\n',
      'utf8',
    );
  } catch {
    reportPath = undefined;
  }

  return {
    ran: true,
    ok,
    findings,
    ...(canonicalParsed
      ? { canonicalDoc: canonicalName }
      : {
          reason: canonicalName
            ? `canonical doc ${canonicalName} unreadable (structural checks only)`
            : 'no canonical doc (structural checks only)',
        }),
    ...(reportPath ? { reportPath } : {}),
  };
}
