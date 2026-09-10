/**
 * exploreCoverage — t57 (C1/C3): tentacle sidecars + the explore→plan
 * coverage metric.
 *
 * Why a sidecar
 * -------------
 * The radio truncates a tentacle's `detail` to 240 chars and the session
 * spine stores metadata, not verbatim conclusions. Without the full text,
 * "how many of the files the plan ended up touching had already emerged
 * from explore?" is incomputable — and the truncation is biased: a `quick`
 * explore's terse conclusion survives it better than a `medium` one's,
 * which would make any flip-to-quick decision measure its own artifact.
 *
 * Surfaces
 * --------
 *   C1  writeTentacleSidecar — full conclusion (capped) under
 *       `.zelari/radio/tentacles/<sessionId>/<nodeId>.md`, fail-open.
 *   C3  computeAndStoreExploreCoverage — overlap between paths mentioned
 *       by EXPLORE sidecars and paths mentioned by WRITER sidecars
 *       (general/fix/verify), persisted as `coverage.json` next to them.
 *   C4  mode capture — the sidecar header records the tentacle's actual
 *       `thoroughness`, and the report carries `exploreModes`, so a session
 *       can be attributed to a phase by the flip gate (`./exploreFlipGate.ts`)
 *       instead of being guessed from timing or config.
 *
 * The C2 spine side already exists (ADR-0033 t75: `file.applied` /
 * `file.read` / `file.rejected` derived events in sessionSpine.ts) — no
 * work needed there.
 *
 * Scope note (deliberate): this module only MEASURES. The quick-default
 * flip is gated on ≥5 dogfood sessions of baseline data; it is not
 * performed here.
 *
 * No I/O at import time. Everything fails open.
 *
 * @since v2.x — t57 strumentazione coverage explore
 */

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Sidecar root, relative to the parent cwd (inside the existing radio dir). */
export const TENTACLE_SIDECAR_SEGMENTS = ['.zelari', 'radio', 'tentacles'] as const;

/** Per-sidecar cap: enough for a real conclusion, small enough to not be a log. */
const SIDECAR_CAP_CHARS = 16 * 1024;

export interface TentacleSidecarInfo {
  agent: string;
  /**
   * C4: the thoroughness the tentacle actually ran with (`task` arg:
   * quick|medium|deep). Recorded so the explore→plan coverage of a session
   * can be attributed to a phase — without it every session written before
   * C4 is mode-unknown and the flip gate has to exclude it.
   */
  thoroughness?: string;
  model?: string;
  durationMs?: number;
  result: string;
  worktree?: string | null;
}

/** Filesystem-safe, length-bounded id for sidecar names. */
export function sanitizeNodeId(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 80) || 'node';
}

/**
 * C1 — persist a tentacle's full conclusion. Fail-open by design: the
 * sidecar is an observability extra, never a dependency of the run.
 *
 * The header grows only additively (`thoroughness:` line, C4): old sidecars
 * stay parseable, and a reader that does not know the line ignores it.
 */
export async function writeTentacleSidecar(
  cwd: string,
  sessionId: string,
  nodeId: string,
  info: TentacleSidecarInfo,
): Promise<void> {
  try {
    const dir = sidecarDir(cwd, sessionId);
    await mkdir(dir, { recursive: true });
    const header = [
      `# tentacle ${nodeId}`,
      `agent: ${info.agent}`,
      info.thoroughness ? `thoroughness: ${info.thoroughness}` : null,
      info.model ? `model: ${info.model}` : null,
      typeof info.durationMs === 'number' ? `durationMs: ${info.durationMs}` : null,
      info.worktree ? `worktree: ${info.worktree}` : null,
      '',
    ]
      .filter((line): line is string => line !== null)
      .join('\n');
    const body =
      info.result.length > SIDECAR_CAP_CHARS
        ? info.result.slice(0, SIDECAR_CAP_CHARS)
        : info.result;
    await writeFile(path.join(dir, `${sanitizeNodeId(nodeId)}.md`), `${header}\n${body}\n`, 'utf8');
  } catch {
    /* fail-open */
  }
}

function sidecarDir(cwd: string, sessionId: string): string {
  return path.join(cwd, ...TENTACLE_SIDECAR_SEGMENTS, sanitizeNodeId(sessionId));
}

/**
 * Normalize a path-like token to a repo-relative, forward-slash,
 * lowercase key (win32-insensitive comparisons). Returns null for tokens
 * that are not file paths worth counting (no extension, node_modules,
 * absolute paths outside the repo).
 */
