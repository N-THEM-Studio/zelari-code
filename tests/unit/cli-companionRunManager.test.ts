/**
 * cli-companionRunManager.test.ts — t32 (Pilastro B residuo): companion
 * client mode (ZELARI_HARNESS_SERVER=1).
 *   (a) client mode drives runs over the harness NDJSON protocol via the
 *       transport seam — ZERO child processes are spawned, and run lifecycle
 *       (exitCode → completed/error, session.dispose after settle) holds;
 *   (b) cancel maps to session.cancel and the 'cancelled' status survives
 *       late turn settlement (same guard as the spawn path's close handler);
 *   (c) steer maps to session.steer and spawn mode rejects it explicitly;
 *   (d) DEFAULT (env unset): the legacy per-run `--headless` spawn is
 *       byte-identical (argv/env/stdio) and still completes runs.
 * child_process.spawn is mocked (vitest module mock, actual module spread) —
 * no new dependency, no real process anywhere.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import {
  HARNESS_SERVER_ENV,
  RunManager,
} from '../../src/cli/companion/runManager.js';
import type { HarnessTransport } from '../../src/cli/serve/harnessClient.js';

const childProcessMock = vi.hoisted(() => ({ spawn: vi.fn() }));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: childProcessMock.spawn };
});

interface TransportSpy {
  requests: Array<Record<string, unknown>>;
  respond(request: Record<string, unknown>, result: unknown): void;
  transport: HarnessTransport & { close(): Promise<void> };
  closeCount(): number;
}

function spyTransport(): TransportSpy {
  const requests: Array<Record<string, unknown>> = [];
  let listener: ((line: string) => void) | undefined;
  let closes = 0;
  return {
    requests,
    respond(request, result) {
      listener?.(JSON.stringify({ id: request['id'], ok: true, result }));
    },
    transport: {
      write: (line: string) => {
        requests.push(JSON.parse(line) as Record<string, unknown>);
      },
      onLine: (fn: (line: string) => void) => {
        listener = fn;
      },
      close: async () => {
        closes++;
      },
    },
    closeCount: () => closes,
  };
}

function request(spy: TransportSpy, method: string): Record<string, unknown> {
  const found = spy.requests.find((r) => r['method'] === method);
  if (!found) throw new Error(`no ${method} request observed`);
  return found;
}

function makeFakeChild(): ChildProcess {
  const child = new EventEmitter() as ChildProcess & {
    stdout: PassThrough;
    stderr: PassThrough;
    killed: boolean;
    kill: (signal?: string) => boolean;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    return true;
  };
  return child as unknown as ChildProcess;
}

describe('RunManager client mode (ZELARI_HARNESS_SERVER=1, t32)', () => {
  beforeEach(() => {
    childProcessMock.spawn.mockReset();
    process.env[HARNESS_SERVER_ENV] = '1';
  });
  afterEach(() => {
    delete process.env[HARNESS_SERVER_ENV];
  });

  it('(a) drives runs over session.create/run.turn with ZERO spawns', async () => {
    const spy = spyTransport();
    const manager = new RunManager({ createTransport: () => spy.transport });
    const started = manager.start({ prompt: 'build the widget', cwd: 'Z:\\proj' });
    expect(started.ok).toBe(true);

    const create = await vi.waitFor(() => request(spy, 'session.create'));
    expect(create['params']).toMatchObject({ workspaceRoot: 'Z:\\proj' });
    expect(childProcessMock.spawn).not.toHaveBeenCalled();

    // Protocol is request/response: run.turn goes out after create resolves.
    spy.respond(create, { sessionId: 'sess-a' });
    const turn = await vi.waitFor(() => request(spy, 'run.turn'));
    expect(turn['params']).toMatchObject({
      task: 'build the widget',
      mode: 'kraken',
      phase: 'build',
      output: 'json',
    });
    expect(childProcessMock.spawn).not.toHaveBeenCalled();

    spy.respond(turn, { exitCode: 0 });
    await vi.waitFor(() => expect(manager.getRun(started.run!.id)?.status).toBe('completed'));
    expect(manager.getRun(started.run!.id)?.exitCode).toBe(0);
    // Kernel hygiene: the per-run session slot is released after settlement.
    await vi.waitFor(() => expect(spy.requests.some((r) => r['method'] === 'session.dispose')).toBe(true));
    expect(childProcessMock.spawn).not.toHaveBeenCalled();

    await manager.close();
    expect(spy.closeCount()).toBe(1);
  });

  it('(b) cancel maps to session.cancel and cancelled status survives late settlement', async () => {
    const spy = spyTransport();
    const manager = new RunManager({ createTransport: () => spy.transport });
    const started = manager.start({ prompt: 'long task', cwd: 'Z:\\proj' }) as {
      ok: true;
      run: { id: string };
    };
    const create = await vi.waitFor(() => request(spy, 'session.create'));
    spy.respond(create, { sessionId: 'sess-x' });
    await vi.waitFor(() => expect(spy.requests.some((r) => r['method'] === 'run.turn')).toBe(true));

    expect(manager.cancel(started.run.id).ok).toBe(true);
    expect(manager.getRun(started.run.id)?.status).toBe('cancelled');
    const cancelReq = await vi.waitFor(() => request(spy, 'session.cancel'));
    expect(cancelReq['params']).toMatchObject({ sessionId: 'sess-x', reason: 'companion cancel' });

    // The turn settles later (harness.cancel makes runOneTurn return) — the
    // guard must NOT overwrite the cancelled status.
    spy.respond(request(spy, 'run.turn'), { exitCode: 0 });
    await vi.waitFor(() => expect(manager.getActive()).toBeNull());
    expect(manager.getRun(started.run.id)?.status).toBe('cancelled');
    await manager.close();
  });

  it('(c) steer maps to session.steer in client mode and is an explicit error in spawn mode', async () => {
    const spy = spyTransport();
    const manager = new RunManager({ createTransport: () => spy.transport });
    const started = manager.start({ prompt: 'x', cwd: 'Z:\\proj' }) as {
      ok: true;
      run: { id: string };
    };
    const create = await vi.waitFor(() => request(spy, 'session.create'));
    spy.respond(create, { sessionId: 'sess-y' });
    await vi.waitFor(() => expect(spy.requests.some((r) => r['method'] === 'run.turn')).toBe(true));

    // steer awaits its §24 ACCEPTANCE response — drive the roundtrip.
    const steerPromise = manager.steer(started.run.id, 'prefer small diffs');
    const steerReq = await vi.waitFor(() => request(spy, 'session.steer'));
    expect(steerReq['params']).toMatchObject({
      sessionId: 'sess-y',
      text: 'prefer small diffs',
    });
    spy.respond(steerReq, { accepted: true, controlType: 'steer' });
    const steered = await steerPromise;
    expect(steered.ok).toBe(true);
    expect((steered as { result: Record<string, unknown> }).result).toMatchObject({
      accepted: true,
      controlType: 'steer',
    });
    expect(childProcessMock.spawn).not.toHaveBeenCalled();

    // Spawn mode: no live channel into the run process — explicit error.
    delete process.env[HARNESS_SERVER_ENV];
    const fakeChild = makeFakeChild();
    childProcessMock.spawn.mockImplementation(() => fakeChild);
    const spawnManager = new RunManager();
    const spawnedRun = spawnManager.start({ prompt: 'y', cwd: 'Z:\\proj' });
    expect(spawnedRun.ok).toBe(true);
    const refused = await spawnManager.steer(spawnedRun.run!.id, 'nope');
    expect(refused.ok).toBe(false);
    expect((refused as { error: string }).error).toContain(HARNESS_SERVER_ENV);
    fakeChild.emit('close', 0);
    await manager.close();
  });
});

describe('RunManager default spawn path (t32: byte-identical without the env)', () => {
  beforeEach(() => {
    childProcessMock.spawn.mockReset();
    delete process.env[HARNESS_SERVER_ENV];
  });
  afterEach(() => {
    delete process.env[HARNESS_SERVER_ENV];
  });

  it('(d) spawns the legacy --headless child with the same argv/env/stdio and completes the run', async () => {
    const fakeChild = makeFakeChild();
    childProcessMock.spawn.mockImplementation(() => fakeChild);
    const manager = new RunManager();
    const started = manager.start({
      prompt: 'fix the bug',
      mode: 'council',
      phase: 'plan',
      cwd: 'Z:\\proj',
      provider: ' openai ',
      model: 'gpt-x',
    });
    expect(started.ok).toBe(true);
    expect(childProcessMock.spawn).toHaveBeenCalledTimes(1);
    const [command, argv, options] = childProcessMock.spawn.mock.calls[0] as unknown as [
      string,
      string[],
      Record<string, unknown>,
    ];
    expect(command).toBe(process.execPath);
    expect(argv).toEqual([
      process.argv[1],
      '--headless',
      '--task',
      'fix the bug',
      '--output',
      'json',
      '--mode',
      'council',
      '--phase',
      'plan',
      '--provider',
      'openai',
      '--model',
      'gpt-x',
    ]);
    expect((options['env'] as Record<string, unknown>).ZELARI_SKIP_PREFLIGHT).toBe('1');
    expect(options['stdio']).toEqual(['ignore', 'pipe', 'pipe']);
    expect(options['windowsHide']).toBe(true);

    fakeChild.emit('close', 0);
    await vi.waitFor(() => expect(manager.getRun(started.run!.id)?.status).toBe('completed'));
    expect(manager.getRun(started.run!.id)?.exitCode).toBe(0);
  });

  it('(e) history still rides the tmp --history-file argv flag on the spawn path', () => {
    const fakeChild = makeFakeChild();
    childProcessMock.spawn.mockImplementation(() => fakeChild);
    const manager = new RunManager();
    const started = manager.start({
      prompt: 'with history',
      cwd: 'Z:\\proj',
      history: [{ role: 'user', content: 'earlier' }],
    });
    expect(started.ok).toBe(true);
    const argv = childProcessMock.spawn.mock.calls[0]![1] as unknown as string[];
    const flagIndex = argv.indexOf('--history-file');
    expect(flagIndex).toBeGreaterThan(-1);
    expect(argv[flagIndex + 1]).toContain('zelari-companion-hist-');
    fakeChild.emit('close', 0);
  });
});
