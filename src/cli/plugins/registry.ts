/**
 * plugins/registry — catalog of optional tool plugins zelari-code can offer
 * to install when missing.
 *
 * A "plugin" here is an OPTIONAL dependency of an edge feature: Playwright
 * powers `browser_check`, typescript-language-server / pyright power the LSP
 * navigation tools, eslint / ruff power the post-edit diagnostics loop. None
 * are required to boot — every one of these features degrades silently when
 * its binary is absent (see browser/driver.ts, lsp/manager.ts,
 * diagnostics/engine.ts). The plugin manager is a DISCOVERY layer on top: it
 * detects absence and offers to install, without changing how the tools
 * register or degrade.
 *
 * The binary names are NOT redeclared here — they're sourced from the
 * existing registries the features already use, so a single source of truth
 * is preserved:
 *   - DEFAULT_PROVIDERS (diagnostics/engine.ts) → eslint, ruff
 *   - LSP_SERVERS (lsp/servers.ts)              → typescript-language-server,
 *                                                 pyright-langserver
 *   - loadPlaywright (browser/driver)           → playwright
 *
 * Detection mirrors how each feature actually resolves its binary:
 *   - project-local linters (eslint/ruff) → resolveBin() walk of node_modules/.bin
 *   - LSP servers                          → resolveBin local, then PATH file
 *     existence (NOT `<bin> --version` — language servers like
 *     pyright-langserver reject --version and exit non-zero, so a version
 *     probe falsely reported them as missing forever)
 *   - Playwright                           → loadPlaywright(cwd): project
 *     node_modules first, then bare import (same as browser_check)
 *
 * Contract: detect() is async, never throws, returns Promise<boolean>. The
 * caller (PluginGate / doctor / /plugins) treats false as "missing, offer to
 * install" and true as "present, leave alone."
 *
 * @see scripts/postinstall.mjs — required install-time deps (this file is
 *      the OPTIONAL complement: tools we recommend but don't mandate)
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { resolveBin } from '../diagnostics/engine.js';
import { loadPlaywright } from '../browser/driver.js';
import { DEFAULT_PROVIDERS } from '../diagnostics/engine.js';
import { LSP_SERVERS } from '../lsp/servers.js';
import { isMuted } from './prefs.js';

/** How a plugin is installed. Mirrors npm conventions. */
export type InstallScope = 'dev' | 'global';

export interface PluginSpec {
  /** Stable id persisted to plugins.json (never rename without migration). */
  id: string;
  /** Human label shown in prompts + doctor output. */
  label: string;
  /** npm package name passed to `npm install`. */
  npmPackage: string;
  /** `-D` (project-local) or `-g` (global). Linters + playwright are project
   * deps (that's how the features resolve them via node_modules/.bin); LSP
   * servers are cross-project dev tools, conventionally global. */
  installScope: InstallScope;
  /** Async presence check. Returns true if installed, false if missing.
   * Never throws. */
  detect: (cwd: string) => Promise<boolean>;
  /** Optional post-install instruction (e.g. Playwright needs a second
   * `npx playwright install chromium` to fetch browser binaries). */
  postInstallHint?: string;
  /** Env-var kill-switch. If the user has set ZELARI_BROWSER=0 etc., the
   * feature is disabled and prompting to install its tool would be noise. */
  featureGate: string;
  /** One-line description of what the plugin enables. */
  description: string;
}

// ---------------------------------------------------------------------------
// Detection primitives — wrap the existing resolution mechanisms.
// ---------------------------------------------------------------------------

/**
 * Detect a project-local binary (eslint, ruff). resolveBin walks up to 6
 * parent dirs looking for `node_modules/.bin/<bin>`; on miss it returns the
 * bare name, which we treat as "not found locally". This matches how
 * diagnostics/engine.ts actually resolves the linter at call time.
 */
function detectLocalBin(bin: string): (cwd: string) => Promise<boolean> {
  return (cwd: string) => {
    try {
      const resolved = resolveBin(bin, cwd);
      // resolveBin returns the bare name when nothing is found.
      return Promise.resolve(resolved !== bin);
    } catch {
      return Promise.resolve(false);
    }
  };
}

