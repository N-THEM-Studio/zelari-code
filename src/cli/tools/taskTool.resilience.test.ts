/**
 * taskTool.resilience.test — G1 + G2 wiring of the 2026-09-23 post-mortem.
 *
 * G1: `runTentacle` stops a tentacle whose tool-loop storms FAILED MUTATIONS
 * (4 consecutive write failures → `TentacleFailure.mutationStorm` with the
 * stable `mutation_storm` code, message via `formatMutationStop`) and does
 * NOT stop it when a landed mutation resets the streak.
 *
 * G2: a report the runtime cut (stream ended mid-message / output cap) comes
 * back with `reportStatus: 'truncated'`, the marker INSIDE the report and the
 * guard line in the parent message. A clean run keeps today's behavior:
 * `reportStatus: 'ok'`, no marker, no guard line.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BrainEvent } from '@zelari/core/shared/events';
import {
  createTaskTool,
  runTentacle,
  type SubAgentHarness,
  type TaskToolDeps,
  type TentacleFailure,
  type TentacleResult,
} from './taskTool.js';
import { MUTATION_FAILURE_THRESHOLD } from './mutationGuard.js';
import {
  REPORT_TRUNCATED_GUARD_LINE,
  REPORT_TRUNCATED_MARKER,
} from './subagentReportStatus.js';
import {
  TRUNCATED_REPORT_BANNER_MARKER,
  TRUNCATED_REPORT_GATE_ENV,
  resetTruncatedReportGateForTests,
} from './truncatedReportGate.js';

/** Minimal provider stream: no model output, text-only finish. */
const providerStream = async function* (): AsyncGenerator<never> {
  // intentional: nothing to stream
};

function fakeRegistry(): any {
  return {
    invoke: async () => ({ output: '' }),
    fingerprints: () => [],
    toOpenAITools: () => [],
  };
}

const mk = (e: object) => ({ id: 'e', ts: 0, sessionId: 's', ...e }) as BrainEvent;

/** A completed write call: structured reject / EACCES storm shape. */
function failedWrite(callId: string, tool: string, detail: string): BrainEvent[] {
  return [
    mk({ type: 'tool_execution_start', toolCallId: callId, toolName: tool, args: { path: 'src/a.ts' } }),
    mk({ type: 'tool_execution_end', toolCallId: callId, isError: true, durationMs: 2, result: detail }),
  ];
}

/** A landed mutation. */
function okWrite(callId: string): BrainEvent[] {
  return [
    mk({ type: 'tool_execution_start', toolCallId: callId, toolName: 'write_file', args: { path: 'src/a.ts' } }),
    mk({ type: 'tool_execution_end', toolCallId: callId, isError: false, durationMs: 2, result: '{"status":"applied"}' }),
  ];
}

function depsFor(script: BrainEvent[]): TaskToolDeps {
  return {
    createSubAgentContext: (async () => ({
      model: 'test-model',
      provider: 'test-provider',
      cwd: '.',
      registry: fakeRegistry(),
      tools: [],
      providerStream,
    })) as unknown as TaskToolDeps['createSubAgentContext'],
    harnessFactory: (() =>
      ({
        run: async function* (): AsyncGenerator<BrainEvent> {
          for (const ev of script) yield ev;
        },
        cancel: () => {},
      }) as SubAgentHarness) as unknown as TaskToolDeps['harnessFactory'],
  } as TaskToolDeps;
}

let dir: string;
let previousWorktreeMode: string | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zelari-resilience-'));
  // General tentacles default to git-worktree isolation (WS3): pin the
  // explicit opt-out so these wiring tests never spawn git.
  previousWorktreeMode = process.env.ZELARI_KRAKEN_WORKTREE;
  process.env.ZELARI_KRAKEN_WORKTREE = 'off';
});

afterEach(() => {
  if (previousWorktreeMode === undefined) delete process.env.ZELARI_KRAKEN_WORKTREE;
  else process.env.ZELARI_KRAKEN_WORKTREE = previousWorktreeMode;
  // W6.2: the gate state spans runTentacle calls — reset between tests.
  delete process.env[TRUNCATED_REPORT_GATE_ENV];
  resetTruncatedReportGateForTests();
  fs.rmSync(dir, { recursive: true, force: true });
});

function run(script: BrainEvent[], agent: 'explore' | 'general' = 'general'): Promise<TentacleResult> {
  return runTentacle({
    deps: depsFor(script),
    args: { description: 'impl slice', prompt: 'implement the slice' },
    agent,
    thoroughness: 'medium',
    parentCwd: dir,
    sessionId: 'resilience-test',
  });
}

