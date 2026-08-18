/**
 * KrakenTurnRuntime — per-turn, in-memory progress projection for standard
 * Kraken (Fase 2, ADR-0020).
 *
 * Derives a user-facing phase (understanding → exploring → implementing |
 * planning → verifying → completed) from the parent turn's BrainEvent stream
 * by PROJECTION (tool activity), without asking the model to self-report.
 * In-memory only: no persistence, no cross-turn state (ADR-0020 non-goal v1 —
 * durable run state is explicitly deferred).
 *
 * Phase rules (deterministic):
 *   - turn start                       → understanding
 *   - task(explore) start              → exploring
 *   - kraken_select start              → selecting (Fase 4)
 *   - task(verify) start               → verifying
 *   - task(verify) end                 → checksPassed refresh (Fase 7)
 *   - beginPass(true) repair pass      → repairing (Fase 8)
 *   - successful write/edit/apply_diff → implementing   (build; in plan these
 *     tools are not registered, so the transition cannot fire there)
 *   - last in-flight tentacle ends     → planning (plan) | implementing when
 *     writes>0 (build)
 *   - finish('completed')              → completed
 *
 * Emits `kraken_progress` ONLY on phase change — counters ride the payload of
 * the last event, so the NDJSON stream stays sparse (Desktop ignores unknown
 * event types by design, which keeps this contract additive).
 */
import {
  createBrainEvent,
  type BrainEvent,
  type BrainKrakenProgressEvent,
  type KrakenProgressPayload,
  type KrakenProgressPhase,
} from '@zelari/core/events';

const WRITE_TOOLS: ReadonlySet<string> = new Set([
  'write_file',
  'edit_file',
  'apply_diff',
]);

export interface KrakenTurnRuntimeOptions {
  mode: 'plan' | 'build';
  sessionId: string;
  /** Sink for phase-change events (NDJSON emitter in headless, UI hook in TUI). */
  onProgress: (event: BrainKrakenProgressEvent) => void;
  /** Injectable clock (tests). Default Date.now. */
  now?: () => number;
  /**
   * Fase 6 (ADR-0020): required-check counter source (the candidate
   * registry in real wiring). Called when kraken_select ends; a value > 0
   * becomes {@link KrakenProgressPayload.checkTotal} via a same-phase
   * payload refresh.
   */
  loadCheckTotal?: () => number;
  /**
   * Fase 7 (ADR-0020): passed-check counter source (the candidate
   * registry in real wiring). Called when a VERIFY tentacle ends; a
   * defined value becomes {@link KrakenProgressPayload.checksPassed}
   * via a same-phase payload refresh. `unknown` checks never count.
   */
  loadChecksPassed?: () => number | undefined;
}

export class KrakenTurnRuntime {
  private readonly mode: 'plan' | 'build';
  private readonly sessionId: string;
  private readonly onProgress: KrakenTurnRuntimeOptions['onProgress'];
  private readonly now: () => number;
  private readonly loadCheckTotal?: () => number;
  private readonly loadChecksPassed?: () => number | undefined;

  private phase: KrakenProgressPhase = 'understanding';
  private phaseEnteredAt: number;
  private tentacles = 0;
  private exploreTentacles = 0;
  private verifyTentacles = 0;
  private writes = 0;
  private inFlightTentacles = 0;
  /** Required checks registered via kraken_select (Fase 6). */
  private checkTotal?: number;
  /** Required checks explicitly PASSED (Fase 7; undefined until first report). */
  private checksPassed?: number;
  /** toolCallId → toolName (end events omit the name). */
  private readonly pendingTools = new Map<string, string>();
  /** toolCallIds of VERIFY tentacles (Fase 7 refresh trigger). */
  private readonly pendingVerifyIds = new Set<string>();
  private started = false;

  constructor(opts: KrakenTurnRuntimeOptions) {
    this.mode = opts.mode;
    this.sessionId = opts.sessionId;
    this.onProgress = opts.onProgress;
    this.now = opts.now ?? Date.now;
    this.loadCheckTotal = opts.loadCheckTotal;
    this.loadChecksPassed = opts.loadChecksPassed;
    this.phaseEnteredAt = this.now();
  }

  /** Start the turn: emits the initial `understanding` event. */
  beginTurn(): void {
    this.started = true;
    this.emit();
  }

