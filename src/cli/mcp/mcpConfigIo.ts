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
import { homedir } from 'node:os';
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
  return join(homedir(), '.zelari-code', 'mcp.json');
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
      if (!cfg || typeof cfg.command !== 'string' || !cfg.command.trim()) continue;
      out[name] = {
        command: cfg.command.trim(),
        args: Array.isArray(cfg.args) ? cfg.args.map(String) : undefined,
        env:
          cfg.env && typeof cfg.env === 'object'
            ? (cfg.env as Record<string, string>)
            : undefined,
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
  if (!opts.config.command?.trim()) {
    return { ok: false, error: 'command is required' };
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
  current[name] = {
    command: opts.config.command.trim(),
    args: opts.config.args,
    env: opts.config.env,
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
