/**
 * ObserverBus — ordered, failure-mode-aware fan-out to a set of observers.
 *
 * Observers run in ascending priority; each throw is isolated per the
 * descriptor's `failureMode`. `emit` returns the raw result list;
 * `emitResolved` collapses it to a single intervention via
 * {@link resolveInterventions}.
 */
import { CONTINUE } from './types.js';
import { join } from 'node:path';
import type {
  AgentObserver,
  ObserverDescriptor,
  ObserverResult,
} from './types.js';
import { resolveInterventions } from './resolve.js';
import { RepetitionGuard } from '../guards/RepetitionGuard.js';
import { FailureSignatureGuard } from '../guards/FailureSignatureGuard.js';
import { DuplicateSearchGuard } from '../guards/DuplicateSearchGuard.js';
import { NoProgressGuard } from '../guards/NoProgressGuard.js';
import { ReasoningWatchdog } from '../guards/ReasoningWatchdog.js';
import { TraceObserver } from './TraceObserver.js';
import { MetricsObserver } from './MetricsObserver.js';
import { RunRecorder, newRunId, runRecordEnabled } from '../recorder/RunRecorder.js';
import { createRecorderObserver } from '../recorder/recorderObserver.js';
import { SteeringObserver } from '../controls/SteeringObserver.js';
import type { RuntimeControlQueue } from '../controls/RuntimeControlQueue.js';

export interface ObserverBusOptions {
  logger?: (message: string) => void;
}

type HookCallback = (event: unknown) => ObserverResult | Promise<ObserverResult>;

export class ObserverBus {
  private readonly descriptors: ObserverDescriptor[];
  private readonly logger: (message: string) => void;

  constructor(
    descriptors: ObserverDescriptor[] = [],
    options: ObserverBusOptions = {},
  ) {
    this.descriptors = [...descriptors].sort((a, b) => a.priority - b.priority);
    this.logger = options.logger ?? (() => {});
  }

  get size(): number {
    return this.descriptors.length;
  }

  async emit<K extends keyof AgentObserver>(
    hook: K,
    event: Parameters<NonNullable<AgentObserver[K]>>[0],
  ): Promise<ObserverResult[]> {
    const results: ObserverResult[] = [];
    for (const descriptor of this.descriptors) {
      const callback = descriptor.observer[hook] as HookCallback | undefined;
      if (typeof callback !== 'function') continue;
      try {
        const result = await callback.call(descriptor.observer, event);
        results.push(result ?? CONTINUE);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (descriptor.failureMode === 'fail-closed') {
          results.push({
            action: 'stop',
            reason: `observer "${descriptor.id}" failed: ${message}`,
            code: 'OBSERVER_FAIL_CLOSED',
          });
        } else {
          if (descriptor.failureMode === 'warn') {
            this.logger(`[observers] ${descriptor.id} (${String(hook)}) failed: ${message}`);
          }
          results.push(CONTINUE);
        }
      }
    }
    return results;
  }

  async emitResolved<K extends keyof AgentObserver>(
    hook: K,
    event: Parameters<NonNullable<AgentObserver[K]>>[0],
  ): Promise<ObserverResult> {
    return resolveInterventions(await this.emit(hook, event));
  }
}

/**
 * Env flag for the default runtime-observer set (Frontier PHASE 1 rollout).
 * Explicit `AgentHarnessConfig.observers` always run; this flag only gates
 * the implicit default bus (RepetitionGuard, failureMode 'warn').
 */
export function runtimeObserversEnabled(): boolean {
  const raw = process.env.ZELARI_RUNTIME_OBSERVERS?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on';
}

/**
 * Options for {@link buildRuntimeObserverBus}. The recorder branch only
 * activates when ZELARI_RUN_RECORD is enabled; `runsDir`/`runId` exist so
 * callers (and tests) can redirect the flight recorder away from the real
 * workspace.
 */
export interface DefaultObserverBusOptions {
  /** Root for `.zelari/runs`-style output. Default: `<cwd>/.zelari/runs`. */
  runsDir?: string;
  runId?: string;
  /**
   * Frontier PHASE 2: live steering queue. An explicit queue is itself an
   * opt-in, so the SteeringObserver joins the bus even when the default-guard
   * env flag is off (explicit config always wins, mirroring
   * `AgentHarnessConfig.observers`).
   */
  steeringQueue?: RuntimeControlQueue;
}

/**
 * Build the default observer bus: the four runtime guards (priority 30,
 * warn) plus the telemetry-only observers — ReasoningWatchdog (priority 30,
 * warn), TraceObserver (80, warn) and MetricsObserver (90, ignore). Returns
 * `undefined` (→ observers OFF) unless ZELARI_RUNTIME_OBSERVERS is enabled,
 * so the default hot path pays zero observer overhead.
 *
 * With ZELARI_RUN_RECORD=1 a Run Flight Recorder observer (priority 85) is
 * appended: manifest/trace/agents/metrics under `<runsDir>/<runId>/`.
 */
export function buildRuntimeObserverBus(
  options: DefaultObserverBusOptions = {},
): ObserverBus | undefined {
  const steering: ObserverDescriptor[] = options.steeringQueue
    ? [
        {
          id: 'steering-observer',
          priority: 20,
          failureMode: 'warn',
          observer: new SteeringObserver(options.steeringQueue),
        },
      ]
    : [];
  // Without a steering queue the env flag still gates everything (the default
  // hot path pays zero observer overhead). With one, a bus containing only
  // the SteeringObserver is returned even when the flag is off.
  if (!runtimeObserversEnabled()) {
    return steering.length > 0 ? new ObserverBus(steering) : undefined;
  }
  const descriptors: ObserverDescriptor[] = [
    ...steering,
    {
      id: 'repetition-guard',
      priority: 30,
      failureMode: 'warn',
      observer: new RepetitionGuard(),
    },
    {
      id: 'failure-signature-guard',
      priority: 30,
      failureMode: 'warn',
      observer: new FailureSignatureGuard(),
    },
    {
      id: 'duplicate-search-guard',
      priority: 30,
      failureMode: 'warn',
      observer: new DuplicateSearchGuard(),
    },
    {
      id: 'no-progress-guard',
      priority: 30,
      failureMode: 'warn',
      observer: new NoProgressGuard(),
    },
    {
      id: 'reasoning-watchdog',
      priority: 30,
      failureMode: 'warn',
      observer: new ReasoningWatchdog(),
    },
    {
      id: 'trace-observer',
      priority: 80,
      failureMode: 'warn',
      observer: new TraceObserver(),
    },
    {
      id: 'metrics-observer',
      priority: 90,
      failureMode: 'ignore',
      observer: new MetricsObserver(),
    },
  ];

  if (runRecordEnabled()) {
    const recorder = new RunRecorder({
      runsDir: options.runsDir ?? join(process.cwd(), '.zelari', 'runs'),
      runId: options.runId ?? newRunId(),
    });
    descriptors.push({
      id: 'run-recorder',
      priority: 85,
      failureMode: 'warn',
      observer: createRecorderObserver(recorder),
    });
  }

  return new ObserverBus(descriptors);
}
