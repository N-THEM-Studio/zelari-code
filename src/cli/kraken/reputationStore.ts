/**
 * reputationStore — t29 (hardening plan §15–16): append-only JSONL store for
 * model reputation records, following the session-spine pattern (ADR-0016):
 * append-only lines, tolerant replay (malformed lines are skipped, never
 * thrown), bounded size via a keep-newest prune.
 *
 * Layout: `<workspaceRoot>/.zelari/reputation.jsonl` by default; the
 * workspace root is the cwd handed in by the caller (NOT read from process
 * state inside this module beyond the documented env override), and
 * `ZELARI_REPUTATION_PATH` overrides the whole file path (tests / power
 * users). One ReputationRecord per line, no envelope: the record is flat and
 * schema-v1 stable (see modelReputation.ts).
 *
 * All functions are async (fs/promises) and append-failures propagate to the
 * caller — the executor seam is the fail-open boundary and wraps every call
 * in try/catch so reputation can NEVER break a run.
 */
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { REPUTATION_OUTCOMES, type ReputationOutcome, type ReputationRecord } from './modelReputation.js';

type Env = Record<string, string | undefined>;

/** Env override for the store file path (whole path, not a directory). */
export const REPUTATION_STORE_ENV = 'ZELARI_REPUTATION_PATH';

/** Prune cap: keep at most this many records (newest win). */
export const DEFAULT_MAX_RECORDS = 2000;

/**
 * Store file path for a workspace: `ZELARI_REPUTATION_PATH` wins verbatim;
 * otherwise `<cwd>/.zelari/reputation.jsonl`.
 */
export function resolveReputationStorePath(cwd: string = process.cwd(), env: Env = process.env): string {
  const override = env[REPUTATION_STORE_ENV]?.trim();
  if (override) return override;
  return path.join(cwd, '.zelari', 'reputation.jsonl');
}

/**
 * Append one record as a single JSON line (mkdir -p for the parent dir).
 * Rejects (throws) on fs failure — the caller decides the fail-open policy.
 */
export async function appendRecord(storePath: string, record: ReputationRecord): Promise<void> {
  await mkdir(path.dirname(storePath), { recursive: true });
  await appendFile(storePath, `${JSON.stringify(record)}\n`, 'utf8');
}

/**
 * Tolerant parse of one line: returns the record only when it has the
 * required fields with sane types; anything else (comments, truncated JSON,
 * foreign data) is skipped by loadRecords.
 */
export function parseRecordLine(line: string): ReputationRecord | null {
  const trimmed = line.trim();
  if (trimmed === '' || !trimmed.startsWith('{')) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  const str = (v: unknown): v is string => typeof v === 'string';
  const strOrNull = (v: unknown): v is string | null => v === null || typeof v === 'string';
  const numOrNull = (v: unknown): v is number | null => v === null || num(v);
  if (!num(r.ts) || !str(r.repo) || r.repo === '' || !str(r.role)) return null;
  if (!strOrNull(r.model) || !strOrNull(r.provider) || !strOrNull(r.language)) return null;
  if (!REPUTATION_OUTCOMES.includes(r.outcome as ReputationOutcome)) return null;
  if (typeof r.firstPass !== 'boolean' || !num(r.repairCount) || r.repairCount < 0) return null;
  if (!numOrNull(r.costUsd) || !numOrNull(r.latencyMs)) return null;
  return {
    ts: r.ts,
    repo: r.repo,
    model: r.model,
    provider: r.provider,
    role: r.role,
    language: r.language,
    outcome: r.outcome as ReputationOutcome,
    firstPass: r.firstPass,
    repairCount: r.repairCount,
    costUsd: r.costUsd,
    latencyMs: r.latencyMs,
  };
}

/**
 * Load every parseable record, oldest line first. Missing file ⇒ []
 * (a fresh workspace has no reputation). NEVER throws: a corrupt or
 * half-written store degrades to "whatever lines parse".
 */
export async function loadRecords(storePath: string): Promise<ReputationRecord[]> {
  let text: string;
  try {
    text = await readFile(storePath, 'utf8');
  } catch {
    return [];
  }
  const records: ReputationRecord[] = [];
  for (const line of text.split('\n')) {
    const rec = parseRecordLine(line);
    if (rec) records.push(rec);
  }
  return records;
}

/**
 * Keep only the newest `maxRecords` records (ties on `ts` broken by later
 * file position winning — the most recently appended line). No-op when the
 * store is within cap. Rewrites atomically (tmp file + rename). Returns the
 * number of records the store holds afterwards. A missing store is a no-op.
 */
export async function pruneStore(storePath: string, maxRecords: number = DEFAULT_MAX_RECORDS): Promise<number> {
  let text: string;
  try {
    text = await readFile(storePath, 'utf8');
  } catch {
    return 0;
  }
  const lines = text.split('\n');
  const parsed = lines
    .map((line, index) => ({ line, index, rec: parseRecordLine(line) }))
    .filter((e): e is { line: string; index: number; rec: ReputationRecord } => e.rec !== null);
  if (parsed.length <= maxRecords) return parsed.length;
  const keep = [...parsed]
    .sort((a, b) => (a.rec.ts !== b.rec.ts ? a.rec.ts - b.rec.ts : a.index - b.index))
    .slice(-maxRecords);
  const tmpPath = `${storePath}.tmp`;
  await writeFile(tmpPath, keep.map((e) => e.line).join('\n') + '\n', 'utf8');
  await rename(tmpPath, storePath);
  return keep.length;
}
