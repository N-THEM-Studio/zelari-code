/**
 * RuntimeControlQueue — FIFO of pending ControlEvents (Frontier PHASE 2, §25).
 *
 * Single producer (external control plane), single consumer (SteeringObserver
 * drained by the agent loop at safe boundaries). Drain-by-type preserves the
 * relative arrival order so multiple steers are injected numbered, in order.
 */
import type {
  CancelControlEvent,
  ControlEvent,
  FollowUpControlEvent,
  SteerControlEvent,
} from './types.js';

export class RuntimeControlQueue {
  private items: ControlEvent[] = [];

  /**
   * Optional drain listener (CLI control bridge, §24): fired synchronously
   * whenever a drain* method actually removes events, with the exact events
   * consumed — lets the host emit `control_applied` at the true boundary.
   */
  onDrained?: (events: ControlEvent[]) => void;

  enqueue(event: ControlEvent): void {
    this.items.push(event);
  }

  /** Next event in arrival order, without removing it. */
  peek(): ControlEvent | undefined {
    return this.items[0];
  }

  get size(): number {
    return this.items.length;
  }

  /**
   * Remove a not-yet-applied control by id (Desktop queue UI, §32: removal
   * stays possible until `control_applied`). Returns true when removed.
   */
  remove(controlId: string): boolean {
    const index = this.items.findIndex((event) => event.id === controlId);
    if (index === -1) return false;
    this.items.splice(index, 1);
    return true;
  }

  clear(): void {
    this.items = [];
  }

  /** All pending steers in arrival order; removes them from the queue. */
  drainSteers(): SteerControlEvent[] {
    return this.drainByType('steer') as SteerControlEvent[];
  }

  /** All pending follow-ups in arrival order; removes them from the queue. */
  drainFollowUps(): FollowUpControlEvent[] {
    return this.drainByType('follow_up') as FollowUpControlEvent[];
  }

  /** All pending cancels in arrival order; removes them from the queue. */
  drainCancels(): CancelControlEvent[] {
    return this.drainByType('cancel') as CancelControlEvent[];
  }

  private drainByType(type: ControlEvent['type']): ControlEvent[] {
    const matched = this.items.filter((event) => event.type === type);
    if (matched.length > 0) {
      this.items = this.items.filter((event) => event.type !== type);
      this.onDrained?.(matched);
    }
    return matched;
  }
}
