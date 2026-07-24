/**
 * Kraken graph engine — tentacle run surface (F2).
 *
 * Stable import path for the graph executor (F3) and any orchestration code
 * that needs to drive a sub-agent tentacle directly, WITHOUT the `task` tool's
 * per-turn spawn cap. The implementation lives in `tools/taskTool.ts` (shared
 * with the `task` tool so behavior stays identical); this module re-exports the
 * orchestration-facing subset.
 *
 * @since v0.10.x — Kraken graph engine (F2)
 */

export {
  runTentacle,
  runSubAgent,
  type RunTentacleOptions,
  type TentacleResult,
  type TentacleSuccess,
  type TentacleFailure,
  type TaskToolDeps,
  type SubAgentContext,
  type SubAgentHarness,
  type TaskAgentKind,
  type TaskThoroughness,
} from '../tools/taskTool.js';
