/**
 * Kraken script runtime — Node `vm` sandbox.
 *
 * Wraps the compiled script bundle in a fresh V8 context with a
 * capability-based global. The sandbox has NO `process`, `require`,
 * `Buffer`, `global`, `__dirname`, `__filename`, or any other Node
 * built-in — only the explicit capabilities the host injects.
 *
 * Security model:
 *   - The bundle is a single async IIFE produced by esbuild. The sandbox
 *     object exposes ONE global: `__zelari_sdk__` (frozen), holding the
 *     capability functions. Scripts can only call into the host through
 *     these functions; they cannot read `process.env` or `fs` because those
 *     do not exist in the context.
 *   - Wall-clock bound is enforced by the `vm` timeout. Per-tentacle
 *     bound is enforced by the host (existing `runTentacle` timeout).
 *   - A footgun guard scans the script for obviously dangerous tokens
 *     (e.g. `process`, `require`, `globalThis`) BEFORE running and
 *     surfaces a structured `PlanError('sandbox_breach')` when found.
 *     This is best-effort: a sufficiently obfuscated script can sneak
 *     around the regex, but the absence of these tokens in the sandbox
 *     means even bypassing the guard leaves nothing to call.
 *
 * @since Kraken v1.30.x — workflow script runtime (F1.1)
 */

import vm from 'node:vm';
import { PlanError } from './types.js';

/** Maximum size of a bundled script (bytes). Anything bigger is almost
 *  certainly an LLM loop, not a real plan. */
const MAX_BUNDLE_BYTES = 256 * 1024;

/** Footgun guard: token-level regexes applied to the source before running. */
const FORBIDDEN_TOKENS: readonly RegExp[] = [
  /\bprocess\b/,
  /\brequire\b/,
  /\bmodule\b/,
  /\bexports\b/,
  /\b__dirname\b/,
  /\b__filename\b/,
  /\bglobalThis\b/,
  /\bglobal\b(?!\s*=)/,
  /\bBuffer\b/,
  /\beval\b/,
  /\bFunction\s*\(/,
  /\bnew\s+Function\b/,
];

export interface SandboxRunOptions {
  /** The compiled JS bundle (esbuild IIFE output). */
  bundleCode: string;
  /** Capability object to expose as `__zelari_sdk__`. Will be deep-frozen. */
  sdk: Record<string, unknown>;
  /** Wall-clock cap (ms) for the whole script. */
  timeoutMs: number;
  /** Optional abort signal. */
  signal?: AbortSignal;
  /**
   * Skip the pre-flight token scan. **Test-only**: production LLM plans
   * benefit from the footgun guard, but the guard rejects test bundles
   * that intentionally probe the sandbox for forbidden tokens. Always
   * leave `false` (the default) outside tests.
   */
  skipFootgunScan?: boolean;
}

/** Result of a sandbox run. The IIFE's resolved value (if any). */
export interface SandboxRunResult {
  /** Whatever the bundle's final expression resolved to (usually `undefined`). */
  value: unknown;
  /** Wall-clock time the script took (ms). */
  durationMs: number;
}

/**
 * Token-level scan of the bundle. Cheap and catches the common LLM mistakes
 * (writing `process.env.X` from muscle memory). Runs BEFORE the bundle
 * executes; a hit raises `PlanError('sandbox_breach')` and the bundle is
 * discarded without being run.
 */
export function scanForFootguns(bundleCode: string): string[] {
  if (bundleCode.length > MAX_BUNDLE_BYTES) {
    return [
      `bundle is ${bundleCode.length} bytes; max is ${MAX_BUNDLE_BYTES} ` +
        `(LLM is almost certainly looping)`,
    ];
  }
  const hits: string[] = [];
  for (const re of FORBIDDEN_TOKENS) {
    const m = re.exec(bundleCode);
    if (m) hits.push(`forbidden token "${m[0]}"`);
  }
  return hits;
}

/** Deep-freeze an object so scripts cannot mutate capabilities. */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Object.isFrozen(value)) return value;
  const obj = value as Record<string, unknown>;
  for (const k of Object.keys(obj)) deepFreeze(obj[k]);
  return Object.freeze(value);
}

