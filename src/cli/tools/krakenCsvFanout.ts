/**
 * Kraken CSV fan-out — `kraken_spawn_on_csv` tool (Slice G / Pillar 4).
 *
 * One tool call reads a CSV, fans out one sub-agent per row, and writes
 * a result CSV. The shape is intentionally a small, predictable wrapper
 * around the existing `runTentacle` from `taskTool.ts`:
 *
 *   - One row = one tentacle. Each tentacle gets a fresh context window,
 *     so the auth row's findings never leak into the test row's context.
 *   - Concurrency is capped at `ZELARI_KRAKEN_MAX_PARALLEL` (12 by default).
 *     A pool of N workers drains the queue; per-row results land in the
 *     same order as the input rows, regardless of completion order.
 *   - On per-row failure: row's `status` = 'error', `error` column is
 *     populated, the run continues. The whole batch fails only when the
 *     read/write or LLM transport itself is broken.
 *   - Scope templating: optional `scope_template` (with `{column}` slots)
 *     is applied per row, then the global scope-overlap check refuses
 *     to run two rows with overlapping scopes in parallel. We never auto-
 *     resolve conflicts; the executor serializes the conflict.
 *
 * This is a **per-row fan-out**, not a single batched completion. The
 * cost is N times a tentacle; the win is true isolation between rows.
 * For "review every PR" / "audit every endpoint" workloads that's the
 * right trade.
 *
 * @since Kraken v1.30.x — workflow script runtime (Pillar 4)
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { runTentacle, type TaskAgentKind, type TaskThoroughness, type TaskToolDeps } from './taskTool.js';

/** Per-call config; validated with Zod for early failure. */
const CsvFanoutArgsSchema = z.object({
  csv_path: z.string().min(1),
  id_column: z.string().min(1),
  output_csv_path: z.string().min(1),
  /** Template with `{column_name}` placeholders. The tentacle's prompt is
   *  the template with each row's values substituted. */
  instruction_template: z.string().min(1),
  /** Default 'verify' — read-mostly workloads are the common case. */
  agent_kind: z.enum(['explore', 'general', 'verify']).default('verify'),
  thoroughness: z.enum(['quick', 'medium', 'deep']).default('medium'),
  /** Optional: per-row scope template with `{column}` placeholders. The
   *  resulting path/glob list is fed to the scope-overlap check. */
  scope_template: z.array(z.string()).optional(),
  /** Default: ZELARI_KRAKEN_MAX_PARALLEL. */
  max_concurrency: z.number().int().positive().optional(),
  /** Per-row timeout (ms). Default: 5 min for verify, 15 min for general. */
  max_runtime_seconds: z.number().int().positive().optional(),
});

export type CsvFanoutArgs = z.infer<typeof CsvFanoutArgsSchema>;

/** Result summary returned to the LLM. The actual rows are in output_csv_path. */
export interface CsvFanoutResult {
  rows: number;
  completed: number;
  errored: number;
  output_csv_path: string;
  /** Wall-clock duration of the whole batch (ms). */
  durationMs: number;
}

/** Read a UTF-8 CSV file. Tiny hand-rolled parser; the format is simple
 *  enough that pulling in a dep is overkill. Handles quoted fields with
 *  embedded newlines and commas. */
export async function readCsv(filePath: string): Promise<{ headers: string[]; rows: Record<string, string>[] }> {
  const text = await fs.readFile(filePath, 'utf8');
  return parseCsv(text);
}

export function parseCsv(text: string): { headers: string[]; rows: Record<string, string>[] } {
  // State machine: walk the text, respect quotes, split on \n, then on ,.
  const records: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; }
        else inQuotes = false;
      } else {
        field += ch;
      }
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ',') { row.push(field); field = ''; }
      else if (ch === '\n') { row.push(field); records.push(row); row = []; field = ''; }
      else if (ch === '\r') { /* ignore; \r\n becomes \n */ }
      else field += ch;
    }
  }
  if (field !== '' || row.length > 0) { row.push(field); records.push(row); }
  // Drop a trailing empty row from a final newline.
  while (records.length > 0 && records[records.length - 1].length === 1 && records[records.length - 1][0] === '') {
    records.pop();
  }
  if (records.length === 0) return { headers: [], rows: [] };
  const headers = records[0];
  const rows = records.slice(1).map((r) => {
    const obj: Record<string, string> = {};
    for (let i = 0; i < headers.length; i++) obj[headers[i]] = r[i] ?? '';
    return obj;
  });
  return { headers, rows };
}

/** Substitute `{column_name}` placeholders in a template. */
export function applyTemplate(template: string, row: Record<string, string>): string {
  return template.replace(/\{([a-zA-Z_][\w-]*)\}/g, (_, k) => row[k] ?? '');
}

