import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunRecorder } from './RunRecorder.js';
import { createRecorderObserver } from './recorderObserver.js';
import { buildRuntimeObserverBus } from '../observers/ObserverBus.js';
import type { RuntimeEventBase, RuntimeIdentity, ToolResultEvent } from '../observers/types.js';

let root: string;
let clock = 1_000;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'zelari-recorder-'));
  clock = 1_000;
});

afterEach(async () => {
  delete process.env.ZELARI_RUN_RECORD;
  delete process.env.ZELARI_RUNTIME_OBSERVERS;
  await rm(root, { recursive: true, force: true });
});

const identity: RuntimeIdentity = {
  runId: 'run_x',
  agentId: 'lead',
  role: 'lead',
  mode: 'kraken',
  model: 'test-model',
  provider: 'openai-compatible',
};

function eventBase(): RuntimeEventBase {
  return { id: `e${clock++}`, ts: clock++, identity, turn: 1 };
}

function toolResult(ok: boolean): ToolResultEvent {
  return { ...eventBase(), toolCallId: 'tc1', toolName: 'bash', result: 'out', ok };
}

describe('RunRecorder', () => {
  it('writes a running manifest on start and final manifest + metrics on finalize', async () => {
    const recorder = new RunRecorder({ runsDir: root, runId: 'run_test1', now: () => clock++ });
    recorder.start();
    await recorder.flush();
    const mid = JSON.parse(await readFile(join(root, 'run_test1', 'manifest.json'), 'utf8'));
    expect(mid.status).toBe('running');
    expect(mid.version).toBe(1);

    recorder.bumpModelCall();
    recorder.bumpToolCall();
    recorder.bumpToolFailure();
    recorder.bumpTurn();
    recorder.finalize('completed');
    await recorder.flush();

    const manifest = JSON.parse(await readFile(join(root, 'run_test1', 'manifest.json'), 'utf8'));
    expect(manifest.status).toBe('completed');
    expect(manifest.endedAt).toBeGreaterThanOrEqual(manifest.startedAt);
    expect(manifest.models).toEqual({});

    const metrics = JSON.parse(await readFile(join(root, 'run_test1', 'metrics.json'), 'utf8'));
    expect(metrics).toEqual({ durationMs: expect.any(Number), modelCalls: 1, toolCalls: 1, toolFailures: 1, turns: 1 });
  });

  it('redacts secrets before they hit disk', async () => {
    const recorder = new RunRecorder({ runsDir: root, runId: 'run_redact', now: () => clock++ });
    recorder.start();
    recorder.record({ type: 'tool_result', apiKey: 'super-secret', text: 'token sk-abcdefghijklmnopqrst' });
    await recorder.flush();
    const trace = await readFile(join(root, 'run_redact', 'trace.jsonl'), 'utf8');
    expect(trace).not.toContain('super-secret');
    expect(trace).toContain('sk-[REDACTED]');
  });

  it('fans tool results out to the per-agent stream', async () => {
    const recorder = new RunRecorder({ runsDir: root, runId: 'run_agents', now: () => clock++ });
    const observer = createRecorderObserver(recorder);
    await observer.onRunStart({ ...eventBase() });
    await observer.onToolResult(toolResult(false));
    await observer.onRunEnd({ ...eventBase(), reason: 'completed' });
    await recorder.flush();

    const agentFile = join(root, 'run_agents', 'agents', 'lead.jsonl');
    const lines = (await readFile(agentFile, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).ok).toBe(false);

    const manifest = JSON.parse(await readFile(join(root, 'run_agents', 'manifest.json'), 'utf8'));
    expect(manifest.status).toBe('completed');
    expect(manifest.models.lead).toBe('test-model');
  });

  it('swallows IO failures instead of throwing (§102)', async () => {
    const recorder = new RunRecorder({ runsDir: join(root, 'no', 'such', 'dir'), runId: 'run_x', now: () => clock++ });
    expect(() => recorder.start()).not.toThrow();
    expect(() => recorder.record({ type: 'x' })).not.toThrow();
    expect(() => recorder.finalize('failed')).not.toThrow();
    await recorder.flush();
  });
});

describe('buildRuntimeObserverBus + recorder', () => {
  it('adds the run-recorder observer only under ZELARI_RUN_RECORD=1', async () => {
    process.env.ZELARI_RUNTIME_OBSERVERS = '1';
    const plain = buildRuntimeObserverBus({ runsDir: root, runId: 'run_plain' });
    expect(plain?.size).toBe(7);

    process.env.ZELARI_RUN_RECORD = '1';
    const withRecorder = buildRuntimeObserverBus({ runsDir: root, runId: 'run_bus' });
    expect(withRecorder?.size).toBe(8);

    await withRecorder?.emit('onRunStart', { ...eventBase() });
    await withRecorder?.emit('onRunEnd', { ...eventBase(), reason: 'completed' });

    // The recorder writes are fire-and-forget on a serial chain (§102): poll
    // until the manifest lands BEFORE asserting on the directory listing —
    // on slow CI runners the mkdir may not have settled at emit-return time.
    const manifestPath = join(root, 'run_bus', 'manifest.json');
    for (let i = 0; i < 80 && !existsSync(manifestPath); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const runDirs = await readdir(root);
    expect(runDirs).toEqual(['run_bus']); // plain bus has no recorder at all
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    expect(manifest.status).toBe('completed');
  });
});