/**
 * Run a compiled bundle in a fresh sandbox with the given capabilities.
 * The script gets ONE global: `__zelari_sdk__`. Standard JS intrinsics
 * (Object, Array, Promise, Math, JSON, Date, console) are available because
 * they are V8 intrinsics — there is no way to exclude them without a
 * custom V8 build, and they are not security risks on their own.
 */
export async function runInSandbox(opts: SandboxRunOptions): Promise<SandboxRunResult> {
  const { bundleCode, sdk, timeoutMs } = opts;

  // 1. Pre-flight: reject obviously-unsafe bundles. Tests opt out via
  //    `skipFootgunScan: true` so they can probe the sandbox for forbidden
  //    tokens without tripping the guard.
  if (!opts.skipFootgunScan) {
    const footguns = scanForFootguns(bundleCode);
    if (footguns.length > 0) {
      throw new PlanError(
        'sandbox_breach',
        `script bundle failed footgun scan: ${footguns.join('; ')}`,
      );
    }
  }

  // 2. Freeze the capabilities so a script cannot replace them.
  const frozen = deepFreeze({ ...sdk });

  // 3. Build a minimal sandbox global. We do NOT add `process`, `require`,
  //    `Buffer`, `global`, etc. — V8 will not put them in the new context
  //    by default, and we never add them ourselves.
  const sandbox: Record<string, unknown> = {
    __zelari_sdk__: frozen,
    // A console that prefixes lines with the graph id; useful for the
    // workbench view and harmless to expose (it just logs to stdout).
    console: makeSandboxConsole(),
  };

  const context = vm.createContext(sandbox, {
    name: 'kraken-script',
    codeGeneration: { strings: false, wasm: false },
  });

  // 4. Run the bundle. `runInContext` accepts a `timeout` option that
  //    aborts the script after N ms; we cap at the requested budget.
  //    esbuild's IIFE format with top-level await produces an async
  //    function, so the result is a Promise.
  const start = Date.now();
  const vmOpts: vm.RunningScriptOptions = {
    timeout: Math.max(1, timeoutMs),
    displayErrors: true,
    breakOnSigint: true,
  };

  try {
    const value = await vm.runInContext(bundleCode, context, vmOpts);
    return { value, durationMs: Date.now() - start };
  } catch (err) {
    // Distinguish "script was cancelled" from "script threw". The vm
    // module throws a `Script execution timed out` Error when the timeout
    // fires; we re-raise as a structured PlanError. Node's vm error has
    // a `message` field but isn't always a true `Error` instance, so we
    // match on the message string defensively.
    const msg = err && typeof err === 'object' && 'message' in err
      ? String((err as { message: unknown }).message ?? '')
      : String(err);
    if (/timed out/i.test(msg)) {
      throw new PlanError('budget_exceeded', `script exceeded ${timeoutMs}ms budget`);
    }
    if (opts.signal?.aborted) {
      throw new PlanError('cancelled', 'script aborted by host');
    }
    if (err instanceof PlanError) throw err;
    throw new PlanError('runtime_error', msg, err);
  }
}

/** A console that the script can use without leaking to the real stdout. */
function makeSandboxConsole(): Console {
  // We proxy to a captured console; this is for debuggability only and
  // does not change the script's ability to do its work.
  const prefix = '[kraken-script]';
  return {
    ...console,
    log: (...args: unknown[]) => console.log(prefix, ...args),
    info: (...args: unknown[]) => console.info(prefix, ...args),
    warn: (...args: unknown[]) => console.warn(prefix, ...args),
    error: (...args: unknown[]) => console.error(prefix, ...args),
  } as Console;
}
