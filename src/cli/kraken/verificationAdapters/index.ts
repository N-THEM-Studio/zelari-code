/**
 * verificationAdapters — ordered registry for the multi-ecosystem native
 * verification path (P1.A / t19). The sole runtime consumer is
 * ../nativeVerification.ts; everything above this layer stays untouched.
 *
 * REGISTRY ORDER IS CONTRACT: on equal detect scores the EARLIER adapter
 * wins (strictly-greater comparison in resolveAdapterForRoot). Current
 * order — node first (largest installed base and the historical F2
 * behavior), then python, rust, go, java (JVM: Gradle/Maven, t24 §P1.A2),
 * dotnet (.NET, t24 §P1.A2). Real ecosystems are mutually exclusive by
 * marker file, so ordering mostly matters for degenerate fixtures.
 */
import type { VerificationAdapter } from './types.js';
import { nodeAdapter } from './node.js';
import { pythonAdapter } from './python.js';
import { rustAdapter } from './rust.js';
import { goAdapter } from './go.js';
import { javaAdapter } from './java.js';
import { dotnetAdapter } from './dotnet.js';

export type { NativePackCommands, VerificationAdapter } from './types.js';

export { nodeAdapter } from './node.js';
export { pythonAdapter } from './python.js';
export { rustAdapter } from './rust.js';
export { goAdapter } from './go.js';
export { javaAdapter } from './java.js';
export { dotnetAdapter } from './dotnet.js';

/** Ordered ecosystem adapters; see header for the tie-break contract. */
export const VERIFICATION_ADAPTERS: readonly VerificationAdapter[] = [
  nodeAdapter,
  pythonAdapter,
  rustAdapter,
  goAdapter,
  javaAdapter,
  dotnetAdapter,
];

/**
 * Highest-scoring adapter for `root` (ties → earlier registration), or null
 * when no adapter applies (score ≤ 0 everywhere — e.g. an empty directory;
 * env overrides alone still work then, see
 * nativeVerification.resolvePackCommandsForRoot). A throwing `detect`
 * (filesystem race) counts as not-applicable rather than aborting resolution.
 */
export async function resolveAdapterForRoot(root: string): Promise<VerificationAdapter | null> {
  let best: VerificationAdapter | null = null;
  let bestScore = 0;
  for (const adapter of VERIFICATION_ADAPTERS) {
    let score: number;
    try {
      score = await adapter.detect(root);
    } catch {
      continue;
    }
    if (score > bestScore) {
      best = adapter;
      bestScore = score;
    }
  }
  return best;
}
