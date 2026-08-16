/**
 * BrainEvent task variants — ADR-0018 slice 3b acceptance.
 *
 * Covers the two new discriminators added to the BrainEvent union:
 * type guards narrow correctly, createBrainEvent stamps the common
 * base fields, and payloads stay JSON-serializable (they cross the
 * NDJSON → Tauri envelope boundary untouched).
 *
 * @since v1.43.0
 */
import { describe, it, expect } from 'vitest';
import {
  createBrainEvent,
  isBrainTaskUpdateEvent,
  isBrainTaskSnapshotEvent,
  isBrainQueueUpdateEvent,
  type BrainEvent,
  type BrainTaskUpdateEvent,
  type BrainTaskSnapshotEvent,
} from './events.js';

const SESSION = 'sess-task-events';

function sampleUpdate(): BrainTaskUpdateEvent {
  return createBrainEvent('task_update', SESSION, {
    source: 'workspace_plan',
    task: {
      id: 't1',
      title: 'Event slice',
      status: 'in_progress',
      phaseId: 'p1',
      priority: 'high',
    },
  });
}

function sampleSnapshot(): BrainTaskSnapshotEvent {
  return createBrainEvent('task_snapshot', SESSION, {
    source: 'workspace_plan',
    tasks: [
      { id: 't1', title: 'A', status: 'completed' },
      { id: 't2', title: 'B', status: 'blocked' },
    ],
  });
}

describe('BrainEvent task variants (ADR-0018 3b)', () => {
  it('guards discriminate task events from other variants', () => {
    const update = sampleUpdate();
    const snapshot = sampleSnapshot();
    const other: BrainEvent = createBrainEvent('queue_update', SESSION, {
      queuedCount: 1,
    });

    expect(isBrainTaskUpdateEvent(update)).toBe(true);
    expect(isBrainTaskSnapshotEvent(update)).toBe(false);
    expect(isBrainTaskSnapshotEvent(snapshot)).toBe(true);
    expect(isBrainTaskUpdateEvent(snapshot)).toBe(false);
    expect(isBrainTaskUpdateEvent(other)).toBe(false);
    expect(isBrainQueueUpdateEvent(other)).toBe(true);
  });

  it('createBrainEvent stamps id/ts/sessionId on task events', () => {
    const update = sampleUpdate();
    expect(update.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(update.ts).toBeGreaterThan(0);
    expect(update.sessionId).toBe(SESSION);
    expect(update.source).toBe('workspace_plan');
    expect(update.task.status).toBe('in_progress');
  });

  it('task payloads survive JSON round-trip (NDJSON boundary)', () => {
    const snapshot = sampleSnapshot();
    const revived = JSON.parse(JSON.stringify(snapshot)) as BrainTaskSnapshotEvent;
    expect(revived.type).toBe('task_snapshot');
    expect(revived.tasks).toHaveLength(2);
    expect(revived.tasks[1].status).toBe('blocked');
    expect(revived.tasks[1].phaseId).toBeUndefined(); // optional dropped, not null
  });
});
