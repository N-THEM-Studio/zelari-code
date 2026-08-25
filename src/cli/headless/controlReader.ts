/**
 * ControlReader — stdin NDJSON → ControlEvent (Frontier PHASE 2, §22).
 *
 * Line-buffered reader over a readable stream (headless stdin). Malformed
 * lines surface as parse results, never throws: the bridge decides whether
 * to emit `control_rejected`.
 */
import type { ControlEvent } from '@zelari/core/runtime';

export type ParseOutcome =
  | { ok: true; event: ControlEvent }
  | { ok: false; id: string; reason: string };

const CONTROL_TYPES = new Set([
  'steer',
  'follow_up',
  'cancel',
  'pause',
  'resume',
]);

/** Validate one parsed JSON object as a ControlEvent (shape-level check). */
export function parseControlEvent(raw: unknown): ParseOutcome {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, id: '', reason: 'control event must be a JSON object' };
  }
  const candidate = raw as Record<string, unknown>;
  const type = candidate['type'];
  if (typeof type !== 'string' || !CONTROL_TYPES.has(type)) {
    return {
      ok: false,
      id: typeof candidate['id'] === 'string' ? candidate['id'] : '',
      reason: `unknown control type: ${String(type)}`,
    };
  }
  if (typeof candidate['id'] !== 'string' || candidate['id'].length === 0) {
    return { ok: false, id: '', reason: 'missing control id' };
  }
  if (type === 'steer' || type === 'follow_up') {
    if (
      typeof candidate['text'] !== 'string' ||
      candidate['text'].trim().length === 0
    ) {
      return {
        ok: false,
        id: candidate['id'],
        reason: `${type} requires a non-empty "text" field`,
      };
    }
  }
  if (
    type === 'cancel' &&
    'reason' in candidate &&
    candidate['reason'] !== undefined &&
    typeof candidate['reason'] !== 'string'
  ) {
    return {
      ok: false,
      id: candidate['id'],
      reason: 'cancel reason must be a string',
    };
  }
  return {
    ok: true,
    event: {
      ...candidate,
      ts: typeof candidate['ts'] === 'number' ? candidate['ts'] : Date.now(),
    } as ControlEvent,
  };
}

/** Parse one NDJSON line; empty/whitespace lines return null (ignored). */
export function parseControlLine(line: string): ParseOutcome | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  try {
    return parseControlEvent(JSON.parse(trimmed));
  } catch (e) {
    return { ok: false, id: '', reason: `malformed JSON: ${(e as Error).message}` };
  }
}

/**
 * Attach a line-buffered reader to a readable stream. Returns a dispose
 * function that detaches listeners without closing the stream.
 */
export function startControlReader(
  input: NodeJS.ReadableStream,
  onLine: (line: string) => void,
): () => void {
  let buffer = '';
  const onData = (chunk: Buffer | string) => {
    buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    let newlineIndex = buffer.indexOf('\n');
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      if (line.trim().length > 0) onLine(line.replace(/\r$/, ''));
      newlineIndex = buffer.indexOf('\n');
    }
  };
  input.on('data', onData);
  return () => {
    input.removeListener('data', onData);
    buffer = '';
  };
}
