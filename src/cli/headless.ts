/**
 * headless — non-interactive CLI mode for CI/CD, scripting, and Zelari Desktop.
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
import type { WorkPhase } from './phase.js';
import { parsePhase } from './phase.js';
import { parseMode } from './mode.js';
import type { ChatMode } from './components/StatusBar.js';
import type { AgentMessage } from '@zelari/core/harness';
import { readFileSync } from 'node:fs';

/** Dispatch mode for headless (mirrors TUI shift+tab modes). */
export type HeadlessMode = ChatMode; // 'agent' | 'council' | 'zelari'

export interface HeadlessOptions {
  /** The user prompt. */
  task: string;
  /** Output format. 'json' = one NDJSON object per event, 'plain' = streamed text. */
  output: 'json' | 'plain';
  /**
   * Dispatch mode. Prefer this over `useCouncil`.
   * @since desktop parity
   */
  mode: HeadlessMode;
  /**
   * Work phase (plan = no project writes; build = full tools).
   * @since desktop parity
   */
  phase: WorkPhase;
  /**
   * Use the council pipeline instead of single-agent dispatch.
   * Kept for backward compatibility; derived from `mode === 'council'` when parsing.
   */
  useCouncil: boolean;
  /** Provider id override (defaults to active provider). */
  provider?: string;
  /** Model override (defaults to provider.json model). */
  model?: string;
  /**
   * Prior conversation turns, so the desktop (which spawns a fresh headless
   * process per message) can preserve multi-turn context. Each invocation
   * seeds the harness with `[system, ...history, {user: task}]` and emits a
   * `history_snapshot` event at end-of-turn for the caller to replay next time.
   * Parsed from `--history <json>`; invalid JSON is ignored (stateless fallback).
   * @since v1.10.0
   */
  history?: AgentMessage[];
}

export interface HeadlessParseResult {
  options: HeadlessOptions | null;
  error?: string;
  help?: string;
}

const HELP_TEXT = `zelari-code --headless --task <prompt> [options]

Non-interactive mode. Streams BrainEvents as NDJSON to stdout (one JSON
object per line) or as plain text (just the assistant message text).

Options:
  --task <text>              Task prompt (required)
  --output json|plain        Output format (default: json)
  --mode agent|council|zelari  Dispatch mode (default: agent)
  --council                  Alias for --mode council
  --phase plan|build         Work phase (default: build)
  --provider <id>            Provider override (default: active)
  --model <name>             Model override (default: provider default)
  --history <json>           Prior turns (JSON AgentMessage[]) for multi-turn context
  --history-file <path>      Same as --history but read from a file (avoids Windows argv cap)

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
  let mode: HeadlessMode = 'agent';
  let phase: WorkPhase = 'build';
  let modeExplicit = false;
  let councilFlag = false;
  let provider: string | undefined;
  let model: string | undefined;
  let history: AgentMessage[] | undefined;

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
      councilFlag = true;
    } else if (arg === '--mode') {
      const next = argv[i + 1];
      const parsed = next ? parseMode(next) : null;
      if (!parsed) {
        return {
          options: null,
          error: `--mode requires 'agent', 'council', or 'zelari', got '${next ?? '(missing)'}'`,
        };
      }
      mode = parsed;
      modeExplicit = true;
      i++;
    } else if (arg === '--phase') {
      const next = argv[i + 1];
      const parsed = next ? parsePhase(next) : null;
      if (!parsed) {
        return {
          options: null,
          error: `--phase requires 'plan' or 'build', got '${next ?? '(missing)'}'`,
        };
      }
      phase = parsed;
      i++;
    } else if (arg === '--provider') {
      provider = argv[i + 1];
      i++;
    } else if (arg === '--model') {
      model = argv[i + 1];
      i++;
    } else if (arg === '--history' || arg === '--history-file') {
      // Multi-turn context from the desktop. `--history` takes the JSON inline
      // (kept for backward compat / scripting); `--history-file` reads it from
      // a tempfile. The file path is PREFERRED on Windows because CreateProcess
      // caps the command line at ~32KB (os error 206) and a long chat history
      // overflows it. Invalid/missing JSON is ignored: the run degrades to
      // stateless (pre-v1.10.0 behavior) rather than erroring out.
      const next = argv[i + 1];
      if (next) {
        let raw: string | null = null;
        if (arg === '--history-file') {
          try {
            raw = readFileSync(next, 'utf-8');
          } catch {
            raw = null; // File gone/unreadable — run stateless.
          }
        } else {
          raw = next;
        }
        if (raw) {
          try {
            const parsedHist = JSON.parse(raw);
            if (Array.isArray(parsedHist)) {
              history = parsedHist.filter(
                (m): m is AgentMessage =>
                  m && typeof m === 'object' && typeof m.role === 'string' &&
                  typeof m.content === 'string',
              );
            }
          } catch {
            // Swallow: stale/incompatible history.
          }
        }
        i++;
      }
    }
  }

  // --council is an alias for --mode council when --mode was not set.
  if (councilFlag && !modeExplicit) {
    mode = 'council';
  } else if (councilFlag && modeExplicit && mode !== 'council') {
    return {
      options: null,
      error: `--council conflicts with --mode ${mode}`,
    };
  }

  if (!task || task.trim().length === 0) {
    return { options: null, error: '--headless requires --task <prompt>' };
  }

  return {
    options: {
      task,
      output,
      mode,
      phase,
      useCouncil: mode === 'council',
      provider,
      model,
      ...(history && history.length > 0 ? { history } : {}),
    },
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
  { apiKey: string; baseUrl: string } | { error: string }
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
  const { resolveBaseUrl } = await import('./provider/openai-compatible.js');
  return {
    apiKey: resolved.apiKey,
    baseUrl: resolveBaseUrl(providerId as never),
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