describe('G1 (2026-09-23) — mutation-storm circuit breaker wiring', () => {
  it('stops the tentacle at the 4th consecutive failed mutation (mutation_storm)', async () => {
    const script: BrainEvent[] = [
      mk({ type: 'message_start' }),
      mk({ type: 'message_delta', delta: 'Scrivo il file e riprovo.' }),
      mk({ type: 'message_end', finishReason: 'tool_calls' }),
    ];
    // The post-mortem storm, verbatim: write_file → EACCES, edit → stale.
    for (let i = 0; i < MUTATION_FAILURE_THRESHOLD; i++) {
      script.push(
        ...(i % 2 === 0
          ? failedWrite(`w${i}`, 'write_file', 'EACCES: permission denied, open src/a.ts')
          : failedWrite(`w${i}`, 'edit', 'edit: stale_snapshot: src/a.ts (expected aaaa, actual bbbb)')),
      );
    }
    // The loop must break BEFORE this turn ever runs.
    script.push(
      mk({ type: 'message_start' }),
      mk({ type: 'message_delta', delta: 'should never be reached' }),
      mk({ type: 'message_end' }),
    );

    const res = await run(script);
    expect(res.ok).toBe(false);
    const failure = res as TentacleFailure;
    expect(failure.mutationStorm?.code).toBe('mutation_storm');
    expect(failure.mutationStorm?.consecutiveFailures).toBe(MUTATION_FAILURE_THRESHOLD);
    expect(failure.error).toContain('mutation storm detected');
    // The stop line quotes the LAST failing mutation (the 4th was `edit`).
    expect(failure.error).toContain('last: edit');
    expect(failure.error).toContain('stale_snapshot');
    expect(failure.error).not.toContain('should never be reached');
    expect(failure.reportStatus).toBe('ok');
  });

  it('a landed mutation resets the streak — no stop, report is ok', async () => {
    const script: BrainEvent[] = [
      mk({ type: 'message_start' }),
      mk({ type: 'message_delta', delta: 'Primo giro di scrittura.' }),
      mk({ type: 'message_end', finishReason: 'tool_calls' }),
      ...failedWrite('w0', 'write_file', 'EACCES: permission denied, open src/a.ts'),
      ...failedWrite('w1', 'edit', 'edit: stale_snapshot: src/a.ts (expected aaaa, actual bbbb)'),
      ...failedWrite('w2', 'write_file', 'EACCES: permission denied, open src/a.ts'),
      ...okWrite('w3'),
      ...failedWrite('w4', 'write_file', 'EACCES: permission denied, open src/a.ts'),
      ...failedWrite('w5', 'edit', 'edit: stale_snapshot: src/a.ts (expected aaaa, actual bbbb)'),
      ...failedWrite('w6', 'write_file', 'EACCES: permission denied, open src/a.ts'),
      mk({ type: 'message_start' }),
      mk({ type: 'message_delta', delta: 'Fatto: il file e stato scritto alla fine.' }),
      mk({ type: 'message_end', finishReason: 'stop' }),
    ];

    const res = await run(script);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    expect(res.result).toContain('Fatto: il file e stato scritto alla fine.');
    expect((res as { mutationStorm?: unknown }).mutationStorm).toBeUndefined();
    expect(res.reportStatus).toBe('ok');
  });
});

