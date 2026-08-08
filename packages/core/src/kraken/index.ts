/**
 * Kraken graph engine — public surface (pure DAG primitives + script runtime).
 *
 * Orchestration (planner/executor/worktree/world-model wiring) lives in the
 * CLI and is NOT exported here. See `.zelari/docs/kraken-graph-engine-plan.md`
 * and `.zelari/docs/kraken-best-in-class-roadmap.md`.
 *
 * @since v0.10.x — Kraken graph engine (F1)
 * @since v1.30.x — workflow script runtime (F1.1)
 * @since v1.31.x — weakness-based hypothesis selection (Bennett 2023)
 */

export * from './graph.js';
export * from './conflict.js';
export * from './verdict.js';
export * from './personas/index.js';
export * from './runtime/index.js';
export * from './weakness.js';
