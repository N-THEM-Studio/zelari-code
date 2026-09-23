/**
 * session/exportAtif.ts — ATIF (Agent Trajectory Interchange Format) v0.1 export.
 *
 * Converts a Zelari session spine into an ATIF trajectory for cross-agent
 * eval comparison (Terminal-Bench 4.0 lineage). This is a BEST-EFFORT mapping:
 * the ATIF schema is evolving and this export is an unstable surface.
 *
 * ATIF v0.1 structure:
 * - metadata: agent identity, session, model, timing
 * - steps: ordered sequence of user messages, tool calls, tool results, and
 *   assistant messages — the observable trajectory
 *
 * @see .zelari/docs/2026-09-21-piano-roi-steal-unreal-agent.md §A4
 * @see tools/eval/runCompetitiveBench.ts (first consumer)
 */

import { pairToolCalls } from './modelSurface.js';
import type { SessionEventEnvelope } from './types.js';
import type { ReplayReport } from './replay.js';
import { buildProjection } from './replay.js';

// ── ATIF types ──────────────────────────────────────────────────────────

export const ATIF_VERSION = '0.1';

/** One observable step in the agent trajectory. */
export type AtifStep =
  | AtifUserMessageStep
  | AtifToolCallStep
  | AtifToolResultStep
  | AtifAssistantMessageStep;

export interface AtifUserMessageStep {
  index: number;
  type: 'user_message';
  content: string;
  ts: number;
}

export interface AtifToolCallStep {
  index: number;
  type: 'tool_call';
  tool: string;
  callId: string;
  input: Record<string, unknown>;
  ts: number;
}

export interface AtifToolResultStep {
  index: number;
  type: 'tool_result';
  tool: string;
  callId: string;
  output: string;
  outputTruncated: boolean;
  durationMs: number;
  isError: boolean;
  ts: number;
}

export interface AtifAssistantMessageStep {
  index: number;
  type: 'assistant_message';
  content: string;
  ts: number;
}

/** The full ATIF trajectory document. */
export interface AtifTrajectory {
  atifVersion: typeof ATIF_VERSION;
  metadata: {
    agent: string;
    agentVersion: string;
    sessionId: string;
    model?: string;
    provider?: string;
    startedAt?: number;
    endedAt?: number;
    totalSteps: number;
    toolCalls: number;
    toolResults: number;
    userMessages: number;
    assistantMessages: number;
    issues: number;
  };
  steps: AtifStep[];
}

// ── Export options ──────────────────────────────────────────────────────

export interface AtifExportOptions {
  /** Agent identifier (default: "zelari-code"). */
  agent?: string;
  /** Agent version string. */
  agentVersion?: string;
  /** Max output length per tool result before truncation (default: 8192). */
  maxOutputLength?: number;
}

// ── Export function ─────────────────────────────────────────────────────

/**
 * Convert a replay report (events + issues) into an ATIF v0.1 trajectory.
 *
 * This function is pure: it takes events in memory and produces the ATIF
 * document. Use `exportAtifFromStore` for the store-backed convenience path.
 */
export function exportAtif(
  events: readonly SessionEventEnvelope[],
  issues: readonly { type: string }[] = [],
  opts?: AtifExportOptions,
): AtifTrajectory {
  const agent = opts?.agent ?? 'zelari-code';
  const agentVersion = opts?.agentVersion ?? '0.0.0';
  const maxOutput = opts?.maxOutputLength ?? 8192;

  const steps: AtifStep[] = [];
  let idx = 0;
  let toolCalls = 0;
  let toolResults = 0;
  let userMessages = 0;
  let assistantMessages = 0;

  // Build a callId→tool map from tool.call events for result attribution.
  const callToolMap = new Map<string, string>();
  for (const e of events) {
    if (e.kind === 'tool.call' && typeof e.data.callId === 'string') {
      callToolMap.set(e.data.callId, String(e.data.tool ?? ''));
    }
  }

  // Walk model-surface events in seq order.
  for (const e of events) {
    const d = e.data;
    switch (e.kind) {
      case 'user.message':
        steps.push({
          index: idx++,
          type: 'user_message',
          content: String(d.text ?? ''),
          ts: e.ts,
        });
        userMessages++;
        break;

      case 'assistant.message':
        steps.push({
          index: idx++,
          type: 'assistant_message',
          content: String(d.text ?? ''),
          ts: e.ts,
        });
        assistantMessages++;
        break;

      case 'tool.call': {
        const callId = String(d.callId ?? '');
        steps.push({
          index: idx++,
          type: 'tool_call',
          tool: String(d.tool ?? ''),
          callId,
          input: (typeof d.args === 'object' && d.args !== null
            ? d.args
            : {}) as Record<string, unknown>,
          ts: e.ts,
        });
        toolCalls++;
        break;
      }

      case 'tool.result': {
        const callId = String(d.callId ?? '');
        const rawOutput = String(d.output ?? '');
        const truncated = rawOutput.length > maxOutput;
        steps.push({
          index: idx++,
          type: 'tool_result',
          tool: callToolMap.get(callId) ?? '',
          callId,
          output: truncated ? rawOutput.slice(0, maxOutput) : rawOutput,
          outputTruncated: truncated,
          durationMs: typeof d.durationMs === 'number' ? d.durationMs : 0,
          isError: d.ok === false,
          ts: e.ts,
        });
        toolResults++;
        break;
      }
    }
  }

  // Metadata: extract timing from session lifecycle events.
  const startedAt = events.find((e) => e.kind === 'session.started')?.ts;
  const endedAt = events.find((e) => e.kind === 'session.ended')?.ts;
  const sessionId = events[0]?.sessionId ?? '';

  // Best-effort model/provider from harness_manifest (if present).
  const manifest = events.find((e) => e.kind === 'session.harness_manifest');
  const manifestData = manifest?.data as Record<string, unknown> | undefined;
  const manifestObj =
    typeof manifestData?.manifest === 'object' && manifestData.manifest !== null
      ? (manifestData.manifest as Record<string, unknown>)
      : undefined;
  const model = typeof manifestObj?.model === 'string' ? manifestObj.model : undefined;
  const provider =
    typeof manifestObj?.provider === 'string' ? manifestObj.provider : undefined;

  return {
    atifVersion: ATIF_VERSION,
    metadata: {
      agent,
      agentVersion,
      sessionId,
      model,
      provider,
      startedAt,
      endedAt,
      totalSteps: steps.length,
      toolCalls,
      toolResults,
      userMessages,
      assistantMessages,
      issues: issues.length,
    },
    steps,
  };
}

// ── Store-backed convenience ────────────────────────────────────────────

/**
 * Export a session from the store as an ATIF trajectory.
 *
 * @param store - the session store
 * @param sessionId - target session
 * @param opts - export options
 */
export async function exportAtifFromStore(
  store: { read(sessionId: string): Promise<ReplayReport> },
  sessionId: string,
  opts?: AtifExportOptions,
): Promise<AtifTrajectory> {
  const report = await store.read(sessionId);
  return exportAtif(report.events, report.issues, opts);
}

/** Pretty-printed JSON ATIF export. */
export async function exportAtifJson(
  store: { read(sessionId: string): Promise<ReplayReport> },
  sessionId: string,
  opts?: AtifExportOptions,
): Promise<string> {
  const trajectory = await exportAtifFromStore(store, sessionId, opts);
  return JSON.stringify(trajectory, null, 2);
}
