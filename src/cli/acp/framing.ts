/**
 * acp/framing — stdio framing for the ACP front door (`zelari-code acp`).
 *
 * ACP rides JSON-RPC 2.0 over stdio with the SAME HTTP-style framing as the
 * Language Server Protocol:
 *
 *     Content-Length: <bytes>\r\n\r\n<json body>
 *
 * The codec already exists in this repo (`src/cli/lsp/protocol.ts`,
 * incremental decoder + encoder, byte-accurate for UTF-8) and is the single
 * source of truth: this module RE-EXPORTS it and only adds the stream
 * plumbing (readable -> messages, message -> writable) plus the advisory
 * diagnostics the JSON-RPC loop logs.
 *
 * Fail-soft contract (P2 — a broken frame or a closed pipe must never kill
 * the agent):
 *   - an unparseable body, or a header block without `Content-Length`, is
 *     DROPPED by the codec, which resynchronizes on the next header; the loop
 *     keeps running. `malformedFrameWarnings` only REPORTS such a frame
 *     (advisory, best-effort — it never affects what is decoded);
 *   - a write into a closed stdout is swallowed and reported once per call
 *     through `onError`, never thrown into the caller.
 */
import type { Readable } from 'node:stream';
import { createMessageParser, encodeMessage } from '../lsp/protocol.js';

export { createMessageParser, encodeMessage };

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
 */
export function createFrameWriter(
  sink: FrameSink,
  onError?: (message: string) => void,
): FrameWriter {
  const write = sink.write.bind(sink);
  return {
    write(message: unknown): void {
      try {
        write(encodeMessage(message));
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
}

export interface FrameReaderHandle {
  detach(): void;
}

/**
 * Attach the incremental decoder to a readable stream. Chunk boundaries are
 * irrelevant: partial frames are buffered, several frames per chunk are all
 * delivered, and a throwing `onMessage` is contained (it cannot desync the
 * stream).
 */
export function attachFrameReader(
  stream: Readable,
  options: FrameReaderOptions,
): FrameReaderHandle {
  const parser = createMessageParser();
  let closed = false;

  const report = (detail: string): void => {
    try {
      options.onMalformedFrame?.(detail);
    } catch {
      /* diagnostics must never throw */
    }
  };

  const finish = (): void => {
    if (closed) return;
    closed = true;
    try {
      options.onEof();
    } catch {
      /* shutdown is best-effort */
    }
  };

  const onData = (chunk: string): void => {
    for (const warning of malformedFrameWarnings(chunk)) report(warning);
    let messages: unknown[];
    try {
      messages = parser.push(chunk);
    } catch (err) {
      report(`decoder error: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    for (const message of messages) {
      try {
        options.onMessage(message);
      } catch (err) {
        report(`consumer error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };

  const onError = (err: Error): void => {
    report(`stdin error: ${err.message}`);
    finish();
  };

  stream.setEncoding('utf8');
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
