/**
 * Kraken graph engine — public surface (pure DAG primitives).
 *
 * Orchestration (planner/executor/worktree/world-model wiring) lives in the
 * CLI and is NOT exported here. See `.zelari/docs/kraken-graph-engine-plan.md`.
 */

export * from './graph.js';
export * from './conflict.js';
