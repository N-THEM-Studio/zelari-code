/**
 * echo-mcp.mjs — WS6 example bundle: a REAL, self-contained MCP stdio server.
 *
 * Speaks Model Context Protocol over stdin/stdout as newline-delimited JSON-RPC
 * 2.0 (the transport `src/cli/mcp/mcpClient.ts` drives: one JSON object per
 * line, no embedded newlines). It implements the handshake plus the two
 * requests a server must answer to be usable, and exposes one tool:
 *
 *   initialize               → protocolVersion / capabilities / serverInfo
 *   notifications/initialized → (notification: no reply by contract)
 *   tools/list               → [{ name: "echo", ... }]
 *   tools/call {name,args}   → { content: [{ type: "text", text }] }
 *
 * Zero dependencies, no network, no file access — the point is that a bundle
 * can ship an MCP server that is real and still says nothing about secrets.
 */
import { createInterface } from 'node:readline';

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'echo-example', version: '1.0.0' };

const TOOLS = [
  {
    name: 'echo',
    description: 'Echo the given text back. The smallest useful MCP tool.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'Text to echo back' } },
      required: ['text'],
      additionalProperties: false,
    },
  },
];

/** One JSON object per line — the wire format of the stdio transport. */
function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendResult(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function handle(message) {
  const { id, method, params } = message ?? {};
  switch (method) {
    case 'initialize':
      return sendResult(id, {
        protocolVersion: params?.protocolVersion ?? PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return undefined; // notifications are answered by silence
    case 'ping':
      return sendResult(id, {});
    case 'tools/list':
      return sendResult(id, { tools: TOOLS });
    case 'tools/call': {
      if (params?.name !== 'echo') {
        return sendResult(id, {
          content: [{ type: 'text', text: `Unknown tool: ${String(params?.name)}` }],
          isError: true,
        });
      }
      const text = params?.arguments?.text;
      if (typeof text !== 'string') {
        return sendResult(id, {
          content: [{ type: 'text', text: 'Missing required string argument: text' }],
          isError: true,
        });
      }
      return sendResult(id, { content: [{ type: 'text', text }] });
    }
    default:
      // A request (has id) gets an error back; an unknown notification is dropped.
      if (id === undefined) return undefined;
      return send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${String(method)}` } });
  }
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (trimmed === '') return;
  try {
    handle(JSON.parse(trimmed));
  } catch (err) {
    process.stderr.write(
      `[echo-example] ignoring unparseable line: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
});
