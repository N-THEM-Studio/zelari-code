/**
 * Kraken script runtime — SDK stub (bundled into user plans).
 *
 * This file is **only** meant to be consumed by the bundler. It defines
 * the public API that user plans import (`@zelari/kraken-runtime` is
 * aliased to this file in the esbuild config). At type-check time the
 * imports resolve to the real `PlanCapabilities` from `./types.js`; at
 * runtime, every exported function forwards to `globalThis.__zelari_sdk__`,
 * which the host populates before running the sandbox.
 *
 * Do NOT call any of these functions outside a script. They are designed
 * to run in a vm context where `globalThis.__zelari_sdk__` exists; if you
 * call them in a normal Node process you'll get a `TypeError`.
 *
 * @since Kraken v1.30.x — workflow script runtime (F1.1)
 */

import type {
  EmitPayload,
  MergeOptions,
  MergeResult,
  PlanCapabilities,
  PlanContext,
  PlanSnapshot,
  TentacleOptions,
  TentacleRef,
} from './types.js';

type Sdk = PlanCapabilities;

function sdk(): Sdk {
  // The host injects `__zelari_sdk__` into the sandbox before the bundle
  // runs. In a normal Node process this global is undefined and the
  // explicit throw below catches misuse early.
  const g = globalThis as unknown as { __zelari_sdk__?: Sdk };
  if (!g.__zelari_sdk__) {
    throw new Error(
      '@zelari/kraken-runtime must run inside a Kraken script sandbox; ' +
        'no __zelari_sdk__ capability was provided',
    );
  }
  return g.__zelari_sdk__;
}

export async function tentacle<T = unknown>(opts: TentacleOptions<T>): Promise<TentacleRef<T>> {
  return sdk().tentacle<T>(opts);
}

export async function barrier<T extends readonly TentacleRef[]>(
  refs: T,
): Promise<{ -readonly [K in keyof T]: T[K] }> {
  return sdk().barrier(refs);
}

export async function race<T extends readonly TentacleRef[]>(refs: T): Promise<T[number]> {
  return sdk().race(refs);
}

export async function while_<T>(
  cond: () => boolean | Promise<boolean>,
  body: () => Promise<T>,
  maxIter: number,
): Promise<T[]> {
  return sdk().while_(cond, body, maxIter);
}

export async function until<T>(
  cond: () => boolean | Promise<boolean>,
  body: () => Promise<T>,
  maxIter: number,
): Promise<T[]> {
  return sdk().until(cond, body, maxIter);
}

export async function merge(
  refs: readonly TentacleRef[],
  opts?: MergeOptions,
): Promise<MergeResult> {
  return sdk().merge(refs, opts);
}

export async function checkpoint(label?: string): Promise<PlanSnapshot> {
  return sdk().checkpoint(label);
}

export function log(msg: string, data?: Record<string, unknown>): void {
  sdk().log(msg, data);
}

export function emit(payload: EmitPayload): void {
  sdk().emit(payload);
}

export function getContext(): PlanContext {
  return sdk().getContext();
}

export function sendTo(peerId: string, payload: EmitPayload): void {
  sdk().sendTo(peerId, payload);
}

// Re-export the types so user plans can `import type { ... }` from a single
// place without needing a second import path.
export type {
  EmitPayload,
  MergeOptions,
  MergeResult,
  PlanCapabilities,
  PlanContext,
  PlanSnapshot,
  TentacleOptions,
  TentacleRef,
} from './types.js';
