/**
 * session/decisionEvents.ts — WS7 slice 2: the DECISION-POINT vocabulary.
 *
 * A replay of a spine can already answer "what did the agent DO" (tool.call /
 * tool.result, file.*, verification.run, verify.debt_*). What it could not
 * answer — the whole point of `zelari-code replay` — is "what did the HARNESS
 * decide on the way": whether the operator was asked, whether an approval was
 * auto-granted, whether the OS jail blocked the spawn, whether the model
 * stopped to ask the user, whether a verify was requested at all.
 *
 * Those five kinds are declared in `types.ts` (SESSION_EVENT_KINDS) and their
 * payload contracts live HERE, in one place, mirrored from the emitters that
 * already exist so a future writer does not invent a second spelling:
 *
 *   permission.asked    ← PermissionRequestPayload (safety/permissionGate.ts,
 *                         WS5): {tool, categories?, effect?, matchedRuleId?,
 *                         source?, reason?, argsSummary?}
 *   auto_approve.granted← the same decision block, effect resolved to allow
 *                         (category default / allow rule / `--permissions yolo`)
 *   jail.blocked        ← JailSpawnDecision deny branch (safety/osJail.ts):
 *                         {backend, mode, reason, tool?}
 *   ask_user.fired      ← the ask_user tool args (question/choices/context)
 *   verify.requested    ← the K1.5/F5 obligation side: a verify was ASKED for
 *                         (`verification.run` records that it actually ran)
 *
 * ALL FIVE ARE STATE-ONLY (P1): they record a decision, they never feed the
 * model loop, so `deriveMessages()` ignores them and MODEL_SURFACE_KINDS must
 * never gain them (pinned by decisionEvents.test.ts).
 *
 * Replay discipline (same as `parsePermissionDenial`): every reader here is
 * DEFENSIVE. A hand-edited or half-written line must yield empty strings, never
 * a throw — the tolerant reader owns "this line is broken" reporting.
 */
import { z } from 'zod';
import type { SessionEventEnvelope } from './types.js';

/**
 * The five kinds this slice ADDED to the spine vocabulary (see SESSION_EVENT_KINDS).
 * Order is the reading order of a session, not the declaration order in types.ts.
 */
export const DECISION_EVENT_KINDS = [
  'permission.asked',
  'auto_approve.granted',
  'jail.blocked',
  'ask_user.fired',
  'verify.requested',
] as const;
export type DecisionEventKind = (typeof DECISION_EVENT_KINDS)[number];

/**
 * What the `decisionEvents` projection aggregates: the five kinds above PLUS
 * the WS1 `permission.denied` — same question ("what did the harness decide
 * about this call?"), so a shadow replay must not have to merge two lists.
 * `permission.denied` keeps its own dedicated `permissionDenials` field too;
 * that field is untouched by this slice.
 */
export const DECISION_PROJECTION_KINDS = [...DECISION_EVENT_KINDS, 'permission.denied'] as const;
export type DecisionProjectionKind = (typeof DECISION_PROJECTION_KINDS)[number];

/** True for every kind the `decisionEvents` projection collects. */
export function isDecisionProjectionKind(kind: string): kind is DecisionProjectionKind {
  return (DECISION_PROJECTION_KINDS as readonly string[]).includes(kind);
}

// ── Payload contracts (zod) ────────────────────────────────────────────────
//
// NOT `.strict()`: the envelope's `data` is an open record and emitters grow
// fields (an `argsSummary`, a `durationMs`, a future `callId`). These schemas
// exist to pin what a payload MUST carry (and to be the single place a writer
// looks up the spelling) — not to reject forward-compatible additions.
// Unknown/missing REQUIRED fields are reported by `decisionPayloadError`.

const nonEmpty = z.string().min(1);
const toolName = z.object({ tool: nonEmpty });

/** `permission.asked` — the gate resolved a dispatch to a PROMPT. */
export const PermissionAskedPayloadSchema = toolName.extend({
  /** Declared permission categories of the call (`read`, `write`, …). */
  categories: z.array(z.string()).optional(),
  /** Always `ask` when present — a deny is `permission.denied` (WS1). */
  effect: z.literal('ask').optional(),
  matchedRuleId: nonEmpty.optional(),
  source: nonEmpty.optional(),
  reason: z.string().optional(),
  argsSummary: z.string().optional(),
});

/** `auto_approve.granted` — the same decision, resolved to ALLOW without a prompt. */
export const AutoApproveGrantedPayloadSchema = toolName.extend({
  categories: z.array(z.string()).optional(),
  /** Where the approval came from (`default` / `project` / `session` / `preset`). */
  source: nonEmpty.optional(),
  matchedRuleId: nonEmpty.optional(),
  reason: z.string().optional(),
});

/** `jail.blocked` — the OS jail refused the spawn (typed `[jail]` error). */
export const JailBlockedPayloadSchema = z.object({
  /** Exec tool whose spawn was refused, when one call owned the spawn. */
  tool: nonEmpty.optional(),
  /** Backend id that failed it (`seatbelt` / `bwrap` / `win32-restricted-token`). */
  backend: nonEmpty,
  /** Wire mirror of `safety/osJail.ts` JailMode (core cannot import the CLI). */
  mode: z.enum(['off', 'advisory', 'required']),
  reason: nonEmpty,
});

