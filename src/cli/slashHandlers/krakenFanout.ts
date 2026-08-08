/**
 * Kraken CSV fan-out slash handler — `/kraken fanout ...` (Slice G / F4.2).
 *
 * Companion to `krakenGraph.ts`. Same shape: standalone async function
 * invoked from `useSlashDispatch.ts`. The handler parses CLI-style args
 * (positional + flags) and calls `runCsvFanout` to drive the batch.
 *
 * Usage:
 *   /kraken fanout <csv_path>
 *     --col <id_column>
 *     --out <output_csv_path>
 *     --instruction "<template with {column} placeholders>"
 *     [--agent explore|verify|general]            (default: verify)
 *     [--thoroughness quick|medium|deep]           (default: medium)
 *     [--scope "<glob template>"]                  (repeatable)
 *     [--concurrency <n>]                          (default: ZELARI_KRAKEN_MAX_PARALLEL)
 *     [--max-runtime <seconds>]
 *
 * @since Kraken v1.30.x — workflow script runtime (Pillar 4)
 */

import { promises as fs } from 'node:fs';
import { AuditLogger } from '../safety/auditLogger.js';
import { createKrakenSubAgentContextFactory } from '../toolRegistry.js';
import { appendSystem } from '../hooks/messageHelpers.js';
import type { ChatMessage } from '../components/ChatStream.js';
import { runCsvFanout, type CsvFanoutArgs } from '../tools/krakenCsvFanout.js';

export interface KrakenFanoutSlashContext {
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  cwd: string;
  sessionId: string;
}

export interface KrakenFanoutParseResult {
  ok: boolean;
  args?: CsvFanoutArgs;
  usage?: string;
  error?: string;
}

/** Tiny CLI-style parser. Returns either parsed args or a usage message. */
export function parseFanoutArgs(argv: string[]): KrakenFanoutParseResult {
  if (argv.length === 0) {
    return { ok: false, usage: USAGE };
  }
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  const listFlags: Record<string, string[]> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq >= 0) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        flags[a.slice(2)] = argv[i + 1];
        i += 1;
      } else {
        flags[a.slice(2)] = true;
      }
    } else {
      positional.push(a);
    }
  }

  const csv = positional[0] ?? (typeof flags.csv === 'string' ? flags.csv : undefined);
  const col = typeof flags.col === 'string' ? flags.col : undefined;
  const out = typeof flags.out === 'string' ? flags.out : undefined;
  const instruction = typeof flags.instruction === 'string' ? flags.instruction : undefined;

  if (!csv) return { ok: false, error: 'csv_path is required (positional or --csv)' };
  if (!col) return { ok: false, error: '--col <id_column> is required' };
  if (!out) return { ok: false, error: '--out <output_csv_path> is required' };
  if (!instruction) return { ok: false, error: '--instruction <template> is required' };

  const agentKindRaw = typeof flags.agent === 'string' ? flags.agent : 'verify';
  if (agentKindRaw !== 'explore' && agentKindRaw !== 'verify' && agentKindRaw !== 'general') {
    return { ok: false, error: `--agent must be one of explore, verify, general (got "${agentKindRaw}")` };
  }
  const thoroughnessRaw = typeof flags.thoroughness === 'string' ? flags.thoroughness : 'medium';
  if (thoroughnessRaw !== 'quick' && thoroughnessRaw !== 'medium' && thoroughnessRaw !== 'deep') {
    return { ok: false, error: `--thoroughness must be one of quick, medium, deep (got "${thoroughnessRaw}")` };
  }
  let concurrency: number | undefined;
  if (typeof flags.concurrency === 'string') {
    concurrency = Number.parseInt(flags.concurrency, 10);
    if (!Number.isFinite(concurrency) || concurrency <= 0) {
      return { ok: false, error: `--concurrency must be a positive integer (got "${flags.concurrency}")` };
    }
  }
  let maxRuntimeSeconds: number | undefined;
  if (typeof flags['max-runtime'] === 'string') {
    maxRuntimeSeconds = Number.parseInt(flags['max-runtime'], 10);
    if (!Number.isFinite(maxRuntimeSeconds) || maxRuntimeSeconds <= 0) {
      return { ok: false, error: `--max-runtime must be a positive integer (got "${flags['max-runtime']}")` };
    }
  }
  // --scope is repeatable: each occurrence is one path/glob template.
  const scopeList = listFlags.scope ?? (typeof flags.scope === 'string' ? [flags.scope] : undefined);

  return {
    ok: true,
    args: {
      csv_path: csv,
      id_column: col,
      output_csv_path: out,
      instruction_template: instruction,
      agent_kind: agentKindRaw,
      thoroughness: thoroughnessRaw,
      ...(scopeList ? { scope_template: scopeList } : {}),
      ...(concurrency !== undefined ? { max_concurrency: concurrency } : {}),
      ...(maxRuntimeSeconds !== undefined ? { max_runtime_seconds: maxRuntimeSeconds } : {}),
    },
  };
}

