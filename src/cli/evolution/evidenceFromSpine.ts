/**
 * evidenceFromSpine — deterministic EvidenceRefs from the session spine (t44,
 * ADR-0023/0016/0024). The spine is the only model-context source; tool calls
 * recorded there are the traceable evidence backing synthesis claims.
 *
 * Judge-safe by construction: this module only READS session events and maps
 * `tool.call` / `tool.result` (the event vocabulary tools/eval spineEvidence
 * already consumes) to `tool-output` EvidenceRefs. It never grades anything —
 * grading stays in the honesty lint; proposing stays in tools/eval (P1).
 *
 * The returned shape is structurally identical to core's EvidenceRef
 * (seq/tier/ref/capturedAt[/digest]) on purpose: no import from core here so
 * the CLI surface stays independent of core's export map.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { sessionsDir } from '../paths.js';

/** EvidenceRef-compatible view (tier is always 'tool-output' here). */
export interface SpineEvidenceRef {
  seq?: number;
  tier: 'tool-output';
  ref: string;
  capturedAt: number;
  digest?: string;
}

/** Hard cap — a runaway session must not flood the honesty lint. */
export const MAX_EVIDENCE_REFS = 400;

/** Spine event types that capture a real tool interaction. */
const TOOL_EVENT_TYPES = new Set(['tool.call', 'tool.result']);

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

/**
 * Pure: JSONL lines → EvidenceRefs. Tolerant (corrupt lines skipped),
 * deterministic (same lines ⇒ same refs), capped at MAX_EVIDENCE_REFS.
 */
export function evidenceRefsFromEventLines(lines: readonly string[]): SpineEvidenceRef[] {
  const out: SpineEvidenceRef[] = [];
  for (const line of lines) {
    if (out.length >= MAX_EVIDENCE_REFS) break;
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue; // corrupt line — skip
    }
    const rec = asRecord(parsed);
    if (!rec) continue;
    const type = typeof rec.type === 'string' ? rec.type : undefined;
    if (!type || !TOOL_EVENT_TYPES.has(type)) continue;
    const data = asRecord(rec.data) ?? rec;
    const tool = typeof data.tool === 'string' && data.tool ? data.tool : undefined;
    if (!tool) continue;
    const callId = typeof data.toolCallId === 'string' && data.toolCallId ? data.toolCallId : undefined;
    const at = typeof rec.at === 'number' ? rec.at : typeof data.at === 'number' ? data.at : 0;
    const outRef: SpineEvidenceRef = {
      tier: 'tool-output',
      ref: callId ? `${tool}:${callId}` : tool,
      capturedAt: at,
    };
    if (typeof rec.seq === 'number' && rec.seq > 0) outRef.seq = rec.seq;
    if (typeof data.digest === 'string') outRef.digest = data.digest;
    out.push(outRef);
  }
  return out;
}

/**
 * Read `<sessionsDir>/<sessionId>/events.jsonl` and collect traceable
 * EvidenceRefs for the honesty lint. Fail-open: any error ⇒ empty list (the
 * lint falls back to its legacy heuristic, never blocks the run).
 */
export function collectSessionEvidenceRefs(sessionId: string): SpineEvidenceRef[] {
  try {
    const file = path.join(sessionsDir(), sessionId, 'events.jsonl');
    if (!existsSync(file)) return [];
    return evidenceRefsFromEventLines(readFileSync(file, 'utf8').split('\n'));
  } catch {
    return []; // fail-open — telemetry, never a gate
  }
}