  /**
   * Reset the phase machine for a recovery pass of the SAME turn (headless
   * BUILD write-retry). Counters are kept — they describe the whole turn.
   *
   * Fase 8 (ADR-0020): `beginPass(true)` marks an automatic REPAIR pass
   * (completion gate) and projects `repairing` instead of restarting at
   * `understanding`, so the UI shows the fix loop rather than a fresh turn.
   */
  beginPass(repair = false): void {
    this.transition(repair ? 'repairing' : 'understanding');
  }

  /**
   * Terminal transition. `completed` is only projected on a clean finish —
   * cancellations and errors are already carried by the `agent_end` event.
   */
  finish(reason: 'completed' | 'cancelled' | 'error'): void {
    if (reason === 'completed') this.transition('completed');
  }

  /** Feed one parent-turn BrainEvent. Never throws. */
  observe(event: BrainEvent): void {
    try {
      if (event.type === 'tool_execution_start') {
        if (event.toolCallId && event.toolName) {
          this.pendingTools.set(event.toolCallId, event.toolName);
        }
        if (event.toolName === 'kraken_select') {
          // Fase 4 (ADR-0020): the parent is comparing candidates.
          this.transition('selecting');
          return;
        }
        if (event.toolName === 'task') {
          this.tentacles++;
          this.inFlightTentacles++;
          const agent =
            typeof event.args?.agent === 'string' ? event.args.agent : 'explore';
          if (agent === 'verify') {
            this.verifyTentacles++;
            if (event.toolCallId) this.pendingVerifyIds.add(event.toolCallId);
          } else this.exploreTentacles++;
          this.transition(agent === 'verify' ? 'verifying' : 'exploring');
        }
        return;
      }
      if (event.type === 'tool_execution_end') {
        const name = this.pendingTools.get(event.toolCallId);
        this.pendingTools.delete(event.toolCallId);
        if (name === 'task') {
          const wasVerify = event.toolCallId
            ? this.pendingVerifyIds.delete(event.toolCallId)
            : false;
          this.inFlightTentacles = Math.max(0, this.inFlightTentacles - 1);
          // Fase 7 (ADR-0020): when a VERIFY tentacle ends, refresh the
          // passed-check counter. Silent update first, so a phase transition
          // below carries the new counters in ONE event (sparse stream);
          // emit explicitly only when no transition fires.
          let checksChanged = false;
          if (wasVerify && this.loadChecksPassed) {
            const passed = this.loadChecksPassed();
            if (passed !== undefined && passed !== this.checksPassed) {
              this.checksPassed = passed;
              checksChanged = true;
            }
          }
          if (this.inFlightTentacles === 0) {
            if (this.mode === 'plan') this.transition('planning');
            else if (this.writes > 0) this.transition('implementing');
            else if (checksChanged) this.emit();
          } else if (checksChanged) {
            this.emit();
          }
          return;
        }
        if (name === 'kraken_select') {
          // Fase 6 (ADR-0020): register the selection's required checks as
          // the turn's check counter. Same-phase refresh — the counters ride
          // the payload of the (re)emitted event, keeping the stream sparse.
          const total = this.loadCheckTotal?.() ?? 0;
          if (total > 0 && total !== this.checkTotal) {
            this.checkTotal = total;
            this.emit();
          }
          return;
        }
        if (name && WRITE_TOOLS.has(name) && !event.isError) {
          this.writes++;
          if (this.mode === 'build') this.transition('implementing');
        }
        return;
      }
    } catch {
      // Progress projection must never break the turn.
    }
  }

  /** Current progress payload (counters + phase). */
  snapshot(): KrakenProgressPayload {
    return {
      phase: this.phase,
      mode: this.mode,
      tentacles: this.tentacles,
      exploreTentacles: this.exploreTentacles,
      verifyTentacles: this.verifyTentacles,
      writes: this.writes,
      phaseEnteredAt: this.phaseEnteredAt,
      ...(this.checkTotal !== undefined ? { checkTotal: this.checkTotal } : {}),
      ...(this.checksPassed !== undefined ? { checksPassed: this.checksPassed } : {}),
    };
  }

  private transition(next: KrakenProgressPhase): void {
    if (this.phase === next) return;
    this.phase = next;
    this.phaseEnteredAt = this.now();
    this.emit();
  }

  private emit(): void {
    if (!this.started) return;
    try {
      this.onProgress(
        createBrainEvent('kraken_progress', this.sessionId, {
          progress: this.snapshot(),
        }),
      );
    } catch {
      // A broken sink must never break the turn.
    }
  }
}
