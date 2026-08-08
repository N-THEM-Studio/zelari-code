/**
 * Kraken script runtime — public surface.
 *
 * Re-exports for `@zelari/core` consumers. CLI-side bundling lives in
 * `src/cli/kraken/runtime/compile.ts` and is NOT exported here (it depends
 * on esbuild, which is a CLI dev dep, not a core runtime dep).
 *
 * @since Kraken v1.30.x — workflow script runtime (F1.1)
 */

export * from './types.js';
export {
  runInSandbox,
  scanForFootguns,
  type SandboxRunOptions,
  type SandboxRunResult,
} from './sandbox.js';
export {
  ScriptRunner,
  DEFAULT_MAX_TENTACLES,
  DEFAULT_PLAN_TIMEOUT_MS,
  resolveMaxTentacles,
  resolvePlanTimeoutMs,
  type ScriptRunnerOptions,
} from './runner.js';
// NOTE: `./sdk.js` is NOT re-exported from the package surface — it is meant
// to be bundled into user plans via the CLI-side esbuild alias, not imported
// directly by Node code. Importing it would throw at runtime.
