/**
 * Read/write Claude-compatible mcp.json for Desktop & scripts.
 * User file: ~/.zelari-code/mcp.json
 * Project:   <cwd>/.zelari/mcp.json  (wins on name conflict at runtime)
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { zelariHome } from '../paths.js';
import type { McpServerConfig } from './mcpClient.js';

export type McpConfigScope = 'user' | 'project';

export interface McpServerEntry extends McpServerConfig {
  name: string;
  /** Where the entry is stored (project overrides user at runtime). */
  scope: McpConfigScope;
  path: string;
}

interface McpConfigFile {
  mcpServers?: Record<string, McpServerConfig>;
}

export function getUserMcpPath(): string {
  return join(zelariHome(), 'mcp.json');
}

export function getProjectMcpPath(projectRoot: string): string {
  return join(projectRoot, '.zelari', 'mcp.json');
}

function readFile(path: string): Record<string, McpServerConfig> {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as McpConfigFile;
    const out: Record<string, McpServerConfig> = {};
    for (const [name, cfg] of Object.entries(parsed.mcpServers ?? {})) {
      const hasCommand =
        !!cfg && typeof cfg.command === 'string' && !!cfg.command.trim();
      const hasUrl =
        !!cfg && typeof cfg.url === 'string' && /^https?:\/\//i.test(cfg.url);
      if (!cfg || (!hasCommand && !hasUrl)) continue;
      out[name] = {
        command: hasCommand ? cfg.command!.trim() : undefined,
        args: Array.isArray(cfg.args) ? cfg.args.map(String) : undefined,
        env:
          cfg.env && typeof cfg.env === 'object'
            ? (cfg.env as Record<string, string>)
            : undefined,
        type:
          hasUrl && !hasCommand
            ? 'http'
            : cfg.type === 'http'
              ? 'http'
              : 'stdio',
        url: hasUrl ? cfg.url!.trim() : undefined,
        timeoutMs:
          typeof cfg.timeoutMs === 'number' && cfg.timeoutMs > 0
            ? cfg.timeoutMs
            : undefined,
        serial: typeof cfg.serial === 'boolean' ? cfg.serial : undefined,
        enabled: cfg.enabled !== false,
      };
    }
    return out;
  } catch {
    return {};
  }
}

function writeFile(path: string, servers: Record<string, McpServerConfig>): void {
  mkdirSync(dirname(path), { recursive: true });
  const body: McpConfigFile = { mcpServers: servers };
  writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
}

/** List servers from both scopes (project entries override user names in `merged`). */
export function listMcpServers(projectRoot?: string | null): {
  userPath: string;
  projectPath: string | null;
  servers: McpServerEntry[];
  merged: Record<string, McpServerConfig>;
} {
  const userPath = getUserMcpPath();
  const userServers = readFile(userPath);
  const projectPath =
    projectRoot && projectRoot.trim()
      ? getProjectMcpPath(projectRoot.trim())
      : null;
  const projectServers = projectPath ? readFile(projectPath) : {};

  const servers: McpServerEntry[] = [];
  for (const [name, cfg] of Object.entries(userServers)) {
    servers.push({ name, ...cfg, scope: 'user', path: userPath });
  }
  for (const [name, cfg] of Object.entries(projectServers)) {
    servers.push({ name, ...cfg, scope: 'project', path: projectPath! });
  }
  servers.sort((a, b) => a.name.localeCompare(b.name));

  const merged: Record<string, McpServerConfig> = {
    ...userServers,
    ...projectServers,
  };

  return { userPath, projectPath, servers, merged };
}

/** Process-env key charset — mirrors ENV_KEY_RE in the Desktop MCP form, so
 *  CLI and Desktop accept exactly the same env names. */
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function requireEnvKey(key: string): string {
  if (!ENV_KEY_RE.test(key)) {
    throw new Error(
      `Invalid env key "${key}" — use letters, digits, _ (no leading digit)`,
    );
  }
  return key;
}

/**
 * Parse the `--env` value(s) of `--set-mcp` into a KEY→VALUE map.
 *
 * Two spellings, because the callers differ:
 *   - `--env '{"KEY":"VALUE"}'` — JSON object (what the Desktop bridge ships);
 *   - `--env KEY=VALUE` repeated — hand-typed in a shell (later one wins).
 *
 * Returns `undefined` when the flag is absent, which `upsertMcpServer` reads
 * as "no env channel" and therefore keeps whatever mcp.json already holds. An
 * explicit `{}` survives as `{}` so it can still clear a stored map.
 *
 * Throws on malformed input — the `--set-mcp` block turns that into a clean
 * message + exit code 1.
 */
