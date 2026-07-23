#!/usr/bin/env node
/**
 * zelari-code — npm bin entrypoint.
 *
 * Spawned by npm when running `zelari-code` from anywhere after
 * `npm install -g zelari-code`. Resolves to the compiled CLI bundle
 * (tsc + esbuild output) OR falls back to tsx (dev/source workflow).
 *
 * Strategy:
 *   1. If `dist/cli/main.bundled.js` exists (production build), require it.
 *   2. Otherwise (dev/source install), use tsx to run the TS source directly.
 *
 * This means `npm install -g .` from a clone works (dev install), AND
 * `npm install -g zelari-code` from the registry works (production).
 */

import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Helper: convert Windows absolute path to file:// URL for dynamic import()
const toImportURL = (p) => pathToFileURL(p).href;

// Resolve the package root (this file lives at <pkg>/bin/zelari-code.js)
const pkgRoot = path.resolve(__dirname, '..');

const compiledBundled = path.join(pkgRoot, 'dist', 'cli', 'main.bundled.js');
const compiledMain = path.join(pkgRoot, 'dist', 'cli', 'main.js');
const compiledApp = path.join(pkgRoot, 'dist', 'cli', 'app.js');
const tsSource = path.join(pkgRoot, 'src', 'cli', 'main.ts');

/**
 * Prefer TypeScript source only when explicitly requested.
 *
 * Do NOT key off ANATHEMA_DEV: Desktop always sets ANATHEMA_DEV=1 on CLI
 * spawns (to skip background update checks). Forcing tsx there breaks
 * get_app_config / --print-config at startup with "Failed to load provider
 * config" when tsx is unavailable or cwd/node resolution differs.
 *
 * Stale-bundle risk (new flags missing) is handled by `desktop:dev` running
 * `build:cli` first. Override with ZELARI_CLI_SOURCE=1 for pure source runs.
 */
function preferSourceOverDist() {
  return (
    process.env.ZELARI_CLI_SOURCE === '1' ||
    process.env.ZELARI_CLI_SOURCE === 'true'
  );
}

async function loadFromSource() {
  try {
    require('tsx/esm/api');
    await import(toImportURL(tsSource));
  } catch (err) {
    // Fall back to dist if present — better than hard-fail for Desktop.
    if (existsSync(compiledBundled)) {
      console.error(
        '[zelari-code] tsx source load failed; falling back to dist bundle.\n' +
          (err instanceof Error ? err.message : String(err)),
      );
      await import(toImportURL(compiledBundled));
      return;
    }
    console.error(
      '[zelari-code] Failed to load TypeScript source via tsx.\n' +
        'Run `npm run build:cli` to use dist, or install tsx.\n' +
        (err instanceof Error ? err.message : String(err)),
    );
    process.exit(1);
  }
}

if (preferSourceOverDist() && existsSync(tsSource)) {
  await loadFromSource();
} else if (existsSync(compiledBundled)) {
  // Production / Desktop path: esbuild-bundled self-contained ESM
  await import(toImportURL(compiledBundled));
} else if (existsSync(compiledMain) && existsSync(compiledApp)) {
  // Production path (legacy): tsc-only emit
  await import(toImportURL(compiledMain));
} else if (existsSync(tsSource)) {
  await loadFromSource();
} else {
  console.error(
    '[zelari-code] Cannot locate CLI entrypoint.\n' +
      `Looked for: ${compiledBundled}\n` +
      `Looked for: ${compiledMain}\n` +
      `Looked for: ${tsSource}\n` +
      'Reinstall the package or report an issue.',
  );
  process.exit(1);
}