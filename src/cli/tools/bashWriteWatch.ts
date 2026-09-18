/**
 * K2.1 / F9 — detect writes performed by bash / exec_process outside the
 * anchored file.* channel (heredoc, `sed -i`, redirects).
 *
 * Pre-snapshot cwd (relative path + size/mtimeMs), run the tool, rescan,
 * emit synthetic spine `file.applied` {origin:'bash'} plus radio
 * `bash.write_detected`. Detection is fail-open but loud: snapshot/diff
 * errors never deny the tool; they emit `bash.watch_failed`.
 *
 * Bodies are never read (stat only; files >5MB included by metadata).
 */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { SessionEventInput } from '@zelari/core/session';
import type { ToolContext, ToolDefinition, TypedResult } from '@zelari/core/harness/tools/toolTypes';

export const BASH_WRITE_DETECTED = 'bash.write_detected' as const;
export const BASH_WATCH_FAILED = 'bash.watch_failed' as const;

export const MAX_EMIT_PATHS = 200;
export const MAX_SCAN_ENTRIES = 2000;
export const MAX_SCAN_DEPTH = 4;
/** Content-diff budget — we never read bodies; kept as the documented skip. */
export const MAX_CONTENT_BYTES = 5 * 1024 * 1024;

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '__pycache__',
  '.cache',
  '.zelari',
  '.venv',
  'coverage',
]);

export type FsStatSnap = Map<string, { size: number; mtimeMs: number }>;

export interface FsDiff {
  path: string;
  kind: 'create' | 'modify' | 'delete';
  size?: number;
  mtimeMs?: number;
}

export interface BashWriteRadioEvent {
  kind: typeof BASH_WRITE_DETECTED | typeof BASH_WATCH_FAILED;
  ok: boolean;
  description: string;
  detail?: string;
  paths?: string[];
  truncated?: boolean;
  count?: number;
}

export interface BashWriteDetectOpts {
  root: string;
  snapshot?: (cwd: string) => Promise<FsStatSnap>;
  radio?: (event: BashWriteRadioEvent) => void;
}

function toRel(root: string, abs: string): string {
  const rel = path.relative(root, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return abs.replace(/\\/g, '/');
  return rel.replace(/\\/g, '/');
}

function snapId(size: number, mtimeMs: number): string {
  return createHash('sha256').update(`${size}:${mtimeMs}`).digest('hex').slice(0, 16);
}

function loudRadio(radio: BashWriteDetectOpts['radio'], event: BashWriteRadioEvent): void {
  try {
    radio?.(event);
  } catch {
    /* radio must never deny */
  }
}

function watchFailed(err: unknown): BashWriteRadioEvent {
  const detail = err instanceof Error ? err.message : String(err);
  return {
    kind: BASH_WATCH_FAILED,
    ok: false,
    description: BASH_WATCH_FAILED,
    detail,
  };
}

function resolveScanRoot(args: Record<string, unknown>, ctx: ToolContext, root: string): string {
  const raw = args['cwd'];
  if (typeof raw === 'string' && raw.length > 0) {
    return path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(root, raw);
  }
  return ctx.cwd || root;
}

export async function snapshotCwd(
  cwd: string,
  opts?: { maxEntries?: number; maxDepth?: number },
): Promise<FsStatSnap> {
  const maxEntries = opts?.maxEntries ?? MAX_SCAN_ENTRIES;
  const maxDepth = opts?.maxDepth ?? MAX_SCAN_DEPTH;
  const out: FsStatSnap = new Map();
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (out.size >= maxEntries || depth > maxDepth) return;
    let ents: import('node:fs').Dirent[];
    try {
      ents = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (depth === 0) throw err;
      return;
    }
    for (const ent of ents) {
      if (out.size >= maxEntries) return;
      if (SKIP_DIRS.has(ent.name)) continue;
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        await walk(abs, depth + 1);
      } else if (ent.isFile()) {
        try {
          const st = await fs.stat(abs);
          out.set(toRel(cwd, abs), { size: st.size, mtimeMs: st.mtimeMs });
        } catch {
          /* skip unreadable */
        }
      }
    }
  };
  await walk(cwd, 0);
  return out;
}

export function diffFsSnapshots(pre: FsStatSnap, post: FsStatSnap): FsDiff[] {
  const diffs: FsDiff[] = [];
  for (const [p, st] of post) {
    const before = pre.get(p);
    if (!before) diffs.push({ path: p, kind: 'create', size: st.size, mtimeMs: st.mtimeMs });
    else if (before.size !== st.size || before.mtimeMs !== st.mtimeMs) {
      diffs.push({ path: p, kind: 'modify', size: st.size, mtimeMs: st.mtimeMs });
    }
  }
  for (const p of pre.keys()) {
    if (!post.has(p)) diffs.push({ path: p, kind: 'delete' });
  }
  return diffs;
}

function appliedEvent(d: FsDiff): SessionEventInput {
  if (d.kind === 'delete') {
    return { kind: 'file.applied', actor: { type: 'tool' }, data: { path: d.path, origin: 'bash', deleted: true } };
  }
  return {
    kind: 'file.applied',
    actor: { type: 'tool' },
    data: {
      path: d.path,
      origin: 'bash',
      bytes: d.size ?? 0,
      snapshotId: snapId(d.size ?? 0, d.mtimeMs ?? 0),
      ...(d.kind === 'create' ? { created: true } : {}),
    },
  };
}

async function emitDetected(
  ctx: ToolContext,
  diffs: FsDiff[],
  radio: BashWriteDetectOpts['radio'],
): Promise<void> {
  if (diffs.length === 0) return;
  const truncated = diffs.length > MAX_EMIT_PATHS;
  const capped = truncated ? diffs.slice(0, MAX_EMIT_PATHS) : diffs;
  for (const d of capped) {
    try {
      await ctx.emitSessionEvent?.(appliedEvent(d));
    } catch {
      /* telemetry only */
    }
  }
  const paths = capped.map((d) => d.path);
  loudRadio(radio, {
    kind: BASH_WRITE_DETECTED,
    ok: true,
    description: BASH_WRITE_DETECTED,
    detail: truncated
      ? `applied=${diffs.length} truncated=${MAX_EMIT_PATHS}`
      : `applied=${diffs.length}`,
    paths,
    count: diffs.length,
    ...(truncated ? { truncated: true } : {}),
  });
}

/**
 * Wrap bash / exec_process: snapshot cwd, run the tool, diff, emit synthetic
 * `file.applied` {origin:'bash'} + audit radio. Snapshot errors are loud
 * (`bash.watch_failed`) and never block execute.
 */
export function wrapWithBashWriteDetection<I extends Record<string, unknown>, O>(
  original: ToolDefinition<I, O>,
  opts: BashWriteDetectOpts,
): ToolDefinition<I, O> {
  const takeSnap = opts.snapshot ?? ((cwd: string) => snapshotCwd(cwd));
  return {
    ...original,
    execute: async (rawArgs: I, ctx: ToolContext): Promise<TypedResult<O>> => {
      const cwd = resolveScanRoot(rawArgs as Record<string, unknown>, ctx, opts.root);
      let pre: FsStatSnap | undefined;
      try {
        pre = await takeSnap(cwd);
      } catch (err) {
        loudRadio(opts.radio, watchFailed(err));
        return original.execute(rawArgs, ctx);
      }
      const result = await original.execute(rawArgs, ctx);
      try {
        const post = await takeSnap(cwd);
        await emitDetected(ctx, diffFsSnapshots(pre, post), opts.radio);
      } catch (err) {
        loudRadio(opts.radio, watchFailed(err));
      }
      return result;
    },
  };
}