export function parseMcpEnvFlag(
  raw: string[],
): Record<string, string> | undefined {
  if (raw.length === 0) return undefined;
  const env: Record<string, string> = {};
  for (const value of raw) {
    const text = value.trim();
    // `{…}` is what the Desktop bridge ships; `[…]` also starts JSON so the
    // error for a non-object reads "must be an object", not "use KEY=VALUE".
    if (text.startsWith('{') || text.startsWith('[')) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error(`--env is not valid JSON: ${text}`);
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('--env JSON must be an object of "KEY": "VALUE" pairs');
      }
      for (const [key, val] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof val !== 'string') {
          throw new Error(`--env "${key}" must map to a string value`);
        }
        env[requireEnvKey(key)] = val;
      }
      continue;
    }
    const eq = text.indexOf('=');
    const key = eq > 0 ? text.slice(0, eq).trim() : '';
    if (!key) {
      throw new Error(`Invalid --env "${text}" — use KEY=VALUE or a JSON object`);
    }
    env[requireEnvKey(key)] = text.slice(eq + 1);
  }
  return env;
}

export function upsertMcpServer(opts: {
  scope: McpConfigScope;
  name: string;
  config: McpServerConfig;
  projectRoot?: string | null;
}): { ok: true; path: string } | { ok: false; error: string } {
  const name = opts.name.trim();
  if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) {
    return {
      ok: false,
      error: 'Invalid server name (use letters, digits, _ -)',
    };
  }
  const hasCommand = !!opts.config.command?.trim();
  const hasUrl =
    typeof opts.config.url === 'string' && /^https?:\/\//i.test(opts.config.url);
  if (!hasCommand && !hasUrl) {
    return {
      ok: false,
      error: 'either command (stdio) or url (http) is required',
    };
  }
  let path: string;
  if (opts.scope === 'user') {
    path = getUserMcpPath();
  } else {
    const root = opts.projectRoot?.trim();
    if (!root) {
      return {
        ok: false,
        error: 'projectRoot required for project scope (Open Folder first)',
      };
    }
    path = getProjectMcpPath(root);
  }
  const current = readFile(path);
  const previous = current[name];
  current[name] = {
    command: hasCommand ? opts.config.command!.trim() : undefined,
    args: opts.config.args,
    // Back-compat: callers that only flip `enabled` (Desktop toggle) or that
    // have no env channel at all (`--set-mcp` without `--env`) must not wipe
    // env written by hand or by another tool. An explicit env always wins —
    // including `{}`, which clears it.
    env: opts.config.env ?? previous?.env,
    type: hasUrl ? 'http' : opts.config.type === 'http' ? 'http' : 'stdio',
    url: hasUrl ? opts.config.url!.trim() : undefined,
    timeoutMs: opts.config.timeoutMs,
    serial: opts.config.serial,
    enabled: opts.config.enabled !== false,
  };
  writeFile(path, current);
  return { ok: true, path };
}

export function removeMcpServer(opts: {
  scope: McpConfigScope;
  name: string;
  projectRoot?: string | null;
}): { ok: true; path: string } | { ok: false; error: string } {
  const path =
    opts.scope === 'user'
      ? getUserMcpPath()
      : opts.projectRoot
        ? getProjectMcpPath(opts.projectRoot)
        : null;
  if (!path) {
    return { ok: false, error: 'projectRoot required for project scope' };
  }
  const current = readFile(path);
  if (!(opts.name in current)) {
    return { ok: false, error: `Server "${opts.name}" not found in ${path}` };
  }
  delete current[opts.name];
  writeFile(path, current);
  return { ok: true, path };
}

export function setMcpServerEnabled(opts: {
  scope: McpConfigScope;
  name: string;
  enabled: boolean;
  projectRoot?: string | null;
}): { ok: true; path: string } | { ok: false; error: string } {
  const path =
    opts.scope === 'user'
      ? getUserMcpPath()
      : opts.projectRoot
        ? getProjectMcpPath(opts.projectRoot)
        : null;
  if (!path) {
    return { ok: false, error: 'projectRoot required for project scope' };
  }
  const current = readFile(path);
  const cfg = current[opts.name];
  if (!cfg) {
    return { ok: false, error: `Server "${opts.name}" not found in ${path}` };
  }
  current[opts.name] = { ...cfg, enabled: opts.enabled };
  writeFile(path, current);
  return { ok: true, path };
}
