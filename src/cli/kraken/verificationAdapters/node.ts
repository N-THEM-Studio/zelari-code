/**
 * verificationAdapters/node — package.json ecosystems (t19 §P1.A).
 *
 * Generalizes the F2 npm-only binding to every mainstream JS package
 * manager. Resolution order:
 *   1. `packageManager` field (corepack manifest — explicit intent wins;
 *      e.g. "pnpm@9.1.0+sha512…" → pnpm; unrecognized names fall through);
 *   2. first existing lockfile: pnpm-lock.yaml → pnpm, yarn.lock → yarn,
 *      bun.lockb / bun.lock → bun, package-lock.json → npm;
 *   3. default npm.
 *
 * Repo-adaptive binding preserved EXACTLY from F2: `<pm> run <script>` is
 * bound only when package.json declares that script. A missing script →
 * null → the criterion is dropped downstream (a required-but-unrunnable
 * command would be a permanently-unknown blocker). Env overrides are applied
 * later, centrally — see nativeVerification.applyEnvOverridesToPlan.
 */
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { NativePackCommands, VerificationAdapter } from './types.js';

type PackageJsonLike = { scripts?: unknown; packageManager?: unknown };

/** Tiny fs helpers stay LOCAL per adapter (shared utils would couple sibling adapters). */
async function fileExists(candidate: string): Promise<boolean> {
  try {
    return (await stat(candidate)).isFile();
  } catch {
    return false;
  }
}

/** Parsed package.json or null (absent / unreadable / invalid JSON). */
async function readPackageJson(root: string): Promise<PackageJsonLike | null> {
  try {
    return JSON.parse(await readFile(path.join(root, 'package.json'), 'utf-8')) as PackageJsonLike;
  } catch {
    return null;
  }
}

/** Lockfile marker → package manager, checked in priority order. */
const PM_LOCKFILES: ReadonlyArray<readonly [marker: string, pm: string]> = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lockb', 'bun'],
  ['bun.lock', 'bun'],
  ['package-lock.json', 'npm'],
];

const KNOWN_PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);

/** corepack-style value ("pnpm@9.1.0+sha512…") → bare manager name, or null. */
function packageManagerFromField(pkg: PackageJsonLike | null): string | null {
  if (!pkg || typeof pkg.packageManager !== 'string') return null;
  const name = pkg.packageManager.split('@')[0]?.trim().toLowerCase() ?? '';
  return KNOWN_PACKAGE_MANAGERS.has(name) ? name : null;
}

async function resolvePackageManager(
  root: string,
): Promise<{ pm: string; declaredToolchain: boolean }> {
  const fromField = packageManagerFromField(await readPackageJson(root));
  if (fromField) return { pm: fromField, declaredToolchain: true };
  for (const [marker, pm] of PM_LOCKFILES) {
    if (await fileExists(path.join(root, marker))) return { pm, declaredToolchain: true };
  }
  // Default per F2 behavior: npm even with no lockfile at all.
  return { pm: 'npm', declaredToolchain: false };
}

function scriptBound(scripts: unknown, scriptName: string, pm: string): string | null {
  if (typeof scripts !== 'object' || scripts === null) return null;
  const entry = (scripts as Record<string, unknown>)[scriptName];
  return typeof entry === 'string' && entry.length > 0 ? `${pm} run ${scriptName}` : null;
}

export const nodeAdapter: VerificationAdapter = {
  async detect(root: string): Promise<number> {
    if (!(await fileExists(path.join(root, 'package.json')))) return 0;
    // A plain package.json alone is weaker evidence than a declared toolchain
    // (field or lockfile): 10 vs 20.
    const { declaredToolchain } = await resolvePackageManager(root);
    return declaredToolchain ? 20 : 10;
  },

  async buildPlan(root: string): Promise<NativePackCommands> {
    const { pm } = await resolvePackageManager(root);
    const pkg = await readPackageJson(root);
    return {
      typecheckCommand: scriptBound(pkg?.scripts, 'typecheck', pm),
      testCommand: scriptBound(pkg?.scripts, 'test', pm),
      buildCommand: scriptBound(pkg?.scripts, 'build', pm),
    };
  },
};
