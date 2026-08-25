/**
 * Observer / Intervention runtime — shared contracts (Frontier upgrade, PHASE 1).
 *
 * A provider-neutral, in-process complement to the external lifecycle hooks
 * (`core/hooks`). Observers run inside the agent loop and return typed
 * interventions without mutating global state. The runtime core stays neutral:
 * observers are opt-in and must not throw for ordinary policy decisions.
 *
 * Naming note: the role type here is `RuntimeAgentRole` because `AgentRole` is
 * already an exported council-role interface (`types/legacy.ts`).
 */

/** Which agent a runtime event belongs to. */
export type RuntimeAgentRole =
  | 'lead'
  | 'explore'
  | 'general'
  | 'verify'
  | 'planner'
  | 'council'
  | 'mission';

export interface RuntimeIdentity {
  runId: string;
  agentId: string;
  parentAgentId?: string;
  role: RuntimeAgentRole;
  mode: 'kraken' | 'council' | 'zelari';
  model?: string;
  provider?: string;
  graphNodeId?: string;
}

/** Fields shared by every observer event. */
export interface RuntimeEventBase {
  id: string;
  ts: number;
  identity: RuntimeIdentity;
  turn: number;
}

export interface RunStartEvent extends RuntimeEventBase {}

export interface ModelAttemptEvent extends RuntimeEventBase {}

export interface ModelDeltaEvent extends RuntimeEventBase {
  delta: string;
}

export interface ModelResponseEvent extends RuntimeEventBase {}

export interface ToolCallEvent extends RuntimeEventBase {
  toolCallId: string;
  toolName: string;
  args: unknown;
}

export interface ToolResultEvent extends RuntimeEventBase {
  toolCallId: string;
  toolName: string;
  result: unknown;
  ok: boolean;
}

export interface TurnEndEvent extends RuntimeEventBase {}

export interface RunEndEvent extends RuntimeEventBase {
  reason: 'completed' | 'cancelled' | 'error';
}

export interface RunCancelledEvent extends RuntimeEventBase {
  reason?: string;
}

/** A message an observer injects back into the agent conversation. */
export interface RuntimeInjectedMessage {
  role: 'system' | 'user';
  kind: string;
  content: string;
}

/** Explicit decision an observer returns. Never mutate global state inline. */
export type ObserverResult =
  | { action: 'continue' }
  | { action: 'retry'; reason?: string; consumeTurn?: boolean }
  | { action: 'stop'; reason: string; code?: string }
  | { action: 'replace'; content: unknown }
  | { action: 'inject'; message: RuntimeInjectedMessage }
  | { action: 'deny_tool'; reason: string };

export const CONTINUE: ObserverResult = { action: 'continue' };

/** Observer callbacks on the agent loop. */
export interface AgentObserver {
  onRunStart?(event: RunStartEvent): ObserverResult | Promise<ObserverResult>;
  onModelAttempt?(event: ModelAttemptEvent): ObserverResult | Promise<ObserverResult>;
  onModelDelta?(event: ModelDeltaEvent): ObserverResult | Promise<ObserverResult>;
  onModelResponse?(event: ModelResponseEvent): ObserverResult | Promise<ObserverResult>;
  onToolCall?(event: ToolCallEvent): ObserverResult | Promise<ObserverResult>;
  onToolResult?(event: ToolResultEvent): ObserverResult | Promise<ObserverResult>;
  onTurnEnd?(event: TurnEndEvent): ObserverResult | Promise<ObserverResult>;
  onRunEnd?(event: RunEndEvent): ObserverResult | Promise<ObserverResult>;
  onCancelled?(event: RunCancelledEvent): ObserverResult | Promise<ObserverResult>;
}

/**
 * How the bus treats an observer that throws.
 *  - `ignore`      → swallow, continue
 *  - `warn`        → log + continue
 *  - `fail-closed` → emit a stop intervention (safety-critical observers)
 */
export type ObserverFailureMode = 'ignore' | 'warn' | 'fail-closed';

export interface ObserverDescriptor {
  id: string;
  /** Lower runs first. 10 = authorization/safety, 90 = metrics. */
  priority: number;
  failureMode: ObserverFailureMode;
  observer: AgentObserver;
}
