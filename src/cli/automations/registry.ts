/**
 * automations/registry.ts — the on-disk Automations Registry (ADR-0037 §1).
 *
 * Single source of truth for both CLI and Desktop. All writes are atomic
 * (tmp file + rename) so a crash never leaves a half-written index. Reads are
 * tolerant: a missing/corrupt index degrades to an empty registry, never a throw.
 *
 *   .zelari/automations/index.json             { version: 1, automations: [{id,enabled}] }
 *   .zelari/automations/<id>.json              AutomationSpec
 *   .zelari/automations/runs/<id>/<runId>.json AutomationRun
 */
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  AUTOMATION_ID_RE,
  AutomationRunSchema,
  AutomationSpecSchema,
  RESERVED_AUTOMATION_ID,
  type AutomationListItem,
  type AutomationRun,
  type AutomationSpec,
  type RegistryIndex,
} from './types.js';

/** `.zelari/automations` under the given project root. */
export function automationsDir(root: string): string {
  return path.join(root, '.zelari', 'automations');
}

/** Path to the registry index. */
function indexPath(root: string): string {
  return path.join(automationsDir(root), 'index.json');
}

/** Path to one spec file. */
function specPath(root: string, id: string): string {
  return path.join(automationsDir(root), `${id}.json`);
}

/** Directory holding the runs of one automation. */
function runsDir(root: string, id: string): string {
  return path.join(automationsDir(root), 'runs', id);
}

/** Path to one run record. */
function runPath(root: string, automationId: string, runId: string): string {
  return path.join(runsDir(root, automationId), `${runId}.json`);
}

/** Write JSON atomically: tmp file in the same dir, then rename over the target. */
async function atomicWriteJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
  await rename(tmp, file);
}

/** Read + normalize the index. Missing/corrupt → empty registry. */
async function readIndex(root: string): Promise<RegistryIndex> {
  try {
    const raw = await readFile(indexPath(root), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<RegistryIndex> | null;
    if (parsed && Array.isArray(parsed.automations)) {
      const automations = parsed.automations
        .filter(
          (a): a is { id: string; enabled: boolean } =>
            !!a && typeof a.id === 'string' && typeof a.enabled === 'boolean',
        )
        .map((a) => ({ id: a.id, enabled: a.enabled }));
      return { version: 1, automations };
    }
  } catch {
    /* missing or unparsable → empty */
  }
  return { version: 1, automations: [] };
}

/**
 * List registered automations from index.json, enriched with each spec's
 * name/kind. Tolerant of a missing index (→ []). Entries whose spec file is
 * gone are skipped (the spec is authoritative).
 */
export async function listAutomations(root: string): Promise<AutomationListItem[]> {
  const idx = await readIndex(root);
  const out: AutomationListItem[] = [];
  for (const entry of idx.automations) {
    const spec = await getAutomation(root, entry.id);
    if (spec) {
      out.push({ id: spec.id, enabled: spec.enabled, name: spec.name, kind: spec.kind });
    }
  }
  return out;
}

/**
 * Load one spec. Returns null ONLY when the file is absent/unreadable or its
 * JSON does not parse. A spec whose JSON parses but fails schema validation is
 * returned best-effort (cast) so a hand-edited file is never silently lost.
 */
export async function getAutomation(root: string, id: string): Promise<AutomationSpec | null> {
  let json: unknown;
  try {
    json = JSON.parse(await readFile(specPath(root, id), 'utf-8'));
  } catch {
    return null;
  }
  const parsed = AutomationSpecSchema.safeParse(json);
  return parsed.success ? parsed.data : (json as AutomationSpec);
}

/**
 * Create or update one automation. Validates the id, writes `<id>.json`, and
 * upserts the index entry (create index if missing; update the entry if present).
 */
export async function upsertAutomation(root: string, spec: AutomationSpec): Promise<void> {
  if (!AUTOMATION_ID_RE.test(spec.id)) {
    throw new Error(`invalid automation id: ${spec.id}`);
  }
  await atomicWriteJson(specPath(root, spec.id), spec);
  const idx = await readIndex(root);
  const existing = idx.automations.find((a) => a.id === spec.id);
  if (existing) {
    existing.enabled = spec.enabled;
  } else {
    idx.automations.push({ id: spec.id, enabled: spec.enabled });
  }
  await atomicWriteJson(indexPath(root), idx);
}

/**
 * Remove one automation's spec + index entry. The reserved `gardener` id is
 * refused. Runs (`runs/<id>/`) are intentionally KEPT as evidence history.
 */
export async function deleteAutomation(root: string, id: string): Promise<void> {
  if (id === RESERVED_AUTOMATION_ID) {
    throw new Error('reserved automation id cannot be deleted');
  }
  await rm(specPath(root, id), { force: true });
  const idx = await readIndex(root);
  idx.automations = idx.automations.filter((a) => a.id !== id);
  await atomicWriteJson(indexPath(root), idx);
}

/**
 * Flip one automation's `enabled` flag (atomic: spec + index rewritten together
 * via {@link upsertAutomation}). The reserved `gardener` id is refused — its
 * Desktop card owns its own prefs toggle. Throws on an unknown id.
 */
export async function setAutomationEnabled(
  root: string,
  id: string,
  enabled: boolean,
): Promise<AutomationSpec> {
  if (id === RESERVED_AUTOMATION_ID) {
    throw new Error('reserved automation id cannot be toggled');
  }
  const spec = await getAutomation(root, id);
  if (!spec) {
    throw new Error(`unknown automation id: ${id}`);
  }
  const next: AutomationSpec = { ...spec, enabled };
  await upsertAutomation(root, next);
  return next;
}

/**
 * New run id: `<yyyymmddHHMMSS>-<8 hex>` (UTC). The timestamp prefix makes a
 * lexical sort of run ids a chronological sort.
 */
export function newRunId(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, '0');
  const stamp =
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
  return `${stamp}-${randomUUID().slice(0, 8)}`;
}

