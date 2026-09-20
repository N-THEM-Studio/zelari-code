/**
 * plugins/bundleCommand — `zelari-code plugin <subcommand>` (WS6).
 *
 * ```
 * zelari-code plugin validate <dir>      exit 0/1, readable errors
 * zelari-code plugin list [dir…]         bundles found + enabled/disabled
 * zelari-code plugin enable <dir|name>   persist enabled=true
 * zelari-code plugin disable <dir|name>  persist enabled=false
 * ```
 *
 * `--cwd <path>` selects the project whose `.zelari/plugins.json` is read and
 * written (default: the current directory); `--help` prints usage.
 *
 * Host discipline mirrors `acp` and `skills:check`: NO Ink, NO preflight, no
 * interactive prompt — stdout carries the report, stderr the diagnostics, and
 * the exit code is the verdict. The subcommand never `process.exit`s: it
 * RETURNS the code so main.ts owns process teardown (and tests can assert it).
 *
 * Enablement is one-directional in its strictness: `enable` VALIDATES the
 * bundle first (you cannot switch on something broken), while `disable` reads
 * only the manifest's NAME. A bundle whose declared FILES are broken can thus
 * always be switched off. (If even the manifest is unparseable, `disable <dir>`
 * fails, but the name `list` shows for that directory still works.)
 *
 * Text output avoids U+2713 / U+2717 ("OK" / "FAILED" instead): they raise
 * UnicodeEncodeError on Windows consoles (see mcp/mcpPresets.ts). The em dash
 * is fine — acpHelpText() uses one too.
 *
 * @since v2.58.0 (WS6 / plugin bundle v1)
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { BUNDLE_MANIFEST_FILE, parseBundleManifest } from './bundleManifest.js';
import { readBundle, type LoadedBundle } from './bundleLoad.js';
import { isDir } from './bundleFs.js';
import { defaultBundleRoots, discoverBundles } from './bundleDiscover.js';
import {
  bundleStatePath,
  isBundleEnabled,
  readBundleState,
  setBundleEnabled,
} from './bundleState.js';

// Re-exported so callers (and the CLI tests) have one import surface for the
// command's building blocks.
export { defaultBundleRoots, discoverBundles };

export interface PluginCommandOptions {
  help?: boolean;
  cwd?: string;
}

/** Parse `plugin` flags. Never throws; unknown flags are ignored (acp parity). */
export function parsePluginFlags(argv: readonly string[]): PluginCommandOptions {
  const out: PluginCommandOptions = {};
  if (argv.includes('--help') || argv.includes('-h')) out.help = true;
  const i = argv.indexOf('--cwd');
  const cwd = i >= 0 ? argv[i + 1] : undefined;
  if (cwd !== undefined && cwd.trim() !== '' && !cwd.startsWith('--')) out.cwd = cwd;
  return out;
}

export function pluginHelpText(): string {
  return (
    'zelari-code plugin — plugin bundles (format v1)\n' +
    '\n' +
    'A bundle is a directory with a zelari-plugin.json manifest declaring\n' +
    'skills, hooks, MCP servers and agents. Validation is static: nothing is\n' +
    'installed, executed or fetched. Bundles are DISABLED until enabled, and\n' +
    'enablement lives in the project file .zelari/plugins.json.\n' +
    '\n' +
    'Usage:\n' +
    '  zelari-code plugin validate <dir>       Validate one bundle (exit 0/1)\n' +
    '  zelari-code plugin list [dir...]        List discovered bundles + state\n' +
    '  zelari-code plugin enable <dir|name>    Enable a bundle (validates first)\n' +
    '  zelari-code plugin disable <dir|name>   Disable a bundle (always allowed)\n' +
    '\n' +
    'Options:\n' +
    '  --cwd <path>       Project root holding .zelari/plugins.json\n' +
    '                     (default: current directory)\n' +
    '  --help, -h         This text\n' +
    '\n' +
    '`list` scans <projectRoot>/examples/extensions plus every directory\n' +
    'recorded in "paths" of .zelari/plugins.json, then any extra dirs given.\n'
  );
}

/** Resolve `<dir|name>` to a bundle name, without validating the whole bundle. */
async function resolveBundleName(
  target: string,
  projectRoot: string,
  roots: readonly string[],
): Promise<{ name: string; dir?: string } | { error: string }> {
  const asDir = path.resolve(projectRoot, target);
  if (await isDir(asDir)) {
    const manifestPath = path.join(asDir, BUNDLE_MANIFEST_FILE);
    let raw: string;
    try {
      raw = await readFile(manifestPath, 'utf8');
    } catch {
      return { error: `${manifestPath}: bundle manifest not found` };
    }
    const parsed = parseBundleManifest(raw, manifestPath);
    if (!parsed.manifest) return { error: parsed.errors[0] ?? `${manifestPath}: invalid manifest` };
    return { name: parsed.manifest.name, dir: asDir };
  }
  const found = (await discoverBundles(roots)).find((b) => b.name === target);
  if (!found) {
    return { error: `no bundle named '${target}' found in: ${roots.join(', ')}` };
  }
  return { name: found.name, dir: found.dir };
}

function reportBundle(bundle: LoadedBundle, enabled: boolean): string[] {
  const list = (items: readonly string[]): string => (items.length > 0 ? ` (${items.join(', ')})` : '');
  return [
    `  manifest: ${bundle.manifestPath}`,
    `  bundle:   ${bundle.name} v${bundle.version}`,
    `  skills:   ${bundle.skills.length}${list(bundle.skills.map((s) => s.id))}`,
    `  hooks:    ${bundle.hooks.length}${list(bundle.hooks.map((h) => `${h.event}${h.observer ? ', observer' : ''}`))}`,
    `  mcp:      ${bundle.mcp.length}${list(bundle.mcp.map((m) => `${m.name}, ${m.source}`))}`,
    `  agents:   ${bundle.agents.length}`,
    `  state:    ${enabled ? 'enabled' : 'disabled'}`,
  ];
}

