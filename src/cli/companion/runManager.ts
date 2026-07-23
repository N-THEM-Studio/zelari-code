/**
 * Spawn headless CLI runs and multiplex NDJSON events for companion clients.
 * Single-flight (one active run), matching Desktop v0.1.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export type RunStatus = 'queued' | 'running' | 'completed' | 'error' | 'cancelled';

export interface CompanionRun {
  id: string;
  status: RunStatus;
  prompt: string;
  mode: string;
  phase: string;
  cwd: string;
  createdAt: number;
  finishedAt?: number;
  exitCode?: number | null;
  error?: string;
  events: unknown[];
}

type Listener = (ev: unknown) => void;

export interface StartRunArgs {
  prompt: string;
  mode?: string;
  phase?: string;
  cwd: string;
  provider?: string;
  model?: string;
  history?: unknown[];
}

export class RunManager {
  private active: {
    run: CompanionRun;
    child: ChildProcess;
    listeners: Set<Listener>;
    historyFile?: string;
  } | null = null;
  private recent: CompanionRun[] = [];

  getActive(): CompanionRun | null {
    return this.active?.run ?? null;
  }

  getRun(id: string): CompanionRun | null {
    if (this.active?.run.id === id) return this.active.run;
    return this.recent.find((r) => r.id === id) ?? null;
  }

  listRecent(limit = 20): CompanionRun[] {
    const cur = this.active ? [this.active.run] : [];
    return [...cur, ...this.recent].slice(0, limit);
  }

  subscribe(runId: string, fn: Listener): () => void {
    if (this.active?.run.id === runId) {
      // Replay buffered events then live
      for (const ev of this.active.run.events) {
        try {
          fn(ev);
        } catch {
          /* ignore */
        }
      }
      this.active.listeners.add(fn);
      return () => {
        this.active?.listeners.delete(fn);
      };
    }
    const past = this.recent.find((r) => r.id === runId);
    if (past) {
      for (const ev of past.events) {
        try {
          fn(ev);
        } catch {
          /* ignore */
        }
      }
    }
    return () => {};
  }

  private emit(ev: unknown): void {
    if (!this.active) return;
    this.active.run.events.push(ev);
    // Cap memory
    if (this.active.run.events.length > 5_000) {
      this.active.run.events.splice(0, this.active.run.events.length - 4_000);
    }
    for (const fn of this.active.listeners) {
      try {
        fn(ev);
      } catch {
        /* ignore */
      }
    }
  }

  start(args: StartRunArgs): { ok: true; run: CompanionRun } | { ok: false; error: string } {
    if (this.active) {
      return {
        ok: false,
        error: `A run is already active (${this.active.run.id}). Cancel it first.`,
      };
    }
    const prompt = args.prompt?.trim();
    if (!prompt) return { ok: false, error: 'prompt is required' };

    const id = randomUUID();
    const mode = (args.mode || 'agent').toLowerCase();
    const phase = (args.phase || 'build').toLowerCase();
    const run: CompanionRun = {
      id,
      status: 'running',
      prompt,
      mode,
      phase,
      cwd: args.cwd,
      createdAt: Date.now(),
      events: [],
    };

    const cliEntry = process.argv[1];
    if (!cliEntry) {
      return { ok: false, error: 'Cannot resolve CLI entry (process.argv[1])' };
    }

    const argv = [
      cliEntry,
      '--headless',
      '--task',
      prompt,
      '--output',
      'json',
      '--mode',
      mode === 'council' || mode === 'zelari' ? mode : 'agent',
      '--phase',
      phase === 'plan' ? 'plan' : 'build',
    ];
    if (args.provider?.trim()) {
      argv.push('--provider', args.provider.trim());
    }
    if (args.model?.trim()) {
      argv.push('--model', args.model.trim());
    }

    let historyFile: string | undefined;
    if (args.history && Array.isArray(args.history) && args.history.length > 0) {
      historyFile = join(tmpdir(), `zelari-companion-hist-${id}.json`);
      try {
        writeFileSync(historyFile, JSON.stringify(args.history), 'utf8');
        argv.push('--history-file', historyFile);
      } catch {
        historyFile = undefined;
      }
    }

    const child = spawn(process.execPath, argv, {
      cwd: args.cwd,
      env: {
        ...process.env,
        ZELARI_SKIP_PREFLIGHT: '1',
        ANATHEMA_DEV: '1',
        FORCE_COLOR: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    this.active = { run, child, listeners: new Set(), historyFile };

    this.emit({
      type: 'log',
      message: `[companion] run ${id} started mode=${mode} phase=${phase} cwd=${args.cwd}`,
    });

    if (child.stdout) {
      const rl = createInterface({ input: child.stdout });
      rl.on('line', (line) => {
        const t = line.trim();
        if (!t) return;
        try {
          const ev = JSON.parse(t) as unknown;
          this.emit(ev);
        } catch {
          this.emit({ type: 'log', message: t });
        }
      });
    }

    child.stderr?.on('data', (buf: Buffer) => {
      const text = buf.toString('utf8').trim();
      if (!text) return;
      for (const line of text.split(/\r?\n/)) {
        if (line.trim()) {
          this.emit({ type: 'log', message: line.trim() });
        }
      }
    });

    child.on('error', (err) => {
      run.status = 'error';
      run.error = err.message;
      run.finishedAt = Date.now();
      this.emit({
        type: 'error',
        severity: 'fatal',
        message: err.message,
        code: 'spawn',
      });
      this.finishActive();
    });

    child.on('close', (code) => {
      if (run.status === 'running') {
        run.status = code === 0 ? 'completed' : 'error';
        run.exitCode = code;
        run.finishedAt = Date.now();
        if (code !== 0 && !run.error) {
          run.error = `exit ${code}`;
        }
      }
      this.emit({
        type: 'run_finished',
        runId: id,
        status: run.status,
        exitCode: code,
      });
      this.finishActive();
    });

    return { ok: true, run };
  }

  cancel(runId?: string): { ok: true } | { ok: false; error: string } {
    if (!this.active) {
      return { ok: false, error: 'No active run' };
    }
    if (runId && this.active.run.id !== runId) {
      return { ok: false, error: `Run ${runId} is not active` };
    }
    const { run, child } = this.active;
    run.status = 'cancelled';
    run.finishedAt = Date.now();
    this.emit({
      type: 'log',
      message: `[companion] cancelling run ${run.id}`,
    });
    try {
      child.kill('SIGTERM');
    } catch {
      /* ignore */
    }
    // Windows: ensure tree dies
    setTimeout(() => {
      try {
        if (!child.killed) child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }, 1500);
    return { ok: true };
  }

  private finishActive(): void {
    if (!this.active) return;
    const { run, historyFile } = this.active;
    if (historyFile) {
      try {
        unlinkSync(historyFile);
      } catch {
        /* ignore */
      }
    }
    this.recent.unshift(run);
    if (this.recent.length > 30) this.recent.length = 30;
    this.active = null;
  }
}