/** Persist one run record (mkdir -p the runs dir). */
export async function writeRun(root: string, run: AutomationRun): Promise<void> {
  await atomicWriteJson(runPath(root, run.automationId, run.runId), run);
}

/** Load one run record, or null when absent/corrupt. */
export async function getRun(
  root: string,
  automationId: string,
  runId: string,
): Promise<AutomationRun | null> {
  let json: unknown;
  try {
    json = JSON.parse(await readFile(runPath(root, automationId, runId), 'utf-8'));
  } catch {
    return null;
  }
  const parsed = AutomationRunSchema.safeParse(json);
  return parsed.success ? parsed.data : (json as AutomationRun);
}

/** List the newest runs first (runId desc). Missing runs dir → []. */
export async function listRuns(
  root: string,
  automationId: string,
  limit = 20,
): Promise<AutomationRun[]> {
  let names: string[];
  try {
    names = await readdir(runsDir(root, automationId));
  } catch {
    return [];
  }
  const ids = names
    .filter((n) => n.endsWith('.json'))
    .map((n) => n.slice(0, -'.json'.length))
    .sort()
    .reverse()
    .slice(0, Math.max(0, limit));
  const out: AutomationRun[] = [];
  for (const id of ids) {
    const run = await getRun(root, automationId, id);
    if (run) out.push(run);
  }
  return out;
}

/**
 * List runs across EVERY registered automation (F2 approvals inbox). Specs are
 * authoritative: an automation whose spec file is gone contributes no runs.
 */
export async function listAllRuns(root: string, limitPerAutomation = 200): Promise<AutomationRun[]> {
  const items = await listAutomations(root);
  const out: AutomationRun[] = [];
  for (const item of items) {
    out.push(...(await listRuns(root, item.id, limitPerAutomation)));
  }
  return out;
}

/** Find one run by id across all registered automations, or null. */
export async function findRun(root: string, runId: string): Promise<AutomationRun | null> {
  const items = await listAutomations(root);
  for (const item of items) {
    const run = await getRun(root, item.id, runId);
    if (run) return run;
  }
  return null;
}
