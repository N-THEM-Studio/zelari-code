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

/**
 * Late-binding seam for hosts where the memory service is constructed BEFORE
 * the spine opens (headless single-turn / council): events are dropped while
 * `holder.current` is unset and flow once the spine handle is assigned.
 * TUI hosts pass a getter-backed holder (`{ get current() { return … } }`) —
 * a getter on `current` satisfies this shape.
 */
export function memorySinkFor(holder: { current?: SpineNoteHandle }): MemoryEventSink {
  return (event) => {
    const handle = holder.current;
    if (handle) spineMemoryEventNote(handle, event);
  };
}
