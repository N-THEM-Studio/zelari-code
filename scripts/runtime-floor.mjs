/**
 * runtime-floor.mjs — single source of truth for the release runtime floor.
 *
 * Consumed by scripts/verify-versions.mjs (engines.node on the root and
 * @zelari/core, the CI smoke Node matrix, and the pinned npm); the future
 * release-gate reads it too. Do not duplicate these values elsewhere — drift
 * here is exactly what this module exists to prevent.
 */
export const NODE_FLOOR = '20.17.0';
export const NPM_PIN = '11.7.0';
export const NPM_ENGINES_MIN = '>=10.0.0';
