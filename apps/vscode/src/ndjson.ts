/**
 * ndjson — newline-delimited JSON framing for the ACP stdio transport.
 *
 * SPEC (agentclientprotocol.com, transports/stdio): messages are UTF-8
 * JSON-RPC objects delimited by `\n`, with no embedded newlines. That is the
 * wire `zelari-code acp` LOCKS on the first message it decodes and then
 * mirrors back (src/cli/acp/framing.ts), so a client that writes bare lines
 * reads bare lines: no `Content-Length` headers on this side of the pipe.
 *
 * Fail-soft, mirroring the server's own policy: a line that is not JSON is
 * DROPPED with a warning and the decoder resynchronizes on the next line; a
 * partial trailing line stays buffered until its `\n` (or `flush()` at EOF
 * salvages it — the same EOF salvage the server performs).
 *
 * Text, not bytes: the reader side calls `stream.setEncoding('utf8')`, so
 * Node's StringDecoder — not a raw byte split — owns multi-byte boundaries.
 */

export interface NdjsonDecodeResult {
  messages: unknown[];
  warnings: string[];
}

export interface NdjsonDecoder {
  /** Decode every complete line in `chunk`; the remainder stays buffered. */
  push(chunk: string): NdjsonDecodeResult;
  /** End of stream: decode the trailing partial line, if any. */
  flush(): NdjsonDecodeResult;
}

/** Runaway guard: a peer that never sends `\n` must not grow the buffer forever. */
const MAX_PENDING_CHARS = 4 * 1024 * 1024;

function preview(value: string): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length <= 80 ? flat : `${flat.slice(0, 80)}…`;
}

function decodeLine(line: string, out: NdjsonDecodeResult): void {
  const trimmed = line.trim();
  // Blank lines are legal and ignored (Zed sends a trailing `\n` after each
  // message, so an empty line is ordinary traffic, not corruption).
  if (trimmed.length === 0) return;
  try {
    out.messages.push(JSON.parse(trimmed) as unknown);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    out.warnings.push(`dropped a non-JSON line (${detail}): ${preview(trimmed)}`);
  }
}

export function createNdjsonDecoder(): NdjsonDecoder {
  let buffer = '';

  const take = (text: string, out: NdjsonDecodeResult): void => {
    for (;;) {
      const nl = text.indexOf('\n');
      if (nl < 0) break;
      decodeLine(text.slice(0, nl), out);
      text = text.slice(nl + 1);
    }
    if (text.length > MAX_PENDING_CHARS) {
      out.warnings.push(
        `dropped ${text.length} buffered chars: no newline within the ${MAX_PENDING_CHARS}-char cap`,
      );
      text = '';
    }
    buffer = text;
  };

  return {
    push(chunk: string): NdjsonDecodeResult {
      const out: NdjsonDecodeResult = { messages: [], warnings: [] };
      take(buffer + chunk, out);
      return out;
    },
    flush(): NdjsonDecodeResult {
      const out: NdjsonDecodeResult = { messages: [], warnings: [] };
      const tail = buffer;
      buffer = '';
      decodeLine(tail, out);
      return out;
    },
  };
}

/** Frame one JSON-RPC message for the wire (trailing `\n`, no embedded ones). */
export function encodeNdjson(message: unknown): string {
  return `${JSON.stringify(message)}\n`;
}
