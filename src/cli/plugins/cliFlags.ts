/**
 * Non-interactive plugin status / install for Desktop + scripts.
 *
 *   zelari-code --plugins-status [--cwd <path>]
 *   zelari-code --plugins-install <id> [--cwd <path>]
 *
 * stdout is JSON only (Desktop parses it). stderr for human diagnostics.
 */

import { PLUGINS, findPlugin } from './registry.js';
import { installPlugin } from './installer.js';

function getArg(argv: readonly string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  if (i < 0) return undefined;
  return argv[i + 1];
}

function resolveCwd(argv: readonly string[]): string {
  return getArg(argv, '--cwd') ?? process.cwd();
}

export function wantsPluginsStatus(argv: readonly string[]): boolean {
  return argv.includes('--plugins-status');
}

export function wantsPluginsInstall(argv: readonly string[]): boolean {
  return argv.includes('--plugins-install');
}

export async function runPluginsStatus(argv: readonly string[]): Promise<number> {
  const cwd = resolveCwd(argv);
  const plugins = [];
  for (const spec of PLUGINS) {
    let present = false;
    try {
      present = await spec.detect(cwd);
    } catch {
      present = false;
    }
    plugins.push({
      id: spec.id,
      label: spec.label,
      present,
      description: spec.description,
      postInstallHint: spec.postInstallHint ?? null,
      npmPackage: spec.npmPackage,
      installScope: spec.installScope,
    });
  }
  process.stdout.write(JSON.stringify({ cwd, plugins }, null, 2) + '\n');
  return 0;
}

export async function runPluginsInstall(argv: readonly string[]): Promise<number> {
  const cwd = resolveCwd(argv);
  const id = getArg(argv, '--plugins-install');
  if (!id) {
    process.stderr.write(
      '[plugins] usage: zelari-code --plugins-install <id> [--cwd <path>]\n',
    );
    process.stdout.write(
      JSON.stringify({
        ok: false,
        id: '',
        message: 'missing plugin id',
      }) + '\n',
    );
    return 1;
  }
  const spec = findPlugin(id);
  if (!spec) {
    const msg = `unknown plugin id: ${id}. Available: ${PLUGINS.map((p) => p.id).join(', ')}`;
    process.stderr.write(`[plugins] ${msg}\n`);
    process.stdout.write(
      JSON.stringify({ ok: false, id, message: msg }) + '\n',
    );
    return 1;
  }

  process.stderr.write(
    `[plugins] installing ${spec.label} into ${cwd}…\n`,
  );
  const result = await installPlugin(spec, cwd);
  const payload = {
    ok: result.ok,
    id: spec.id,
    message: result.ok
      ? `Installed ${spec.label}`
      : result.error ?? `Install failed for ${spec.label}`,
    output: result.output?.slice(-4000),
    postInstallHint: spec.postInstallHint ?? null,
  };
  process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
  if (!result.ok) {
    process.stderr.write(`[plugins] ✗ ${payload.message}\n`);
    return 1;
  }
  process.stderr.write(`[plugins] ✓ ${payload.message}\n`);
  if (spec.postInstallHint) {
    process.stderr.write(`[plugins] → ${spec.postInstallHint}\n`);
  }
  return 0;
}
