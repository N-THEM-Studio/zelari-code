#!/usr/bin/env node
/**
 * smoke:acp — end-to-end smoke of the ACP front door from the real bundle.
 *
 * Spawns `node bin/zelari-code.js acp`, sends one LSP-framed `initialize`
 * request, and asserts the JSON-RPC response carries
 * `result.protocolVersion`. This is the CI-grade version of the manual
 * roundtrip documented in docs/TOOLS.md ("ACP front door").
 *
 * Exit codes: 0 = pass, 1 = fail (message on stderr).
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(root, 'bin', 'zelari-code.js');
const TIMEOUT_MS = 20_000;

function encode(obj) {
  const body = JSON.stringify(obj);
  return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
}

function fail(msg) {
  console.error(`[smoke:acp] FAIL — ${msg}`);
  process.exit(1);
}

const child = spawn(process.execPath, [bin, 'acp'], {
  cwd: root,
  stdio: ['pipe', 'pipe', 'pipe'],
});

let buffer = '';
const timer = setTimeout(() => {
  fail(`timeout after ${TIMEOUT_MS}ms waiting for initialize response`);
  child.kill();
}, TIMEOUT_MS);

child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  // Minimal LSP framing scan: find one complete message and stop.
  const headerEnd = buffer.indexOf('\r\n\r\n');
  if (headerEnd < 0) return;
  const header = buffer.slice(0, headerEnd);
  const m = /Content-Length:\s*(\d+)/i.exec(header);
  if (!m) return fail(`bad framing header: ${JSON.stringify(header)}`);
  const len = Number(m[1]);
  if (buffer.length < headerEnd + 4 + len) return; // incomplete body
  const body = buffer.slice(headerEnd + 4, headerEnd + 4 + len);
  clearTimeout(timer);
  child.kill();
  let msg;
  try {
    msg = JSON.parse(body);
  } catch (e) {
    return fail(`non-JSON body: ${JSON.stringify(body.slice(0, 200))}`);
  }
  if (msg.id !== 1) return fail(`expected id 1, got ${JSON.stringify(msg.id)}`);
  if (msg.error) return fail(`JSON-RPC error: ${JSON.stringify(msg.error)}`);
  if (!msg.result || msg.result.protocolVersion !== 1) {
    return fail(`expected result.protocolVersion 1, got ${JSON.stringify(msg.result)}`);
  }
  console.log(`[smoke:acp] PASS — initialize -> protocolVersion ${msg.result.protocolVersion} (agent ${msg.result?.agentName ?? 'n/a'})`);
  process.exit(0);
});

let stderrTail = '';
child.stderr.setEncoding('utf8');
child.stderr.on('data', (c) => {
  stderrTail = (stderrTail + c).slice(-500);
});
child.on('error', (e) => fail(`spawn failed: ${e.message} — run npm run build first`));
child.on('exit', (code) => {
  if (code !== null && buffer.length === 0) {
    fail(`acp exited ${code} before any response. stderr: ${stderrTail}`);
  }
});

child.stdin.write(encode({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }));
child.stdin.end();
