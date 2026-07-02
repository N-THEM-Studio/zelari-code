#!/usr/bin/env node
/**
 * prepublish.mjs — single-entry pre-publish gate.
 *
 * Runs typecheck → build:cli → test in one Node process, so npm does NOT
 * need to spawn nested `npm run <script>` calls. On Windows + Git Bash,
 * nested `npm run` inside `cmd.exe` fails with "Shim target not found:
 * npm.cmd" because the npm shim resolution breaks.
 *
 * Instead of relying on bin shims (which are `.cmd` on Windows and can't
 * be spawned with shell:false), we call the JS entry points directly via
 * the current `node` executable. Fully cross-platform.
 *
 * Exit non-zero if any step fails (blocks `npm publish`).
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(__dirname, '..');

/** Resolve a module's JS entry file from node_modules. */
function resolveModuleFile(specifier, file) {
  // createRequire lets us resolve package main paths reliably.
  return path.resolve(pkgRoot, 'node_modules', specifier, file);
}

/** Run `node <file> <args>`, inherit stdio, throw on non-zero exit. */
function run(label, file, args) {
  if (!existsSync(file)) {
    throw new Error(`Entry not found: ${file}. Run \`npm install\` first.`);
  }
  console.log(`\n[prepublish] ${label}: ${path.relative(pkgRoot, file)} ${args.join(' ')}`);
  const result = spawnSync(process.execPath, [file, ...args], {
    cwd: pkgRoot,
    stdio: 'inherit',
    shell: false,
  });
  if (result.status !== 0) {
    console.error(`\n[prepublish] ✗ ${label} failed (exit ${result.status})`);
    process.exit(result.status ?? 1);
  }
  console.log(`[prepublish] ✓ ${label} ok`);
}

// 0. Build @zelari/core FIRST.
// The root typecheck resolves `@zelari/core/*` subpaths to the emitted
// .d.ts files under packages/core/dist/ (via tsconfig `paths`). On a
// clean tree (or after `npm run clean`) dist/ is absent, so tsc fails
// with TS2307 on every core import — and the unresolved types cascade
// into TS7006 "implicitly any" errors across the CLI. Mirrors the CI
// workflow (.github/workflows/publish.yml publish-cli job), which builds
// core before typecheck for the same reason. Locally `pretest` masks
// this, but `prepublishOnly` bypasses `pretest`.
run(
  'build:core',
  resolveModuleFile('typescript', 'bin/tsc'),
  ['-p', 'packages/core/tsconfig.json'],
);

// 1. Typecheck (tsc --noEmit)
run(
  'typecheck',
  resolveModuleFile('typescript', 'bin/tsc'),
  ['--noEmit', '-p', 'tsconfig.json'],
);

// 2. Build: tsc emit + esbuild bundle
run(
  'build:cli (tsc)',
  resolveModuleFile('typescript', 'bin/tsc'),
  ['-p', 'tsconfig.json'],
);
run('build:cli (bundle)', path.join(pkgRoot, 'scripts', 'bundle-cli.mjs'), []);

// 3. Tests
run(
  'test',
  resolveModuleFile('vitest', 'vitest.mjs'),
  ['run'],
);

console.log('\n[prepublish] ✓ All checks passed. Ready to publish.');
