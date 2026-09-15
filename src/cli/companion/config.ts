/**
 * Companion host config + token (for Android / remote clients over Tailscale).
 *
 * Files under ~/.zelari-code/:
 *   companion.json   — projects allowlist, bind/port defaults
 *   companion.token  — bearer token (created on first serve if missing)
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { zelariHome } from '../paths.js';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const DEFAULT_COMPANION_PORT = 7421;
export const DEFAULT_COMPANION_BIND = '127.0.0.1';

export interface CompanionProject {
  id: string;
  name: string;
  path: string;
}

export interface CompanionConfigFile {
  projects: CompanionProject[];
  bind?: string;
  port?: number;
}

export function getZelariHome(): string {
  return zelariHome();
}

export function getCompanionConfigPath(): string {
  return join(getZelariHome(), 'companion.json');
}

export function getCompanionTokenPath(): string {
  return join(getZelariHome(), 'companion.token');
}

function ensureHome(): void {
  const home = getZelariHome();
  if (!existsSync(home)) {
    mkdirSync(home, { recursive: true });
  }
}

export function loadCompanionConfig(): CompanionConfigFile {
  const path = getCompanionConfigPath();
  if (!existsSync(path)) {
    return { projects: [] };
  }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as CompanionConfigFile;
    const projects = Array.isArray(raw.projects)
      ? raw.projects
          .filter(
            (p) =>
              p &&
              typeof p.path === 'string' &&
              p.path.trim() &&
              typeof (p.id ?? p.name) === 'string',
          )
          .map((p) => ({
            id: String(p.id || p.name)
              .trim()
              .toLowerCase()
              .replace(/[^a-z0-9-_]+/g, '-')
              .slice(0, 64),
            name: String(p.name || p.id || 'project').trim() || 'project',
            path: String(p.path).trim(),
          }))
      : [];
    return {
      projects,
      bind: typeof raw.bind === 'string' ? raw.bind : undefined,
      port: typeof raw.port === 'number' ? raw.port : undefined,
    };
  } catch {
    return { projects: [] };
  }
}

export function saveCompanionConfig(cfg: CompanionConfigFile): void {
  ensureHome();
  writeFileSync(
    getCompanionConfigPath(),
    JSON.stringify(
      {
        bind: cfg.bind,
        port: cfg.port,
        projects: cfg.projects,
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );
}

/** Load token or create a new one (printed once by serve). */
export function loadOrCreateToken(explicit?: string): {
  token: string;
  created: boolean;
} {
  if (explicit && explicit.trim()) {
    return { token: explicit.trim(), created: false };
  }
  ensureHome();
  const path = getCompanionTokenPath();
  if (existsSync(path)) {
    const t = readFileSync(path, 'utf8').trim();
    if (t) return { token: t, created: false };
  }
  const token = randomBytes(24).toString('base64url');
  writeFileSync(path, token + '\n', 'utf8');
  try {
    // Best-effort restrict (POSIX); ignored on Windows.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('node:fs') as typeof import('node:fs');
    fs.chmodSync?.(path, 0o600);
  } catch {
    /* ignore */
  }
  return { token, created: true };
}

