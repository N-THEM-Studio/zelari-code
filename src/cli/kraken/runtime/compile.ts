/**
 * Kraken script runtime — esbuild bundling (CLI side).
 *
 * esbuild is a devDep of the CLI; it is not available in `@zelari/core` at
 * runtime. Bundling therefore lives here, not in the core package. The
 * core package provides the SDK stub (`packages/core/src/kraken/runtime/sdk.ts`)
 * and the sandbox; this file uses esbuild to resolve
 * `@zelari/kraken-runtime` imports in user plans to the SDK stub, then
 * emits a single IIFE bundle the sandbox can load.
 *
 * The bundling is **deliberately minimal**:
 *   - No tree-shaking beyond esbuild's default (small plans, doesn't matter).
 *   - No source maps in production (the plan is ephemeral).
 *   - No minification (the bundle runs in a vm, not in a browser).
 *   - `format: 'esm'` with `target: 'es2022'` so top-level await works
 *     (esbuild's iife format with top-level await produces a Promise,
 *     which the sandbox already awaits).
 *
 * @since Kraken v1.30.x — workflow script runtime (F1.3)
 */

import { build } from 'esbuild';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Path to the SDK stub that user plans resolve `@zelari/kraken-runtime` to. */
const SDK_STUB = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'packages',
  'core',
  'src',
  'kraken',
  'runtime',
  'sdk.ts',
);

export interface CompilePlanOptions {
  /** Path to the user's plan file (`.ts`). */
  planPath: string;
  /** Where to write the bundle. */
  outPath: string;
  /** Optional path to a `zod` schemas the plan imports; default: nothing. */
  zodSchemasPath?: string;
}

export interface CompilePlanResult {
  outPath: string;
  bytes: number;
  durationMs: number;
}

/**
 * Bundle the user's plan with esbuild. The output is a single ESM file
 * with `@zelari/kraken-runtime` aliased to the SDK stub. The sandbox
 * loads this file in a `vm` context.
 *
 * Throws on syntax errors or unresolved imports (esbuild surfaces both
 * with a structured `BuildFailure`).
 */
export async function compileScriptPlan(opts: CompilePlanOptions): Promise<CompilePlanResult> {
  const start = Date.now();
  await fs.mkdir(path.dirname(opts.outPath), { recursive: true });

  const result = await build({
    entryPoints: [opts.planPath],
    bundle: true,
    format: 'esm',
    target: 'es2022',
    platform: 'node',
    write: false,
    sourcemap: false,
    minify: false,
    treeShaking: true,
    alias: {
      '@zelari/kraken-runtime': SDK_STUB,
      // The stub itself imports types-only from types.js; the alias above
      // does NOT resolve those (esbuild only aliases user-facing imports).
      // We rewrite the stub's internal type-only imports in a second pass
      // below if needed; in practice the stub only does `import type {...}`
      // which esbuild strips without resolution.
    },
    logLevel: 'silent',
  });

  // `write: false` returns the result in memory; the ESM output may be one
  // file or more. We take the first (entry) file.
  const out = result.outputFiles?.[0];
  if (!out) {
    throw new Error('esbuild produced no output files');
  }

  await fs.writeFile(opts.outPath, out.text, 'utf8');
  return {
    outPath: opts.outPath,
    bytes: out.text.length,
    durationMs: Date.now() - start,
  };
}
