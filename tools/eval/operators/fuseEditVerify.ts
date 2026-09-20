/**
 * tools/eval/operators/fuseEditVerify.ts — WS7 slice 3 — the FIRST operator of the
 * "proofed harness evolution": `fuse_edit_verify`.
 *
 * A PURE ANALYSER + PROPOSER over ONE session spine (ADR-0016). It re-reads what the
 * harness ALREADY logged and names the two sequences a fused harness would have
 * collapsed into a single decision:
 *
 *   fuse_edit_verify         write call → turn boundary → verify call
 *   reopen_with_minimal_diff file.rejected → re-read → retry write (same path)
 *
 * It never writes, never replays a model, never decides, adds NO tool and touches NO
 * runtime: it is composed ON TOP of what already landed (ADR-0033 `file.*` events +
 * snapshotId anchors) and reads them through `./operatorSpine.ts` (which also owns
 * the honest limits of the spine — read that header before trusting a proposal).
 *
 * ADR-0036: the proposer proposes, the gate judges. `receiptFromProposals` can
 * therefore only emit `hold`/`canary`/`reject` — `promote` is unreachable from here
 * BY CONSTRUCTION (an explicit ask for it is capped, reason kept).
 *
 * APPLYING a fusion (actually running the verify inside the writer's turn) is the
 * CONTROLLER slice: OUT of this one. This module proposes; nothing more.
 *
 * Pure: no I/O, no clock, no network, no writes. Imports: zod + core TYPES + slice 1.
 */
import { z } from 'zod';
import type { SessionEventEnvelope, SessionProjection } from '@zelari/core/session';
import {
  PromotionReceiptSchema,
  resolvePromotionDecision,
  type PromotionDecision,
  type PromotionReceipt,
  type ReceiptEvidence,
} from '../promotionReceipt.ts';
import {
  SpineRefSchema,
  asString,
  callRef,
  callIdOf,
  operatorSpine,
  operatorSpineFromProjection,
  samePath,
  seqRef,
  type OperatorCall,
  type OperatorSpine,
  type SpineRef,
} from './operatorSpine.ts';

export const FUSE_OPERATOR_ID = 'fuse_edit_verify';

export const FUSE_PROPOSAL_KINDS = ['fuse_edit_verify', 'reopen_with_minimal_diff'] as const;
export type FuseProposalKind = (typeof FUSE_PROPOSAL_KINDS)[number];

/**
 * The write side. Beyond the two spec'd names, the live harness also logs aliases
 * (real tally over 1002 local spines: edit 664, edit_file 427, write_file 413,
 * apply_diff 86, plus the MCP twins) — omitting them would blind the operator on most
 * real sessions. Narrow/extend via `FuseOptions.writeTools`.
 */
export const WRITE_TOOL_NAMES: readonly string[] = [
  'edit', 'write_file', 'edit_file', 'apply_diff',
  'mcp_filesystem_edit_file', 'mcp_filesystem_write_file',
];

/** The re-anchor the reject hint demands ("re-read <path>, then retry"). */
const READ_TOOL_NAMES: readonly string[] = ['read_file', 'mcp_filesystem_read_text_file'];

/** Shell tools whose `args.command` may BE the verify. */
const SHELL_TOOL_NAMES: readonly string[] = ['bash', 'exec_process', 'inspect_command'];

/** A verify MEASURES the work. Deliberately narrow: a miss costs one proposal, a
 * false positive invents a fusion (P1). */
