/**
 * acp/framing — stdio wire format for the ACP front door (`zelari-code acp`).
 *
 * SPEC (agentclientprotocol.com, stdio transport): messages are UTF-8
 * JSON-RPC objects delimited by newlines (`\n`) and MUST NOT contain
 * embedded newlines — i.e. NDJSON. Zed and every spec-compliant client
 * speak this; a bare `{"jsonrpc":...}` line with NO `Content-Length`
 * header is the CORRECT client behavior.
 *
 * For tolerance, LSP-style frames (`Content-Length: <bytes>\r\n\r\n<json>`,
 * codec re-exported from `src/cli/lsp/protocol.js`) are still decoded: the
 * dual decoder auto-detects the format of each inbound message, and the
 * FIRST decoded message locks a shared `WireFormat` so the writer MIRRORS
 * the client on output. Default before any input arrives: `ndjson`.
 *
 * A JSON line is only delivered on its terminating newline (or by the
 * EOF flush, which salvages a last line missing its final `\n`).
 *
 * Fail-soft contract (P2 — a broken line or a closed pipe must never kill
 * the agent):
 *   - an unparseable line/body, or a header block without `Content-Length`,
 *     is DROPPED with an advisory warning; the decoder resynchronizes on
 *     the next line/header and the loop keeps running;
 *   - a write into a closed stdout is swallowed and reported once per call
 *     through `onError`, never thrown into the caller.
 */
import type { Readable } from 'node:stream';
import { createMessageParser, encodeMessage } from '../lsp/protocol.js';

export { createMessageParser, encodeMessage };

/** Outbound wire format. `ndjson` is the ACP spec default. */
export type WireMode = 'ndjson' | 'lsp-frame';

/** Shared reader→writer state: locked on the first decoded inbound message. */
export interface WireFormat {
  mode: WireMode;
}

export interface DecodeResult {
  messages: unknown[];
  warnings: string[];
}

/** Runaway-buffer guard (advisory drop, the loop keeps running). */
const MAX_PENDING_BYTES = 4 * 1024 * 1024;
const HEADER_PREFIX = 'content-length:';

/**
 * Byte-accurate dual-format incremental decoder. Works on Buffers (never on
 * pre-decoded strings) so a UTF-8 sequence split across chunk boundaries
 * cannot corrupt a message.
 */
export function createDualWireDecoder(format?: WireFormat): {
  push(chunk: string | Buffer): DecodeResult;
  flush(): DecodeResult;
} {
  const fmt: WireFormat = format ?? { mode: 'ndjson' };
  let buf: Buffer = Buffer.alloc(0);
  let locked = false;

  const lock = (mode: WireMode): void => {
    if (locked) return;
    locked = true;
    fmt.mode = mode;
  };

  /** One decoding step; `false` = more input needed before progressing. */
  const step = (out: DecodeResult): boolean => {
    while (buf.length > 0 && (buf[0] === 0x0a || buf[0] === 0x0d)) buf = buf.subarray(1);
    if (buf.length === 0) return false;

    // LSP-style frame: `Content-Length: <n>\r\n\r\n<exactly n bytes>`.
    if (buf.subarray(0, HEADER_PREFIX.length).toString('latin1').toLowerCase() === HEADER_PREFIX) {
      const sep = buf.indexOf('\r\n\r\n');
      if (sep === -1) {
        if (buf.length > MAX_PENDING_BYTES) {
          out.warnings.push('runaway header block without \\r\\n\\r\\n (dropped)');
          buf = Buffer.alloc(0);
          return true;
        }
        return false;
      }
      const header = buf.subarray(0, sep).toString('latin1');
      const m = /content-length:\s*(\d+)/i.exec(header);
      if (!m) {
        out.warnings.push(
          `frame without a usable Content-Length: ${JSON.stringify(header.slice(0, 80))}`,
        );
        buf = buf.subarray(sep + 4);
        return true;
      }
      const bodyStart = sep + 4;
      const bodyEnd = bodyStart + Number(m[1]);
      if (buf.length < bodyEnd) return false;
      const body = buf.subarray(bodyStart, bodyEnd).toString('utf8');
      buf = buf.subarray(bodyEnd);
      try {
        out.messages.push(JSON.parse(body));
        lock('lsp-frame');
      } catch {
        out.warnings.push(`unparseable frame body (dropped): ${JSON.stringify(body.slice(0, 80))}`);
      }
      return true;
    }

    // NDJSON (the spec): one JSON object per line, `\n`-terminated.
    const nl = buf.indexOf(0x0a);
    if (nl === -1) {
      if (buf.length > MAX_PENDING_BYTES) {
        out.warnings.push('runaway line without a newline (dropped)');
        buf = Buffer.alloc(0);
        return true;
      }
      return false;
    }
    const line = buf.subarray(0, nl).toString('utf8').replace(/\r+$/, '');
    buf = buf.subarray(nl + 1);
    if (line.trim().length === 0) return true;
    try {
      out.messages.push(JSON.parse(line));
      lock('ndjson');
    } catch {
      out.warnings.push(`unparseable JSON line (dropped): ${JSON.stringify(line.slice(0, 80))}`);
    }
    return true;
  };

  const drain = (): DecodeResult => {
    const out: DecodeResult = { messages: [], warnings: [] };
    while (step(out)) {
      /* keep draining */
    }
    return out;
  };

  return {
    push(chunk: string | Buffer): DecodeResult {
      const data = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk);
      buf = buf.length === 0 ? data : Buffer.concat([buf, data]);
      return drain();
    },
    /** EOF: salvage a trailing NDJSON line that lacks the final newline. */
    flush(): DecodeResult {
      const out = drain();
      if (buf.length === 0) return out;
      const line = buf.toString('utf8').trim();
      buf = Buffer.alloc(0);
      if (line.length > 0) {
        try {
          out.messages.push(JSON.parse(line));
          lock('ndjson');
        } catch {
          out.warnings.push(
            `unparseable JSON line at EOF (dropped): ${JSON.stringify(line.slice(0, 80))}`,
          );
        }
      }
      return out;
    },
  };
}

