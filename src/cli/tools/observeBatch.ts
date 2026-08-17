/**
 * observe_batch — N independent read-only observations in ONE round-trip.
 * 2026-07 context-growth plan, Fase 1 ("micro Code Mode").
 *
 * Instead of 3+ sequential read_file/grep_content/list_files calls (each
 * dumping a full payload into the context), the model declares a batch of
 * independent observe operations; this tool executes them in parallel
 * (chunked, like AgentHarness.executePendingTools) and returns, by default,
 * a DETERMINISTIC evidence projection per op (counts, ranges, top matches)
 * built from the Fase-0 Ground Truth meta — zero LLM summarization involved.
 *
 * Guarantees:
 *  - failures are isolated per operation (batch never throws for op errors);
 *  - every op's args are validated against the underlying tool's zod schema
 *    (defaults applied) before execution;
 *  - reuses the sandbox + permission + result-cache wrapped tools from
 *    toolRegistry, so path checks/audit/dedup come for free;
 *  - aggregate output cap with EXPLICIT truncation markers (never silent);
 *  - evidence projection is pure: same (args, value, meta) → byte-identical
 *    JSON (prefix-cache safe, Fase 2 will rely on this).
 *
 * Env: ZELARI_OBSERVE_BATCH=0 disables registration (A/B vs Fase M baseline);
 *      ZELARI_OBSERVE_OP_TIMEOUT_MS per-op timeout (default 15000);
 *      ZELARI_MAX_PARALLEL_TOOLS chunk width (default 6, shared with harness).
 */
import { z } from 'zod';
import type {
  ToolDefinition,
  ToolContext,
  ToolResultMeta,
  TypedResult,
} from '@zelari/core/harness/tools/toolTypes';
import { typedOk } from '@zelari/core/harness/tools/toolTypes';

export const MAX_OPERATIONS = 8;
export const AGGREGATE_CAP_BYTES = 48 * 1024;
export const DEFAULT_PER_OP_TIMEOUT_MS = 15_000;
const TOP_MATCHES = 5;
const LIST_SAMPLE = 10;

/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
type AnyTool = ToolDefinition<any, any>;

export type ObserveToolName = 'read_file' | 'grep_content' | 'list_files';

export interface ObserveBatchDeps {
  /** Pre-wrapped safe tools (sandbox + permissions + result cache). */
  tools: Record<ObserveToolName, AnyTool>;
}

// ---------------------------------------------------------------------------
// Evidence projection (deterministic, zero-LLM)
// ---------------------------------------------------------------------------

export interface GrepEvidence {
  tool: 'grep_content';
  pattern: string;
  matches: number;
  top: string[];
  filesWalked?: number;
  truncated?: boolean;
}

export interface ReadFileEvidence {
  tool: 'read_file';
  path: string;
  totalLines: number;
  readLines: { start: number; end: number };
  sizeBytes: number;
  truncated?: boolean;
}

export interface ListFilesEvidence {
  tool: 'list_files';
  dir: string;
  entries: number;
  sample: string[];
  truncated?: boolean;
}

export type EvidenceProjection = GrepEvidence | ReadFileEvidence | ListFilesEvidence;

/**
 * Pure projection of a tool result onto compact evidence. Reads Fase-0 meta
 * counts first, falls back to the value. Same inputs → byte-identical output.
 */
export function projectEvidence(
  tool: ObserveToolName,
  parsedArgs: Record<string, unknown>,
  value: unknown,
  meta?: ToolResultMeta,
): EvidenceProjection {
  switch (tool) {
    case 'grep_content': {
      const v = (value ?? {}) as {
        matches?: Array<{ relPath?: string; line?: number }>;
        totalMatches?: number;
        filesWalked?: number;
        truncated?: boolean;
      };
      const ev: GrepEvidence = {
        tool: 'grep_content',
        pattern: typeof parsedArgs.pattern === 'string' ? parsedArgs.pattern : '',
        matches: meta?.counts?.matches ?? v.totalMatches ?? v.matches?.length ?? 0,
        top: (v.matches ?? [])
          .slice(0, TOP_MATCHES)
          .map((m) => `${m.relPath ?? '?'}:${m.line ?? '?'}`),
      };
      const fw = meta?.counts?.filesWalked ?? v.filesWalked;
      if (fw !== undefined) ev.filesWalked = fw;
      if (meta?.truncated || v.truncated) ev.truncated = true;
      return ev;
    }
    case 'read_file': {
      const v = (value ?? {}) as {
        path?: string;
        totalLines?: number;
        readLines?: { start?: number; end?: number };
        sizeBytes?: number;
      };
      const ev: ReadFileEvidence = {
        tool: 'read_file',
        path: typeof v.path === 'string' ? v.path : String(parsedArgs.path ?? ''),
        totalLines: v.totalLines ?? -1,
        readLines: { start: v.readLines?.start ?? -1, end: v.readLines?.end ?? -1 },
        sizeBytes: v.sizeBytes ?? 0,
      };
      if (meta?.truncated) ev.truncated = true;
      return ev;
    }
    case 'list_files': {
      const v = (value ?? {}) as {
        dir?: string;
        entries?: Array<{ name?: string; type?: string }>;
        truncated?: boolean;
      };
      const ev: ListFilesEvidence = {
        tool: 'list_files',
        dir: typeof v.dir === 'string' ? v.dir : String(parsedArgs.path ?? ''),
        entries: meta?.counts?.filesWalked ?? v.entries?.length ?? 0,
        sample: (v.entries ?? [])
          .slice(0, LIST_SAMPLE)
          .map((e) => (e.type === 'directory' ? `${e.name}/` : String(e.name))),
      };
      if (meta?.truncated || v.truncated) ev.truncated = true;
      return ev;
    }
  }
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const OperationSchema = z.object({
  /** Caller-chosen identifier, echoed in results (unique within the batch). */
  id: z.string().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/, 'id: only [A-Za-z0-9._-] allowed'),
  tool: z.enum(['read_file', 'grep_content', 'list_files']),
  /** Args of the underlying tool; validated by that tool's own schema. */
  args: z.record(z.string(), z.unknown()).optional(),
});

