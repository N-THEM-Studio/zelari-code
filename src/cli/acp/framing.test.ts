/**
 * ACP framing — encode/decode round-trip, chunk boundaries, malformed frames,
 * EOF. Pure unit tests (no streams beyond a PassThrough); the fail-soft
 * contract of the front door is asserted here.
 */
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  attachFrameReader,
  createDualWireDecoder,
  createFrameWriter,
  encodeMessage,
  malformedFrameWarnings,
  type WireFormat,
} from './framing.js';

function frame(body: string): string {
  return `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`;
}

describe('acp/framing — writer', () => {
  it('serializes with a BYTE Content-Length (UTF-8 safe)', () => {
    const chunks: string[] = [];
    const writer = createFrameWriter({ write: (c) => chunks.push(c) });
    writer.write({ jsonrpc: '2.0', id: 1, result: { text: 'città' } });

    const header = chunks.join('').split('\r\n\r\n')[0]!;
    const body = chunks.join('').split('\r\n\r\n')[1]!;
    expect(header).toBe(`Content-Length: ${Buffer.byteLength(body, 'utf8')}`);
    expect(Buffer.byteLength(body, 'utf8')).toBeGreaterThan(body.length);
    expect(JSON.parse(body)).toEqual({ jsonrpc: '2.0', id: 1, result: { text: 'città' } });
  });

  it('binds the sink write at construction (a later patched stdout cannot swallow frames)', () => {
    const original = process.stdout.write;
    const chunks: string[] = [];
    const writer = createFrameWriter({ write: (c) => chunks.push(c) });
    // Simulate the turn-time capture: stdout is replaced AFTER the binding.
    process.stdout.write = ((() => true) as unknown) as typeof process.stdout.write;
    try {
      writer.write({ jsonrpc: '2.0', method: 'session/update' });
    } finally {
      process.stdout.write = original;
    }
    expect(chunks).toHaveLength(1);
  });

  it('never throws when the sink write fails — reports instead', () => {
    const errors: string[] = [];
    const writer = createFrameWriter(
      {
        write: () => {
          throw new Error('EPIPE');
        },
      },
      (m) => errors.push(m),
    );
    expect(() => writer.write({ jsonrpc: '2.0', id: 1 })).not.toThrow();
    expect(errors).toEqual(['EPIPE']);
  });
});

describe('acp/framing — malformedFrameWarnings', () => {
  it('is silent for a well-formed frame', () => {
    expect(malformedFrameWarnings(frame('{"jsonrpc":"2.0"}'))).toEqual([]);
  });

  it('reports a header block without Content-Length', () => {
    const warnings = malformedFrameWarnings('X-Whatever: 1\r\n\r\n{"a":1}');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Content-Length');
  });

  it('finds a bad header even after a good frame', () => {
    const warnings = malformedFrameWarnings(frame('{"ok":true}') + 'Content-Type: x\r\n\r\n{}');
    expect(warnings).toHaveLength(1);
  });

  it('returns [] for a header still in flight (no separator yet)', () => {
    expect(malformedFrameWarnings('Content-Length: 12\r\n')).toEqual([]);
  });
});