describe('G2 (2026-09-23) — truncated-report signal wiring', () => {
  it('a stream cut mid-message yields reportStatus=truncated and the marker in the report', async () => {
    // message_start + deltas … then the stream just ENDS: no message_end seal.
    const res = await run(
      [
        mk({ type: 'message_start' }),
        mk({ type: 'message_delta', delta: 'frammento di thinking, nessuna conclusione' }),
      ],
      'explore',
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    expect(res.reportStatus).toBe('truncated');
    expect(res.result).toContain(REPORT_TRUNCATED_MARKER);
    expect(res.result).toContain('frammento di thinking');
  });

  it('the parent message carries the marker and the guard line; clean runs are unchanged', async () => {
    const deps = depsFor([
      mk({ type: 'message_start' }),
      mk({ type: 'message_delta', delta: 'frammento di thinking, nessuna conclusione' }),
    ]);
    const tool = createTaskTool(deps);
    const res = (await (tool as { execute: (a: unknown, c: unknown) => Promise<unknown> }).execute(
      { agent: 'explore', prompt: 'mappa il modulo auth', description: 'auth architecture' },
      { sessionId: 'resilience-msg', cwd: dir },
    )) as { ok: boolean; value?: { result: string } };
    expect(res.ok).toBe(true);
    expect(res.value?.result).toContain(REPORT_TRUNCATED_MARKER);
    expect(res.value?.result).toContain(REPORT_TRUNCATED_GUARD_LINE);

    // Default invariato: a clean run has neither the marker nor the guard line.
    const clean = createTaskTool(
      depsFor([
        mk({ type: 'message_start' }),
        mk({ type: 'message_delta', delta: 'Conclusione esplicita e completa.' }),
        mk({ type: 'message_end', finishReason: 'stop' }),
      ]),
    );
    const okRes = (await (clean as { execute: (a: unknown, c: unknown) => Promise<unknown> }).execute(
      { agent: 'explore', prompt: 'mappa il modulo auth', description: 'auth architecture' },
      { sessionId: 'resilience-clean', cwd: dir },
    )) as { ok: boolean; value?: { result: string } };
    expect(okRes.ok).toBe(true);
    expect(okRes.value?.result).toContain('Conclusione esplicita e completa.');
    expect(okRes.value?.result).not.toContain(REPORT_TRUNCATED_MARKER);
    expect(okRes.value?.result).not.toContain(REPORT_TRUNCATED_GUARD_LINE);
  });

  it('an output-cap cut (finishReason=length) is a truncation fact too', async () => {
    const res = await run(
      [
        mk({ type: 'message_start' }),
        mk({ type: 'message_delta', delta: 'testo tagliato dal cap di output' }),
        mk({ type: 'message_end', finishReason: 'length' }),
      ],
      'explore',
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    expect(res.reportStatus).toBe('truncated');
    expect(res.result).toContain(REPORT_TRUNCATED_MARKER);
    expect(res.result).toContain('finish-reason-length');
  });
});

describe('W6.1 (2026-09-23) — partial-transcript flush on non-success exits', () => {
  /** The one sidecar written for a tentacle, as raw text. */
  const sidecarBody = (sessionId: string): string => {
    const dirPath = path.join(dir, '.zelari', 'radio', 'tentacles', sessionId);
    const files = fs.readdirSync(dirPath).filter((f) => f.endsWith('.md'));
    expect(files.length).toBe(1);
    return fs.readFileSync(path.join(dirPath, files[0]!), 'utf8');
  };

  const executeTool = async (
    script: BrainEvent[],
    sessionId: string,
    agent: 'explore' | 'general' = 'explore',
  ) => {
    const tool = createTaskTool(depsFor(script));
    return (await (tool as { execute: (a: unknown, c: unknown) => Promise<unknown> }).execute(
      { agent, prompt: 'mappa il modulo auth', description: `w61 ${sessionId}` },
      { sessionId, cwd: dir },
    )) as { ok: boolean; error?: unknown; value?: { result: string } };
  };

  it('a no-output failure flushes a sidecar marked [interrupted] (trace before silence)', async () => {
    // Harness that emits NOTHING: the exact "produced no output" failure path.
    const res = await executeTool([], 'w61-nooutput');
    expect(res.ok).toBe(false);
    const body = sidecarBody('w61-nooutput');
    expect(body).toContain('[interrupted]');
    expect(body).toContain('status: failed');
  });

  it('a mutation-storm stop flushes its trail too', async () => {
    const script: BrainEvent[] = [
      mk({ type: 'message_start' }),
      mk({ type: 'message_delta', delta: 'provo a scrivere…' }),
      mk({ type: 'message_end', finishReason: 'tool_calls' }),
      ...failedWrite('s0', 'write_file', 'EACCES: permission denied, open src/a.ts'),
      ...failedWrite('s1', 'edit', 'edit: stale_snapshot: src/a.ts (expected aaaa, actual bbbb)'),
      ...failedWrite('s2', 'write_file', 'EACCES: permission denied, open src/a.ts'),
      ...failedWrite('s3', 'edit', 'edit: stale_snapshot: src/a.ts (expected aaaa, actual bbbb)'),
    ];
    const res = await executeTool(script, 'w61-storm', 'general');
    expect(res.ok).toBe(false);
    const body = sidecarBody('w61-storm');
    expect(body).toContain('[interrupted]');
    expect(body).toContain('status: failed');
  });

  it('a clean run writes the sidecar WITHOUT the marker (default unchanged)', async () => {
    const res = await executeTool(
      [
        mk({ type: 'message_start' }),
        mk({ type: 'message_delta', delta: 'Conclusione completa e verificata.' }),
        mk({ type: 'message_end', finishReason: 'stop' }),
      ],
      'w61-ok',
    );
    expect(res.ok).toBe(true);
    const body = sidecarBody('w61-ok');
    expect(body).toContain('Conclusione completa e verificata.');
    expect(body).not.toContain('[interrupted]');
    expect(body).not.toContain('status:');
  });
});

describe('W6.2 (2026-09-23) — truncated-basis banner on the next general spawn', () => {
  /** Deps whose harnessFactory captures the config the spawn was built with. */
  const captureDeps = (script: BrainEvent[], sink: { config?: unknown }): TaskToolDeps => {
    const base = depsFor(script);
    return {
      ...base,
      harnessFactory: ((cfg: unknown) => {
        sink.config = cfg;
        return (base.harnessFactory as () => SubAgentHarness)();
      }) as unknown as TaskToolDeps['harnessFactory'],
    };
  };

  /** The user-message content the sub-agent was actually spawned with. */
  const userPromptOf = (sink: { config?: unknown }): string => {
    const messages =
      (sink.config as { messages?: Array<{ role: string; content: string }> } | undefined)?.messages ?? [];
    return messages.find((m) => m.role === 'user')?.content ?? '';
  };

  const cleanScript = (): BrainEvent[] => [
    mk({ type: 'message_start' }),
    mk({ type: 'message_delta', delta: 'Conclusione esplicita e completa.' }),
    mk({ type: 'message_end', finishReason: 'stop' }),
  ];

  const runIn = (
    sessionId: string,
    script: BrainEvent[],
    agent: 'explore' | 'general',
    sink?: { config?: unknown },
  ): Promise<TentacleResult> =>
    runTentacle({
      deps: sink ? captureDeps(script, sink) : depsFor(script),
      args: { description: 'impl slice', prompt: 'implement the slice' },
      agent,
      thoroughness: 'medium',
      parentCwd: dir,
      sessionId,
    });

  it('a truncated explore flags the session: the next general prompt carries the banner, the one after does not (one-shot)', async () => {
    // 1) the exact post-mortem shape: stream cut mid-message, no message_end seal.
    const truncated = await runIn(
      'w62-a',
      [
        mk({ type: 'message_start' }),
        mk({ type: 'message_delta', delta: 'frammento di thinking, nessuna conclusione' }),
      ],
      'explore',
    );
    expect((truncated as { reportStatus?: string }).reportStatus).toBe('truncated');

    // 2) the doomed general — now warned at spawn time, prompt still intact below the banner.
    const first: { config?: unknown } = {};
    const warned = await runIn('w62-a', cleanScript(), 'general', first);
    expect(warned.ok).toBe(true);
    expect(userPromptOf(first)).toContain(TRUNCATED_REPORT_BANNER_MARKER);
    expect(userPromptOf(first)).toContain('implement the slice');

    // 3) one-shot: the flag was consumed, the next general spawns clean.
    const second: { config?: unknown } = {};
    await runIn('w62-a', cleanScript(), 'general', second);
    expect(userPromptOf(second)).not.toContain(TRUNCATED_REPORT_BANNER_MARKER);
  });

  it('a clean report never arms the gate — the general prompt is untouched', async () => {
    const ok = await runIn('w62-b', cleanScript(), 'explore');
    expect((ok as { reportStatus?: string }).reportStatus).toBe('ok');

    const sink: { config?: unknown } = {};
    await runIn('w62-b', cleanScript(), 'general', sink);
    expect(userPromptOf(sink)).not.toContain(TRUNCATED_REPORT_BANNER_MARKER);
    expect(userPromptOf(sink)).toContain('implement the slice');
  });

  it('kill-switch env disables the banner even after a truncated report', async () => {
    process.env[TRUNCATED_REPORT_GATE_ENV] = '0';
    const truncated = await runIn(
      'w62-c',
      [
        mk({ type: 'message_start' }),
        mk({ type: 'message_delta', delta: 'frammento tagliato dal runtime' }),
      ],
      'explore',
    );
    expect((truncated as { reportStatus?: string }).reportStatus).toBe('truncated');

    const sink: { config?: unknown } = {};
    await runIn('w62-c', cleanScript(), 'general', sink);
    expect(userPromptOf(sink)).not.toContain(TRUNCATED_REPORT_BANNER_MARKER);
  });
});