export const ObserveBatchArgsSchema = z.object({
  operations: z
    .array(OperationSchema)
    .min(1, 'at least one operation required')
    .max(MAX_OPERATIONS, `at most ${MAX_OPERATIONS} operations per batch`)
    .refine((ops) => new Set(ops.map((o) => o.id)).size === ops.length, {
      message: 'operation ids must be unique within the batch',
    }),
  /**
   * 'evidence' (default): only the compact deterministic projection enters
   * the context. 'raw': full payloads, under the aggregate byte cap.
   */
  resultMode: z.enum(['raw', 'evidence']).default('evidence'),
});

export type ObserveBatchArgs = z.infer<typeof ObserveBatchArgsSchema>;

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export interface ObservationEntry {
  id: string;
  tool: ObserveToolName;
  status: ToolResultMeta['status'] | 'unknown';
  durationMs: number;
  /** UTF-8 bytes of the payload actually included (raw or evidence). */
  bytes: number;
  evidence: EvidenceProjection;
  warnings?: string[];
  truncated?: boolean;
  /** Present iff resultMode='raw' AND the aggregate cap allowed it. */
  raw?: unknown;
  /** Raw payload skipped by the aggregate cap (explicit, never silent). */
  rawOmitted?: boolean;
}

export interface FailureEntry {
  id: string;
  tool?: ObserveToolName;
  error: string;
}

export interface ObserveBatchResult {
  resultMode: 'raw' | 'evidence';
  observations: ObservationEntry[];
  failures: FailureEntry[];
  totals: { ops: number; ok: number; failed: number; bytes: number; wallMs: number };
  truncated: boolean;
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();
function utf8Bytes(s: string): number {
  return encoder.encode(s).length;
}

function zodMessage(err: unknown): string {
  if (err instanceof z.ZodError) return err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
  return err instanceof Error ? err.message : String(err);
}

type OpOutcome =
  | { idx: number; observation: Omit<ObservationEntry, 'bytes' | 'raw' | 'rawOmitted'> & { rawBytes: number; raw: unknown } }
  | { idx: number; failure: FailureEntry };

async function runOperation(
  op: { id: string; tool: ObserveToolName; args?: Record<string, unknown> },
  idx: number,
  ctx: ToolContext,
  deps: ObserveBatchDeps,
  perOpTimeoutMs: number,
): Promise<OpOutcome> {
  const tool = deps.tools[op.tool];
  let parsed: Record<string, unknown>;
  try {
    parsed = tool.inputSchema.parse(op.args ?? {}) as Record<string, unknown>;
  } catch (err) {
    return { idx, failure: { id: op.id, tool: op.tool, error: `invalid args: ${zodMessage(err)}` } };
  }

  const ac = new AbortController();
  const onParentAbort = () => ac.abort();
  if (ctx.signal.aborted) return { idx, failure: { id: op.id, tool: op.tool, error: 'cancelled: parent signal aborted' } };
  ctx.signal.addEventListener('abort', onParentAbort, { once: true });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const started = Date.now();
  try {
    timer = setTimeout(() => ac.abort(), perOpTimeoutMs);
    const execP = tool.execute(parsed, { ...ctx, signal: ac.signal });
    execP.catch(() => {}); // a post-timeout AbortError must not become unhandled
    const timeoutP = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`TIMEOUT after ${perOpTimeoutMs}ms`)), perOpTimeoutMs);
    });
    const result: TypedResult<unknown> = await Promise.race([execP, timeoutP]);
    if (!result.ok) {
      return { idx, failure: { id: op.id, tool: op.tool, error: result.error } };
    }
    const meta = result.meta;
    const evidence = projectEvidence(op.tool, parsed, result.value, meta);
    const rawStr = JSON.stringify(result.value) ?? 'null';
    return {
      idx,
      observation: {
        id: op.id,
        tool: op.tool,
        status: meta?.status ?? 'unknown',
        durationMs: Date.now() - started,
        warnings: meta?.warnings,
        truncated: meta?.truncated,
        evidence,
        raw: result.value,
        rawBytes: utf8Bytes(rawStr),
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const error = /TIMEOUT/.test(msg) || Date.now() - started >= perOpTimeoutMs
      ? `TIMEOUT after ${perOpTimeoutMs}ms`
      : msg;
    return { idx, failure: { id: op.id, tool: op.tool, error } };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    ctx.signal.removeEventListener('abort', onParentAbort);
  }
}

