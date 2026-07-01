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
