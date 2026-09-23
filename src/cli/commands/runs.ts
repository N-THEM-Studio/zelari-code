/**
 * commands/runs — `zelari-code runs list|show <run-id> [--json]` (K5.1/F31).
 *
 * FIRST reader for the Run Flight Recorder output: `.zelari/runs/<run-id>/`
 * (written by packages/core/src/runtime/recorder/RunRecorder.ts — manifest.json
 * + metrics.json + trace.jsonl + agents/*.jsonl). Until now the recorder wrote
 * those directories and NOTHING in the CLI could read them back (F31: "run
 * records written but no reader") — dogfood data sat on disk unread.
 *
 * Advisory-only, same discipline as commands/inspectSession: reads run
 * records, writes nothing, emits no events, never influences run exit codes.
 * The reader is TOLERANT by contract: a missing or corrupt manifest.json is
 * skipped with a warning, never a stack trace (the recorder itself is
 * best-effort (§102) and may have left partial state behind).
 */
import path from 'node:path';
import { promises as fs } from 'node:fs';

/** Read-side shape of RunRecorder's manifest.json (v1). Tolerant: extra fields pass through. */
export interface RunManifestLike {
  version?: number;
  runId?: string;
  sessionId?: string;
  mode?: string;
  phase?: string;
  startedAt?: number;
  endedAt?: number;
  status?: string;
  cwd?: string;
  models?: Record<string, string>;
}

/** Read-side shape of RunRecorder's metrics.json (written at finalize only). */
export interface RunMetricsLike {
  durationMs?: number;
  modelCalls?: number;
  toolCalls?: number;
  toolFailures?: number;
  turns?: number;
}

export interface RunRecord {
  runId: string;
  dir: string;
  manifest: RunManifestLike | null;
  metrics: RunMetricsLike | null;
}

export interface RunShowExtras {
  traceEvents: number;
  agents: { id: string; events: number }[];
}

export interface RunsFlags {
  sub: 'list' | 'show' | 'help';
  runId?: string;
  json: boolean;
  limit: number;
  cwd: string;
}

const DEFAULT_LIMIT = 20;

/** `<workspaceRoot>/.zelari/runs` — mirrors the RunRecorder default (ObserverBus). */
export function resolveRunsDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.zelari', 'runs');
}

/** Parse `runs [list|show <run-id>] [--json] [--limit N] [--cwd <dir>] [--help]`. */
export function parseRunsFlags(argv: readonly string[]): RunsFlags | { error: string } {
  const args = argv[0] === 'runs' ? argv.slice(1) : [...argv];
  let json = false;
  let help = false;
  let limit = DEFAULT_LIMIT;
  let cwd = process.cwd();
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--json') json = true;
    else if (a === '--help' || a === '-h') help = true;
    else if (a === '--limit') {
      const v = Number(args[++i]);
      if (!Number.isFinite(v) || v <= 0) return { error: '--limit requires a positive number' };
      limit = Math.floor(v);
    } else if (a === '--cwd') {
      const v = args[++i];
      if (!v) return { error: '--cwd requires a directory' };
      cwd = v;
    } else rest.push(a);
  }
  if (help) return { sub: 'help', runId: undefined, json, limit, cwd };
  const sub = rest[0] ?? 'list';
  if (sub === 'list') return { sub, runId: undefined, json, limit, cwd };
  if (sub === 'show') {
    const runId = rest[1];
    if (!runId) return { error: 'usage: zelari-code runs show <run-id>' };
    return { sub, runId, json, limit, cwd };
  }
  return { error: `unknown subcommand '${sub}' (expected list, show or --help)` };
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null; // missing or corrupt (§102 partial state) — never throw
  }
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** Count non-empty lines of a JSONL stream; 0 when the file is missing/unreadable. */
async function countJsonl(file: string): Promise<number> {
  try {
    const text = await fs.readFile(file, 'utf8');
    return text.split('\n').filter((l) => l.trim().length > 0).length;
  } catch {
    return 0;
  }
}

/** Read one run directory (manifest + metrics). Tolerant: corrupt manifest ⇒ manifest: null. */
export async function readRunRecord(runDir: string, runId: string): Promise<RunRecord> {
  const manifest = asRecord(await readJson(path.join(runDir, 'manifest.json')));
  const metrics = asRecord(await readJson(path.join(runDir, 'metrics.json')));
  return {
    runId,
    dir: runDir,
    manifest: manifest as RunManifestLike | null,
    metrics: metrics as RunMetricsLike | null,
  };
}

/** Trace/agent event counts for `runs show`. Bounded by the record's own size (diagnostic read). */
export async function readRunExtras(runDir: string): Promise<RunShowExtras> {
  const traceEvents = await countJsonl(path.join(runDir, 'trace.jsonl'));
  const agents: { id: string; events: number }[] = [];
  try {
    const entries = await fs.readdir(path.join(runDir, 'agents'), { withFileTypes: true });
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
      agents.push({ id: e.name.replace(/\.jsonl$/, ''), events: await countJsonl(path.join(runDir, 'agents', e.name)) });
    }
    agents.sort((a, b) => a.id.localeCompare(b.id));
  } catch {
    /* no agents dir — fine */
  }
  return { traceEvents, agents };
}

/**
 * List run records (newest first). A directory without a readable manifest is
 * skipped and reported in `skipped` — never silently dropped, never fatal.
 */
