/**
 * retrieve_observation — rematerialize a projected tool result by seq.
 * 2026-07 context-growth plan, Fase 2.
 *
 * The model sees `OBSERVATION ref=#N … [retrieve_observation #N]` after the
 * SessionSurface projector replaces a cold/oversized tool body. This tool
 * reads the ORIGINAL body from the append-only session JSONL.
 *
 * Permissions: `read`. Never mutates the log. Refuses to re-project a stub
 * (the log is the only source — if the log itself were a stub, something
 * wrote the surface back into the transcript, which we treat as an error).
 *
 * Kill switch: ZELARI_SESSION_SURFACE=0 skips registration.
 */
import { z } from 'zod';
import { typedOk, typedErr, type ToolDefinition, type ToolContext } from '@zelari/core/harness/tools/toolTypes';
import { getObservationBySeq } from '../hooks/observationStore.js';
import { isObservationStub } from '../hooks/sessionSurface.js';
import { getSessionBaseDir } from '../sessionManager.js';

export const RetrieveObservationArgsSchema = z.object({
  /**
   * 1-based observation seq from `OBSERVATION ref=#N`, or the literal
   * `#N` / `ref=#N` form the model may copy from the stub.
   */
  seq: z.union([z.number().int().positive(), z.string().min(1)]).describe(
    'Observation seq (e.g. 12 or "#12") from OBSERVATION ref=#N',
  ),
});

export type RetrieveObservationArgs = z.infer<typeof RetrieveObservationArgsSchema>;

export interface RetrieveObservationResult {
  seq: number;
  tool?: string;
  isError: boolean;
  durationMs: number;
  bytes: number;
  result: string;
}

const SEQ_RE = /(\d+)/;

export function parseSeqRef(raw: number | string): number | null {
  if (typeof raw === 'number' && Number.isInteger(raw) && raw > 0) return raw;
  const m = String(raw).match(SEQ_RE);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export interface RetrieveObservationDeps {
  /** Override session id (tests). Defaults to ctx.sessionId. */
  sessionId?: string;
  /** Override sessions dir (tests). */
  baseDir?: string;
}

export function createRetrieveObservationTool(
  deps: RetrieveObservationDeps = {},
): ToolDefinition<RetrieveObservationArgs, RetrieveObservationResult> {
  return {
    name: 'retrieve_observation',
    description:
      'Rematerialize a previously projected tool result by its observation seq ' +
      '(the N in `OBSERVATION ref=#N`). Use when the stub does not contain ' +
      'enough detail and you need the original body from the session log. ' +
      'Read-only; does not re-run the tool.',
    permissions: ['read'],
    inputSchema: RetrieveObservationArgsSchema,
    execute: async (input, ctx: ToolContext) => {
      const seq = parseSeqRef(input.seq);
      if (seq === null) {
        return typedErr('seq must be a positive integer (e.g. 12 or "#12")', {
          status: 'failed',
          warnings: ['INVALID_SEQ'],
        });
      }
      const sessionId = deps.sessionId ?? ctx.sessionId;
      if (!sessionId || sessionId === 'cli') {
        return typedErr(
          `no session id — cannot retrieve observation #${seq} (session log unavailable)`,
          { status: 'failed', warnings: ['NO_SESSION'] },
        );
      }
      const baseDir = deps.baseDir ?? getSessionBaseDir();
      const rec = await getObservationBySeq(sessionId, seq, baseDir);
      if (!rec) {
        return typedErr(
          `observation #${seq} not found in session ${sessionId.slice(0, 8)}… ` +
            `(it may belong to a previous session, or the log has not flushed yet)`,
          { status: 'failed', warnings: ['NOT_FOUND'] },
        );
      }
      if (isObservationStub(rec.result)) {
        return typedErr(
          `observation #${seq} is itself a surface stub — the session log was projected. ` +
            `Refusing to rematerialize a stub (log must stay full-fidelity).`,
          { status: 'failed', warnings: ['STUB_IN_LOG'] },
        );
      }
      return typedOk(
        {
          seq: rec.seq,
          tool: rec.toolName,
          isError: rec.isError,
          durationMs: rec.durationMs,
          bytes: rec.result.length,
          result: rec.result,
        },
        {
          status: rec.isError ? 'failed' : 'complete',
          counts: { bytes: rec.result.length },
        },
      );
    },
  };
}
