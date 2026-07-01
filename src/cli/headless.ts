/**
 * headless — non-interactive CLI mode for CI/CD and scripting.
 *
 * Bypasses Ink entirely. Reads `--task <prompt>`, runs the prompt
 * through the same dispatch path the TUI uses, and serializes the
 * resulting events as one JSON object per line (NDJSON) on stdout.
 *
 * Exit codes:
 *   0  — task completed successfully (last `agent_end.reason === 'completed'`)
 *   1  — user error (missing task, missing API key, invalid flag)
 *   2  — runtime error (provider failure, council exception)
 *   3  — task errored (the agent run itself emitted `agent_end.reason === 'error'`)
 *
 * @public
 * @since 0.5.0
 */
import { PROVIDERS, resolveApiKeyWithMeta } from './keyStore.js';
import { getActiveProvider, getModelForProvider } from './providerConfig.js';
import { openaiCompatibleProvider } from './provider/openai-compatible.js';

export interface HeadlessOptions {
  /** The user prompt. */
  task: string;
  /** Output format. 'json' = one NDJSON object per event, 'plain' = streamed text. */
  output: 'json' | 'plain';
  /** Use the council pipeline instead of single-agent dispatch. */
  useCouncil: boolean;
  /** Provider id override (defaults to active provider). */
  provider?: string;
  /** Model override (defaults to provider.json model). */
  model?: string;
}

export interface HeadlessParseResult {
  options: HeadlessOptions | null;
  error?: string;
  help?: string;
}

const HELP_TEXT = `zelari-code --headless --task <prompt> [--output json|plain] [--council] [--provider <id>] [--model <name>]

Non-interactive mode. Streams BrainEvents as NDJSON to stdout (one JSON
object per line) or as plain text (just the assistant message text).

Exit codes:
  0  completed
  1  user error (bad flags, missing API key, ...)
  2  runtime error (provider failure, council exception)
  3  agent run errored
`;

/**
 * Parse argv for --headless options. Returns null options when
 * --headless is not present (caller should fall through to TUI mode).
 */
export function parseHeadlessFlags(argv: readonly string[]): HeadlessParseResult {
  if (!argv.includes('--headless')) {
    return { options: null };
  }

  let task: string | undefined;
  let output: 'json' | 'plain' = 'json';
  let useCouncil = false;
  let provider: string | undefined;
  let model: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--headless') continue;
    if (arg === '--output') {
      const next = argv[i + 1];
      if (next === 'json' || next === 'plain') {
        output = next;
        i++;
      } else {
        return {
          options: null,
          error: `--output requires 'json' or 'plain', got '${next ?? '(missing)'}'`,
        };
      }
    } else if (arg === '--task') {
      task = argv[i + 1];
      i++;
    } else if (arg === '--council') {
      useCouncil = true;
    } else if (arg === '--provider') {
      provider = argv[i + 1];
      i++;
    } else if (arg === '--model') {
      model = argv[i + 1];
      i++;
    }
  }

  if (!task || task.trim().length === 0) {
    return { options: null, error: '--headless requires --task <prompt>' };
  }

  return {
    options: { task, output, useCouncil, provider, model },
  };
}

/**
 * Print the headless help text to stdout (caller prints to stderr for errors).
 */
export function printHeadlessHelp(): void {
  // eslint-disable-next-line no-console
  console.log(HELP_TEXT);
}

/**
 * Resolve the API key for a provider; returns null with a reason
 * when the key is missing. Used to fail fast with a clear error
 * instead of failing mid-stream.
 */
export async function resolveHeadlessKey(providerId: string): Promise<
  { apiKey: string; baseUrl?: string } | { error: string }
> {
  const spec = PROVIDERS.find((p) => p.id === providerId);
  if (!spec) {
    return { error: `unknown provider: '${providerId}'` };
  }
  const resolved = await resolveApiKeyWithMeta(providerId);
  if (!resolved || !resolved.apiKey) {
    return {
      error:
        `no API key for provider '${providerId}'.\n` +
        `Set the env var ${spec.envVar} or save a key via /login.`,
    };
  }
  // baseUrl lives in providerConfig (customEndpoints) not on StoredKey.
  // Imported lazily to avoid a circular dep at module load.
  const { getCustomEndpoint } = await import('./providerConfig.js');
  const customBase = getCustomEndpoint(providerId as never);
  return {
    apiKey: resolved.apiKey,
    ...(customBase ? { baseUrl: customBase } : {}),
  };
}

/**
 * Determine the effective provider + model for a headless run.
 * Prefers explicit --provider/--model flags, then the active
 * provider from provider.json, then 'openai-compatible' as a
 * last resort.
 */
export function resolveHeadlessProvider(opts: HeadlessOptions): {
  provider: string;
  model: string;
} {
  const provider = opts.provider ?? getActiveProvider().id;
  const model = opts.model ?? getModelForProvider(provider as never);
  return { provider, model };
}

/**
 * Emit one NDJSON line to stdout. Use process.stdout.write directly
 * to avoid the console.log trailing newline (NDJSON convention is
 * one JSON object per line, no extra whitespace).
 */
export function emitEvent(event: unknown): void {
  process.stdout.write(JSON.stringify(event) + '\n');
}

export { openaiCompatibleProvider };
