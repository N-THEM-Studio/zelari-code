/**
 * Run Flight Recorder (Frontier PHASE 5, §67-§71).
 *
 * Persists a per-run directory under `.zelari/runs/<run-id>/`:
 *
 *   manifest.json   run metadata (no secrets — payloads pass Redactor)
 *   trace.jsonl     ordered runtime events
 *   agents/*.jsonl  per-agent event streams
 *   metrics.json    counters snapshot, written at finalize
 *
 * All IO is best-effort (§102): every write is enqueued on a serial chain
 * whose errors are swallowed, so a recorder failure never blocks the run.
 */
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { redactRuntimePayload } from './Redactor.js';

export interface RunRecorderOptions {
  /** Root directory that contains one folder per run. */
  runsDir: string;
  runId?: string;
  sessionId?: string;
  mode?: string;
  phase?: string;
  cwd?: string;
  models?: Record<string, string>;
  now?: () => number;
}

export interface RunManifest {
  version: 1;
  runId: string;
  sessionId?: string;
  mode: string;
  phase: string;
  startedAt: number;
  endedAt?: number;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  cwd: string;
  models: Record<string, string>;
}

/** Metrics the recorder itself can count truthfully at finalize time. */
export interface RunMetricsFile {
  durationMs: number;
  modelCalls: number;
  toolCalls: number;
  toolFailures: number;
  turns: number;
}

export type RunFinalStatus = 'completed' | 'failed' | 'cancelled';

/** Generate a stable-enough run id: `run_<time36>_<hex>`. */
export function newRunId(now: () => number = Date.now): string {
  return `run_${now().toString(36)}_${randomBytes(4).toString('hex')}`;
}

/** Env flag for the run flight recorder (Frontier PHASE 5 rollout). */
export function runRecordEnabled(): boolean {
  const raw = process.env.ZELARI_RUN_RECORD?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on';
}

function sanitizeAgentId(agentId: string): string {
  const safe = agentId.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 64);
  return safe.length > 0 ? safe : 'agent';
}

export class RunRecorder {
  readonly runId: string;
  readonly runDir: string;

  private readonly opts: RunRecorderOptions;
  private readonly now: () => number;
  private chain: Promise<void> = Promise.resolve();
  private startedAt = 0;
  private started = false;
  private finalized = false;
  private readonly models: Record<string, string>;
  private readonly counters = { modelCalls: 0, toolCalls: 0, toolFailures: 0, turns: 0 };

  constructor(options: RunRecorderOptions) {
    this.opts = options;
    this.now = options.now ?? Date.now;
    this.runId = options.runId ?? newRunId(this.now);
    this.runDir = join(options.runsDir, this.runId);
    this.models = { ...(options.models ?? {}) };
  }

  /** Create the run dir and write the initial manifest. Idempotent. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.startedAt = this.now();
    this.enqueue(async () => {
      await mkdir(this.runDir, { recursive: true });
      await mkdir(join(this.runDir, 'agents'), { recursive: true });
      await writeFile(join(this.runDir, 'manifest.json'), JSON.stringify(this.buildManifest('running'), null, 2));
    });
  }

  /** Append one redacted event to trace.jsonl. */
  record(event: Record<string, unknown>): void {
    if (!this.started) this.start();
    this.enqueue(() => appendFile(join(this.runDir, 'trace.jsonl'), `${JSON.stringify(redactRuntimePayload(event))}\n`));
  }

  /** Append one redacted event to the per-agent stream. */
  recordAgent(agentId: string, event: Record<string, unknown>): void {
    if (!this.started) this.start();
    this.enqueue(() =>
      appendFile(join(this.runDir, 'agents', `${sanitizeAgentId(agentId)}.jsonl`), `${JSON.stringify(redactRuntimePayload(event))}\n`),
    );
  }

  /** Track which model served which role, for the final manifest. */
  noteModel(role: string, model: string | undefined): void {
    if (role && model) this.models[role] = model;
  }

  bumpModelCall(): void {
    this.counters.modelCalls += 1;
  }

  bumpToolCall(): void {
    this.counters.toolCalls += 1;
  }

  bumpToolFailure(): void {
    this.counters.toolFailures += 1;
  }

  bumpTurn(): void {
    this.counters.turns += 1;
  }

  getMetrics(): RunMetricsFile {
    return {
      durationMs: this.finalized || this.startedAt > 0 ? Math.max(0, this.now() - this.startedAt) : 0,
      ...this.counters,
    };
  }

  /** Write final manifest + metrics.json. Idempotent. */
  finalize(status: RunFinalStatus): void {
    if (this.finalized) return;
    if (!this.started) this.start();
    this.finalized = true;
    const endedAt = this.now();
    this.enqueue(async () => {
      await writeFile(join(this.runDir, 'manifest.json'), JSON.stringify(this.buildManifest(status, endedAt), null, 2));
      await writeFile(join(this.runDir, 'metrics.json'), JSON.stringify(this.getMetrics(), null, 2));
    });
  }

  /** Await pending writes (tests / graceful shutdown). */
  async flush(): Promise<void> {
    await this.chain;
  }

  private buildManifest(status: RunManifest['status'], endedAt?: number): RunManifest {
    return {
      version: 1,
      runId: this.runId,
      sessionId: this.opts.sessionId,
      mode: this.opts.mode ?? 'kraken',
      phase: this.opts.phase ?? 'build',
      startedAt: this.startedAt,
      ...(endedAt !== undefined ? { endedAt } : {}),
      status,
      cwd: this.opts.cwd ?? process.cwd(),
      models: this.models,
    };
  }

  /**
   * Serial best-effort write queue: preserves trace ordering and swallows
   * IO errors (§102 — recorder failure must not block the run).
   */
  private enqueue(write: () => Promise<void>): void {
    this.chain = this.chain.then(write).catch(() => {
      /* best-effort: drop failed write, keep the chain alive */
    });
  }
}
