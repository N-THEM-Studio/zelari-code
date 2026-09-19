/**
 * acp/command — `zelari-code acp`: the Agent Client Protocol front door.
 *
 * Host discipline mirrors `serve` / `--serve-harness` (main.ts): no TUI, no
 * Ink, no preflight — the transport owns stdin/stdout for the whole process
 * lifetime. Flags are minimal and default to the existing configuration:
 *
 *   --cwd <path>       Fallback workspace for clients that omit cwd on
 *                      session/new (default: the process cwd)
 *   --provider <id>    Provider override (default: the active provider)
 *   --model <id>       Model override (default: the provider's model)
 *   --help, -h         Print this help and exit 0
 *
 * Exit codes: 0 on a clean shutdown (stdin EOF or SIGINT/SIGTERM), 1 on a
 * fatal transport failure.
 *
 * @since 2.51.0
 */
import { createHeadlessTurnDispatcher } from './turnAdapter.js';
import { startAcpServer } from './server.js';
import type { Readable } from 'node:stream';
import type { FrameSink } from './framing.js';

export interface AcpCommandOptions {
  help?: boolean;
  cwd?: string;
  model?: string;
  provider?: string;
  /** Transport input. Injectable for tests; defaults to `process.stdin`. */
  input?: Readable;
  /** Transport output. Injectable for tests; defaults to `process.stdout`. */
  output?: FrameSink;
}

/** Read one `--flag <value>` pair; a missing/flag-shaped value is ignored. */
function readFlagValue(argv: readonly string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  if (i < 0) return undefined;
  const value = argv[i + 1];
  return typeof value === 'string' && value.length > 0 && !value.startsWith('--')
    ? value
    : undefined;
}

/** Parse the `acp` subcommand flags (never throws; unknown flags are ignored). */
export function parseAcpFlags(argv: readonly string[]): AcpCommandOptions {
  const out: AcpCommandOptions = {};
  if (argv.includes('--help') || argv.includes('-h')) out.help = true;
  const cwd = readFlagValue(argv, '--cwd');
  const model = readFlagValue(argv, '--model');
  const provider = readFlagValue(argv, '--provider');
  if (cwd !== undefined) out.cwd = cwd;
  if (model !== undefined) out.model = model;
  if (provider !== undefined) out.provider = provider;
  return out;
}

export function acpHelpText(): string {
  return (
    'zelari-code acp — Agent Client Protocol server on stdio (for editors)\n' +
    '\n' +
    'Speaks JSON-RPC 2.0 over stdin/stdout with LSP-style framing\n' +
    '(`Content-Length: <bytes>\\r\\n\\r\\n<json>`). Point an ACP-capable editor\n' +
    '(e.g. Zed) at this command as a custom agent server.\n' +
    '\n' +
    'Methods (implemented subset):\n' +
    '  initialize                 protocolVersion + agent capabilities\n' +
    '  session/new { cwd }        -> { sessionId }\n' +
    '  session/prompt { sessionId, prompt: [{type:"text",text}] }\n' +
    '                             -> { stopReason } when the turn ends\n' +
    '  session/cancel { sessionId }\n' +
    '\n' +
    'Notifications sent to the client: session/update with\n' +
    'agent_message_chunk, tool_call and tool_call_update (see\n' +
    'src/cli/acp/protocol.ts for the exact subset and its non-goals).\n' +
    '\n' +
    'Options:\n' +
    '  --cwd <path>       Fallback workspace when a client omits cwd\n' +
    '                     (default: current directory)\n' +
    '  --provider <id>    Provider override (default: the active provider)\n' +
    '  --model <id>       Model override (default: the provider default)\n' +
    '  --help, -h         Print this help and exit\n' +
    '\n' +
    'Turns run through the same headless dispatch as `--headless`\n' +
    '(kraken by default), one turn at a time; stdin EOF shuts down cleanly.\n'
  );
}

/**
 * Run the ACP transport until stdin closes (or a signal arrives). Never
 * throws: a fatal boot failure is reported and mapped to exit code 1.
 */
export async function runAcpCommand(opts: AcpCommandOptions = {}): Promise<number> {
  if (opts.help === true) {
    process.stdout.write(acpHelpText());
    return 0;
  }
  const dispatcher = createHeadlessTurnDispatcher({
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.provider ? { provider: opts.provider } : {}),
  });
  return await new Promise<number>((resolve) => {
    let settled = false;
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      resolve(code);
    };
    let handle: ReturnType<typeof startAcpServer>;
    try {
      handle = startAcpServer({
        dispatcher,
        ...(opts.cwd ? { fallbackCwd: opts.cwd } : {}),
        ...(opts.input ? { input: opts.input } : {}),
        ...(opts.output ? { output: opts.output } : {}),
        log: (line) => {
          try {
            process.stderr.write(`${line}\n`);
          } catch {
            /* stderr closed: diagnostics are best-effort */
          }
        },
        onShutdown: () => finish(0),
      });
    } catch (err) {
      process.stderr.write(
        `[zelari-code acp] fatal: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      finish(1);
      return;
    }
    const onSignal = (): void => {
      handle.close();
      finish(0);
    };
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
  });
}
