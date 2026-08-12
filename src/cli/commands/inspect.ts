/**
 * inspect.ts — `zelari-code inspect [--json]` (v1.32.0).
 *
 * Unified environment inspection for a project:
 *   - version / cwd / platform / phase / mode
 *   - config sources (files + env overrides)
 *   - skills (builtin + user + project)
 *   - MCP servers (user + project) with trust status
 *   - lifecycle hooks (global + project) with trust status
 *   - plugins (optional tooling)
 *   - AGENTS.md rules present
 *   - folder trust status
 *
 * Human-readable by default; `--json` emits a machine-readable report with a
 * stable `schemaVersion` field so Desktop / scripts can parse it.
 *
 * @since v1.32.0
 */

import path from 'node:path';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import {
  isFolderTrusted,
  listTrustedFolders,
  getTrustStorePath,
} from '../safety/folderTrust.js';
import {
  globalHooksDir,
  projectHooksDir,
} from '../safety/lifecycleHooks.js';
import { listMcpServers } from '../mcp/mcpConfigIo.js';
import {
  listSkillsSnapshot,
  ensureBuiltinSkillsLoadedSync,
} from '../skillConfigIo.js';
import { PLUGINS } from '../plugins/registry.js';
import { getCurrentVersion } from '../updater.js';

export interface InspectReport {
  schemaVersion: 1;
  zelariVersion: string;
  cwd: string;
  platform: string;
  node: string;
  phase: string;
  mode: string;
  trust: {
    store: string;
    trusted: boolean;
    folders: Array<{ path: string; trustedAt: string }>;
  };
  configSources: Array<{ path: string; exists: boolean }>;
  skills: {
    total: number;
    builtin: number;
    user: number;
    project: number;
    compat: number;
  };
  mcp: {
    user: Array<{ name: string; enabled: boolean }>;
    project: Array<{ name: string; enabled: boolean }>;
    projectTrusted: boolean;
    projectConfigExists: boolean;
  };
  hooks: {
    global: { path: string; active: boolean; files: string[] };
    project: { path: string; active: boolean; files: string[] };
  };
  plugins: Array<{ id: string; label: string; installed: boolean }>;
  agentsMd: string[];
}

/** Collect the full report (never throws — each section degrades to empty). */
export async function collectInspectReport(
  cwd: string = process.cwd(),
): Promise<InspectReport> {
  ensureBuiltinSkillsLoadedSync();
  const snap = listSkillsSnapshot(cwd);

  const mcp = listMcpServers(cwd);
  const userMcpPath = path.join(homedir(), '.zelari-code', 'mcp.json');
  const projectMcpPath = path.join(cwd, '.zelari', 'mcp.json');

  const globalHooks = globalHooksDir();
  const projectHooks = projectHooksDir(cwd);
  const projectTrusted = isFolderTrusted(cwd);

  const skillsByScope = (scope: string) =>
    snap.skills.filter((s) => s.scope === scope).length;

  const pluginStates = await Promise.all(
    PLUGINS.map(async (p) => ({
      id: p.id,
      label: p.label ?? p.id,
      installed: await p.detect(cwd),
    })),
  );

  return {
    schemaVersion: 1,
    zelariVersion: getCurrentVersion(),
    cwd,
    platform: `${process.platform}-${process.arch}`,
    node: process.version,
    phase: process.env.ZELARI_PHASE ?? 'build',
    mode: process.env.ZELARI_MODE ?? 'kraken',
    trust: {
      store: getTrustStorePath(),
      trusted: projectTrusted,
      folders: listTrustedFolders(),
    },
    configSources: [
      { path: userMcpPath, exists: existsSync(userMcpPath) },
      { path: projectMcpPath, exists: existsSync(projectMcpPath) },
      { path: path.join(homedir(), '.zelari-code', 'provider.json'), exists: existsSync(path.join(homedir(), '.zelari-code', 'provider.json')) },
      { path: path.join(cwd, '.zelari', 'AGENTS.md'), exists: existsSync(path.join(cwd, '.zelari', 'AGENTS.md')) },
      { path: path.join(cwd, 'AGENTS.md'), exists: existsSync(path.join(cwd, 'AGENTS.md')) },
    ],
    skills: {
      total: snap.skills.length,
      builtin: skillsByScope('builtin'),
      user: skillsByScope('user'),
      project: skillsByScope('project'),
      compat: skillsByScope('compat'),
    },
    mcp: {
      user: mcp.servers
        .filter((s) => s.scope === 'user')
        .map((s) => ({ name: s.name, enabled: s.enabled !== false })),
      project: mcp.servers
        .filter((s) => s.scope === 'project')
        .map((s) => ({ name: s.name, enabled: s.enabled !== false })),
      projectTrusted,
      projectConfigExists: existsSync(projectMcpPath),
    },
    hooks: {
      global: {
        path: globalHooks,
        active: true,
        files: listJsonFiles(globalHooks),
      },
      project: {
        path: projectHooks,
        active: projectTrusted,
        files: listJsonFiles(projectHooks),
      },
    },
    plugins: pluginStates,
    agentsMd: findAgentsMd(cwd),
  };
}

