/**
 * claudeProvider — local-CLI provider. Spawns the official, unmodified
 * Claude Code binary (`claude` by default; `ZELARI_LOCAL_CLI` to override)
 * in print mode and translates `--output-format stream-json` into
 * ProviderDelta.
 *
 * The binary owns its tool loop. Zelari does not re-execute those tools.
 * Across harness turns the official session is continued with `--resume`
 * (see claudeSession.ts) instead of replaying a fresh conversation. Pass
 * `args` to keep the legacy one-shot spawn used by tests.
 *
 * Subscription login stays in the binary (`claude auth login`). This
 * provider does not read or store claude.ai tokens.
 *
 * @since v1.30.0
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { AgentMessage, ProviderDelta, ProviderStreamFn } from '@zelari/core/harness';
import { getPhase } from '../../phaseState.js';
import {
  buildClaudeInputLines,
  createClaudeStreamParser,
  type ClaudeStreamParser,
} from './claudeStreamJson.js';
import {
  buildClaudeLaunchArgs,
  messagesForClaudeTurn,
  peekClaudeCodeSession,
  rememberClaudeCodeSession,
} from './claudeSession.js';
import {
  resolveClaudeExecutable,
  type ClaudeExecutable,
} from './resolveClaudeExecutable.js';

export interface LocalCliProviderOptions {
  /** Executable to spawn (default: process.env.ZELARI_LOCAL_CLI ?? 'claude'). */
  cli?: string;
  /**
   * Override the full argv (tests with a fake CLI script). When set, binary
   * resolution and `--resume` are skipped so the one-shot contract stays.
   */
  args?: string[];
  /** Passed as --model when set. */
  model?: string;
  /** Socket for the Slice A permission broker (default: ZELARI_PERM_SOCKET). */
  permissionSocketPath?: string;
  /** Extra env for the spawned CLI (default: inherit process.env). */
  env?: NodeJS.ProcessEnv;
  /** Injectable spawn for tests. */
  spawnFn?: typeof spawn;
  /** Override getPhase() for tests. Read at stream time when omitted. */
  phase?: 'plan' | 'build';
  /** Injectable resolver. Default: resolveClaudeExecutable. */
  resolveCli?: (name: string) => ClaudeExecutable;
}

interface PumpOutcome {
  sessionId: string | null;
  errored: boolean;
}

/** Resolve the child exit code, waiting for the 'exit' event if needed. */
function waitForExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs = 2_000,
): Promise<number | null> {
  return new Promise((resolve) => {
    if (child.exitCode != null) return resolve(child.exitCode);
    const timer = setTimeout(() => resolve(child.exitCode ?? null), timeoutMs);
    timer.unref?.();
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code ?? null);
    });
  });
}

async function* pumpClaudeChild(input: {
  program: string;
  args: string[];
  label: string;
  messages: readonly AgentMessage[];
  spawnFn: typeof spawn;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}): AsyncGenerator<ProviderDelta, PumpOutcome> {
  const { program, args, label, messages, spawnFn } = input;
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawnFn(program, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(input.env ? { env: input.env } : {}),
    }) as ChildProcessWithoutNullStreams;
  } catch (err) {
    yield {
      kind: 'error',
      message: `[local-cli] failed to spawn ${label}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
    return { sessionId: null, errored: true };
  }

  const spawnErrorBox: { err: Error | null } = { err: null };
  child.once('error', (err: Error) => {
    spawnErrorBox.err = err;
  });
  const onAbort = () => {
    child.kill();
  };
  input.signal?.addEventListener('abort', onAbort, { once: true });

  let stderrTail = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => {
    stderrTail = (stderrTail + d).slice(-2000);
  });

  const parser: ClaudeStreamParser = createClaudeStreamParser();
  let errored = false;
  try {
    for (const line of buildClaudeInputLines(messages)) {
      child.stdin.write(line + '\n');
    }
    child.stdin.end();

    let buf = '';
    let finished = false;
    for await (const chunk of child.stdout) {
      buf += chunk.toString('utf8');
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        for (const delta of parser.push(line)) {
          if (delta.kind === 'finish') finished = true;
          yield delta;
        }
      }
    }
    if (buf.trim().length > 0) {
      for (const delta of parser.push(buf)) {
        if (delta.kind === 'finish') finished = true;
        yield delta;
      }
    }

    if (!finished) {
      const spawnErr = spawnErrorBox.err;
      if (spawnErr) {
        errored = true;
        yield {
          kind: 'error',
          message: `[local-cli] ${label} failed to start: ${spawnErr.message}`,
        };
      } else {
        const exitCode = await waitForExit(child);
        if (exitCode != null && exitCode !== 0) {
          errored = true;
          yield {
            kind: 'error',
            message: `[local-cli] ${label} exited ${exitCode}: ${stderrTail.trim() || 'no stderr'}`,
          };
        } else {
          yield { kind: 'finish', reason: parser.stopReason || 'stop' };
        }
      }
    }
  } finally {
    input.signal?.removeEventListener('abort', onAbort);
    if (child.exitCode == null) child.kill();
  }
  return { sessionId: parser.sessionId, errored };
}

export function createLocalCliProvider(
  opts: LocalCliProviderOptions = {},
): ProviderStreamFn {
  const resolveCli = opts.resolveCli ?? ((name: string) => resolveClaudeExecutable(name));
  return async function* (params): AsyncIterable<ProviderDelta> {
    const cli = opts.cli ?? process.env.ZELARI_LOCAL_CLI ?? 'claude';
    const model = opts.model ?? params.model;
    const permSocket =
      opts.permissionSocketPath ?? process.env.ZELARI_PERM_SOCKET ?? '';
    const oneShot = opts.args !== undefined;

    let program = cli;
    let args: string[];
    let feed: readonly AgentMessage[] = params.messages;
    const conversationId = params.conversationId ?? '';

    if (oneShot) {
      args = opts.args ?? [];
    } else {
      const resolved = resolveCli(cli);
      if (!resolved.ok) {
        yield { kind: 'error', message: resolved.reason };
        return;
      }
      const prior = conversationId ? peekClaudeCodeSession(conversationId) : undefined;
      program = resolved.program;
      args = [
        ...resolved.argvPrefix,
        ...buildClaudeLaunchArgs({
          model,
          permissionSocketPath: permSocket,
          phase: opts.phase ?? getPhase(),
          resumeSessionId: prior?.claudeSessionId ?? null,
        }),
      ];
      feed = messagesForClaudeTurn(params.messages, prior?.sentMessageCount ?? 0);
    }

    const outcome = yield* pumpClaudeChild({
      program,
      args,
      label: cli,
      messages: feed,
      spawnFn: opts.spawnFn ?? spawn,
      env: opts.env,
      signal: params.signal,
    });

    if (!oneShot && conversationId && outcome.sessionId && !outcome.errored) {
      rememberClaudeCodeSession(conversationId, {
        claudeSessionId: outcome.sessionId,
        sentMessageCount: params.messages.length,
      });
    }
  };
}