export function normalizePathToken(token: string, cwd: string): string | null {
  if (!token) return null;
  let p = token.replace(/^[(`'"<[{]+/, '').replace(/[)`'"\]}>.,:;]+$/, '');
  p = p.replace(/\\/g, '/');
  if (p.length === 0) return null;
  // URLs are not repo paths (they match the token regex but are links).
  if (p.includes('://')) return null;
  if (!/\.[A-Za-z0-9]{1,8}$/.test(p)) return null;
  const low = p.toLowerCase();
  if (low.startsWith('node_modules/') || low.includes('/node_modules/')) return null;
  if (path.isAbsolute(p)) {
    const rel = path.relative(cwd, p);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    return rel.split(path.sep).join('/').toLowerCase();
  }
  return low.replace(/^[./]+/, '');
}

const PATH_TOKEN_RE = /(?:[A-Za-z]:)?(?:[\w.-]*\/)+[\w.-]+\.[A-Za-z0-9]{1,8}/g;

/** Extract the set of normalized repo paths a piece of text mentions. */
export function extractMentionedPaths(text: string, cwd: string): Set<string> {
  const out = new Set<string>();
  for (const match of text.match(PATH_TOKEN_RE) ?? []) {
    const normalized = normalizePathToken(match, cwd);
    if (normalized) out.add(normalized);
  }
  return out;
}

export interface CoverageCount {
  mentionedCount: number;
  touchedCount: number;
  coveredCount: number;
  /** |mentioned ∩ touched| / |touched|; null when touched is empty. */
  ratio: number;
}

/** Pure overlap computation. Null when there is nothing touched to cover. */
export function computeCoverage(mentioned: Set<string>, touched: Set<string>): CoverageCount | null {
  if (touched.size === 0) return null;
  let covered = 0;
  for (const t of touched) if (mentioned.has(t)) covered += 1;
  return {
    mentionedCount: mentioned.size,
    touchedCount: touched.size,
    coveredCount: covered,
    ratio: covered / touched.size,
  };
}

export interface ExploreCoverageReport {
  sessionId: string;
  mentioned: string[];
  touched: string[];
  covered: string[];
  ratio: number;
  computedAt: string;
  /**
   * C4: sorted unique thoroughness values declared by this session's
   * `agent: explore` sidecar headers. Omitted (not `[]`) when no explore
   * sidecar declared one — a legacy session is mode-UNKNOWN, and the flip
   * gate must be able to tell that apart from a session with no explore at
   * all. `undefined` here is a fact, not a default.
   */
  exploreModes?: string[];
  /** C4: number of explore sidecars whose header carried no thoroughness. */
  exploreModesUnknown?: number;
}

/** C4: the thoroughness a sidecar header declared, if any (lowercased). */
function declaredThoroughness(raw: string): string | null {
  return /^thoroughness:\s*(\S+)/m.exec(raw)?.[1]?.trim().toLowerCase() ?? null;
}

/**
 * C3 — compute and persist the coverage report for one session's sidecar
 * set. Mentioned = paths in `explore` sidecars; touched = paths in
 * `general`/`fix`/`verify` sidecars (an approximation of "what the plan
 * ended up touching", self-contained without spine parsing; the spine's
 * `file.applied` events remain the stricter source for a later revision).
 *
 * C4 — the same pass collects the thoroughness of the explore sidecars, so
 * each session carries its own phase (`exploreModes`) for the flip gate.
 * Returns null (and writes nothing) when no writer sidecar exists.
 */
export async function computeAndStoreExploreCoverage(
  cwd: string,
  sessionId: string,
): Promise<ExploreCoverageReport | null> {
  try {
    const dir = sidecarDir(cwd, sessionId);
    const files = await readdir(dir).catch(() => [] as string[]);
    const mentioned = new Set<string>();
    const touched = new Set<string>();
    const exploreModes = new Set<string>();
    let exploreModesUnknown = 0;
    for (const file of files) {
      if (!file.endsWith('.md')) continue;
      const raw = await readFile(path.join(dir, file), 'utf8');
      const agent = /^agent:\s*(\S+)/m.exec(raw)?.[1] ?? 'unknown';
      const paths = extractMentionedPaths(raw, cwd);
      if (agent === 'explore') {
        for (const p of paths) mentioned.add(p);
        const mode = declaredThoroughness(raw);
        if (mode) exploreModes.add(mode);
        else exploreModesUnknown += 1;
      } else if (agent === 'general' || agent === 'fix' || agent === 'verify') {
        for (const p of paths) touched.add(p);
      }
    }
    const coverage = computeCoverage(mentioned, touched);
    if (!coverage) return null;
    const report: ExploreCoverageReport = {
      sessionId,
      mentioned: [...mentioned].sort(),
      touched: [...touched].sort(),
      covered: [...touched].filter((t) => mentioned.has(t)).sort(),
      ratio: coverage.ratio,
      computedAt: new Date().toISOString(),
      // Additive: absent when nothing was declared (legacy sidecar headers).
      ...(exploreModes.size > 0 ? { exploreModes: [...exploreModes].sort() } : {}),
      ...(exploreModesUnknown > 0 ? { exploreModesUnknown } : {}),
    };
    await writeFile(path.join(dir, 'coverage.json'), JSON.stringify(report, null, 2), 'utf8');
    return report;
  } catch {
    return null; // fail-open: measurement must never break the run
  }
}
