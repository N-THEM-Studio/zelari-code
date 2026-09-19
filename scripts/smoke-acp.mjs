#!/usr/bin/env node
/**
 * smoke:acp — end-to-end smoke of the ACP front door from the real bundle.
 *
 * TWO roundtrips, one per WIRE FORMAT the server must speak:
 *   1. NDJSON (newline-delimited JSON) — the ACP stdio spec, as spoken by Zed
 *      (agentclientprotocol.com/protocol/transports). Regression guard: the
 *      server once shipped accepting ONLY LSP frames — every smoke green,
 *      every spec-conformant client hung forever on `initialize`.
 *   2. LSP-style frames (`Content-Length: <n>\r\n\r\n<json>`) — legacy
 *      compat, still accepted and mirrored on output.
 *
 * Each roundtrip spawns `node bin/zelari-code.js acp`, sends `initialize`,
 * and asserts the response carries `result.protocolVersion === 1` in the SAME
 * wire it was sent with (the writer mirrors the reader's detected format).
 * Exit 0 only if BOTH pass.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(root, 'bin', 'zelari-code.js');
const TIMEOUT_MS = 20_000;

function fail(msg) {
  console.error(`[smoke:acp] FAIL — ${msg}`);
  process.exit(1);
}

const encodeLsp = (obj) => {
  const body = JSON.stringify(obj);
  return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
};
const encodeNdjson = (obj) => `${JSON.stringify(obj)}\n`;

/** Each reader consumes from `buf.text`, returns {msg, consumed} or null. */
function readLsp(buf) {
  const headerEnd = buf.text.indexOf('\r\n\r\n');
  if (headerEnd < 0) return null;
  const m = /Content-Length:\s*(\d+)/i.exec(buf.text.slice(0, headerEnd));
  if (!m) throw new Error(`bad framing header: ${JSON.stringify(buf.text.slice(0, headerEnd))}`);
  const len = Number(m[1]);
  if (buf.text.length < headerEnd + 4 + len) return null; // incomplete body
  return { msg: JSON.parse(buf.text.slice(headerEnd + 4, headerEnd + 4 + len)), consumed: headerEnd + 4 + len };
}

function readNdjson(buf) {
  const nl = buf.text.indexOf('\n');
  if (nl < 0) return null; // incomplete line
  return { msg: JSON.parse(buf.text.slice(0, nl)), consumed: nl + 1 };
}

function checkInitializeResponse(msg) {
  if (msg.id !== 1) return `expected id 1, got ${JSON.stringify(msg.id)}`;
  if (msg.error) return `JSON-RPC error: ${JSON.stringify(msg.error)}`;
  if (!msg.result || msg.result.protocolVersion !== 1) {
    return `expected result.protocolVersion 1, got ${JSON.stringify(msg.result)}`;
  }
  return null;
}

function roundtrip(label, encode, read) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, 'acp'], {
      cwd: root,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const buf = { text: '' };
    let stderrTail = '';
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      if (err) reject(err);
      else resolve();
    };
    const timer = setTimeout(() => {
      finish(new Error(`timeout after ${TIMEOUT_MS}ms waiting for initialize response`));
    }, TIMEOUT_MS);

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buf.text += chunk;
      let parsed;
      try {
        parsed = read(buf);
      } catch (e) {
        return finish(new Error(`non-JSON body: ${e.message}`));
      }
      if (!parsed) return; // wait for more bytes
      const problem = checkInitializeResponse(parsed.msg);
      if (problem) return finish(new Error(problem));
      finish(null);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c) => {
      stderrTail = (stderrTail + c).slice(-500);
    });
    child.on('error', (e) => finish(new Error(`spawn failed: ${e.message} — run npm run build first`)));
    child.on('exit', (code) => {
      if (code !== null && buf.text.length === 0 && !settled) {
        finish(new Error(`acp exited ${code} before any response. stderr: ${stderrTail}`));
      }
    });

    child.stdin.write(encode({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }));
    child.stdin.end();
  }).then(() => {
    console.log(`[smoke:acp] PASS — ${label}: initialize -> protocolVersion 1`);
  });
}

const wires = [
  ['ndjson (ACP stdio spec, Zed)', encodeNdjson, readNdjson],
  ['lsp frames (legacy compat)', encodeLsp, readLsp],
];

try {
  for (const [label, encode, read] of wires) await roundtrip(label, encode, read);
  process.exit(0);
} catch (e) {
  fail(e.message);
}