/** Minimal writable surface (process.stdout-compatible, trivially faked).
 *  Deliberately NOT `NodeJS.WritableStream`: the writer only ever writes. */
export interface FrameSink {
  write(chunk: string): unknown;
}

export interface FrameWriter {
  /** Serialize + write ONE JSON-RPC message. Never throws. */
  write(message: unknown): void;
}

/**
 * Frame writer. `sink.write` is bound HERE, at construction time, on purpose:
 * an in-flight turn may temporarily patch `process.stdout.write` (see
 * turnAdapter.ts — the headless dispatch writes its NDJSON stream there), and
 * ACP frames must never be swallowed by that capture window.
 *
 * With a shared `format` (the same object given to the reader) the writer
 * mirrors the inbound wire: `ndjson` after NDJSON input, LSP frames after
 * framed input. Without one it emits LSP frames (legacy callers/tests).
 */
export function createFrameWriter(
  sink: FrameSink,
  onError?: (message: string) => void,
  format?: WireFormat,
): FrameWriter {
  const write = sink.write.bind(sink);
  return {
    write(message: unknown): void {
      try {
        write(
          format && format.mode === 'ndjson'
            ? `${JSON.stringify(message)}\n`
            : encodeMessage(message),
        );
      } catch (err) {
        try {
          onError?.(err instanceof Error ? err.message : String(err));
        } catch {
          /* diagnostics must never throw */
        }
      }
    },
  };
}

/**
 * Advisory scan for frame headers the codec will have to drop. Returns one
 * message per header block seen in `chunk` that carries no usable
 * `Content-Length`. Pure, bounded (headers are truncated), never throws.
 *
 * Chunk boundaries mean a header split across two reads is simply not
 * reported — this is a diagnostic, never a gate: the codec decides.
 */
export function malformedFrameWarnings(chunk: string): string[] {
  const out: string[] = [];
  let rest = chunk;
  for (;;) {
    const headerEnd = rest.indexOf('\r\n\r\n');
    if (headerEnd === -1) return out;
    const header = rest.slice(0, headerEnd);
    // A JSON body never contains a raw CRLFCRLF (JSON escapes control chars),
    // so any separator we find starts a header block.
    if (!/Content-Length:\s*\d+/i.test(header)) {
      out.push(`frame without a usable Content-Length: ${JSON.stringify(header.slice(0, 80))}`);
    }
    rest = rest.slice(headerEnd + 4);
  }
}

export interface FrameReaderOptions {
  /** Called once per decoded JSON-RPC message (already parsed). */
  onMessage: (message: unknown) => void;
  /** stdin closed: the transport is over. Called at most once. */
  onEof: () => void;
  /** Advisory diagnostics (malformed header, throwing consumer). */
  onMalformedFrame?: (detail: string) => void;
  /** Shared with the writer so responses mirror the inbound wire format. */
  format?: WireFormat;
}

export interface FrameReaderHandle {
  detach(): void;
}

/**
 * Attach the dual-format decoder to a readable stream. Chunk boundaries are
 * irrelevant: partial lines/frames are buffered, several messages per chunk
 * are all delivered, and a throwing `onMessage` is contained (it cannot
 * desync the stream).
 */
export function attachFrameReader(
  stream: Readable,
  options: FrameReaderOptions,
): FrameReaderHandle {
  const parser = createDualWireDecoder(options.format);
  let closed = false;

  const report = (detail: string): void => {
    try {
      options.onMalformedFrame?.(detail);
    } catch {
      /* diagnostics must never throw */
    }
  };

  const deliver = (message: unknown): void => {
    try {
      options.onMessage(message);
    } catch (err) {
      report(`consumer error: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const finish = (): void => {
    if (closed) return;
    closed = true;
    try {
      const rest = parser.flush();
      for (const warning of rest.warnings) report(warning);
      for (const message of rest.messages) deliver(message);
    } catch {
      /* EOF salvage is best-effort */
    }
    try {
      options.onEof();
    } catch {
      /* shutdown is best-effort */
    }
  };

  const onData = (chunk: Buffer): void => {
    for (const warning of malformedFrameWarnings(chunk.toString('utf8'))) report(warning);
    let decoded: DecodeResult;
    try {
      decoded = parser.push(chunk);
    } catch (err) {
      report(`decoder error: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    for (const warning of decoded.warnings) report(warning);
    for (const message of decoded.messages) deliver(message);
  };

  const onError = (err: Error): void => {
    report(`stdin error: ${err.message}`);
    finish();
  };

  stream.on('data', onData);
  stream.on('end', finish);
  stream.on('close', finish);
  stream.on('error', onError);

  return {
    detach(): void {
      closed = true;
      stream.off('data', onData);
      stream.off('end', finish);
      stream.off('close', finish);
      stream.off('error', onError);
    },
  };
}
