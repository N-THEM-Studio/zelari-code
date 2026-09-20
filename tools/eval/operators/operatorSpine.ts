/**
 * tools/eval/operators/operatorSpine.ts — WS7 slice 3 (support module) — the VIEW an
 * operator reads: one session spine (ADR-0016) flattened into exactly what a
 * proposal needs, plus the refs that make every proposal verifiable.
 *
 * The full `buildProjection()` output deliberately does NOT serve this purpose, and
 * that is a documented limit, not a bug: `buildProjection` drops `tool.call` events
 * (deriveMessages omits them unless `includeToolCalls`) and never projects
 * `file.read/applied/rejected` at all — i.e. neither the CALL ORDER nor the WRITE
 * LIFECYCLE an operator reasons about is in it. `operatorSpineFromProjection` says
 * so out loud (empty calls/fileEvents + `PROJECTION_LIMIT`) instead of guessing (P1).
 *
 * WHAT THE SPINE CANNOT SAY (measured on the real spines under `.zelari/sessions`;
 * the operator test embeds a verbatim excerpt of one):
 *   - NO turn index, NO call→turn binding: the ONLY turn boundary on the wire is an
 *     `assistant.message` (or `user.message`) event. A turn that carried no
 *     assistant text is INVISIBLE, so a model-visible boundary can be MISSED
 *     (never invented).
 *   - `file.rejected` has TWO spellings in the wild: core `fileEvents.ts` writes
 *     `{path, reason, hint?}`, the CLI mirror `src/cli/spineFileEvents.ts` writes
 *     `{path, status}`. Hence `reason ?? status`.
 *   - `minimalDiff` / `span` / `actualHash` are NEVER on the spine: both writers keep
 *     them out of `data` ("the diff never leaks into data"). A proposal can POINT AT
 *     a reject event; it cannot quote the diff.
 *   - `file.*` paths are ABSOLUTE, a tool call carries whatever the model typed:
 *     `samePath` reconciles separator style + the relative/absolute gap only.
 *
 * Pure: no I/O, no clock, no network, no writes. Imports: zod + core TYPES only.
 */
import { z } from 'zod';
import type { SessionEventEnvelope, SessionProjection } from '@zelari/core/session';

/** One verifiable pointer at the spine: `call:<callId>` or `seq:<n>`. */
export const SpineRefSchema = z.object({ kind: z.string().min(1), ref: z.string().min(1) });
export type SpineRef = z.infer<typeof SpineRefSchema>;

/** `call:<callId>` — resolves through `OperatorSpine.calls`. */
export function callRef(call: OperatorCall): string {
  return `call:${callIdOf(call)}`;
}

/** `seq:<n>` — resolves through calls / turns / fileEvents / verifyRequested. */
export function seqRef(seq: number): string {
  return `seq:${seq}`;
}

/** Non-blank string, else ''. Primitive-only: exotic values never render. */
export function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Same path modulo separator style and the absolute/relative gap the spine leaves
 * open. Case-SENSITIVE on purpose: the spine never binds a call to a cwd, so folding
 * case could merge two real files on a case-sensitive filesystem.
 */
export function samePath(a: string, b: string): boolean {
  const x = asString(a).replace(/\\/g, '/').replace(/\/+$/, '');
  const y = asString(b).replace(/\\/g, '/').replace(/\/+$/, '');
  if (x.length === 0 || y.length === 0) return false;
  return x === y || x.endsWith(`/${y}`) || y.endsWith(`/${x}`);
}

/** One `tool.call`, with its own result folded in. */
export interface OperatorCall {
  seq: number;
  /** Writer-assigned id; `''` when the log carried none (`callIdOf` then uses seq). */
  callId: string;
  tool: string;
  args: Record<string, unknown>;
  /** `args.path` as the model typed it (`''` when the tool carries no path). */
  path: string;
  resultSeq?: number;
  /** Absent = NOT MEASURED (never defaulted to false). */
  ok?: boolean;
}

export interface OperatorFileEvent {
  seq: number;
  kind: 'file.read' | 'file.applied' | 'file.rejected';
  path: string;
  /** `data.reason ?? data.status` — the two spellings the spine really uses. */
  reason: string;
}

