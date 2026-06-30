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
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Resolve the package root (this file lives at <pkg>/bin/zelari-code.js)
const pkgRoot = path.resolve(__dirname, '..');

const compiledBundled = path.join(pkgRoot, 'dist', 'cli', 'main.bundled.js');
const compiledMain = path.join(pkgRoot, 'dist', 'cli', 'main.js');
const compiledApp = path.join(pkgRoot, 'dist', 'cli', 'app.js');
const tsSource = path.join(pkgRoot, 'src', 'cli', 'main.ts');

if (existsSync(compiledBundled)) {
  // Production path: esbuild-bundled self-contained ESM (includes .tsx)
  await import(compiledBundled);
} else if (existsSync(compiledMain) && existsSync(compiledApp)) {
  // Production path (legacy): tsc-only emit (only .ts, requires .tsx to be absent)
  await import(compiledMain);
} else if (existsSync(tsSource)) {
  // Dev/source install path: use tsx
  try {
    require('tsx/esm/api');
    await import(tsSource);
  } catch {
    console.error(
      '[zelari-code] Neither compiled dist nor tsx runtime found.\n' +
        'Production install: run `npm run build:cli` before installing (requires esbuild + tsx).\n' +
        'Source install: install `tsx` (npm i -g tsx) and run from source.',
    );
    process.exit(1);
  }
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