/** Build the observe_batch tool from the registry's safe wrapped tools. */
export function createObserveBatchTool(
  deps: ObserveBatchDeps,
): ToolDefinition<ObserveBatchArgs, ObserveBatchResult> {
  return {
    name: 'observe_batch',
    description:
      'Run multiple independent read-only observations (read_file, grep_content, list_files) in ONE round-trip. ' +
      'PREFER this over 3+ sequential read/grep/list calls when exploring multiple targets at once ' +
      '(e.g. map a subsystem: list a dir + grep a symbol + read two line ranges). ' +
      'Default resultMode "evidence" keeps only compact deterministic evidence in context (counts, ranges, top matches); ' +
      'resultMode "raw" returns full payloads under an aggregate byte cap (truncation is explicit, never silent). ' +
      'Operations run in parallel and MUST be independent (no ordering between them); per-operation failures are ' +
      'isolated and reported in `failures`. Not for writes or ordered steps — use the single tools for those.',
    permissions: ['read'],
    timeoutMs: 60_000,
    inputSchema: ObserveBatchArgsSchema,
    execute: async (input, ctx) => {
      const t0 = Date.now();
      const maxParallel = Math.max(
        1,
        Number.parseInt(process.env.ZELARI_MAX_PARALLEL_TOOLS ?? '6', 10) || 6,
      );
      const perOpTimeout = Math.max(
        100,
        Number.parseInt(
          process.env.ZELARI_OBSERVE_OP_TIMEOUT_MS ?? String(DEFAULT_PER_OP_TIMEOUT_MS),
          10,
        ) || DEFAULT_PER_OP_TIMEOUT_MS,
      );

      const outcomes: OpOutcome[] = [];
      const ops = input.operations;
      for (let i = 0; i < ops.length; i += maxParallel) {
        const chunk = ops.slice(i, i + maxParallel);
        const results = await Promise.all(
          chunk.map((op, j) => runOperation(op, i + j, ctx, deps, perOpTimeout)),
        );
        outcomes.push(...results);
      }
      outcomes.sort((a, b) => a.idx - b.idx);

      const observations: ObservationEntry[] = [];
      const failures: FailureEntry[] = [];
      // Aggregate cap: raw payloads included in input order while the budget
      // lasts; later ones get an explicit rawOmitted marker (never silent).
      let budget = AGGREGATE_CAP_BYTES;
      let truncated = false;
      for (const o of outcomes) {
        if ('failure' in o) {
          failures.push(o.failure);
          continue;
        }
        // Strip the transport-only raw fields: what enters the result entry
        // (and therefore the context) is decided HERE, explicitly.
        const { raw, rawBytes, ...rest } = o.observation;
        const evBytes = utf8Bytes(JSON.stringify(rest.evidence) ?? 'null');
        if (input.resultMode === 'raw' && !truncated && rawBytes <= budget) {
          budget -= rawBytes;
          observations.push({ ...rest, bytes: rawBytes, raw });
        } else if (input.resultMode === 'raw') {
          truncated = true;
          observations.push({ ...rest, bytes: evBytes, rawOmitted: true });
        } else {
          observations.push({ ...rest, bytes: evBytes });
        }
      }

      const totalBytes = observations.reduce((s, o) => s + o.bytes, 0);
      const status: ToolResultMeta['status'] =
        failures.length === 0 ? 'complete' : observations.length === 0 ? 'failed' : 'partial';
      return typedOk(
        {
          resultMode: input.resultMode,
          observations,
          failures,
          totals: {
            ops: ops.length,
            ok: observations.length,
            failed: failures.length,
            bytes: totalBytes,
            wallMs: Date.now() - t0,
          },
          truncated,
        },
        {
          status,
          counts: { bytes: totalBytes },
          ...(truncated ? { truncated: true } : {}),
        },
      );
    },
  };
}
