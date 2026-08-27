/**
 * verificationAdapters/types — P1.A (t19): the seam between the native
 * criteria pack and per-ecosystem build toolchains.
 *
 * An adapter owns ONE ecosystem (node/python/rust/go): it recognizes a repo
 * root (`detect`, score-based: 0 = not applicable, higher = more confident)
 * and translates it into deterministic `NativePackCommands` (`buildPlan`).
 *
 * Honest-unknown rule for EVERY adapter: when a slot has no trustworthy
 * command (tool not configured, no standard convention), bind `null` — the
 * criterion is dropped downstream. A fabricated command would misreport a
 * missing tool as a `fail` instead of an honest absence.
 *
 * Dependency direction (no runtime cycles): this file imports the pack
 * command shape from ../nativeVerification.js via a TYPE-ONLY import
 * (erased at runtime). nativeVerification.js is the sole RUNTIME consumer
 * of the registry in ./index.js, so the graph stays acyclic.
 *
 * `NativePackCommands` deliberately stays DEFINED in ../nativeVerification.js
 * (re-exported here, least-churn choice for t19): every existing importer of
 * the type keeps compiling unchanged.
 */
import type { NativePackCommands } from '../nativeVerification.js';

export type { NativePackCommands };

export interface VerificationAdapter {
  /**
   * Score-based ecosystem detection for `root`: 0 = not applicable, higher =
   * more confident. The registry keeps the highest-scoring adapter; TIES
   * RESOLVE TO THE FIRST REGISTERED adapter (strictly-greater comparison),
   * which is why the registry order in ./index.js is part of the contract.
   */
  detect(root: string): Promise<number>;
  /**
   * Deterministic commands for this repo; any slot may be `null` (= dropped,
   * honest absence). Env overrides are applied ON TOP of this plan centrally
   * in nativeVerification.ts — adapters never read env.
   */
  buildPlan(root: string): Promise<NativePackCommands>;
}