/** `ask_user.fired` — the model stopped the loop to ask the operator. */
export const AskUserFiredPayloadSchema = z.object({
  question: nonEmpty,
  /** `tool.call` id this question belongs to, when the emitter knows it. */
  callId: nonEmpty.optional(),
  choices: z.array(z.string()).optional(),
  context: z.string().optional(),
});

/** `verify.requested` — a verify was ASKED for (it may never run). */
export const VerifyRequestedPayloadSchema = z.object({
  /** K1.5/F5 debt slot the request belongs to, when one exists. */
  taskId: nonEmpty.optional(),
  /** Criterion ids the request targets (`verification.run` reports outcomes). */
  criterionIds: z.array(z.string()).optional(),
  source: nonEmpty.optional(),
  reason: z.string().optional(),
});

/** One schema per DECISION_EVENT_KIND — the payload contract table. */
export const DECISION_EVENT_PAYLOAD_SCHEMAS = {
  'permission.asked': PermissionAskedPayloadSchema,
  'auto_approve.granted': AutoApproveGrantedPayloadSchema,
  'jail.blocked': JailBlockedPayloadSchema,
  'ask_user.fired': AskUserFiredPayloadSchema,
  'verify.requested': VerifyRequestedPayloadSchema,
} as const satisfies Record<DecisionEventKind, z.ZodTypeAny>;

/**
 * Validate a payload against its kind's contract. Returns `null` when the
 * payload satisfies it, else a one-line reason (the FIRST zod issue, prefixed
 * with the field path) ready for stderr. Never throws.
 */
export function decisionPayloadError(kind: DecisionEventKind, data: unknown): string | null {
  const schema: z.ZodTypeAny = DECISION_EVENT_PAYLOAD_SCHEMAS[kind];
  const result = schema.safeParse(data);
  if (result.success) return null;
  const issue = result.error.issues[0];
  const where = issue?.path.length ? `${issue.path.join('.')}: ` : '';
  return `${where}${issue?.message ?? 'payload does not match the contract'}`;
}

// ── Projection ────────────────────────────────────────────────────────────

/**
 * One decision point, flattened for replay rendering. `seq`/`at` come from the
 * ENVELOPE (never from a `timestamp` field inside the payload): an event's ts
 * is writer-assigned, and replay must read the same clock the rest of the
 * projection reads.
 */
export interface DecisionEventSummary {
  seq: number;
  at: number;
  kind: DecisionProjectionKind;
  /** Tool the decision was about (`''` when the kind carries none). */
  tool: string;
  /** Rule/layer that drove it (`''` when none did). */
  source: string;
  /** Human reason, verbatim from the payload (`''` when absent). */
  reason: string;
  /** Bounded, kind-specific one-liner (question, backend+mode, criteria…). */
  detail: string;
}

/** Primitive-only string read: exotic values degrade to `''`, never `[object Object]`. */
function str(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

/** `str` + collapse + bound, so a multi-line question cannot break the report. */
function oneLine(value: unknown, max = 120): string {
  const text = str(value).replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
}

/** `a, b, c` for a bounded list, `''` when there is nothing to join. */
function joinList(value: unknown, max = 6): string {
  if (!Array.isArray(value)) return '';
  return value
    .map((v) => oneLine(v, 40))
    .filter((v) => v.length > 0)
    .slice(0, max)
    .join(', ');
}

/** `ruleId @source` / `ruleId` / `source` — whatever the payload carried. */
function describeOrigin(data: Record<string, unknown>): string {
  const rule = oneLine(data.matchedRuleId, 60);
  const source = oneLine(data.source, 60);
  if (rule && source) return `${rule} @${source}`;
  return rule || source;
}

function describeDetail(kind: DecisionProjectionKind, data: Record<string, unknown>): string {
  switch (kind) {
    case 'permission.asked':
      return (
        oneLine(data.reason) ||
        oneLine(data.argsSummary) ||
        (describeOrigin(data) ? `rule ${describeOrigin(data)}` : 'prompt awaited')
      );
    case 'auto_approve.granted': {
      const origin = describeOrigin(data);
      return origin ? `auto-approved (${origin})` : 'auto-approved';
    }
    case 'jail.blocked':
      return `${oneLine(data.backend, 40) || 'jail'} ${oneLine(data.mode, 20) || '?'}: ${oneLine(data.reason)}`;
    case 'ask_user.fired': {
      const choices = joinList(data.choices);
      return oneLine(data.question) + (choices ? `  [choices: ${choices}]` : '');
    }
    case 'verify.requested': {
      const criteria = joinList(data.criterionIds, 4);
      return oneLine(data.reason) || (criteria ? `criteria: ${criteria}` : '');
    }
    case 'permission.denied':
      return oneLine(data.reason) || `denied by ${describeOrigin(data) || 'a permission rule'}`;
  }
}

/**
 * Flatten one decision event. Pure and defensive: a payload missing every
 * field still yields a summary with empty strings (the KIND is the datum).
 */
export function parseDecisionEvent(e: SessionEventEnvelope): DecisionEventSummary {
  const data = e.data;
  return {
    seq: e.seq,
    at: e.ts,
    kind: e.kind as DecisionProjectionKind,
    tool: oneLine(data.tool, 60),
    source: oneLine(data.source, 60),
    reason: oneLine(data.reason),
    detail: describeDetail(e.kind as DecisionProjectionKind, data),
  };
}