export interface IsBinaryOnPathOptions {
  /** Override PATH (tests). Defaults to process.env.PATH. */
  pathEnv?: string;
  /** Override PATHEXT on win32 (tests). Defaults to process.env.PATHEXT. */
  pathExt?: string;
  /** Override platform (tests). Defaults to process.platform. */
  platform?: NodeJS.Platform;
  /** Override existsSync (tests). */
  exists?: (p: string) => boolean;
}

/**
 * True when `bin` (a bare command name) resolves to a file on PATH.
 *
 * Used instead of `<bin> --version` because several language-server binaries
 * (notably `pyright-langserver`) ignore/reject `--version`, exit non-zero with
 * empty stdout, and would be reported as "missing" forever even when installed.
 * Runtime spawn uses the same PATH; existence is the right presence signal.
 *
 * Never throws. Rejects path-like names (contain `/` or `\`) to avoid treating
 * a full path as a PATH search.
 */
export function isBinaryOnPath(
  bin: string,
  opts: IsBinaryOnPathOptions = {},
): boolean {
  if (!bin || bin.includes('/') || bin.includes('\\') || bin.includes('..')) {
    return false;
  }
  const platform = opts.platform ?? process.platform;
  const exists = opts.exists ?? existsSync;
  const pathEnv = opts.pathEnv ?? process.env.PATH ?? '';
  // Use the path dialect of the TARGET platform (not the host). Otherwise a
  // platform:'linux' probe on Windows would path.join with win32 rules and
  // never match posix PATH entries (and vice versa).
  const pathMod = platform === 'win32' ? path.win32 : path.posix;
  const sep = platform === 'win32' ? ';' : ':';
  const dirs = pathEnv.split(sep).filter((d) => d.length > 0);

  const candidates: string[] = [bin];
  if (platform === 'win32') {
    const pathExt = opts.pathExt ?? process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM';
    for (const ext of pathExt.split(';')) {
      if (!ext) continue;
      candidates.push(bin + ext);
      // PATHEXT is usually uppercase; shims on disk are often lowercase (.cmd).
      const lower = ext.toLowerCase();
      if (lower !== ext) candidates.push(bin + lower);
    }
  }

  for (const dir of dirs) {
    for (const name of candidates) {
      try {
        if (exists(pathMod.join(dir, name))) return true;
      } catch {
        // ignore per-candidate fs errors
      }
    }
  }
  return false;
}

/**
 * Detect an LSP (or other global) binary the same way runtime does:
 *   1. project-local `node_modules/.bin` via resolveBin
 *   2. bare name present on PATH (file existence, not --version)
 */
function detectPathBin(bin: string): (cwd: string) => Promise<boolean> {
  return (cwd: string) => {
    try {
      if (resolveBin(bin, cwd) !== bin) return Promise.resolve(true);
    } catch {
      // fall through to PATH
    }
    return Promise.resolve(isBinaryOnPath(bin));
  };
}

