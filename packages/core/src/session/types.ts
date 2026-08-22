/**
 * session/types.ts — Session spine v1: envelope + event vocabulary (ADR-0016/0021).
 *
 * The session log is the single source of truth for what the model saw and
 * what the harness did. One JSON object per line:
 *
 *   {"schemaVersion":1,"sessionId":"…","seq":7,"ts":1755…,"kind":"tool.result",
 *    "actor":{"type":"agent"},"data":{…}}
 *
 * Invariant (P1): model-visible ⟺ logged — every kind that feeds the model
 * input must appear in MODEL_SURFACE_KINDS (see modelSurface.ts). The
 * vocabulary is closed: new kinds require a schema review (ADR-0021).
 */

import { z } from 'zod';

/** Bump on breaking envelope/event changes; migrations documented in MIGRATION.md. */
export const SESSION_SCHEMA_VERSION = 1;

export const SessionActorSchema = z.object({
  type: z.enum(['user', 'agent', 'system', 'subagent', 'tool']),
  id: z.string().min(1).optional(),
  /** Human label for display (e.g. role/persona name). */
  role: z.string().min(1).optional(),
});
export type SessionActor = z.infer<typeof SessionActorSchema>;

/**
 * Closed event vocabulary (surface + state events).
 * Surface (model-visible): user.message, assistant.message, tool.call,
 * tool.result, session.compacted. Everything else is state/derived.
 * `session.compacted` with `{fromSeq,toSeq,checkpoint}` shadows that range
 * in deriveMessages(); `{summary}` without a range is legacy (append-only).
 */
export const SESSION_EVENT_KINDS = [
  'session.started',
  'session.resumed',
  'session.ended',
  'session.forked',
  // 2.6 Track A (harness manifest): canonical harness fingerprint recorded
  // once at session start / manifest change. State-only (never model-surface):
  // data = {manifest, manifestHash}. Schema review per ADR-0021.
  'session.harness_manifest',
  'user.message',
  'assistant.message',
  'tool.call',
  'tool.result',
  // 2.x B (crash-safe recovery): dangling call classified. State-only.
  'tool.interrupted',
  'context.injected',
  'session.compacted',
  'task.created',
  'task.updated',
  // 2.6 Track A (doc §14): first-class task contract. Append-only,
  // monotone versioning (task.contract_updated supersedes, never rewrites).
  // State-only: compaction projects it into CompactionStateSnapshot.
  'task.contract',
  'task.contract_updated',
  'kraken.task',
  'council.member',
  'mission.phase',
  'mission.replan',
  // F4 (doc §6 advisory continuation): driver → host advice record. State-only
  // (never model-surface): the recommendation must not feed the model loop.
  'mission.progress',
  'verification.run',
  // F3 (ADR-0023 §5 evidence traceability): per-observation state event —
  // the session-log anchor EvidenceRef.seq points at (command output, fs
  // observation, digest). Not model-surface. Schema review per ADR-0021.
  'verification.evidence',
  // 2.6 Track B (resource-aware execution, doc §9-§12): host-owned resource
  // state. `resource.snapshot` is model-surface with LATEST-ONLY projection
  // (doc §10.2 — see modelSurface.ts); limit/reserve events are state-only.
  'resource.snapshot',
  'resource.limit_reached',
  'resource.reserve_entered',
  'note',
] as const;
export type SessionEventKind = (typeof SESSION_EVENT_KINDS)[number];

export const SessionEventEnvelopeSchema = z.object({
  schemaVersion: z.literal(SESSION_SCHEMA_VERSION),
  sessionId: z.string().min(1),
  /** Monotonic, gap-free, 1-based. Assigned by the writer after validation. */
  seq: z.number().int().positive(),
  ts: z.number().int().nonnegative(),
  kind: z.enum(SESSION_EVENT_KINDS),
  actor: SessionActorSchema,
  data: z.record(z.string(), z.unknown()),
});
export type SessionEventEnvelope = z.infer<typeof SessionEventEnvelopeSchema>;

/** Event payload without writer-assigned fields (seq/ts/sessionId/schemaVersion). */
export interface SessionEventInput {
  kind: SessionEventKind;
  actor: SessionActor;
  data?: Record<string, unknown>;
}

/** Convenience actors. */
export const ACTOR_USER: SessionActor = { type: 'user' };
export const ACTOR_AGENT: SessionActor = { type: 'agent' };
export const ACTOR_SYSTEM: SessionActor = { type: 'system' };