/** Let the stream machinery deliver the writes made so far. */
function flush(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

describe('acp/framing — reader', () => {
  it('decodes several frames from one chunk and buffers partial frames', async () => {
    const stream = new PassThrough();
    const seen: unknown[] = [];
    attachFrameReader(stream, { onMessage: (m) => seen.push(m), onEof: () => {} });

    const wire = frame('{"jsonrpc":"2.0","id":1}') + frame('{"jsonrpc":"2.0","id":2}');
    stream.write(wire.slice(0, 20));
    await flush();
    expect(seen).toEqual([]); // header/body split: nothing complete yet
    stream.write(wire.slice(20));
    await flush();
    expect(seen).toEqual([{ jsonrpc: '2.0', id: 1 }, { jsonrpc: '2.0', id: 2 }]);
  });

  it('keeps the stream framed across a split in the middle of the body', async () => {
    const stream = new PassThrough();
    const seen: unknown[] = [];
    attachFrameReader(stream, { onMessage: (m) => seen.push(m), onEof: () => {} });
    const first = frame('{"jsonrpc":"2.0","id":1,"result":{"deep":[1,2,3]}}');
    stream.write(first.slice(0, first.length - 5));
    await flush();
    stream.write(first.slice(first.length - 5) + frame('{"jsonrpc":"2.0","id":2}'));
    await flush();
    expect(seen).toEqual([
      { jsonrpc: '2.0', id: 1, result: { deep: [1, 2, 3] } },
      { jsonrpc: '2.0', id: 2 },
    ]);
  });

  it('drops a malformed frame, resyncs and reports it (fail-soft)', async () => {
    const stream = new PassThrough();
    const seen: unknown[] = [];
    const warnings: string[] = [];
    attachFrameReader(stream, {
      onMessage: (m) => seen.push(m),
      onEof: () => {},
      onMalformedFrame: (d) => warnings.push(d),
    });
    stream.write('Garbage: 1\r\n\r\nnonsense\n' + '{"jsonrpc":"2.0","id":7}\n');
    await flush();
    // The bad lines are dropped; the following well-formed line is delivered
    // (a JSON line is only delivered on its terminating newline).
    expect(seen).toEqual([{ jsonrpc: '2.0', id: 7 }]);
    expect(warnings.some((w) => w.includes('Content-Length'))).toBe(true);
  });

  it('contains a throwing consumer instead of desyncing the stream', async () => {
    const stream = new PassThrough();
    const seen: unknown[] = [];
    const warnings: string[] = [];
    attachFrameReader(stream, {
      onMessage: (m) => {
        if ((m as { id?: number }).id === 1) throw new Error('boom');
        seen.push(m);
      },
      onEof: () => {},
      onMalformedFrame: (d) => warnings.push(d),
    });
    stream.write(frame('{"jsonrpc":"2.0","id":1}') + frame('{"jsonrpc":"2.0","id":2}'));
    await flush();
    expect(seen).toEqual([{ jsonrpc: '2.0', id: 2 }]);
    expect(warnings).toEqual(['consumer error: boom']);
  });

  it('fires onEof exactly once on end (and stays silent after detach)', () => {
    const stream = new PassThrough();
    const onEof = vi.fn();
    const handle = attachFrameReader(stream, { onMessage: () => {}, onEof });
    stream.end();
    return new Promise<void>((resolve) => {
      setImmediate(() => {
        expect(onEof).toHaveBeenCalledTimes(1);
        handle.detach();
        stream.emit('close');
        expect(onEof).toHaveBeenCalledTimes(1);
        resolve();
      });
    });
  });
});

describe('acp/framing — dual wire: ndjson (the ACP spec / Zed wire format)', () => {
  it('decodes bare newline-delimited JSON and mirrors the writer to ndjson', () => {
    const format: WireFormat = { mode: 'ndjson' };
    const decoder = createDualWireDecoder(format);
    const { messages, warnings } = decoder.push(
      '{"jsonrpc":"2.0","id":"z1","method":"initialize","params":{"protocolVersion":1}}\n' +
        '\n' +
        '{"jsonrpc":"2.0","method":"initialized"}\r\n',
    );
    expect(warnings).toEqual([]);
    expect(messages).toEqual([
      { jsonrpc: '2.0', id: 'z1', method: 'initialize', params: { protocolVersion: 1 } },
      { jsonrpc: '2.0', method: 'initialized' },
    ]);
    expect(format.mode).toBe('ndjson');

    const chunks: string[] = [];
    const writer = createFrameWriter({ write: (c) => chunks.push(c) }, undefined, format);
    writer.write({ jsonrpc: '2.0', id: 'z1', result: { protocolVersion: 1 } });
    expect(chunks).toEqual(['{"jsonrpc":"2.0","id":"z1","result":{"protocolVersion":1}}\n']);
  });

  it('keeps decoding LSP input and mirrors the writer to lsp-frame', () => {
    const format: WireFormat = { mode: 'ndjson' };
    const decoder = createDualWireDecoder(format);
    const { messages } = decoder.push(frame('{"jsonrpc":"2.0","id":1}'));
    expect(messages).toEqual([{ jsonrpc: '2.0', id: 1 }]);
    expect(format.mode).toBe('lsp-frame');

    const chunks: string[] = [];
    const writer = createFrameWriter({ write: (c) => chunks.push(c) }, undefined, format);
    writer.write({ jsonrpc: '2.0', id: 1, result: null });
    expect(chunks[0]).toContain('Content-Length: ');
  });

  it('survives a UTF-8 multibyte char split across byte-level chunks', () => {
    const decoder = createDualWireDecoder();
    const bytes = Buffer.from('{"text":"città"}\n', 'utf8');
    const cut = bytes.indexOf(Buffer.from('à', 'utf8')) + 1; // split inside 'à'
    expect(decoder.push(bytes.subarray(0, cut)).messages).toEqual([]);
    expect(decoder.push(bytes.subarray(cut)).messages).toEqual([{ text: 'città' }]);
  });

  it('flush() salvages a trailing line missing its final newline', () => {
    const decoder = createDualWireDecoder();
    expect(decoder.push('{"jsonrpc":"2.0","id":9}').messages).toEqual([]);
    expect(decoder.flush().messages).toEqual([{ jsonrpc: '2.0', id: 9 }]);
  });

  it('drops a non-JSON line with a warning; later lines still decode', () => {
    const decoder = createDualWireDecoder();
    const { messages, warnings } = decoder.push('not json at all\n{"jsonrpc":"2.0","id":3}\n');
    expect(messages).toEqual([{ jsonrpc: '2.0', id: 3 }]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('dropped');
  });

  it('reader delivers ndjson lines from a stream and EOF-flushes the last one', async () => {
    const stream = new PassThrough();
    const seen: unknown[] = [];
    attachFrameReader(stream, { onMessage: (m) => seen.push(m), onEof: () => {} });
    stream.write('{"jsonrpc":"2.0","id":1}\n');
    await flush();
    expect(seen).toEqual([{ jsonrpc: '2.0', id: 1 }]);
    stream.write('{"jsonrpc":"2.0","id":2}'); // no trailing newline
    stream.end();
    await flush();
    expect(seen).toEqual([{ jsonrpc: '2.0', id: 1 }, { jsonrpc: '2.0', id: 2 }]);
  });
});
