/**
 * sessionSurface — projection of tool-result bodies onto addressable evidence.
 * 2026-07 context-growth plan, Fase 2.
 *
 * Distinguishes:
 *   LOG     = immutable BrainEvent transcript (session JSONL)
 *   SURFACE = what the model sees (AgentMessage[].content for role:'tool')
 *
 * When a tool result leaves the hot tail (N most-recent tool messages, or
 * exceeds the byte budget), its body is replaced by a DETERMINISTIC stub:
 *
 *   OBSERVATION ref=#<seq> tool=<name> status=<s> bytes=<n>
 *   [retrieve_observation #<seq>]
 *
 * The original body stays in the JSONL. `retrieve_observation` rematerializes
 * it on demand. Replacement is monotone: once a stub is written it is never
 * expanded back (prefix-cache safety — same input → same surface).
 *
 * Kill switch: ZELARI_SESSION_SURFACE=0 restores the pre-Fase-2 pruner.
 */
import type { AgentMessage } from '@zelari/core/harness';
import { envNumber } from '../utils/envNumber.js';

/** Marker prefix — also used by retrieve_observation to refuse rematerializing a stub. */
export const OBSERVATION_STUB_PREFIX = 'OBSERVATION ref=#';

export const DEFAULT_HOT_TAIL = 4;
export const DEFAULT_MAX_BODY_CHARS = 4_000;

/** Kill switch: ZELARI_SESSION_SURFACE=0 restores the pre-Fase-2 pruner. */
export function sessionSurfaceEnabled(): boolean {
  return process.env.ZELARI_SESSION_SURFACE !== '0';
}

export interface SessionSurfaceOptions {
  /** Keep the last N tool messages at full fidelity. Default 4 (ZELARI_SURFACE_HOT_TAIL). */
  hotTail?: number;
  /**
   * Bodies at-or-under this length stay full even outside the hot tail
   * (cheap evidence / errors). Default 4000 (ZELARI_SURFACE_MAX_BODY_CHARS).
   */
  maxBodyChars?: number;
}

export interface SessionSurfaceStats {
  /** Tool messages replaced with a stub this pass. */
  projected: number;
  /** Chars omitted by those replacements. */
  charsOmitted: number;
  /** Tool messages already stubbed (left untouched). */
  alreadyStubbed: number;
}

export interface SessionSurfaceResult {
  messages: AgentMessage[];
  stats: SessionSurfaceStats;
}

export interface ObservationStubFields {
  seq: number;
  tool?: string;
  status?: string;
  bytes?: number;
  extra?: string;
}

/** True when a tool-result body is already a Fase-2 stub (never un-prune). */
export function isObservationStub(content: string): boolean {
  return content.startsWith(OBSERVATION_STUB_PREFIX);
}

/**
 * Parse `OBSERVATION ref=#N …` into fields. Returns null if the body is not a stub.
 * Extra key=value pairs after the known ones are preserved as `extra`.
 */
