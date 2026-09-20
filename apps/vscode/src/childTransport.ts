/**
 * childTransport — the production `AcpTransport`: `zelari-code acp` as a
 * child process with piped stdio.
 *
 * Node-only (no `vscode`), so the vitest suite exercises this real spawn path
 * against a real child: see acpClientChild.e2e.test.ts (a fixture agent, plus
 * the actual bundled CLI when `dist/` is present).
 *
 * Failure discipline (a broken pipe must never kill the extension host):
 *   - `spawn` failures AND stdout/stderr/stdin 'error' events (EPIPE when the
 *     agent dies first) are reported through `onError`/`onStderr`, never
 *     thrown; an unhandled 'error' event on a stream would crash VS Code.
 *   - stderr is split into lines with a runaway guard (a noisy agent must not
 *     grow the buffer without bound).
 *   - Nothing is buffered on the protocol path: values are held only until the
 *     first subscriber, and AcpClient subscribes in the same tick as the spawn.
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import type { AcpTransport } from './acpTransport.js';
import { resolveLaunchSpec, type ZelariLaunchConfig } from './launch.js';

export interface SpawnAcpOptions {
  /** Settings-derived launch configuration (see launch.ts). */
  config: Partial<ZelariLaunchConfig>;
  /** Workspace the agent runs in (session/new also carries it). */
  cwd?: string;
  /** Environment for the child (defaults to the extension host's). */
  env?: NodeJS.ProcessEnv;
  /** Injectable for tests; defaults to `process.platform`. */
  platform?: NodeJS.Platform;
}

export type SpawnAcpResult =
  | {
      ok: true;
      transport: AcpTransport;
      /** What was actually launched (logged by the extension). */
      spec: { program: string; args: string[]; useShell: boolean };
    }
  | { ok: false; reason: string };

/** Max chars held from an agent's stderr while no line boundary shows up. */
const STDERR_BUFFER_CAP = 64 * 1024;

interface Channel<T> {
  on(listener: (value: T) => void): void;
  emit(value: T): void;
}

/**
 * Fan-out with bounded late-subscriber replay, written for exactly ONE
 * consumer (AcpClient): values emitted before it subscribes are held and
 * replayed, so the session's first frames cannot be lost to a scheduling
 * accident.
 */
function createChannel<T>(maxHeld: number): Channel<T> {
  const listeners: ((value: T) => void)[] = [];
  const held: T[] = [];
  return {
    on(listener) {
      for (const value of held.splice(0)) listener(value);
      listeners.push(listener);
    },
    emit(value) {
      if (listeners.length === 0) {
        if (held.length < maxHeld) held.push(value);
        return;
      }
      for (const listener of [...listeners]) listener(value);
    },
  };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Spawn the ACP agent and adapt its stdio to `AcpTransport`. Never throws:
 * a bad configuration or an unusable program is an `{ ok: false, reason }`.
 */
export function spawnAcpTransport(options: SpawnAcpOptions): SpawnAcpResult {
  const resolution = resolveLaunchSpec(options.config, options.platform ?? process.platform);
  if (!resolution.ok) return { ok: false, reason: resolution.reason };

  const data = createChannel<string>(64);
  const ends = createChannel<void>(1);
  const exits = createChannel<{ code: number | null; signal: string | null }>(1);
  const errors = createChannel<Error>(1);
  const stderrLines = createChannel<string>(64);

  let child: ChildProcess;
  try {
    child = spawn(resolution.program, resolution.args, {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: options.env }),
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: resolution.useShell,
      windowsHide: true,
    });
  } catch (err) {
    return {
      ok: false,
      reason: `cannot start '${resolution.program}': ${messageOf(err)}`,
    };
  }

  let stderrBuffer = '';
  const onStderrChunk = (chunk: string): void => {
    stderrBuffer += chunk;
    for (;;) {
      const nl = stderrBuffer.indexOf('\n');
      if (nl < 0) break;
      const line = stderrBuffer.slice(0, nl).trimEnd();
      stderrBuffer = stderrBuffer.slice(nl + 1);
      if (line.length > 0) stderrLines.emit(line);
    }
    if (stderrBuffer.length > STDERR_BUFFER_CAP) {
      stderrBuffer = stderrBuffer.slice(-STDERR_BUFFER_CAP);
    }
  };

  if (child.stdout !== null) {
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => data.emit(chunk));
    child.stdout.on('end', () => ends.emit(undefined));
  }
  if (child.stderr !== null) {
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', onStderrChunk);
  }
  // A dead stdin (EPIPE) is the normal consequence of the agent exiting while
  // a shutdown write is in flight — a diagnostics line, not a crash.
  child.stdin?.on('error', (err: Error) => errors.emit(err));
  child.on('error', (err: Error) => errors.emit(err));
  child.on('exit', (code, signal) => exits.emit({ code, signal }));

  return {
    ok: true,
    spec: {
      program: resolution.program,
      args: resolution.args,
      useShell: resolution.useShell,
    },
    transport: {
      write(chunk: string): void {
        child.stdin?.write(chunk);
      },
      onData: (listener) => data.on(listener),
      onEnd: (listener) => ends.on(() => listener()),
      onExit: (listener) => exits.on(({ code, signal }) => listener(code, signal)),
      onError: (listener) => errors.on(listener),
      onStderr: (listener) => stderrLines.on(listener),
      endInput(): void {
        child.stdin?.end();
      },
      kill(): void {
        child.kill();
      },
    },
  };
}
