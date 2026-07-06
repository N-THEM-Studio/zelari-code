/**
 * lsp/protocol — LSP wire framing + minimal type helpers.
 *
 * Language Server Protocol messages are JSON-RPC 2.0 objects framed with an
 * HTTP-style header: `Content-Length: <bytes>\r\n\r\n<json-body>`. This module
 * is the pure, dependency-free core: encode a message, and incrementally
 * decode a byte stream into complete messages (handling partial frames and
 * multiple messages per chunk). It never does I/O, so it's fully unit-testable.
 */

/** Encode a JSON-RPC message into a framed LSP wire string. */
export function encodeMessage(message: unknown): string {
  const json = JSON.stringify(message);
  // Content-Length is the BYTE length of the body, not the char length.
  const contentLength = Buffer.byteLength(json, 'utf8');
  return `Content-Length: ${contentLength}\r\n\r\n${json}`;
}

/**
 * Incremental LSP message decoder. Feed it raw stdout chunks; it returns any
 * complete JSON-RPC messages parsed so far, buffering partial frames.
 */
export function createMessageParser(): {
  push: (chunk: string) => unknown[];
} {
  let buffer = '';
  return {
    push(chunk: string): unknown[] {
      buffer += chunk;
      const out: unknown[] = [];
      // Loop: each iteration extracts one complete frame, or breaks when the
      // buffer doesn't yet hold a full header+body.
      for (;;) {
        const headerEnd = buffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) break; // header not complete yet
        const header = buffer.slice(0, headerEnd);
        const match = /Content-Length:\s*(\d+)/i.exec(header);
        if (!match) {
          // Malformed header — drop up to the separator and resync.
          buffer = buffer.slice(headerEnd + 4);
          continue;
        }
        const length = Number(match[1]);
        const bodyStart = headerEnd + 4;
        // Content-Length is bytes; slice by bytes to be correct with UTF-8.
        const rest = Buffer.from(buffer.slice(bodyStart), 'utf8');
        if (rest.length < length) break; // body not fully arrived yet
        const body = rest.subarray(0, length).toString('utf8');
        // Advance the buffer past the consumed body (re-encode remainder).
        buffer = rest.subarray(length).toString('utf8');
        try {
          out.push(JSON.parse(body));
        } catch {
          // Skip an unparseable body — the stream stays framed correctly
          // because we already consumed exactly Content-Length bytes.
        }
      }
      return out;
    },
  };
}

// ---------------------------------------------------------------------------
// Minimal LSP types (only what the tools use)
// ---------------------------------------------------------------------------

export interface Position {
  line: number; // 0-based
  character: number; // 0-based
}

export interface Range {
  start: Position;
  end: Position;
}

export interface Location {
  uri: string;
  range: Range;
}

/** Convert a filesystem path to a `file://` URI (LSP identifies docs by URI). */
export function pathToUri(filePath: string): string {
  // Normalize Windows backslashes and ensure a leading slash.
  let p = filePath.replace(/\\/g, '/');
  if (!p.startsWith('/')) p = `/${p}`;
  // Encode each segment but keep the slashes.
  const encoded = p
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
  return `file://${encoded}`;
}

/** Convert a `file://` URI back to a filesystem path. */
export function uriToPath(uri: string): string {
  if (!uri.startsWith('file://')) return uri;
  const withoutScheme = decodeURIComponent(uri.slice('file://'.length));
  // On POSIX the path already starts with '/'. On Windows LSP emits
  // file:///C:/... — strip the leading slash before a drive letter.
  return /^\/[A-Za-z]:/.test(withoutScheme) ? withoutScheme.slice(1) : withoutScheme;
}
