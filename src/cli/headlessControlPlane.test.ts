/**
 * Control plane (PHASE 2 §22–§35): reader parsing, bridge acks, late-steer
 * conversion, queue drain notifications. Uses an EventEmitter as fake stdin.
 */
import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { RuntimeControlQueue } from '@zelari/core/runtime';
import { parseControlEvent, parseControlLine, startControlReader } from './headless/controlReader.js';
import { attachControlPlane } from './headless/controlBridge.js';
import {
  HEADLESS_PROTOCOL_VERSION,
  protocolInfoEvent,
} from './headless/protocol.js';

class FakeStdin extends EventEmitter {
  push(line: string): void {
    this.emit('data', Buffer.from(line + '\n', 'utf8'));
  }
}

function recordedEmit(): { events: unknown[]; emit: (e: unknown) => void } {
  const events: unknown[] = [];
  return { events, emit: (e: unknown) => events.push(e) };
}

const types = (events: unknown[]): string[] =>
  events.map((e) => (e as { type: string }).type);

describe('parseControlEvent', () => {
  it('accepts a well-formed steer', () => {
    const out = parseControlEvent({ type: 'steer', id: 's1', text: 'stop touching the db', ts: 1 });
    expect(out.ok).toBe(true);
  });

  it('rejects unknown types, missing ids, empty text, and non-objects', () => {
    expect(parseControlEvent({ type: 'nuke', id: 'x' }).ok).toBe(false);
    expect(parseControlEvent({ type: 'steer', id: '', text: 'hi' }).ok).toBe(false);
    expect(parseControlEvent({ type: 'steer', id: 's', text: '  ' }).ok).toBe(false);
    expect(parseControlEvent('steer').ok).toBe(false);
    expect(parseControlEvent([1, 2]).ok).toBe(false);
  });

  it('defaults ts when absent', () => {
    const out = parseControlEvent({ type: 'follow_up', id: 'f1', text: 'next' });
    expect(out.ok && typeof out.event.ts).toBe('number');
  });

  it('parseControlLine: null on blank, reason on malformed JSON', () => {
    expect(parseControlLine('   ')).toBeNull();
    expect(parseControlLine('not json').ok).toBe(false);
  });
});

describe('RuntimeControlQueue onDrained', () => {
  it('fires with the drained events, not on empty drains', () => {
    const queue = new RuntimeControlQueue();
    const drained: string[] = [];
    queue.onDrained = (events) => drained.push(...events.map((e) => e.id));
    queue.enqueue({ type: 'steer', id: 'a', text: 'x', ts: 1 });
    queue.enqueue({ type: 'follow_up', id: 'b', text: 'y', ts: 1 });
    queue.drainSteers();
    queue.drainSteers(); // empty — no second fire
    expect(drained).toEqual(['a']);
  });
});

describe('attachControlPlane', () => {
  it('protocol_info advertises v2 with stdin-control capability', () => {
    const info = protocolInfoEvent();
    expect(info.version).toBe(HEADLESS_PROTOCOL_VERSION);
    expect(info.capabilities).toContain('stdin-control');
  });

  it('valid line → accepted; observer drain → applied at turn-end', () => {
    const stdin = new FakeStdin();
    const queue = new RuntimeControlQueue();
    const { events, emit } = recordedEmit();
    const plane = attachControlPlane({ input: stdin, queue, emit });
    stdin.push(JSON.stringify({ type: 'steer', id: 's1', text: 'keep the schema' }));
    expect(types(events)).toEqual(['control_accepted']);
    queue.drainSteers(); // SteeringObserver boundary
    expect(types(events)).toEqual(['control_accepted', 'control_applied']);
    expect((events[1] as { boundary: string }).boundary).toBe('turn-end');
    plane.dispose();
  });

  it('malformed and unsupported events are rejected, never enqueued', () => {
    const stdin = new FakeStdin();
    const queue = new RuntimeControlQueue();
    const { events, emit } = recordedEmit();
    const plane = attachControlPlane({ input: stdin, queue, emit });
    stdin.push('{broken');
    stdin.push(JSON.stringify({ type: 'pause', id: 'p1' }));
    stdin.push(JSON.stringify({ type: 'resume', id: 'r1' }));
    expect(types(events)).toEqual([
      'control_rejected',
      'control_rejected',
      'control_rejected',
    ]);
    expect(queue.size).toBe(0);
    plane.dispose();
  });

  it('cancel → accepted, applied on drain, onCancel invoked', () => {
    const stdin = new FakeStdin();
    const queue = new RuntimeControlQueue();
    const { events, emit } = recordedEmit();
    let cancelled = false;
    const plane = attachControlPlane({
      input: stdin,
      queue,
      emit,
      onCancel: () => {
        cancelled = true;
      },
    });
    stdin.push(JSON.stringify({ type: 'cancel', id: 'c1', reason: 'user stop' }));
    queue.drainCancels();
    expect(cancelled).toBe(true);
    expect(types(events)).toEqual(['control_accepted', 'control_applied']);
    plane.dispose();
  });

  it('finalize converts a late steer into a follow-up and returns its text (§28)', () => {
    const stdin = new FakeStdin();
    const queue = new RuntimeControlQueue();
    const { events, emit } = recordedEmit();
    const plane = attachControlPlane({ input: stdin, queue, emit });
    stdin.push(JSON.stringify({ type: 'steer', id: 'late1', text: 'add regression tests' }));
    const texts = plane.finalize();
    expect(texts).toEqual(['add regression tests']);
    const applied = events.filter(
      (e) => (e as { type: string }).type === 'control_applied',
    ) as { boundary: string; controlType: string }[];
    expect(applied.some((a) => a.boundary === 'converted-to-follow-up' && a.controlType === 'steer')).toBe(true);
    expect(applied.some((a) => a.boundary === 'run-end' && a.controlType === 'follow_up')).toBe(true);
    expect(queue.size).toBe(0);
    plane.dispose();
  });

  it('steer arriving after finalize is converted on arrival', () => {
    const stdin = new FakeStdin();
    const queue = new RuntimeControlQueue();
    const { events, emit } = recordedEmit();
    const plane = attachControlPlane({ input: stdin, queue, emit });
    plane.finalize();
    stdin.push(JSON.stringify({ type: 'steer', id: 's9', text: 'queued anyway' }));
    expect(queue.drainFollowUps().map((f) => f.text)).toEqual(['queued anyway']);
    expect(types(events)).toContain('control_applied');
    plane.dispose();
  });

  it('startControlReader is line-buffered across chunk splits', () => {
    const stdin = new EventEmitter() as NodeJS.ReadableStream & EventEmitter;
    const lines: string[] = [];
    const dispose = startControlReader(stdin, (l) => lines.push(l));
    stdin.emit('data', Buffer.from('{"type":"ste', 'utf8'));
    stdin.emit('data', Buffer.from('er","id":"1"}\r\n{"a":2}\n', 'utf8'));
    expect(lines).toEqual(['{"type":"steer","id":"1"}', '{"a":2}']);
    dispose();
    stdin.emit('data', Buffer.from('ignored\n', 'utf8'));
    expect(lines).toHaveLength(2);
  });
});