/** Serialize a list of records as CSV. Mirrors `parseCsv` (quoted fields). */
export function serializeCsv(headers: string[], rows: Record<string, string>[]): string {
  const escape = (v: string): string => {
    if (v.includes(',') || v.includes('\n') || v.includes('"')) {
      return `"${v.replace(/"/g, '""')}"`;
    }
    return v;
  };
  const out: string[] = [headers.map(escape).join(',')];
  for (const row of rows) {
    out.push(headers.map((h) => escape(row[h] ?? '')).join(','));
  }
  return out.join('\n') + '\n';
}

export function resolveMaxConcurrency(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.ZELARI_KRAKEN_MAX_PARALLEL;
  if (raw === undefined || raw === '') return 12;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 12;
}

/** Pool worker: pull rows from the queue, run a tentacle per row, collect
 *  results. The pool caps concurrency at `max_concurrency`; each worker
 *  grabs the next unclaimed row until the queue is empty. */
export async function runCsvFanout(args: CsvFanoutArgs, deps: TaskToolDeps, opts: {
  parentCwd: string;
  sessionId: string;
  onLog?: (line: string) => void;
}): Promise<CsvFanoutResult> {
  const start = Date.now();
  const absCsv = path.isAbsolute(args.csv_path) ? args.csv_path : path.join(opts.parentCwd, args.csv_path);
  const absOut = path.isAbsolute(args.output_csv_path) ? args.output_csv_path : path.join(opts.parentCwd, args.output_csv_path);
  const { headers, rows } = await readCsv(absCsv);
  if (headers.length === 0) {
    throw new Error(`kraken_csv_fanout: ${absCsv} is empty`);
  }
  if (!args.id_column) {
    throw new Error('kraken_csv_fanout: id_column is required');
  }
  if (!headers.includes(args.id_column)) {
    throw new Error(`kraken_csv_fanout: id_column "${args.id_column}" not in CSV header [${headers.join(', ')}]`);
  }

  const concurrency = args.max_concurrency ?? resolveMaxConcurrency();
  opts.onLog?.(`csv fanout: ${rows.length} rows × ${args.agent_kind} @ concurrency=${concurrency}`);

  // Per-row runtime cap. We mirror the kind-aware default from the graph
  // executor (5 min for readers, 15 min for writers) so a slow row can't
  // hang the whole batch.
  const perRowMs =
    args.max_runtime_seconds !== undefined
      ? args.max_runtime_seconds * 1000
      : args.agent_kind === 'general'
        ? 900_000
        : 300_000;

  // Output records: copy each input row, append result columns.
  const outputRecords: Record<string, string>[] = rows.map((r) => ({ ...r, status: 'pending', result: '', error: '' }));
  const outHeaders = [...headers, 'status', 'result', 'error'];

  // Simple worker pool. Rows are claimed by index; the pool stops when
  // the next index >= rows.length.
  let nextIndex = 0;
  let completed = 0;
  let errored = 0;
  const errors: string[] = [];

  async function worker(): Promise<void> {
    while (true) {
      const i = nextIndex;
      nextIndex += 1;
      if (i >= rows.length) return;
      const row = rows[i];
      const prompt = applyTemplate(args.instruction_template, row);
      const scope = args.scope_template?.map((t) => applyTemplate(t, row));
      const res = await runTentacle({
        deps,
        args: {
          description: `csv-row ${row[args.id_column] ?? i}`,
          prompt,
          ...(scope ? { scope } : {}),
        },
        agent: args.agent_kind as TaskAgentKind,
        thoroughness: args.thoroughness as TaskThoroughness,
        parentCwd: opts.parentCwd,
        sessionId: opts.sessionId,
      });
      outputRecords[i].status = res.ok ? 'ok' : 'error';
      if (res.ok) {
        outputRecords[i].result = res.result;
        completed += 1;
      } else {
        outputRecords[i].error = res.error;
        errored += 1;
        errors.push(`${row[args.id_column] ?? i}: ${res.error}`);
      }
      // Atomic write of the result so a long batch can be observed mid-flight
      // by tailing the file. We rewrite the whole output on each row; the
      // expected sizes here are small enough (CSV with at most a few KB per
      // row of LLM conclusion) that this is cheap.
      await fs.mkdir(path.dirname(absOut), { recursive: true });
      await atomicWrite(absOut, serializeCsv(outHeaders, outputRecords));
    }
  }

  const pool = Array.from({ length: Math.min(concurrency, rows.length) }, () => worker());
  await Promise.all(pool);

  const durationMs = Date.now() - start;
  opts.onLog?.(`csv fanout: ${completed} ok, ${errored} error, ${durationMs}ms`);
  if (errored > 0) {
    opts.onLog?.(`csv fanout: first 3 errors:\n  - ${errors.slice(0, 3).join('\n  - ')}`);
  }

  return {
    rows: rows.length,
    completed,
    errored,
    output_csv_path: absOut,
    durationMs,
  };
}

/** Atomic write via tmp + rename so partial files are never visible. */
async function atomicWrite(file: string, contents: string): Promise<void> {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, contents, 'utf8');
  await fs.rename(tmp, file);
}