/** Detect Playwright via the exact loader browser_check uses (cwd-aware). */
async function detectPlaywright(cwd: string): Promise<boolean> {
  try {
    const mod = await loadPlaywright(cwd);
    return mod !== null;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Plugin catalog.
//
// IDs are stable forever (persisted to plugins.json). Derived from the feature
// registries so the binary names stay in lockstep — if diagnostics/engine.ts
// renames `eslint` to something else, this catalog follows automatically.
// ---------------------------------------------------------------------------

/** The canonical plugin list. Order = display order in prompts + doctor. */
export const PLUGINS: readonly PluginSpec[] = [
  {
    id: 'eslint',
    label: 'ESLint (diagnostics for JS/TS)',
    npmPackage: 'eslint',
    installScope: 'dev',
    detect: detectLocalBin(binForProvider('eslint')),
    featureGate: 'ZELARI_DIAGNOSTICS',
    description: 'Enables the post-edit diagnostics loop for .js/.jsx/.ts/.tsx/.mjs/.cjs files.',
  },
  {
    id: 'ruff',
    label: 'Ruff (diagnostics for Python)',
    npmPackage: 'ruff',
    installScope: 'dev',
    detect: detectLocalBin(binForProvider('ruff')),
    featureGate: 'ZELARI_DIAGNOSTICS',
    description: 'Enables the post-edit diagnostics loop for .py files.',
  },
  {
    id: 'playwright',
    label: 'Playwright (browser_check tool)',
    npmPackage: 'playwright',
    installScope: 'dev',
    detect: detectPlaywright,
    postInstallHint: 'Then fetch the browser binary: `npx playwright install chromium`',
    featureGate: 'ZELARI_BROWSER',
    description: 'Powers the browser_check tool (URL probing, click/fill/wait, screenshots).',
  },
  {
    id: 'typescript-language-server',
    label: 'typescript-language-server (LSP for TS/JS)',
    npmPackage: 'typescript-language-server',
    installScope: 'global',
    detect: detectPathBin(binForLspLanguage('typescript')),
    featureGate: 'ZELARI_LSP',
    description: 'Powers go_to_definition / find_references / hover_type / rename_symbol for TS/JS.',
  },
  {
    id: 'pyright',
    label: 'pyright (LSP for Python)',
    npmPackage: 'pyright',
    installScope: 'global',
    // Detect the langserver binary runtime spawns (pyright-langserver), not
    // the `pyright` CLI — and never via --version (langserver rejects it).
    detect: detectPathBin(binForLspLanguage('python')),
    featureGate: 'ZELARI_LSP',
    description: 'Powers go_to_definition / find_references / hover_type / rename_symbol for Python.',
  },
  {
    // fff — high-performance codebase search MCP (fffind / ffgrep).
    // Installed as a global CLI; wire it in ~/.zelari-code/mcp.json (see
    // postInstallHint). Kill-switch: ZELARI_FFF=0.
    id: 'fff',
    label: 'fff (fast codebase search MCP)',
    npmPackage: 'fff-mcp',
    installScope: 'global',
    detect: detectPathBin('fff-mcp'),
    postInstallHint:
      'Add to ~/.zelari-code/mcp.json: {"mcpServers":{"fff":{"command":"fff-mcp","args":[]}}} then restart. Prefer mcp_fff_* tools for search.',
    featureGate: 'ZELARI_FFF',
    description:
      'Accelerates codebase search via fff MCP (fffind, ffgrep, fff-multi-grep) — faster and more token-efficient than plain grep.',
  },
];

// ---------------------------------------------------------------------------
// Small adapters so the catalog above derives binary names from the existing
// registries rather than hardcoding them (single source of truth).
// ---------------------------------------------------------------------------

/** Look up a diagnostic provider's binary name by provider name. */
function binForProvider(name: string): string {
  const p = DEFAULT_PROVIDERS.find((x) => x.name === name);
  if (!p) throw new Error(`plugin registry: unknown diagnostic provider '${name}'`);
  return p.bin;
}

/** Look up an LSP server's binary name by language. */
function binForLspLanguage(language: string): string {
  const s = LSP_SERVERS.find((x) => x.language === language);
  if (!s) throw new Error(`plugin registry: unknown LSP language '${language}'`);
  return s.bin;
}

// ---------------------------------------------------------------------------
// Aggregating detector — what the gate / doctor / /plugins call.
// ---------------------------------------------------------------------------

/**
 * Detect all plugins that are MISSING, in display order, after applying the
 * two filters that suppress noise:
 *   1. featureGate — if ZELARI_BROWSER=0 etc., the feature is off, so don't
 *      prompt to install the tool it needs.
 *   2. dontAskAgain — if the user dismissed this plugin before, respect it.
 *      (The `/plugins` command passes `includeMuted: true` to re-surface them.)
 *
 * Never throws. A detect() that rejects is treated as "missing".
 */
export async function detectMissingPlugins(
  cwd: string,
  opts: { includeMuted?: boolean } = {},
): Promise<PluginSpec[]> {
  const missing: PluginSpec[] = [];
  for (const spec of PLUGINS) {
    // Filter 1: kill-switch. If the feature is disabled, don't offer its tool.
    if (process.env[spec.featureGate] === '0') continue;
    // Filter 2: user-muted (unless explicitly re-surfaced via /plugins).
    if (!opts.includeMuted && isMuted(spec.id)) continue;
    let present = false;
    try {
      present = await spec.detect(cwd);
    } catch {
      present = false;
    }
    if (!present) missing.push(spec);
  }
  return missing;
}

/** Look up a plugin by id (for `/plugins install <id>`). */
export function findPlugin(id: string): PluginSpec | undefined {
  return PLUGINS.find((p) => p.id === id);
}
