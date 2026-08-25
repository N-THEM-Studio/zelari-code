/**
 * Bridge that turns observer events into RunRecorder writes
 * (Frontier PHASE 5). Never intervenes: every hook returns CONTINUE.
 * Model deltas are deliberately not traced (noise; §70 event list).
 */
import { CONTINUE } from '../observers/types.js';
import type {
  AgentObserver,
  ModelAttemptEvent,
  ModelResponseEvent,
  RunCancelledEvent,
  RunEndEvent,
  RunStartEvent,
  ToolCallEvent,
  ToolResultEvent,
  TurnEndEvent,
} from '../observers/types.js';
import { RunRecorder } from './RunRecorder.js';

interface AnyRuntimeEvent {
  id: string;
  ts: number;
  turn: number;
  identity: { agentId: string; role: string; model?: string; provider?: string };
}

function base(event: AnyRuntimeEvent): Record<string, unknown> {
  return {
    id: event.id,
    ts: event.ts,
    turn: event.turn,
    agentId: event.identity.agentId,
    role: event.identity.role,
  };
}

export function createRecorderObserver(recorder: RunRecorder): AgentObserver {
  return {
    onRunStart(event: RunStartEvent) {
      recorder.noteModel(event.identity.role, event.identity.model);
      recorder.start();
      recorder.record({ type: 'run_start', ...base(event) });
      return CONTINUE;
    },

    onModelAttempt(event: ModelAttemptEvent) {
      recorder.bumpModelCall();
      recorder.record({ type: 'model_attempt', ...base(event) });
      return CONTINUE;
    },

    onModelResponse(event: ModelResponseEvent) {
      recorder.record({ type: 'model_response', ...base(event) });
      return CONTINUE;
    },

    onToolCall(event: ToolCallEvent) {
      recorder.bumpToolCall();
      recorder.record({ type: 'tool_call', ...base(event), toolCallId: event.toolCallId, tool: event.toolName });
      return CONTINUE;
    },

    onToolResult(event: ToolResultEvent) {
      if (!event.ok) recorder.bumpToolFailure();
      const line = { type: 'tool_result', ...base(event), toolCallId: event.toolCallId, tool: event.toolName, ok: event.ok };
      recorder.record(line);
      recorder.recordAgent(event.identity.agentId, line);
      return CONTINUE;
    },

    onTurnEnd(event: TurnEndEvent) {
      recorder.bumpTurn();
      recorder.record({ type: 'turn_end', ...base(event) });
      return CONTINUE;
    },

    onRunEnd(event: RunEndEvent) {
      recorder.record({ type: 'run_end', ...base(event), reason: event.reason });
      recorder.finalize(event.reason === 'completed' ? 'completed' : event.reason === 'cancelled' ? 'cancelled' : 'failed');
      return CONTINUE;
    },

    onCancelled(event: RunCancelledEvent) {
      recorder.record({ type: 'run_cancelled', ...base(event), reason: event.reason });
      recorder.finalize('cancelled');
      return CONTINUE;
    },
  };
}
