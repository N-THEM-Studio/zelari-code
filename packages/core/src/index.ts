/**
 * @zelari/core — public API surface.
 *
 * Stable entrypoint. Anything not re-exported here is internal and may
 * change without notice. Subpath imports (@zelari/core/harness, etc.) are
 * supported for fine-grained access.
 */

// Events (provider-neutral contract)
export * from './events/index.js';

// Public types
export * from './types/index.js';

// Agent loop
export * from './harness/index.js';

// Council (multi-agent orchestration)
export * from './council/index.js';

// Skills (built-in)
export * from './skills/index.js';

// Memory backend contract (implementation lives in the CLI)
export * from './memory/types.js';

// Durable state contract (file-backed store lives in the CLI)
export * from './state/index.js';

// Kraken graph engine (pure DAG primitives; orchestration lives in the CLI)
export * from './kraken/index.js';

// Session spine — append-only log, replay, fork/resume (ADR-0016/0021)
export * from './session/index.js';

// Runtime execution seams + versioned profiles (ADR-0022)
export * from './runtime/index.js';

// Deterministic verification + completion policy + optional verifier (ADR-0023)
export * from './verification/index.js';

// Mission state derived from the session spine (2.0 Phase 4)
export * from './mission/index.js';

// Experimental flags registry (2.0 Phase 5 — all OFF by default)
export * from './experimental.js';

export { CORE_VERSION } from './version.js';
export { toolFingerprintHash, skillFingerprintHash, type ToolFingerprint, type SkillFingerprint } from './runtime/fingerprints.js';