export function parseObservationStub(content: string): ObservationStubFields | null {
  if (!isObservationStub(content)) return null;
  const first = content.split('\n', 1)[0] ?? content;
  const seqMatch = first.match(/^OBSERVATION ref=#(\d+)\b/);
  if (!seqMatch) return null;
  const fields: ObservationStubFields = { seq: Number(seqMatch[1]) };
  const tool = first.match(/\btool=([A-Za-z0-9._-]+)/);
  if (tool) fields.tool = tool[1];
  const status = first.match(/\bstatus=([A-Za-z0-9._-]+)/);
  if (status) fields.status = status[1];
  const bytes = first.match(/\bbytes=(\d+)/);
  if (bytes) fields.bytes = Number(bytes[1]);
  const known = /^(ref|#\d+|tool|status|bytes)$/;
  const extras: string[] = [];
  for (const m of first.matchAll(/\b([A-Za-z_][A-Za-z0-9._-]*)=([^\s]+)/g)) {
    if (!known.test(m[1])) extras.push(`${m[1]}=${m[2]}`);
  }
  if (extras.length) fields.extra = extras.join(' ');
  return fields;
}

/**
 * Deterministic stub. Same fields → byte-identical string (cache-safe).
 * `seq` is the 1-based index of this tool_execution_end in the session log.
 */
export function formatObservationStub(fields: ObservationStubFields): string {
  const parts = [`${OBSERVATION_STUB_PREFIX}${fields.seq}`];
  if (fields.tool) parts.push(`tool=${fields.tool}`);
  if (fields.status) parts.push(`status=${fields.status}`);
  if (fields.bytes !== undefined) parts.push(`bytes=${fields.bytes}`);
  if (fields.extra) parts.push(fields.extra);
  return `${parts.join(' ')}\n[retrieve_observation #${fields.seq}]`;
}

/**
 * Extract Ground-Truth status from a tool-result body (Fase 0 footer), if any.
 * Footer shape: `\n[observation status=complete filesWalked=12 …]`
 */
export function statusFromToolBody(body: string): string | undefined {
  const m = body.match(/\[observation\s+([^\]]+)\]\s*$/);
  if (!m) return undefined;
  const status = m[1].match(/\bstatus=([A-Za-z0-9._-]+)/);
  return status?.[1];
}

function resolveSurfaceLimits(opts?: SessionSurfaceOptions): {
  hotTail: number;
  maxBodyChars: number;
} {
  return {
    hotTail:
      opts?.hotTail ??
      envNumber(process.env.ZELARI_SURFACE_HOT_TAIL, { default: DEFAULT_HOT_TAIL, min: 0 }),
    maxBodyChars:
      opts?.maxBodyChars ??
      envNumber(process.env.ZELARI_SURFACE_MAX_BODY_CHARS, {
        default: DEFAULT_MAX_BODY_CHARS,
        min: 64,
      }),
  };
}

/**
 * Resolve the stable observation seq for a tool message.
 *
 * Preference order (all deterministic):
 *  1. already a stub → keep its seq (monotone — never rewrite the number)
 *  2. `lookup(toolCallId)` from the session log
 *  3. 1-based index among role:'tool' messages in THIS history (offline / tests)
 */
export function resolveObservationSeq(
  message: AgentMessage,
  indexAmongTools: number,
  lookup?: (toolCallId: string) => number | undefined,
): number {
  const existing = parseObservationStub(message.content ?? '');
  if (existing) return existing.seq;
  const id = message.toolCallId;
  if (id && lookup) {
    const fromLog = lookup(id);
    if (typeof fromLog === 'number' && fromLog > 0) return fromLog;
  }
  return indexAmongTools + 1;
}

/**
 * Infer a tool name from the preceding assistant(tool_calls) that declared
 * this toolCallId. Deterministic walk — no side tables.
 */
export function inferToolName(
  messages: readonly AgentMessage[],
  toolIndex: number,
  toolCallId: string | undefined,
): string | undefined {
  if (!toolCallId) return undefined;
  for (let i = toolIndex - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'assistant' || !m.toolCalls) continue;
    const hit = m.toolCalls.find((c) => c.id === toolCallId);
    if (hit) return hit.name;
  }
  return undefined;
}

/**
 * Project oversized / cold tool-result bodies onto addressable stubs.
 *
 * Invariants:
 *  - never mutates the input array or its messages
 *  - already-stubbed bodies are left byte-identical
 *  - same (messages, opts, lookup) → byte-identical output (cache-safe)
 *  - returns the SAME array reference when nothing changed
 */
export function projectSessionSurface(
  messages: readonly AgentMessage[],
  opts?: SessionSurfaceOptions,
  lookup?: (toolCallId: string) => number | undefined,
): SessionSurfaceResult {
  const { hotTail, maxBodyChars } = resolveSurfaceLimits(opts);
  const stats: SessionSurfaceStats = { projected: 0, charsOmitted: 0, alreadyStubbed: 0 };

  const toolPositions: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === 'tool') toolPositions.push(i);
  }
  if (toolPositions.length === 0) {
    return { messages: messages as AgentMessage[], stats };
  }

  const hotStart = Math.max(0, toolPositions.length - hotTail);
  const protect = new Set(toolPositions.slice(hotStart));

  let changed = false;
  const out = messages.map((m, i) => {
    if (m.role !== 'tool') return m;
    const body = m.content ?? '';
    if (isObservationStub(body)) {
      stats.alreadyStubbed += 1;
      return m;
    }
    if (protect.has(i) || body.length <= maxBodyChars) return m;

    const toolOrdinal = toolPositions.indexOf(i);
    const seq = resolveObservationSeq(m, toolOrdinal, lookup);
    const stub = formatObservationStub({
      seq,
      tool: inferToolName(messages, i, m.toolCallId),
      status: statusFromToolBody(body),
      bytes: body.length,
    });
    changed = true;
    stats.projected += 1;
    stats.charsOmitted += Math.max(0, body.length - stub.length);
    return { ...m, content: stub };
  });

  return {
    messages: changed ? out : (messages as AgentMessage[]),
    stats,
  };
}
