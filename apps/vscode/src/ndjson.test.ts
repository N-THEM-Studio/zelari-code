import { describe, expect, it } from 'vitest';
import { createNdjsonDecoder, encodeNdjson } from './ndjson.js';

describe('ndjson — ACP stdio framing', () => {
  it('decodes one message per line and ignores blank lines (Zed sends a trailing \\n)', () => {
    const decoder = createNdjsonDecoder();
    const { messages, warnings } = decoder.push(
      '{"jsonrpc":"2.0","id":"z1","method":"initialize"}\n' +
        '\n' +
        '{"jsonrpc":"2.0","method":"initialized"}\r\n',
    );
    expect(warnings).toEqual([]);
    expect(messages).toEqual([
      { jsonrpc: '2.0', id: 'z1', method: 'initialize' },
      { jsonrpc: '2.0', method: 'initialized' },
    ]);
  });

  it('buffers a partial line until its newline arrives (chunk boundaries are irrelevant)', () => {
    const decoder = createNdjsonDecoder();
    expect(decoder.push('{"jsonrpc":"2.0","id":1,"res').messages).toEqual([]);
    expect(decoder.push('ult":{"protocolVersion":1}}').messages).toEqual([]);
    expect(decoder.push('\n').messages).toEqual([
      { jsonrpc: '2.0', id: 1, result: { protocolVersion: 1 } },
    ]);
  });

  it('delivers every message in a chunk that carries several of them', () => {
    const decoder = createNdjsonDecoder();
    const { messages } = decoder.push('{"a":1}\n{"b":2}\n{"c":3}\n');
    expect(messages).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
  });

  it('drops a non-JSON line with a warning and resynchronizes on the next one', () => {
    const decoder = createNdjsonDecoder();
    const { messages, warnings } = decoder.push('this is not json\n{"ok":true}\n');
    expect(messages).toEqual([{ ok: true }]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('dropped a non-JSON line');
    expect(warnings[0]).toContain('this is not json');
  });

  it('flush() salvages a trailing line with no newline (EOF), and reports a broken fragment', () => {
    const decoder = createNdjsonDecoder();
    decoder.push('{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}');
    expect(decoder.flush()).toEqual({
      messages: [{ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1 } }],
      warnings: [],
    });

    const dirty = createNdjsonDecoder();
    dirty.push('{"jsonrpc":"2.0","id":2,"resu');
    const flushed = dirty.flush();
    expect(flushed.messages).toEqual([]);
    expect(flushed.warnings).toHaveLength(1);
    // The buffer is consumed either way: a second flush cannot repeat a warning.
    expect(dirty.flush()).toEqual({ messages: [], warnings: [] });
  });

  it('guards against a peer that never sends a newline (runaway buffer dropped, loop survives)', () => {
    const decoder = createNdjsonDecoder();
    const { warnings } = decoder.push('x'.repeat(4 * 1024 * 1024 + 16));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('no newline within');
    expect(decoder.push('{"after":"the guard"}\n').messages).toEqual([{ after: 'the guard' }]);
  });

  it('encodes exactly one NDJSON frame: a single trailing newline, no embedded ones', () => {
    const frame = encodeNdjson({
      jsonrpc: '2.0',
      id: 1,
      method: 'session/prompt',
      params: { prompt: [{ type: 'text', text: 'line one\nline two' }] },
    });
    expect(frame.endsWith('}\n')).toBe(true);
    expect(frame.indexOf('\n')).toBe(frame.length - 1);
    expect(JSON.parse(frame)).toMatchObject({ id: 1, method: 'session/prompt' });
  });
});