const VERIFY_COMMAND_RE =
  /(^|[\s;&|(])(npx\s+)?(vitest|jest|pytest|tsc)\b|\bnpm\s+(run\s+)?(test|typecheck|lint)\b|\b(cargo|go|dotnet)\s+test\b/;

/** Tools that ARE a verify by name (`task agent=verify` is the runtime auto-verify). */
const VERIFY_TOOL_RE = /^(verify|run_tests|typecheck|test)(_|$)/;

/** The reject reasons the reopen operator acts on (ADR-0033 machine statuses). */
export const REOPEN_REASONS: readonly string[] = ['stale_snapshot', 'hunk_mismatch'];

/**
 * How far after its re-read a retry may sit and still be that re-read's retry (in
 * tool calls; real reopen sequences measured at 1..6). Past the bound the operator is
 * silent: an unbounded window would credit any later edit of the same file to the
 * reject — prose, not evidence.
 */
export const MAX_REOPEN_CALLS = 8;

/** Where the fused form would have to live (the controller's job, not ours). */
export const APPLY_NOTE =
  'analyser only: applying the fusion (running the verify inside the writer turn) is the controller slice — OUT here';

/** A proposal's evidence entry IS a spine ref (same schema object, one spelling). */
export const FuseEvidenceSchema = SpineRefSchema;
export type FuseEvidence = SpineRef;

export const FuseProposalSchema = z.object({
  kind: z.enum(FUSE_PROPOSAL_KINDS),
  /** Spine identities of the calls the fused form would replace (`call:<id>`). */
  callIds: z.array(z.string().min(1)).min(1),
  /** Tool calls the fused form removes from THIS spine (counted, not modelled). */
  estSavedCalls: z.number().int().nonnegative(),
  /** Verifiable pointers — checked by `unresolvedRefs` in the tests. */
  evidence: z.array(FuseEvidenceSchema).min(1),
  path: z.string().optional(),
  tool: z.string().optional(),
  /** Deterministic proposal order: the seq the proposal is anchored on. */
  decisiveSeq: z.number().int().positive(),
  note: z.string().optional(),
});
export type FuseProposal = z.infer<typeof FuseProposalSchema>;

function isWrite(call: OperatorCall, writeTools: readonly string[]): boolean {
  return writeTools.includes(call.tool);
}

function isRead(call: OperatorCall): boolean {
  return READ_TOOL_NAMES.includes(call.tool) || call.tool.endsWith('_read_text_file');
}

/** Shell-side command TEXT. `bash`/`inspect_command` carry `command`;
 * `exec_process` carries `{program, args}` — both spellings are on real spines. */
function shellCommand(call: OperatorCall): string {
  const direct = asString(call.args.command);
  if (direct.length > 0) return direct;
  const program = asString(call.args.program);
  const argv = Array.isArray(call.args.args) ? call.args.args.map((a) => asString(a)).join(' ') : '';
  return `${program} ${argv}`.trim();
}

/** The runtime auto-verify tentacle, a by-name verify tool, or a shell call whose
 * command measures the work. */
function isVerify(call: OperatorCall): boolean {
  if (VERIFY_TOOL_RE.test(call.tool)) return true;
  if (call.tool === 'task') return asString(call.args.agent) === 'verify';
  return SHELL_TOOL_NAMES.includes(call.tool) && VERIFY_COMMAND_RE.test(shellCommand(call));
}

const ev = (kind: string, ref: string): FuseEvidence => ({ kind, ref });

/** The write→verify fusion: both calls ADJACENT on the spine, split by a turn
 * boundary the fused form deletes. At most one proposal per verify call. */
function proposeFuse(spine: OperatorSpine, writeTools: readonly string[]): FuseProposal[] {
  const out: FuseProposal[] = [];
  for (let i = 0; i < spine.calls.length - 1; i++) {
    const w = spine.calls[i]!;
    const v = spine.calls[i + 1]!;
    if (!isWrite(w, writeTools) || !isVerify(v) || w.ok === false) continue; // a rejected write is a reopen case
    if (spine.fileEvents.some((f) => f.kind === 'file.rejected' && f.seq > w.seq && f.seq < v.seq)) continue;
    // No turn boundary ⇒ the verify already rides in the writer's turn (same decision
    // batch): that IS the fused form, and it is NOT a candidate.
    const boundary = spine.turns.filter((s) => s > w.seq && s < v.seq).sort((a, b) => a - b)[0];
    if (boundary === undefined) continue;
    const applied = spine.fileEvents.find((f) => f.kind === 'file.applied' && f.seq > w.seq && f.seq < v.seq && samePath(f.path, w.path));
    const asked = spine.verifyRequested.find((s) => s > w.seq && s < v.seq);
    out.push(
      FuseProposalSchema.parse({
        kind: 'fuse_edit_verify',
        callIds: [callIdOf(w), callIdOf(v)],
        estSavedCalls: 1, // one call: the verify, re-issued in its own turn
        evidence: [
          ev('tool.call', callRef(w)),
          ...(w.resultSeq === undefined ? [] : [ev('tool.result', seqRef(w.resultSeq))]),
          ...(applied === undefined ? [] : [ev('file.applied', seqRef(applied.seq))]),
          ev('assistant.message', seqRef(boundary)),
          ...(asked === undefined ? [] : [ev('verify.requested', seqRef(asked))]),
          ev('tool.call', callRef(v)),
        ],
        ...(w.path.length > 0 ? { path: w.path } : {}),
        tool: w.tool,
        decisiveSeq: w.seq,
        note: `verify '${v.tool}' was a separate call in the next turn — ${APPLY_NOTE}`,
      }),
    );
  }
  return out;
}

/** The reject recovery: `file.rejected` → re-read → retry write on the same path.
 * The structured reject already carries the fresh anchor (`actualHash`) and the
 * targeted region (`minimalDiff`), so the re-read its hint demanded is removable ⇒
 * estSavedCalls = 1. The diff is NOT on the spine (see operatorSpine.ts): the
 * proposal POINTS AT the reject event instead of quoting it. */
function proposeReopens(spine: OperatorSpine, writeTools: readonly string[]): FuseProposal[] {
  const out: FuseProposal[] = [];
  for (const reject of spine.fileEvents) {
    if (reject.kind !== 'file.rejected' || !REOPEN_REASONS.includes(reject.reason)) continue;
    const later = spine.calls.filter((c) => c.seq > reject.seq);
    const readAt = later.findIndex((c) => isRead(c) && samePath(c.path, reject.path));
    if (readAt < 0) continue;
    const read = later[readAt]!;
    const retry = later.slice(readAt + 1, readAt + 1 + MAX_REOPEN_CALLS).find((c) => isWrite(c, writeTools) && samePath(c.path, reject.path));
    if (retry === undefined) continue;
    out.push(
      FuseProposalSchema.parse({
        kind: 'reopen_with_minimal_diff',
        callIds: [callIdOf(read), callIdOf(retry)],
        estSavedCalls: 1, // the re-read the reject hint demanded
        evidence: [ev('file.rejected', seqRef(reject.seq)), ev('tool.call', callRef(read)), ev('tool.call', callRef(retry))],
        path: reject.path,
        tool: retry.tool,
        decisiveSeq: reject.seq,
        note: `rejected as '${reject.reason}' then re-read + retried: reopen with the reject's minimalDiff/anchor — ${APPLY_NOTE}`,
      }),
    );
  }
  return out;
}

export type FuseInput = { events: readonly SessionEventEnvelope[] } | { projection: SessionProjection };

export interface FuseOptions {
  /** Override the write side (default `WRITE_TOOL_NAMES`). */
  writeTools?: readonly string[];
}

/** The operator: spine → proposals, deterministically ordered (decisiveSeq, kind). */
export function proposeFusions(input: FuseInput, opts: FuseOptions = {}): FuseProposal[] {
  const spine = 'events' in input ? operatorSpine(input.events) : operatorSpineFromProjection(input.projection);
  const writeTools = opts.writeTools ?? WRITE_TOOL_NAMES;
  return [...proposeFuse(spine, writeTools), ...proposeReopens(spine, writeTools)].sort(
    (a, b) => a.decisiveSeq - b.decisiveSeq || a.kind.localeCompare(b.kind),
  );
}

/** The ask the gate must answer before any decision: replay and re-derive. */
export const OPERATOR_VALIDATION_ASK = 'replay the spine and re-derive the proposals (operator re-run)';

export interface ReceiptFromProposalsInput {
  /** What is judged — a session id, a manifest hash, a proposal id. */
  subject?: string;
  /** Caller-supplied stamp. NO clock in here: the operator stays pure. */
  at?: string;
  operator?: string;
  surface?: string;
  /** Explicit ask. `promote` is CAPPED: a proposer never promotes (ADR-0036). */
  request?: PromotionDecision;
}

/**
 * Proposals → the WS7-slice-1 receipt. Derivation only: the schema and the
 * fail-closed resolver are the ones that already landed, untouched. The default is
 * `hold`, and `promote` is unreachable from here BY CONSTRUCTION — the proposer/judge
 * split, mechanized.
 */
export function receiptFromProposals(proposals: readonly FuseProposal[], input: ReceiptFromProposalsInput = {}): PromotionReceipt {
  const evidence: ReceiptEvidence[] = proposals.flatMap((p) => p.evidence.map((e) => ({ kind: `${p.kind}:${e.kind}`, ref: e.ref })));
  const saved = proposals.reduce((n, p) => n + p.estSavedCalls, 0);
  const reasons: string[] = [];
  let attempt: PromotionDecision = input.request ?? 'hold';
  if (attempt === 'promote') {
    attempt = 'hold';
    reasons.push(`promote refused: ${FUSE_OPERATOR_ID} is a proposer, not the judge (ADR-0036) — the gate re-derives and decides`);
  }
  reasons.push(
    proposals.length === 0
      ? 'no fusion derived from this spine — nothing to promote'
      : `${proposals.length} proposal(s) from ${FUSE_OPERATOR_ID}, est. ${saved} saved call(s) — held until the gate re-derives them`,
  );
  const requiredValidation = [OPERATOR_VALIDATION_ASK];
  const resolved = resolvePromotionDecision(attempt, { evidence, requiredValidation });
  return PromotionReceiptSchema.parse({
    v: 1,
    subject: input.subject ?? FUSE_OPERATOR_ID,
    source: 'decision',
    at: input.at ?? '',
    status: 'proposed',
    decision: resolved.decision,
    reasons: [...reasons, ...resolved.reasons],
    ...(input.operator === undefined ? {} : { operator: input.operator }),
    ...(input.surface === undefined ? {} : { surface: input.surface }),
    requiredValidation,
    evidence,
  });
}
