/**
 * Crash-safe tool recovery (Zelari 2.x workstream B).
 *
 * A session may stop between tool.call and tool.result. Read-only calls are
 * retry-safe; mutating calls are inspect-first (never retried blindly).
 */

import type { SessionEventEnvelope } from './types.js';
import { pairToolCalls } from './modelSurface.js';

export type InterruptedToolState = 'not-started' | 'started-outcome-unknown';
export type ToolRetrySafety = 'safe' | 'inspect-first';
export type ToolSideEffect = 'none' | 'local' | 'external';

export interface ToolInterrupted {
  toolCallSeq: number;
  callId: string;
  tool: string;
  state: InterruptedToolState;
  retrySafety: ToolRetrySafety;
  sideEffect: ToolSideEffect;
}

const READ_ONLY = new Set([
  'read_file',
  'list_files',
  'grep_content',
  'show_diff',
  'web_search',
  'fetch_url',
  'lsp_definition',
  'lsp_references',
  'lsp_hover',
  'lsp_symbols',
  'ast_outline',
  'ast_find_symbol',
  'semantic_search',
]);

const EXTERNAL = new Set(['fetch_url', 'web_search']);

export function sideEffectForTool(tool: string, declared?: ToolSideEffect): ToolSideEffect {
  if (declared) return declared;
  if (EXTERNAL.has(tool)) return 'external';
  if (READ_ONLY.has(tool)) return 'none';
  return 'local';
}

export function retrySafetyForSideEffect(sideEffect: ToolSideEffect): ToolRetrySafety {
  return sideEffect === 'none' ? 'safe' : 'inspect-first';
}

function toolNameOf(call: SessionEventEnvelope): string {
  return typeof call.data.tool === 'string' && call.data.tool.trim()
    ? call.data.tool
    : 'unknown';
}

function callIdOf(call: SessionEventEnvelope): string {
  return typeof call.data.callId === 'string' ? call.data.callId : `seq:${call.seq}`;
}

/**
 * Dangling tool.call events (no matching tool.result). Read-only → not-started
 * + retry-safe. Mutating/external → started-outcome-unknown + inspect-first.
 */
export function classifyInterruptedTools(
  events: readonly SessionEventEnvelope[],
  sideEffects: ReadonlyMap<string, ToolSideEffect> = new Map(),
): ToolInterrupted[] {
  const alreadyClassified = new Set(
    events
      .filter((e) => e.kind === 'tool.interrupted')
      .map((e) => (typeof e.data.callId === 'string' ? e.data.callId : undefined))
      .filter((id): id is string => Boolean(id)),
  );
  const out: ToolInterrupted[] = [];
  for (const pair of pairToolCalls(events)) {
    if (pair.result) continue;
    const callId = callIdOf(pair.call);
    if (alreadyClassified.has(callId)) continue;
    const tool = toolNameOf(pair.call);
    const sideEffect = sideEffectForTool(tool, sideEffects.get(tool));
    const retrySafety = retrySafetyForSideEffect(sideEffect);
    out.push({
      toolCallSeq: pair.call.seq,
      callId,
      tool,
      state: retrySafety === 'safe' ? 'not-started' : 'started-outcome-unknown',
      retrySafety,
      sideEffect,
    });
  }
  return out;
}

/** Payload for a state-only `tool.interrupted` spine event. */
export function interruptedEventData(item: ToolInterrupted): Record<string, unknown> {
  return {
    toolCallSeq: item.toolCallSeq,
    callId: item.callId,
    tool: item.tool,
    state: item.state,
    retrySafety: item.retrySafety,
    sideEffect: item.sideEffect,
  };
}