function listJsonFiles(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort();
  } catch {
    return [];
  }
}

function findAgentsMd(cwd: string): string[] {
  const candidates = [
    path.join(cwd, 'AGENTS.md'),
    path.join(cwd, '.zelari', 'AGENTS.md'),
  ];
  const found: string[] = [];
  for (const c of candidates) {
    if (existsSync(c)) {
      try {
        const text = readFileSync(c, 'utf8');
        found.push(`${c} (${text.length} bytes)`);
      } catch {
        found.push(`${c} (unreadable)`);
      }
    }
  }
  return found;
}

function formatHuman(r: InspectReport): string {
  const lines: string[] = [
    `zelari-code inspect v${r.zelariVersion}`,
    `  cwd:      ${r.cwd}`,
    `  platform: ${r.platform}  node ${r.node}`,
    `  phase:    ${r.phase}  mode: ${r.mode}`,
    ``,
    `trust: ${r.trust.trusted ? 'TRUSTED ✔' : 'NOT TRUSTED ✖'}  (store: ${r.trust.store})`,
    ...r.trust.folders.map((f) => `  - ${f.path} (${f.trustedAt})`),
    ``,
    `skills: ${r.skills.total} total (builtin ${r.skills.builtin}, user ${r.skills.user}, project ${r.skills.project}, compat ${r.skills.compat})`,
    ``,
    `MCP:`,
    `  user:    ${r.mcp.user.length ? r.mcp.user.map((m) => m.name).join(', ') : '(none)'}`,
    `  project: ${r.mcp.projectConfigExists ? (r.mcp.projectTrusted ? r.mcp.project.map((m) => m.name).join(', ') || '(configured, no servers)' : 'IGNORED (folder not trusted)') : '(no .zelari/mcp.json)'}`,
    ``,
    `hooks:`,
    `  global:  ${r.hooks.global.active ? 'active' : 'inactive'} @ ${r.hooks.global.path} (${r.hooks.global.files.length} file(s))`,
    `  project: ${r.hooks.project.active ? 'active' : 'IGNORED (folder not trusted)'} @ ${r.hooks.project.path} (${r.hooks.project.files.length} file(s))`,
    ``,
    `plugins: ${r.plugins.length ? r.plugins.map((p) => `${p.id}${p.installed ? '' : ' (missing)'}`).join(', ') : '(none)'}`,
    ``,
    `AGENTS.md rules:`,
    ...(r.agentsMd.length ? r.agentsMd.map((a) => `  - ${a}`) : ['  (none)']),
  ];
  return lines.join('\n');
}

/** Run the inspect command. Prints to stdout; returns exit code (0). */
export async function runInspect(
  opts: { json?: boolean; cwd?: string } = {},
): Promise<number> {
  const report = await collectInspectReport(opts.cwd ?? process.cwd());
  if (opts.json) {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(report, null, 2));
  } else {
    // eslint-disable-next-line no-console
    console.log(formatHuman(report));
  }
  return 0;
}
