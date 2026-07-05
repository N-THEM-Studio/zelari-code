/**
 * workspace/index.ts — Public API barrel for the council workspace subsystem.
 *
 * The council workspace persists council output (plan/risks/decisions/reviews/docs)
 * to `.zelari/` at the project root and auto-curates `AGENTS.MD` from the
 * collected artifacts. This is the CLI replacement for the Electron-only
 * `ctx.createPhase`/etc. injection that AnathemaBrain uses.
 *
 * @see docs/plans/2026-07-01-council-workspace-cli-stubs.md
 * @module cli/workspace
 */

// Storage primitives — YAML frontmatter parser/serializer + per-key mutex.
export {
  Storage,
  workspaceMutex,
  parseFrontmatter,
  serializeFrontmatter,
  parseYaml,
  serializeYaml,
} from "./storage.js";
export type { ParsedDoc } from "./storage.js";

// Filesystem paths + workspace root resolution.
export {
  resolveWorkspaceRoot,
  workspaceFile,
  workspaceArtifact,
  projectName,
  WORKSPACE_SUBDIRS,
} from "./paths.js";

// Public types — frontmatter shapes + WorkspaceContext.
export type {
  WorkspaceContext,
  PlanFrontmatter,
  AdrFrontmatter,
  RiskFrontmatter,
  ReviewFrontmatter,
  DocFrontmatter,
} from "./types.js";

// Tool stubs — council workspace tools as filesystem-backed implementations.
export { createWorkspaceContext, createWorkspaceStubs } from "./stubs.js";

// Tool registry — wraps stubs as EnhancedToolDefinition[] for the harness.
export { createWorkspaceToolRegistry } from "./toolRegistry.js";

// AGENTS.MD auto-maintenance — marker-delimited sections + idempotent writes.
export {
  updateAgentsMd,
  parseAgentsMd,
  serializeAgentsMd,
  AUTO_SECTIONS,
} from "./agentsMd.js";
export type { AutoSectionId, UpdateResult, Section } from "./agentsMd.js";

// Post-council hook — orchestrates `updateAgentsMd` after every council run.
export {
  runPostCouncilHook,
  runImplementationVerificationHook,
} from "./postCouncilHook.js";
export type {
  HookResult,
  PostCouncilHookOptions,
  VerificationHookResult,
} from "./postCouncilHook.js";