export function tokenMatches(expected: string, provided: string | null): boolean {
  if (!provided) return false;
  const a = createHash('sha256').update(expected).digest();
  const b = createHash('sha256').update(provided).digest();
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export function slugFromPath(p: string): string {
  const base = p.replace(/[/\\]+$/, '').split(/[/\\]/).pop() || 'project';
  return base
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'project';
}

/**
 * t66 full-fs: resolve an absolute, existing directory from the companion
 * picker into a project-shaped descriptor. resolveProjectPath flags the
 * result untrusted so a run there parks as awaiting_trust until the desktop
 * modal answers. '..' segments and non-absolute paths are rejected; the
 * directory must exist (the picker only ever proposes real folders).
 */
export function resolveFsDirectory(
  rawPath: string,
): { ok: true; project: CompanionProject } | { ok: false; error: string } {
  const trimmed = rawPath.trim();
  if (!trimmed) return { ok: false, error: 'cwd is required' };
  const norm = trimmed.replace(/\\/g, '/');
  const absolute = /^([a-zA-Z]:\/|\/)/.test(norm);
  if (!absolute || norm.split('/').includes('..')) {
    return {
      ok: false,
      error: `cwd must be an absolute path without '..': ${trimmed}`,
    };
  }
  let stat;
  try {
    stat = statSync(trimmed);
  } catch {
    return { ok: false, error: `path not found: ${trimmed}` };
  }
  if (!stat.isDirectory()) {
    return { ok: false, error: `not a directory: ${trimmed}` };
  }
  const abs = resolve(trimmed);
  const slug = slugFromPath(abs);
  return { ok: true, project: { id: slug, name: slug, path: abs } };
}

/** Merge CLI --project paths into config (in-memory; optionally persist). */
export function mergeProjects(
  cfg: CompanionConfigFile,
  extraPaths: string[],
): CompanionProject[] {
  const byId = new Map<string, CompanionProject>();
  for (const p of cfg.projects) {
    byId.set(p.id, p);
  }
  for (const raw of extraPaths) {
    const path = raw.trim();
    if (!path) continue;
    let id = slugFromPath(path);
    let n = 2;
    while (byId.has(id) && byId.get(id)!.path !== path) {
      id = `${slugFromPath(path)}-${n++}`;
    }
    byId.set(id, {
      id,
      name: slugFromPath(path),
      path,
    });
  }
  return [...byId.values()];
}

export function resolveProjectPath(
  projects: CompanionProject[],
  cwdOrId: string | undefined | null,
  opts: { fullFs?: boolean } = {},
):
  | { ok: true; project: CompanionProject; trusted: boolean }
  | { ok: false; error: string } {
  const key = String(cwdOrId ?? '').trim();
  // t66: with full-fs an explicit cwd resolves even with an empty allowlist —
  // the desktop trust gate replaces the allowlist as the run barrier.
  if (!projects.length && !(opts.fullFs && key)) {
    return {
      ok: false,
      error:
        'No projects configured. Pass --project <path> or edit ~/.zelari-code/companion.json',
    };
  }
  if (!key) {
    return { ok: true, project: projects[0]!, trusted: true };
  }
  const byId = projects.find((p) => p.id === key || p.name === key);
  if (byId) return { ok: true, project: byId, trusted: true };
  const norm = key.replace(/\\/g, '/').toLowerCase();
  const byPath = projects.find(
    (p) => p.path.replace(/\\/g, '/').toLowerCase() === norm,
  );
  if (byPath) return { ok: true, project: byPath, trusted: true };
  // Prefix match under an allowlisted root
  const under = projects.find((p) => {
    const root = p.path.replace(/\\/g, '/').toLowerCase().replace(/\/$/, '');
    return norm === root || norm.startsWith(root + '/');
  });
  if (under) {
    return {
      ok: true,
      project: { ...under, path: key },
      trusted: true,
    };
  }
  // t66 full-fs: any existing absolute directory resolves, flagged
  // untrusted — the desktop trust modal gates the actual run start.
  if (opts.fullFs) {
    const dir = resolveFsDirectory(key);
    if (dir.ok) return { ok: true, project: dir.project, trusted: false };
    return { ok: false, error: dir.error };
  }
  return {
    ok: false,
    error: `cwd/project not in allowlist: ${key}. Allowed: ${projects.map((p) => p.id).join(', ')}`,
  };
}

/**
 * t63: sandbox check for GET /v1/fs — same normalization/prefix logic as
 * resolveProjectPath (backslash→slash, case-insensitive, any depth under an
 * allowlisted root). '..' segments are rejected before any fs access.
 */
export function isUnderRoots(
  rawPath: string,
  projects: CompanionProject[],
): { ok: true; root: CompanionProject; normalized: string } | { ok: false } {
  const norm = rawPath.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
  if (!norm || norm.split('/').includes('..')) return { ok: false };
  for (const p of projects) {
    const root = p.path.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
    if (norm === root || norm.startsWith(root + '/')) {
      return { ok: true, root: p, normalized: norm };
    }
  }
  return { ok: false };
}
