/**
 * Context Engine v2 — public surface (Frontier Runtime Upgrade §46–66).
 *
 * Policy per agent role + pure projection from the durable transcript.
 * RunRecord remains the session spine (ADR-0016); spill/compaction/token
 * budget already exist in core tools / session / CLI budget respectively.
 */
export * from './ContextPolicy.js';
export * from './ContextProjector.js';
export * from './parentContext.js';