const USAGE = `Usage:
  /kraken fanout <csv_path>
    --col <id_column>
    --out <output_csv_path>
    --instruction "<template with {column} placeholders>"
    [--agent explore|verify|general]            (default: verify)
    [--thoroughness quick|medium|deep]           (default: medium)
    [--scope "<glob template>"]                  (repeatable)
    [--concurrency <n>]                          (default: ZELARI_KRAKEN_MAX_PARALLEL)
    [--max-runtime <seconds>]

Each row in <csv_path> becomes one sub-agent tentacle. The result CSV
gets one row per input row, with extra columns \`status\`, \`result\`, \`error\`.`;

export async function handleKrakenFanout(
  ctx: KrakenFanoutSlashContext,
  raw: string,
): Promise<void> {
  // Strip the leading "/kraken fanout" if present, then split on whitespace.
  // Quoted strings with spaces are supported: --instruction "review {path} for {issue}".
  const argv = splitArgs(stripPrefix(raw, 'fanout'));
  const parsed = parseFanoutArgs(argv);
  if (!parsed.ok || !parsed.args) {
    appendSystem(ctx.setMessages, parsed.usage ?? `Usage: ${USAGE}`);
    if (parsed.error) {
      appendSystem(ctx.setMessages, `[kraken fanout] ${parsed.error}`);
    }
    return;
  }

  // Sanity-check the source CSV early; the batch is expensive to start if
  // the file is missing.
  const absCsv = isAbsolute(parsed.args.csv_path) ? parsed.args.csv_path : joinPath(ctx.cwd, parsed.args.csv_path);
  try {
    await fs.access(absCsv);
  } catch {
    appendSystem(ctx.setMessages, `[kraken fanout] source CSV not found: ${absCsv}`);
    return;
  }

  appendSystem(
    ctx.setMessages,
    `[kraken fanout] starting: ${parsed.args.csv_path} → ${parsed.args.output_csv_path} (agent=${parsed.args.agent_kind})`,
  );

  const audit = new AuditLogger();
  const taskToolDeps = {
    createSubAgentContext: createKrakenSubAgentContextFactory({
      root: ctx.cwd,
      audit,
      sessionId: ctx.sessionId,
    }),
  };

  try {
    const summary = await runCsvFanout(parsed.args, taskToolDeps, {
      parentCwd: ctx.cwd,
      sessionId: ctx.sessionId,
      onLog: (line) => appendSystem(ctx.setMessages, `[kraken fanout] ${line}`),
    });
    appendSystem(
      ctx.setMessages,
      `[kraken fanout] done: ${summary.completed}/${summary.rows} ok, ${summary.errored} error, ${summary.durationMs}ms → ${summary.output_csv_path}`,
    );
  } catch (err) {
    appendSystem(
      ctx.setMessages,
      `[kraken fanout] failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// --- helpers (no external deps) -------------------------------------------------

function isAbsolute(p: string): boolean {
  return /^([A-Za-z]:[\\/]|[\\/])/.test(p);
}

function joinPath(a: string, b: string): string {
  if (a.endsWith('\\') || a.endsWith('/')) return a + b;
  return `${a}\\${b}`;
}

function stripPrefix(s: string, prefix: string): string {
  const trimmed = s.trim();
  if (trimmed.toLowerCase().startsWith(prefix.toLowerCase())) {
    return trimmed.slice(prefix.length).trim();
  }
  return trimmed;
}

/** Split a CLI-style string into argv tokens, respecting double quotes. */
export function splitArgs(s: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && /\s/.test(ch)) {
      if (cur !== '') { out.push(cur); cur = ''; }
      continue;
    }
    cur += ch;
  }
  if (cur !== '') out.push(cur);
  return out;
}