export async function listRunRecords(
  runsDir: string,
  opts: { limit?: number } = {},
): Promise<{ records: RunRecord[]; skipped: string[] }> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(runsDir, { withFileTypes: true });
  } catch {
    return { records: [], skipped: [] }; // no runs dir yet ⇒ no runs
  }
  const records: RunRecord[] = [];
  const skipped: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const record = await readRunRecord(path.join(runsDir, e.name), e.name);
    if (!record.manifest) {
      skipped.push(e.name);
      continue;
    }
    records.push(record);
  }
  records.sort((a, b) => (b.manifest?.startedAt ?? 0) - (a.manifest?.startedAt ?? 0));
  return { records: records.slice(0, opts.limit ?? DEFAULT_LIMIT), skipped };
}

function formatDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return '-';
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function formatTs(ts: number | undefined): string {
  return ts === undefined || !Number.isFinite(ts) ? '-' : new Date(ts).toISOString();
}

/** Pure renderer: run list → text block. No IO (same discipline as inspectSession). */
export function renderRunList(records: RunRecord[], skipped: string[]): string {
  const lines = records.map((r) => {
    const m = r.manifest!;
    const metrics = r.metrics;
    const tools = metrics ? `${metrics.toolCalls ?? 0} tools (${metrics.toolFailures ?? 0} fail)` : '-';
    return [
      m.runId ?? r.runId,
      `status=${m.status ?? 'unknown'}`,
      `${m.mode ?? '?'}/${m.phase ?? '?'}`,
      formatTs(m.startedAt),
      formatDuration(metrics?.durationMs ?? (m.endedAt && m.startedAt ? m.endedAt - m.startedAt : undefined)),
      tools,
    ].join('  ');
  });
  if (records.length === 0) lines.push('no runs recorded');
  for (const id of skipped) lines.push(`skipped ${id} (unreadable manifest)`);
  return lines.join('\n');
}

/** Pure renderer: one run record (+extras) → text block. */
export function renderRunShow(record: RunRecord, extras: RunShowExtras): string {
  const m = record.manifest ?? {};
  const models = Object.entries(m.models ?? {}).map(([k, v]) => `${k}=${v}`).join(', ') || '-';
  const lines = [
    `run ${m.runId ?? record.runId}  status=${m.status ?? 'unknown'}  mode=${m.mode ?? '?'}  phase=${m.phase ?? '?'}`,
    `  session    ${m.sessionId ?? '-'}`,
    `  started    ${formatTs(m.startedAt)}`,
    `  ended      ${formatTs(m.endedAt)}`,
    `  duration   ${formatDuration(record.metrics?.durationMs ?? (m.endedAt && m.startedAt ? m.endedAt - m.startedAt : undefined))}`,
    `  cwd        ${m.cwd ?? '-'}`,
    `  models     ${models}`,
  ];
  const metrics = record.metrics;
  if (metrics) {
    lines.push(
      `  metrics    modelCalls=${metrics.modelCalls ?? 0} toolCalls=${metrics.toolCalls ?? 0} toolFailures=${metrics.toolFailures ?? 0} turns=${metrics.turns ?? 0}`,
    );
  } else {
    lines.push('  metrics    (not finalized)');
  }
  lines.push(`  trace      ${extras.traceEvents} events`);
  lines.push(
    extras.agents.length > 0
      ? `  agents     ${extras.agents.map((a) => `${a.id} (${a.events})`).join(', ')}`
      : '  agents     (none)',
  );
  return lines.join('\n');
}

export function runsHelpText(): string {
  return [
    'zelari-code runs — read the run flight recorder (`.zelari/runs/<run-id>/`)',
    '',
    'Usage:',
    '  zelari-code runs list [--json] [--limit N]   newest run records first',
    '  zelari-code runs show <run-id> [--json]      one run: manifest, metrics, agent streams',
    '',
    'Options:',
    '  --json         machine-readable output',
    '  --limit N      max rows for list (default 20)',
    '  --cwd <dir>    workspace root (default: current directory)',
    '  --help         this text',
    '',
    'Recording is opt-in: set ZELARI_RUN_RECORD=1 to write run records.',
  ].join('\n');
}

/**
 * Entry point for `zelari-code runs …`. Accepts argv WITH or WITHOUT the
 * leading `runs` token. Never throws; the exit code is the return value so
 * main.ts owns process teardown (same contract as runReplayCommand).
 */
export async function runRunsCommand(argv: readonly string[]): Promise<number> {
  try {
    const flags = parseRunsFlags(argv);
    if ('error' in flags) {
      process.stderr.write(`${flags.error}\n`);
      return 1;
    }
    if (flags.sub === 'help') {
      process.stdout.write(`${runsHelpText()}\n`);
      return 0;
    }
    const runsDir = resolveRunsDir(flags.cwd);
    if (flags.sub === 'list') {
      const { records, skipped } = await listRunRecords(runsDir, { limit: flags.limit });
      process.stdout.write(
        flags.json ? `${JSON.stringify({ runs: records, skipped }, null, 2)}\n` : `${renderRunList(records, skipped)}\n`,
      );
      return 0;
    }
    const runDir = path.join(runsDir, flags.runId!);
    let isDir = false;
    try {
      isDir = (await fs.stat(runDir)).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) {
      process.stderr.write(`run not found: ${flags.runId}\n`);
      return 1;
    }
    const record = await readRunRecord(runDir, flags.runId!);
    const extras = await readRunExtras(runDir);
    process.stdout.write(
      flags.json
        ? `${JSON.stringify({ run: record, ...extras }, null, 2)}\n`
        : `${renderRunShow(record, extras)}\n`,
    );
    return 0;
  } catch (err) {
    process.stderr.write(`runs command failed: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}
