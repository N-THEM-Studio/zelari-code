/**
 * tools/eval/competitive/adapters.ts — per-agent spawn adapters for the
 * competitive bench (t35+t36).
 *
 * - zelari: `node <repo>/bin/zelari-code.js --headless --task-file <file>`
 *   — the same surface runAnchors.ts uses; prompt goes through a FILE
 *   (Windows CreateProcess caps the command line, and runAnchors already
 *   ships this pattern).
 * - codex / claude / opencode: `codex exec <prompt>`, `claude -p <prompt>`,
 *   `opencode run <prompt>` — prompt as argv. shell:true is REQUIRED for
 *   these on Windows (npm global installs are .cmd shims and Node refuses
 *   to spawn .cmd without a shell); args are therefore pre-quoted by the
 *   adapter, never raw-interpolated.
 *
 * Detection is a pure PATH scan (filesystem only — no process spawned), so
 * the dry-run path is fully offline. `--version` probing happens only on
 * real runs and is best-effort (null when it fails).
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { AnchorManifest } from '../types.ts';
import type { AgentId } from './schema.ts';

/** Absolute path of the zelari CLI entry (repo root bin/). */
export const ZELARI_CLI_PATH = path.resolve(import.meta.dirname, '../../../bin/zelari-code.js');
/** Repo root (for package.json version + default result dirs). */
export const REPO_ROOT = path.resolve(import.meta.dirname, '../../../');

export interface AgentSpawnSpec {
  program: string;
  /** Pre-quoted when `shell` is true (cmd.exe / sh join argv with spaces). */
  args: string[];
  shell: boolean;
}

export interface AgentAdapter {
  id: AgentId;
  label: string;
  /** One-line command preview for the plan/report; `<prompt>` elided. */
  preview: string;
  /** PATH scan only — safe for the offline dry-run. */
  locate(): { found: boolean; binPath?: string };
  buildSpawn(input: { anchor: AnchorManifest; taskFile: string; prompt: string }): AgentSpawnSpec;
}

/**
 * Isolated child env for the zelari headless spawn — mirrors the companion
 * runManager child env plus a sessions dir redirected into the bench scratch
 * root, so a bench run never pollutes the repo/dev session state.
 */
export function zelariChildEnv(scratchRoot: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ZELARI_SKIP_PREFLIGHT: '1',
    FORCE_COLOR: '0',
    ZELARI_SESSIONS_DIR: path.join(scratchRoot, 'sessions'),
  };
}

/** Probe `--version` (real runs only — spawns a process; 15s cap). */
export function probeVersion(adapter: AgentAdapter): string | null {
  const bin = adapter.locate().binPath ?? adapter.id;
  try {
    const res = spawnSync(bin, ['--version'], {
      encoding: 'utf8',
      timeout: 15_000,
      shell: adapter.id !== 'zelari',
      windowsHide: true,
    });
    const first = String(res.stdout ?? '').split(/\r?\n/).find((l) => l.trim().length > 0);
    return first?.trim() ?? null;
  } catch {
    return null;
  }
}

/**
 * Windows CRT argv quoting (the rules CommandLineToArgvW applies). Needed
 * because shell:true makes Node join program+args verbatim.
 */
export function winQuote(arg: string): string {
  if (arg.length > 0 && !/[\s"]/.test(arg)) return arg;
  let out = '"';
  let backslashes = 0;
  for (const ch of arg) {
    if (ch === '\\') {
      backslashes += 1;
      continue;
    }
    if (ch === '"') {
      out += '\\'.repeat(backslashes * 2 + 1) + '"';
    } else {
      out += '\\'.repeat(backslashes) + ch;
    }
    backslashes = 0;
  }
  return out + '\\'.repeat(backslashes * 2) + '"';
}

/** POSIX sh single-quote quoting (embedded ' become '"'"'). */
export function shQuote(arg: string): string {
  return `'${arg.replaceAll("'", `'"'"'`)}'`;
}

/** Quote one argv entry for the platform shell (used only for shell:true). */
export function quoteForShell(arg: string): string {
  return process.platform === 'win32' ? winQuote(arg) : shQuote(arg);
}

/** Find a binary on PATH — filesystem check only, no process spawn. */
export function findOnPath(bin: string): string | undefined {
  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';')
    : [''];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, bin + (ext ? ext.toLowerCase() : ext));
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

/** zelari adapter: headless CLI via node (no shell — execPath is absolute). */
function zelariAdapter(): AgentAdapter {
  return {
    id: 'zelari',
    label: `zelari (${path.basename(ZELARI_CLI_PATH)})`,
    preview: `node bin/zelari-code.js --headless --task-file <file> --profile <profile> --output json`,
    locate: () => {
      if (!existsSync(ZELARI_CLI_PATH)) return { found: false };
      return { found: true, binPath: ZELARI_CLI_PATH };
    },
    buildSpawn: ({ anchor, taskFile }) => ({
      program: process.execPath,
      args: [
        ZELARI_CLI_PATH,
        '--headless',
        '--task-file', taskFile,
        '--profile', anchor.profile,
        '--output', 'json',
      ],
      shell: false,
    }),
  };
}

/** Competitor adapter factory: `<bin> <sub…> <prompt>` with pre-quoted argv. */
function competitorAdapter(id: 'codex' | 'claude' | 'opencode', label: string, argsBefore: string[]): AgentAdapter {
  return {
    id,
    label,
    preview: [id, ...argsBefore, '<prompt>'].join(' '),
    locate: () => {
      const binPath = findOnPath(id);
      return binPath ? { found: true, binPath } : { found: false };
    },
    buildSpawn: ({ prompt }) => ({
      program: id,
      args: [...argsBefore, quoteForShell(prompt)],
      shell: true,
    }),
  };
}

/** Adapter registry, in canonical run order. */
export function allAdapters(): AgentAdapter[] {
  return [
    zelariAdapter(),
    competitorAdapter('codex', 'codex CLI', ['exec']),
    competitorAdapter('claude', 'claude CLI', ['-p']),
    competitorAdapter('opencode', 'opencode CLI', ['run']),
  ];
}

/**
 * Last zelari usage event from the NDJSON headless stream, if any. Honest by
 * construction: returns null unless a parsed event carries numeric
 * inputTokens + outputTokens (the stream does not emit one today — this
 * keeps the bench forward-compatible without inventing numbers).
 */
export function parseZelariUsage(stdout: string): { input: number; output: number; cacheHit?: number } | null {
  let usage: { input: number; output: number; cacheHit?: number } | null = null;
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      if (typeof obj.inputTokens === 'number' && typeof obj.outputTokens === 'number') {
        usage = {
          input: obj.inputTokens,
          output: obj.outputTokens,
          cacheHit: typeof obj.cacheHitTokens === 'number' ? obj.cacheHitTokens : undefined,
        };
      }
    } catch {
      // Non-JSON line — ignore (progress text, warnings).
    }
  }
  return usage;
}
