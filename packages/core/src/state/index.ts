/**
 * Durable state types — see types.ts for the full contract.
 * File-backed implementation lives in the CLI (`src/cli/state/`).
 */
export type {
  StateCommitId,
  StateCommitMode,
  DiscoveryKind,
  Discovery,
  StateCommitVerification,
  StateCommitMeta,
  StateCommitInput,
  DurableStateStore,
} from './types.js';
