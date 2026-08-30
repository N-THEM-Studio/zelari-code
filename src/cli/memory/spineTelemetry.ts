/**
 * spineTelemetry — W2: project core memory telemetry onto the ADR-0016
 * session spine.
 *
 * Production hosts never passed `onEvent` to `getMemoryService`, so
 * projection decisions (what durable context was injected, how heavy) were
 * unmeasurable. This module adapts the core sink contract onto the spine's
 * state-only `note` vocabulary (same idiom as `spineOrchestrationNote`):
 * identifiers and counters ONLY — memory content must never reach telemetry.
 */
import type { MemoryEvent, MemoryEventSink } from '@zelari/core/memory';

/** Minimal structural handle — satisfied by SessionSpineMirror (TUI) and HeadlessSpineHandle (headless). */
export type SpineNoteHandle = { note(text: string, data?: Record<string, unknown>): void };

/** Late-binding holder: `current` is assigned after the spine opens. */
export type LateBindingSpineHolder = {
  current?: SpineNoteHandle;
  /** Overflow past {@link PRE_BIND_BUFFER_CAP} while `current` was unset. */
  droppedEvents?: number;
};

/** Pre-bind MemoryEvents kept until {@link flushMemorySpineNotes}. */
export const PRE_BIND_BUFFER_CAP = 32;

const buffers = new WeakMap<object, MemoryEvent[]>();

/**
 * Write one memory telemetry event as a spine `note`. Per-turn context
 * projection (`memory_recall_end` with reason `context-built`) gets the
 * dedicated `context.projection` subject; every other event lands under
 * `memory_event` with its type. Never throws — a degraded/disabled spine
 * must not break the run over telemetry.
 */
export function spineMemoryEventNote(handle: SpineNoteHandle, event: MemoryEvent): void {
  try {
    if (event.type === 'memory_recall_end' && event.reason === 'context-built') {
      handle.note('context.projection', {
        subject: 'context.projection',
        ...(event.contextChars !== undefined ? { contextChars: event.contextChars } : {}),
        ...(event.returnedCount !== undefined ? { returnedCount: event.returnedCount } : {}),
        ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
        ...(event.backend !== undefined ? { backend: event.backend } : {}),
      });
      return;
    }
    handle.note(`memory_${event.type}`, {
      subject: 'memory_event',
      type: event.type,
      ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
      ...(event.candidateCount !== undefined ? { candidateCount: event.candidateCount } : {}),
      ...(event.returnedCount !== undefined ? { returnedCount: event.returnedCount } : {}),
      ...(event.backend !== undefined ? { backend: event.backend } : {}),
      ...(event.reason !== undefined ? { reason: event.reason } : {}),
      ...(event.memoryId !== undefined ? { memoryId: event.memoryId } : {}),
    });
  } catch {
    // Degraded spine must NEVER break the run over telemetry.
  }
}

function bufferOf(holder: object): MemoryEvent[] {
  let buf = buffers.get(holder);
  if (!buf) {
    buf = [];
    buffers.set(holder, buf);
  }
  return buf;
}

/**
 * Late-binding seam for hosts where the memory service is constructed BEFORE
 * the spine opens (headless single-turn / council). Events while
 * `holder.current` is unset are buffered (cap {@link PRE_BIND_BUFFER_CAP});
 * call {@link flushMemorySpineNotes} after assigning the handle.
 * Overflow increments `holder.droppedEvents`. TUI getter-backed holders
 * still look like a drop unless the host calls flush (no auto-flush on
 * later events — that would change TUI attach semantics).
 */
export function memorySinkFor(holder: LateBindingSpineHolder): MemoryEventSink {
  return (event) => {
    const handle = holder.current;
    if (handle) {
      spineMemoryEventNote(handle, event);
      return;
    }
    const buf = bufferOf(holder);
    if (buf.length < PRE_BIND_BUFFER_CAP) buf.push(event);
    else holder.droppedEvents = (holder.droppedEvents ?? 0) + 1;
  };
}

/**
 * Drain the per-holder pre-bind buffer onto `holder.current`. No-op when
 * the handle is unset or the buffer is empty. Does not throw.
 */
export function flushMemorySpineNotes(holder: LateBindingSpineHolder): void {
  const handle = holder.current;
  const buf = buffers.get(holder);
  if (!handle || !buf?.length) return;
  const pending = buf.splice(0, buf.length);
  for (const event of pending) spineMemoryEventNote(handle, event);
}
