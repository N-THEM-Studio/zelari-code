/**
 * claudeProvider — local-CLI provider (Slice B, OpenMausBot driver pattern,
 * MIT). Implements zelari's `ProviderStreamFn` by spawning an external agent
 * CLI (`claude` by default; `ZELARI_LOCAL_CLI` to override) in print mode
 * with `--output-format stream-json --input-format stream-json`, feeding it
 * the harness conversation, and translating its events into ProviderDelta.
 *
 * The external CLI is an autonomous agent: it executes its own tools and, when
 * `ZELARI_PERM_SOCKET` is set (Slice A broker in the parent zelari process),
 * approval prompts arrive in the zelari TUI via
 * `--permission-prompt-tool "zelari-code --permission-mcp <socket>"`.
 *
 * Stateless per harness contract: the harness re-invokes the provider with
 * the full updated conversation on every tool-loop iteration, so each call
 * spawns a fresh CLI process.
 *
 * `cli`/`args` are injectable for tests (a fake CLI script).
 *
 * @since v1.30.0
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { ProviderStreamFn, ProviderDelta } from '@zelari/core/harness';
import {
  buildClaudeInputLines,
  createClaudeStreamParser,
} from './claudeStreamJson.js';

export interface LocalCliProviderOptions {
  /** Executable to spawn (default: process.env.ZELARI_LOCAL_CLI ?? 'claude'). */
  cli?: string;
  /** Override the full argv (used by tests with a fake CLI script). */
  args?: string[];
  /** Passed as --model when set. */
  model?: string;
  /** Socket for the Slice A permission broker (default: ZELARI_PERM_SOCKET). */
  permissionSocketPath?: string;
  /** Extra env for the spawned CLI (default: inherit process.env). */
  env?: NodeJS.ProcessEnv;
  /** Injectable spawn for tests. */
  spawnFn?: typeof spawn;
}

const DEFAULT_ARGS = [
  '-p',
  '--output-format',
  'stream-json',
  '--input-format',
  'stream-json',
  '--verbose',
];

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

export function createLocalCliProvider(
  opts: LocalCliProviderOptions = {},
): ProviderStreamFn {
  return async function* (params): AsyncIterable<ProviderDelta> {
    const cli = opts.cli ?? process.env.ZELARI_LOCAL_CLI ?? 'claude';
    const model = opts.model ?? params.model;
    const permSocket =
      opts.permissionSocketPath ?? process.env.ZELARI_PERM_SOCKET ?? '';

    const args = opts.args ?? [...DEFAULT_ARGS];
    if (opts.args === undefined) {
      if (model) {
        args.push('--model', model);
      }
      if (permSocket) {
        args.push(
          '--permission-prompt-tool',
          `zelari-code --permission-mcp ${permSocket}`,
        );
      }
    }

    const spawnFn = opts.spawnFn ?? spawn;
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawnFn(cli, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        ...(opts.env ? { env: opts.env } : {}),
      }) as ChildProcessWithoutNullStreams;
    } catch (err) {
      yield {
        kind: 'error',
        message: `[local-cli] failed to spawn ${cli}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
      return;
    }

    const spawnErrorBox: { err: Error | null } = { err: null };
    child.once('error', (err: Error) => {
      spawnErrorBox.err = err;
    });
    const onAbort = () => {
      child.kill();
    };
    params.signal?.addEventListener('abort', onAbort, { once: true });

    let stderrTail = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => {
      stderrTail = (stderrTail + d).slice(-2000);
    });

    // Feed the conversation, then close stdin so the CLI starts.
    for (const line of buildClaudeInputLines(params.messages)) {
      child.stdin.write(line + '\n');
    }
    child.stdin.end();

    const parser = createClaudeStreamParser();
    let buf = '';
    let finished = false;

    try {
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
      // Trailing line without newline.
      if (buf.trim().length > 0) {
        for (const delta of parser.push(buf)) {
          if (delta.kind === 'finish') finished = true;
          yield delta;
        }
      }

      if (!finished) {
        const spawnErr = spawnErrorBox.err;
        if (spawnErr) {
          yield {
            kind: 'error',
            message: `[local-cli] ${cli} failed to start: ${spawnErr.message}`,
          };
        } else {
          // stdout may close a tick before the 'exit' event fires, so await
          // the exit code deterministically instead of reading child.exitCode
          // right away (it can still be null here).
          const exitCode = await waitForExit(child);
          if (exitCode != null && exitCode !== 0) {
            yield {
              kind: 'error',
              message: `[local-cli] ${cli} exited ${exitCode}: ${stderrTail.trim() || 'no stderr'}`,
            };
          } else {
            // Stream ended without a result event (e.g. killed) — close cleanly.
            yield { kind: 'finish', reason: parser.stopReason || 'stop' };
          }
        }
      }
    } finally {
      params.signal?.removeEventListener('abort', onAbort);
      if (child.exitCode == null) child.kill();
    }
  };
}
