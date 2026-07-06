#!/usr/bin/env node
/**
 * bundle-cli.mjs — Bundle the Zelari Code CLI entrypoint (including .tsx
 * files) into a single ESM file using esbuild.
 *
 * tsc emits .ts → .js but NOT .tsx. The CLI uses Ink (React) so app.tsx
 * needs bundling. esbuild handles .tsx natively and produces a self-contained
 * file that `bin/zelari-code.js` can import.
 *
 * Output: dist/cli/main.bundled.js
 * The bin wrapper prefers `main.bundled.js` if present (faster startup, no
 * dynamic resolution of dozens of relative imports).
 */

import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(__dirname, '..');

const entry = path.join(pkgRoot, 'src', 'cli', 'main.ts');
const outfile = path.join(pkgRoot, 'dist', 'cli', 'main.bundled.js');

await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  sourcemap: true,
  // Externalize React + Ink ecosystem (must be installed alongside the CLI)
  external: [
    'react',
    'react-dom',
    'react/jsx-runtime',
    'react/jsx-dev-runtime',
    'ink',
    'ink-text-input',
    // Misc
    'react-devtools-core',
    'ws',
    // AST engine loads the TypeScript compiler API lazily at runtime from
    // node_modules — keep it OUT of the bundle (it is ~7MB) so startup and
    // bundle size stay lean.
    'typescript',
  ],
  // Use tsconfig from package root
  tsconfig: path.join(pkgRoot, 'tsconfig.json'),
  // Banner for ESM Node compatibility
  banner: {
    js: "import { createRequire as __crq } from 'node:module'; const require = __crq(import.meta.url);",
  },
  logLevel: 'info',
});

console.log(`[bundle-cli] bundled → ${path.relative(pkgRoot, outfile)}`);