export interface OperatorSpine {
  sessionId: string;
  lastSeq: number;
  /** `tool.call` events in log order — the spine's only ordering signal. */
  calls: OperatorCall[];
  /** seq of every `assistant.message`/`user.message` — the ONLY turn boundaries. */
  turns: number[];
  /** seq of every `verify.requested` decision event (evidence enrichment). */
  verifyRequested: number[];
  fileEvents: OperatorFileEvent[];
  /** Why this spine cannot answer a question the operator asks (`[]` = full fidelity). */
  limits: string[];
}

/** The spine's own call identity rule (pairToolCalls): callId, else `seq:<n>`. */
export function callIdOf(call: OperatorCall): string {
  return call.callId.length > 0 ? call.callId : `seq:${call.seq}`;
}

/** Build the view from raw envelopes: O(n), pure, defensive reads. */
export function operatorSpine(events: readonly SessionEventEnvelope[]): OperatorSpine {
  const last = events[events.length - 1];
  const spine: OperatorSpine = {
    sessionId: last?.sessionId ?? '',
    lastSeq: last?.seq ?? 0,
    calls: [],
    turns: [],
    verifyRequested: [],
    fileEvents: [],
    limits: [],
  };
  const byCallId = new Map<string, OperatorCall>();
  for (const e of events) {
    if (e.kind === 'tool.call') {
      const raw = e.data.args;
      const args = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
      const call: OperatorCall = { seq: e.seq, callId: asString(e.data.callId), tool: asString(e.data.tool), args, path: asString(args.path) };
      spine.calls.push(call);
      if (call.callId.length > 0) byCallId.set(call.callId, call);
    } else if (e.kind === 'tool.result') {
      const call = byCallId.get(asString(e.data.callId));
      if (call !== undefined) {
        call.resultSeq = e.seq;
        if (typeof e.data.ok === 'boolean') call.ok = e.data.ok;
      }
    } else if (e.kind === 'assistant.message' || e.kind === 'user.message') {
      spine.turns.push(e.seq);
    } else if (e.kind === 'verify.requested') {
      spine.verifyRequested.push(e.seq);
    } else if (e.kind === 'file.read' || e.kind === 'file.applied' || e.kind === 'file.rejected') {
      spine.fileEvents.push({ seq: e.seq, kind: e.kind, path: asString(e.data.path), reason: asString(e.data.reason) || asString(e.data.status) });
    }
  }
  return spine;
}

/** The projection degrade, named once (report + tests read the same string). */
export const PROJECTION_LIMIT =
  'buildProjection() is not enough: it drops tool.call events (deriveMessages omits them) and never projects ' +
  'file.read/applied/rejected — no call order, no write lifecycle ⇒ nothing derivable, no guessing (P1)';

/** DEGRADED view from a projection alone: turns are recoverable, call order and file
 * events are NOT. Empty call/file sets plus the reason. */
export function operatorSpineFromProjection(projection: SessionProjection): OperatorSpine {
  return {
    sessionId: projection.sessionId,
    lastSeq: projection.lastSeq,
    calls: [],
    turns: projection.messages.filter((m) => m.role === 'assistant' || m.role === 'user').map((m) => m.seq),
    verifyRequested: [],
    fileEvents: [],
    limits: [PROJECTION_LIMIT],
  };
}

/** Every ref in `holders[].evidence` that does NOT resolve on this spine
 * (`[] ⇒ all verifiable`). Structural parameter: any proposal shape fits. */
export function unresolvedRefs(holders: readonly { evidence: readonly SpineRef[] }[], spine: OperatorSpine): string[] {
  const ids = new Set(spine.calls.map(callIdOf));
  const seqs = new Set<number>(spine.turns);
  for (const c of spine.calls) {
    seqs.add(c.seq);
    if (c.resultSeq !== undefined) seqs.add(c.resultSeq);
  }
  for (const f of spine.fileEvents) seqs.add(f.seq);
  for (const s of spine.verifyRequested) seqs.add(s);
  const bad: string[] = [];
  for (const holder of holders) {
    for (const e of holder.evidence) {
      const ok = e.ref.startsWith('call:')
        ? ids.has(e.ref.slice(5))
        : e.ref.startsWith('seq:')
          ? seqs.has(Number(e.ref.slice(4)))
          : false;
      if (!ok) bad.push(e.ref);
    }
  }
  return bad;
}