/** `plugin validate <dir>` — static validation only. Exit 0/1. */
export async function runPluginValidate(dir: string, projectRoot: string): Promise<number> {
  process.stdout.write(`zelari-code plugin validate — ${dir}\n`);
  const result = await readBundle(dir);
  for (const warning of result.warnings) process.stderr.write(`  warning: ${warning}\n`);
  if (!result.bundle) {
    process.stderr.write(`  FAILED: ${result.errors.length} problem(s)\n`);
    for (const error of result.errors) process.stderr.write(`  error: ${error}\n`);
    return 1;
  }
  const state = await readBundleState(projectRoot);
  for (const error of state.errors) process.stderr.write(`  warning: ${error}\n`);
  for (const line of reportBundle(result.bundle, isBundleEnabled(state.state, result.bundle.name))) {
    process.stdout.write(`${line}\n`);
  }
  process.stdout.write('  OK: valid bundle\n');
  return 0;
}

/** `plugin list [dir...]` — discovery + state. Exit 0. */
export async function runPluginList(
  extraDirs: readonly string[],
  projectRoot: string,
): Promise<number> {
  const read = await readBundleState(projectRoot);
  for (const error of read.errors) process.stderr.write(`[plugin] warning: ${error}\n`);
  const roots = [
    ...defaultBundleRoots(projectRoot, read.state),
    ...extraDirs.map((d) => path.resolve(projectRoot, d)),
  ];
  const found = await discoverBundles(roots);
  process.stdout.write(`zelari-code plugin list — project ${projectRoot}\n`);
  process.stdout.write(`  state file: ${bundleStatePath(projectRoot)}\n`);
  for (const root of roots) process.stdout.write(`  scanning:   ${root}\n`);
  if (found.length === 0) {
    process.stdout.write('  no bundles found\n');
    return 0;
  }
  for (const bundle of found) {
    const state = isBundleEnabled(read.state, bundle.name) ? 'enabled' : 'disabled';
    const verdict = bundle.ok ? 'valid' : 'INVALID';
    process.stdout.write(
      `  ${state.padEnd(8)} ${verdict.padEnd(7)} ${bundle.name}${
        bundle.version ? ` v${bundle.version}` : ''
      } — ${bundle.dir}\n`,
    );
    for (const error of bundle.errors) process.stderr.write(`      error: ${error}\n`);
  }
  return 0;
}

/** `plugin enable|disable <dir|name>`. Exit 0/1. */
export async function runPluginSetEnabled(
  target: string,
  enabled: boolean,
  projectRoot: string,
): Promise<number> {
  const read = await readBundleState(projectRoot);
  for (const error of read.errors) process.stderr.write(`[plugin] warning: ${error}\n`);
  const roots = defaultBundleRoots(projectRoot, read.state);
  const resolved = await resolveBundleName(target, projectRoot, roots);
  if ('error' in resolved) {
    process.stderr.write(`[plugin] ${resolved.error}\n`);
    return 1;
  }
  if (enabled && resolved.dir) {
    // Enabling validates: a bundle that does not load must not be switchable on.
    const check = await readBundle(resolved.dir);
    if (!check.bundle) {
      process.stderr.write(`[plugin] refusing to enable '${resolved.name}' — bundle is invalid:\n`);
      for (const error of check.errors) process.stderr.write(`[plugin]   ${error}\n`);
      return 1;
    }
  }
  const written = await setBundleEnabled({
    projectRoot,
    name: resolved.name,
    enabled,
    ...(resolved.dir ? { dir: resolved.dir } : {}),
  });
  if (!written.ok) {
    process.stderr.write(`[plugin] ${written.error}\n`);
    return 1;
  }
  process.stdout.write(`  ${enabled ? 'enabled' : 'disabled'} ${resolved.name} in ${written.path}\n`);
  return 0;
}

/**
 * Entry point for `zelari-code plugin …`. Accepts argv WITH or WITHOUT the
 * leading `plugin` token. Never throws; the exit code is the return value.
 */
export async function runPluginCommand(argv: readonly string[]): Promise<number> {
  try {
    const args = argv[0] === 'plugin' ? argv.slice(1) : [...argv];
    const opts = parsePluginFlags(args);
    const projectRoot = path.resolve(opts.cwd ?? process.cwd());
    // Positional args, minus the value consumed by `--cwd`.
    const positional = args.filter((a, i) => !a.startsWith('-') && args[i - 1] !== '--cwd');
    const [subcommand, ...rest] = positional;
    if (opts.help === true || subcommand === undefined) {
      process.stdout.write(pluginHelpText());
      return opts.help === true ? 0 : 1;
    }
    switch (subcommand) {
      case 'validate': {
        const dir = rest[0];
        if (!dir) {
          process.stderr.write('[plugin] usage: zelari-code plugin validate <dir>\n');
          return 1;
        }
        return await runPluginValidate(dir, projectRoot);
      }
      case 'list':
        return await runPluginList(rest, projectRoot);
      case 'enable':
      case 'disable': {
        const target = rest[0];
        if (!target) {
          process.stderr.write(`[plugin] usage: zelari-code plugin ${subcommand} <dir|name>\n`);
          return 1;
        }
        return await runPluginSetEnabled(target, subcommand === 'enable', projectRoot);
      }
      default:
        process.stderr.write(`[plugin] unknown subcommand '${subcommand}'\n\n`);
        process.stdout.write(pluginHelpText());
        return 1;
    }
  } catch (err) {
    process.stderr.write(`[zelari-code plugin] ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}
