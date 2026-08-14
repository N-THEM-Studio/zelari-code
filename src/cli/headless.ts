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
import type { AgentMessage, AgentImage } from '@zelari/core/harness';
import { readFileSync } from 'node:fs';
import type { SessionTodoStatus } from './sessionTodos.js';

/** Dispatch mode for headless (mirrors TUI shift+tab modes). */
export type HeadlessMode = ChatMode; // 'kraken' | 'council' | 'zelari'

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
  /**
   * Session todo list replayed by the Desktop across the per-message process
   * boundary, so `todo_read` returns the prior state instead of empty.
   * `writeSessionTodos` normalizes id/content/status. @since v1.35.x
   */
  todos?: Array<{ id?: string; content: string; status?: SessionTodoStatus }>;
  /** Inline images attached to this run (e.g. expanded from @img.png tags). */
  images?: AgentImage[];
  /**
   * When true, forces a single-cycle run (ZELARI_MISSION_MAX_ITER=1) and
   * acquires a trigger lockfile. Used by cron/git-hook triggers (ADR-0014).
   */
  once?: boolean;
  /**
   * Plan + execute a Kraken task graph (F4 planner + F3 executor) instead
   * of a normal single-agent/council/zelari dispatch. Mutually exclusive
   * with `--task`. Gated by the ZELARI_KRAKEN_GRAPH kill-switch.
   * @since Kraken graph engine F6
   */
  krakenGraph?: string;
  /**
   * When true, the kraken-graph flow plans the graph, serializes it to
   * `.zelari/radio/plan-<id>.json`, and exits 0 WITHOUT executing. Use
   * `--run-plan <id>` afterwards to inspect / approve / execute the
   * pre-flight plan manually. This is the first step of the "pre-flight
   * plan review" UX (see ADR 013 follow-up). Defaults to false; enabled
   * via env `ZELARI_KRAKEN_PLAN_ONLY=1`.
   * @since v1.31.x
   */
  planOnly?: boolean;
  /**
   * When set, skips the planner and executes a pre-built plan loaded
   * from `.zelari/radio/plan-<id>.json`. Pairs with `planOnly: true`:
   * the typical flow is "plan only" → "user inspects" → "run plan".
   * Set via env `ZELARI_KRAKEN_RUN_PLAN=<id>`.
   * @since v1.31.x
   */
  runPlan?: string;
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
  --mode kraken|council|zelari  Dispatch mode (default: kraken; agent=alias)
  --council                  Alias for --mode council
  --phase plan|build         Work phase (default: build)
  --provider <id>            Provider override (default: active)
  --model <name>             Model override (default: provider default)
  --history <json>           Prior turns (JSON AgentMessage[]) for multi-turn context
  --history-file <path>      Same as --history but read from a file (avoids Windows argv cap)
  --once                     Trigger mode: single cycle + lockfile (for cron/git hooks)
  --kraken-graph <goal>      Plan + execute a Kraken task graph instead of --task
                             (mutually exclusive with --task; ZELARI_KRAKEN_GRAPH=0 disables)

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
  let mode: HeadlessMode = 'kraken';
  let phase: WorkPhase = 'build';
  let modeExplicit = false;
  let councilFlag = false;
  let provider: string | undefined;
  let model: string | undefined;
  let history: AgentMessage[] | undefined;
  let todos: Array<{ id?: string; content: string; status?: SessionTodoStatus }> | undefined;
  let once = false;
  let krakenGraph: string | undefined;
  // Pre-flight plan review (Slice N+3): opt-in via env, with a CLI
  // flag for symmetry. Both default to off.
  let planOnly =
    process.env.ZELARI_KRAKEN_PLAN_ONLY === '1' ||
    process.env.ZELARI_KRAKEN_PLAN_ONLY === 'true';
  let runPlan = process.env.ZELARI_KRAKEN_RUN_PLAN;

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
          error: `--mode requires 'kraken', 'council', or 'zelari' (agent=alias), got '${next ?? '(missing)'}'`,
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
              // Coerce content to string: snapshots may omit content on
              // tool-call assistant stubs; empty string keeps the role.
              history = parsedHist
                .filter(
                  (m): m is Record<string, unknown> =>
                    !!m &&
                    typeof m === 'object' &&
                    typeof (m as { role?: unknown }).role === 'string',
                )
                .map((m) => {
                  const role = String(m.role);
                  const raw = m.content;
                  const content =
                    typeof raw === 'string'
                      ? raw
                      : raw == null
                        ? ''
                        : typeof raw === 'object'
                          ? JSON.stringify(raw)
                          : String(raw);
                  const msg: AgentMessage = {
                    role: role as AgentMessage['role'],
                    content,
                  };
                  if (typeof m.toolCallId === 'string') {
                    msg.toolCallId = m.toolCallId;
                  }
                  return msg;
                })
                .filter(
                  (m) =>
                    m.role === 'user' ||
                    m.role === 'assistant' ||
                    m.role === 'tool' ||
                    m.role === 'system',
                );
            }
          } catch {
            // Swallow: stale/incompatible history.
          }
        }
        i++;
      }
    } else if (arg === '--todos') {
      // JSON array of { id?, content, status? } — the Desktop replays the
      // mirrored todo list here so the fresh process keeps multi-turn tasks.
      const next = argv[i + 1];
      if (next) {
        try {
          const parsed = JSON.parse(next) as unknown;
          if (Array.isArray(parsed)) {
            todos = parsed
              .filter(
                (t): t is { id?: unknown; content?: unknown; status?: unknown } =>
                  !!t &&
                  typeof t === 'object' &&
                  typeof (t as { content?: unknown }).content === 'string',
              )
              .map((t) => ({
                id: typeof t.id === 'string' ? t.id : undefined,
                content: String(t.content).slice(0, 500),
                status: t.status as SessionTodoStatus | undefined,
              }));
          }
        } catch {
          // Swallow: stale/incompatible todos degrade to empty (stateless).
        }
        i++;
      }
    } else if (arg === '--once') {
      once = true;
    } else if (arg === '--kraken-graph') {
      krakenGraph = argv[i + 1];
      i++;
    } else if (arg === '--plan-only') {
      planOnly = true;
    } else if (arg === '--run-plan') {
      runPlan = argv[i + 1];
      i++;
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

  if (task && krakenGraph) {
    return { options: null, error: '--task and --kraken-graph are mutually exclusive' };
  }
  if ((!task || task.trim().length === 0) && (!krakenGraph || krakenGraph.trim().length === 0)) {
    return { options: null, error: '--headless requires --task <prompt> or --kraken-graph <goal>' };
  }

  return {
    options: {
      task: task ?? '',
      output,
      mode,
      phase,
      useCouncil: mode === 'council',
      provider,
      model,
      ...(history && history.length > 0 ? { history } : {}),
      ...(todos && todos.length > 0 ? { todos } : {}),
      ...(once ? { once: true } : {}),
      ...(krakenGraph ? { krakenGraph } : {}),
      ...(planOnly ? { planOnly: true } : {}),
      ...(runPlan ? { runPlan } : {}),
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
