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
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
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
  return join(homedir(), '.zelari-code');
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
): { ok: true; project: CompanionProject } | { ok: false; error: string } {
  if (!projects.length) {
    return {
      ok: false,
      error:
        'No projects configured. Pass --project <path> or edit ~/.zelari-code/companion.json',
    };
  }
  if (!cwdOrId || !String(cwdOrId).trim()) {
    return { ok: true, project: projects[0]! };
  }
  const key = String(cwdOrId).trim();
  const byId = projects.find((p) => p.id === key || p.name === key);
  if (byId) return { ok: true, project: byId };
  const norm = key.replace(/\\/g, '/').toLowerCase();
  const byPath = projects.find(
    (p) => p.path.replace(/\\/g, '/').toLowerCase() === norm,
  );
  if (byPath) return { ok: true, project: byPath };
  // Prefix match under an allowlisted root
  const under = projects.find((p) => {
    const root = p.path.replace(/\\/g, '/').toLowerCase().replace(/\/$/, '');
    return norm === root || norm.startsWith(root + '/');
  });
  if (under) {
    return {
      ok: true,
      project: { ...under, path: key },
    };
  }
  return {
    ok: false,
    error: `cwd/project not in allowlist: ${key}. Allowed: ${projects.map((p) => p.id).join(', ')}`,
  };
}
