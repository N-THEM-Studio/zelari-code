/**
 * sessionSurface — Fase 2 acceptance: deterministic projection, monotone
 * stubs, byte-identical replay, no un-pruning.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentMessage } from '@zelari/core/harness';
import {
  formatObservationStub,
  isObservationStub,
  parseObservationStub,
  projectSessionSurface,
  resolveObservationSeq,
  statusFromToolBody,
} from './sessionSurface.js';

function tool(id: string, content: string): AgentMessage {
  return { role: 'tool', toolCallId: id, content };
}
function assistantCall(id: string, name: string): AgentMessage {
  return { role: 'assistant', content: '', toolCalls: [{ id, name, args: {} }] };
}

describe('observation stub codec', () => {
  it('round-trips fields byte-identically', () => {
    const stub = formatObservationStub({
      seq: 12,
      tool: 'grep_content',
      status: 'complete',
      bytes: 4096,
    });
    expect(stub).toBe(
      'OBSERVATION ref=#12 tool=grep_content status=complete bytes=4096\n[retrieve_observation #12]',
    );
    expect(isObservationStub(stub)).toBe(true);
    expect(parseObservationStub(stub)).toEqual({
      seq: 12,
      tool: 'grep_content',
      status: 'complete',
      bytes: 4096,
    });
    expect(formatObservationStub(parseObservationStub(stub)!)).toBe(stub);
  });

  it('rejects non-stubs', () => {
    expect(isObservationStub('hello')).toBe(false);
    expect(parseObservationStub('hello')).toBeNull();
  });

  it('reads Fase-0 footer status', () => {
    expect(statusFromToolBody('body\n[observation status=partial filesWalked=3]')).toBe(
      'partial',
    );
    expect(statusFromToolBody('plain')).toBeUndefined();
  });
});

describe('projectSessionSurface', () => {
  afterEach(() => {
    delete process.env.ZELARI_SURFACE_HOT_TAIL;
    delete process.env.ZELARI_SURFACE_MAX_BODY_CHARS;
    delete process.env.ZELARI_SESSION_SURFACE;
  });

  it('returns the same reference when nothing needs projecting', () => {
    const msgs: AgentMessage[] = [
      { role: 'user', content: 'hi' },
      tool('c1', 'tiny'),
    ];
    const r = projectSessionSurface(msgs, { hotTail: 4, maxBodyChars: 4000 });
    expect(r.messages).toBe(msgs);
    expect(r.stats.projected).toBe(0);
  });

  it('keeps the hot tail full-fidelity and stubs older oversized bodies', () => {
    const big = 'B'.repeat(500);
    const msgs: AgentMessage[] = [];
    for (let i = 1; i <= 6; i++) {
      msgs.push(assistantCall(`c${i}`, 'read_file'));
      msgs.push(tool(`c${i}`, big + `\n[observation status=complete bytes=${big.length}]`));
    }
    const r = projectSessionSurface(msgs, { hotTail: 2, maxBodyChars: 100 });
    expect(r.stats.projected).toBe(4);
    const tools = r.messages.filter((m) => m.role === 'tool');
    expect(tools.slice(0, 4).every((m) => isObservationStub(m.content))).toBe(true);
    expect(tools.slice(4).every((m) => !isObservationStub(m.content))).toBe(true);
    expect(tools[0].content).toContain('tool=read_file');
    expect(tools[0].content).toContain('status=complete');
    expect(tools[0].content).toContain('[retrieve_observation #1]');
  });

  it('is deterministic: same input → byte-identical surface', () => {
    const big = 'X'.repeat(800);
    const msgs: AgentMessage[] = [
      assistantCall('a', 'grep_content'),
      tool('a', big),
      assistantCall('b', 'grep_content'),
      tool('b', big),
      assistantCall('c', 'list_files'),
      tool('c', big),
    ];
    const a = projectSessionSurface(msgs, { hotTail: 1, maxBodyChars: 50 });
    const b = projectSessionSurface(msgs, { hotTail: 1, maxBodyChars: 50 });
    expect(JSON.stringify(a.messages)).toBe(JSON.stringify(b.messages));
    expect(a.stats).toEqual(b.stats);
  });

  it('never un-prunes an existing stub (monotone / cache-safe)', () => {
    const stub = formatObservationStub({ seq: 7, tool: 'read_file', bytes: 9999 });
    const msgs: AgentMessage[] = [tool('old', stub), tool('hot', 'H'.repeat(50))];
    const r = projectSessionSurface(msgs, { hotTail: 4, maxBodyChars: 10 });
    expect(r.messages[0].content).toBe(stub);
    expect(r.stats.alreadyStubbed).toBe(1);
    expect(r.stats.projected).toBe(0);
  });

  it('uses lookup(toolCallId) for stable seq when provided', () => {
    const big = 'Z'.repeat(200);
    const msgs: AgentMessage[] = [
      assistantCall('call-z', 'bash'),
      tool('call-z', big),
      assistantCall('keep', 'bash'),
      tool('keep', big),
    ];
    const lookup = (id: string) => (id === 'call-z' ? 42 : undefined);
    const r = projectSessionSurface(msgs, { hotTail: 1, maxBodyChars: 10 }, lookup);
    expect(r.messages[1].content).toContain('ref=#42');
    expect(r.messages[1].content).toContain('[retrieve_observation #42]');
  });

  it('falls back to 1-based ordinal when lookup misses', () => {
    const seq = resolveObservationSeq(tool('x', 'body'), 3);
    expect(seq).toBe(4);
  });
});
