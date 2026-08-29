/**
 * Agent harness — the provider-neutral agent loop.
 * `AgentHarness` is the single entrypoint for running an LLM-driven turn
 * (system prompt + tools + streaming events).
 */
export * from '../core/AgentHarness.js';
export * from '../core/providerStream.js';
export * from '../core/requestSnapshot.js';
export * from '../core/sessionJsonl.js';
// Fase M: context-growth metrics (log-only per-run counters).
export * from '../core/contextGrowth.js';
// v1.32.0: lifecycle hooks (PreToolUse/PostToolUse/SessionStart/End) + fail-open runner.
export * from '../core/hooks/index.js';
// t29 (Pilastro B): long-lived harness kernel — sessions + per-workspace
// services, transport-free (stdio NDJSON host lives in the CLI).
export * from './appServerTypes.js';
export * from './appServer.js';
// t30 (Pilastro C): ExtensionAPI seam — collect-only registry + the narrow
// ExtensionHost surface (registerTool / onPreToolUse / sandboxed fs only).
export * from './extensionApiTypes.js';
export * from './extensionApi.js';
