/**
 * Spawn headless CLI runs and multiplex NDJSON events for companion clients.
 * Single-flight (one active run), matching Desktop v0.1.
 *
 * t32 — client mode (ZELARI_HARNESS_SERVER=1): instead of one `--headless`
 * child per run, runs are driven over the harness App Server NDJSON protocol
 * (session.create → run.turn → session.dispose, session.steer/session.cancel
 * for live control). The default client transport is ONE long-lived
 * `--serve-harness` child shared by every run (full BrainEvent fidelity: the
 * server's stdout IS the transport read side); the App Server keeps
 * per-workspace services warm across runs and owns proof persistence.
 *
 * KILL SWITCH: leave ZELARI_HARNESS_SERVER unset (or `=0`) and the legacy
 * per-run spawn path below runs byte-identically.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HarnessClient, type HarnessTransport } from '../serve/harnessClient.js';

/** Env flag enabling the harness App Server client mode (`=1`). */
export const HARNESS_SERVER_ENV = 'ZELARI_HARNESS_SERVER';

function harnessServerMode(): boolean {
  return process.env[HARNESS_SERVER_ENV] === '1';
}

/** t65: true for a permission.request event (the yolo ask-swallow gate). */
function isPermissionRequestEvent(ev: unknown): boolean {
  return (
    typeof ev === 'object' &&
    ev !== null &&
    (ev as { type?: unknown }).type === 'permission.request'
  );
}

/** Transport handle the RunManager client mode runs on. */
type HarnessTransportHandle = HarnessTransport & { close(): Promise<void> };

export interface RunManagerOptions {
  /**
   * Test/embedder seam: overrides the default transport (stdio to
   * `--serve-harness`). Providing it engages client mode regardless of env.
   */
  createTransport?: (() => HarnessTransportHandle) | undefined;
}

export type RunStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'error'
  | 'cancelled'
  | 'awaiting_trust';

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
  /** t63: per-turn knobs (Desktop parity) — client-mode passthrough. */
  permissionPreset?: string;
  strictDone?: boolean;
  /** Forward-compat: run.turn does not consume it today (env-governed pack). */
  verifyPack?: boolean;
}

export class RunManager {
  private active: {
    run: CompanionRun;
    /** Spawn mode only: the `--headless` child. */
    child?: ChildProcess;
    /** Client mode only: harness session driving this run (t32). */
    harnessSessionId?: string;
    /** Set by cancel() before the harness session is connected. */
    cancelRequested?: boolean;
    listeners: Set<Listener>;
    historyFile?: string;
    /** t66: parked-run credentials so releaseTrust can relaunch it. */
    trustArgs?: StartRunArgs;
    trustMode?: 'harness' | 'spawn';
    /** t65: active run preset — drives the yolo permission.request swallow. */
    permissionPreset?: string;
  } | null = null;
  private recent: CompanionRun[] = [];
  private readonly createTransport: (() => HarnessTransportHandle) | undefined;
  private harnessClient: HarnessClient | null = null;
  private harnessTransport: HarnessTransportHandle | null = null;

  constructor(options: RunManagerOptions = {}) {
    this.createTransport = options.createTransport;
  }

  /** Client mode engages on the env flag or an injected transport seam. */
  private get clientMode(): boolean {
    return this.createTransport !== undefined || harnessServerMode();
  }

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
    // t65: a yolo run never surfaces permission.request to the phone —
    // auto-allow it in-process and swallow the event (belt-and-suspenders
    // over the toolRegistry env preset). Fail-closed otherwise: standard /
    // strict requests are forwarded and wait for the user.
    if (
      this.active.permissionPreset === 'yolo' &&
      isPermissionRequestEvent(ev)
    ) {
      const requestId = (ev as { requestId?: unknown }).requestId;
      if (typeof requestId === 'string' && requestId.trim()) {
        void this.permissionRespond(this.active.run.id, requestId, 'allow');
        return;
      }
    }
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

  start(
    args: StartRunArgs,
    gate?: { awaitingTrust?: boolean },
  ):
    | { ok: true; run: CompanionRun; awaitingTrust?: boolean }
    | { ok: false; error: string } {
    if (this.active) {
      return {
        ok: false,
        error: `A run is already active (${this.active.run.id}). Cancel it first.`,
      };
    }
    const prompt = args.prompt?.trim();
    if (!prompt) return { ok: false, error: 'prompt is required' };

    const id = randomUUID();
    const mode = (args.mode || 'kraken').toLowerCase();
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

    // t66: untrusted cwd (full-fs companion picker) — park the run until the
    // desktop trust modal answers POST /v1/trust. The phone keeps its SSE
    // subscription: trust.pending is buffered/replayed like any event.
    if (gate?.awaitingTrust) {
      run.status = 'awaiting_trust';
      this.active = {
        run,
        listeners: new Set(),
        trustArgs: args,
        trustMode: this.clientMode ? 'harness' : 'spawn',
        permissionPreset: args.permissionPreset,
      };
      this.emit({
        type: 'trust.pending',
        runId: id,
        path: args.cwd,
        message: `[companion] run ${id} awaiting desktop trust approval for ${args.cwd}`,
      });
      return { ok: true, run, awaitingTrust: true };
    }

    // t32 client mode: session.create + run.turn on the harness App Server
    // instead of a per-run `--headless` child (see HARNESS_SERVER_ENV).
    if (this.clientMode) {
      return this.startViaHarness(run, args, mode, phase);
    }
    return this.launchSpawn(run, args);
  }

  /**
   * t66: desktop approved the parked run — launch it now, preserving the
   * listeners (phone SSE) attached while it was awaiting trust.
   */
  releaseTrust(): { ok: true } | { ok: false; error: string } {
    const a = this.active;
    if (!a || a.run.status !== 'awaiting_trust' || !a.trustArgs) {
      return { ok: false, error: 'no run awaiting trust' };
    }
    const args = a.trustArgs;
    a.run.status = 'running';
    this.emit({ type: 'trust.settled', runId: a.run.id, approved: true });
    if (a.trustMode === 'harness') {
      return this.startViaHarness(a.run, args, a.run.mode, a.run.phase);
    }
    return this.launchSpawn(a.run, args);
  }

  /** t66: desktop denied the parked run — fail it, fail-closed. */
  denyTrust(reason: string): { ok: true } | { ok: false; error: string } {
    const a = this.active;
    if (!a || a.run.status !== 'awaiting_trust') {
      return { ok: false, error: 'no run awaiting trust' };
    }
    a.run.status = 'error';
    a.run.error = reason;
    a.run.finishedAt = Date.now();
    this.emit({ type: 'trust.settled', runId: a.run.id, approved: false });
    this.emit({
      type: 'error',
      severity: 'fatal',
      message: reason,
      code: 'trust_denied',
    });
    this.emit({
      type: 'run_finished',
      runId: a.run.id,
      status: 'error',
      exitCode: null,
    });
    this.finishActive();
    return { ok: true };
  }

  /** t66: current awaiting_trust run (if any) for GET /v1/trust/pending. */
  pendingTrust(): { runId: string; path: string } | null {
    const a = this.active;
    if (!a || a.run.status !== 'awaiting_trust') return null;
    return { runId: a.run.id, path: a.run.cwd };
  }

  /** t66: spawn-path launch, extracted from start() so releaseTrust can
   * launch a parked run. Preserves parked listeners (same run id). */
  private launchSpawn(
    run: CompanionRun,
    args: StartRunArgs,
  ): { ok: true; run: CompanionRun } | { ok: false; error: string } {
    const cliEntry = process.argv[1];
    if (!cliEntry) {
      return { ok: false, error: 'Cannot resolve CLI entry (process.argv[1])' };
    }

    const argv = [
      cliEntry,
      '--headless',
      '--task',
      run.prompt,
      '--output',
      'json',
      '--mode',
      run.mode === 'council' || run.mode === 'zelari' ? run.mode : 'kraken',
      '--phase',
      run.phase === 'plan' ? 'plan' : 'build',
    ];
    if (args.provider?.trim()) {
      argv.push('--provider', args.provider.trim());
    }
    if (args.model?.trim()) {
      argv.push('--model', args.model.trim());
    }
    // t63: per-turn knobs — only --strict-done exists as a CLI flag on the
    // spawn path; permissionPreset/verifyPack are client-mode-only.
    if (args.strictDone === true) argv.push('--strict-done');
    else if (args.strictDone === false) argv.push('--no-strict-done');
    // t65: yolo/full-access — forward the permission preset on the spawn
    // path too, via the existing --permissions CLI flag (main.ts validates
    // the value before it reaches the env).
    if (args.permissionPreset) {
      argv.push('--permissions', args.permissionPreset);
    }

    let historyFile: string | undefined;
    if (args.history && Array.isArray(args.history) && args.history.length > 0) {
      historyFile = join(tmpdir(), `zelari-companion-hist-${run.id}.json`);
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
        // t65: belt-and-suspenders — the long-lived headless child reads the
        // preset straight from env even if it never re-parses --permissions;
        // mirrors main.ts's --permissions → ZELARI_PERMISSION_PRESET promotion.
        ...(args.permissionPreset
          ? { ZELARI_PERMISSION_PRESET: args.permissionPreset }
          : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    // t66: same-run relaunch (trust release) keeps the parked listeners.
    const parked = this.active?.run.id === run.id ? this.active : null;
    this.active = {
      run,
      child,
      listeners: parked?.listeners ?? new Set(),
      historyFile,
      permissionPreset: args.permissionPreset,
    };

    this.emit({
      type: 'log',
      message: `[companion] run ${run.id} started mode=${run.mode} phase=${run.phase} cwd=${args.cwd}`,
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
        runId: run.id,
        status: run.status,
        exitCode: code,
      });
      this.finishActive();
    });

    return { ok: true, run };
  }

  /**
   * t32 client mode entry: same CompanionRun lifecycle as the spawn path,
   * driven by session.create → run.turn over the harness NDJSON protocol.
   * Synchronous like start(): the async chain runs fire-and-forget and
   * reports through the usual run status + emit path.
   */
  private startViaHarness(
    run: CompanionRun,
    args: StartRunArgs,
    mode: string,
    phase: string,
  ): { ok: true; run: CompanionRun } | { ok: false; error: string } {
    // t66: preserve parked listeners (phone SSE) when releasing a
    // trust-gated run — same run id relaunch must not drop subscribers.
    const parked = this.active?.run.id === run.id ? this.active : null;
    this.active = {
      run,
      listeners: parked?.listeners ?? new Set(),
      permissionPreset: args.permissionPreset,
    };
    this.emit({
      type: 'log',
      message: `[companion] run ${run.id} started mode=${mode} phase=${phase} cwd=${args.cwd}`,
    });
    void this.driveHarnessTurn(run, args, mode, phase);
    return { ok: true, run };
  }

  /**
   * The client-mode turn: one harness session per run (mirroring the
   * one-process-per-run semantics), disposed after settlement so the App
   * Server's per-workspace services stay warm for the NEXT run. Turn
   * BrainEvents ride the transport like child stdout lines did in spawn
   * mode — with the default stdio transport that is verbatim (runOneTurn
   * emits them on the server's stdout).
   */
  private async driveHarnessTurn(
    run: CompanionRun,
    args: StartRunArgs,
    mode: string,
    phase: string,
  ): Promise<void> {
    try {
      const client = await this.ensureHarnessClient();
      const sessionId = await client.createSession(args.cwd);
      const connected = this.active;
      if (!connected || connected.run.id !== run.id) {
        // Run superseded/finished while connecting — release the session slot.
        await client.disposeSession(sessionId).catch(() => undefined);
        return;
      }
      if (connected.cancelRequested) {
        // Cancelled before the session connected: dispose, never start a turn.
        await client.disposeSession(sessionId).catch(() => undefined);
        this.emit({
          type: 'run_finished',
          runId: run.id,
          status: run.status,
          exitCode: run.exitCode ?? null,
        });
        this.finishActive();
        return;
      }
      connected.harnessSessionId = sessionId;
      // Same turn input the spawn argv produced (HeadlessOptions shape);
      // history rides the payload instead of a tmp --history-file.
      const turnInput: Record<string, unknown> = {
        task: run.prompt,
        mode,
        phase,
        output: 'json',
      };
      if (args.provider?.trim()) turnInput['provider'] = args.provider.trim();
      if (args.model?.trim()) turnInput['model'] = args.model.trim();
      if (Array.isArray(args.history) && args.history.length > 0) {
        turnInput['history'] = args.history;
      }
      // t63: per-turn passthrough. permissionPreset/strictDone are consumed
      // by the server (applyTurnPermissionPreset / HeadlessOptions spread);
      // verifyPack rides the envelope for forward compat.
      if (args.permissionPreset) turnInput['permissionPreset'] = args.permissionPreset;
      if (args.strictDone !== undefined) turnInput['strictDone'] = args.strictDone;
      if (args.verifyPack !== undefined) turnInput['verifyPack'] = args.verifyPack;
      const result = await client.runTurn(sessionId, turnInput);
      const stillOwner = this.active?.run.id === run.id;
      if (stillOwner && run.status === 'running') {
        // Same guard as the spawn path's close handler: a cancelled run
        // keeps its 'cancelled' status when the turn settles later.
        const exitCode = typeof result.exitCode === 'number' ? result.exitCode : 1;
        run.status = exitCode === 0 ? 'completed' : 'error';
        run.exitCode = exitCode;
        run.finishedAt = Date.now();
        if (exitCode !== 0 && !run.error) run.error = `exit ${exitCode}`;
      }
      if (stillOwner) {
        this.emit({
          type: 'run_finished',
          runId: run.id,
          status: run.status,
          exitCode: run.exitCode ?? null,
        });
        this.finishActive();
      }
      await client.disposeSession(sessionId).catch(() => undefined);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (this.active?.run.id === run.id) {
        run.status = 'error';
        run.error = message;
        run.finishedAt = Date.now();
        this.emit({ type: 'error', severity: 'fatal', message, code: 'harness_client' });
        this.finishActive();
      }
    }
  }

  private async ensureHarnessClient(): Promise<HarnessClient> {
    if (this.harnessClient) return this.harnessClient;
    const transport = (this.createTransport ?? (() => this.createServerTransport()))();
    this.harnessTransport = transport;
    this.harnessClient = new HarnessClient(transport, (event) => {
      // Server-initiated NDJSON (protocol_info handshake, BrainEvents, §24
      // control acks) takes the same emit path child stdout lines used.
      this.emit(event);
    });
    return this.harnessClient;
  }

  /**
   * Default client transport: ONE long-lived `--serve-harness` child shared
   * by every run, instead of one `--headless` child per run.
   */
  private createServerTransport(): HarnessTransportHandle {
    const cliEntry = process.argv[1];
    if (!cliEntry) {
      throw new Error('Cannot resolve CLI entry (process.argv[1])');
    }
    const child = spawn(process.execPath, [cliEntry, '--serve-harness'], {
      env: { ...process.env, ZELARI_SKIP_PREFLIGHT: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    child.stderr?.on('data', (buf: Buffer) => {
      const text = buf.toString('utf8').trim();
      if (text) this.emit({ type: 'log', message: `[harness] ${text}` });
    });
    return {
      write: (line) => {
        child.stdin?.write(line + '\n');
      },
      onLine: (listener) => {
        const rl = createInterface({ input: child.stdout! });
        rl.on('line', listener);
      },
      close: () =>
        new Promise<void>((resolveClose) => {
          try {
            child.once('close', () => resolveClose());
            child.kill('SIGTERM');
          } catch {
            resolveClose();
          }
        }),
    };
  }

  /**
   * t32: steer the active run (harness client mode only). Spawn mode has no
   * live channel into the running process — explicit error, never a silent
   * drop. §24: the result reflects ACCEPTANCE; watch for control_applied.
   */
  async steer(
    runId: string | undefined,
    text: string,
  ): Promise<
    { ok: true; result: Record<string, unknown> } | { ok: false; error: string }
  > {
    if (!this.active) return { ok: false, error: 'No active run' };
    if (runId && this.active.run.id !== runId) {
      return { ok: false, error: `Run ${runId} is not active` };
    }
    const trimmed = text?.trim();
    if (!trimmed) return { ok: false, error: 'text is required' };
    if (!this.active.harnessSessionId || !this.harnessClient) {
      return {
        ok: false,
        error: `steer requires harness server mode (${HARNESS_SERVER_ENV}=1)`,
      };
    }
    try {
      const result = await this.harnessClient.steer(this.active.harnessSessionId, trimmed);
      return { ok: true, result };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** t63: settle a permission.request on the active client-mode run. */
  async permissionRespond(
    runId: string | undefined,
    requestId: string,
    decision: string,
  ): Promise<{ ok: true; result: Record<string, unknown> } | { ok: false; error: string }> {
    if (!this.active) return { ok: false, error: 'No active run' };
    if (runId && this.active.run.id !== runId) {
      return { ok: false, error: `Run ${runId} is not active` };
    }
    const id = requestId?.trim();
    if (!id) return { ok: false, error: 'requestId is required' };
    if (!this.active.harnessSessionId || !this.harnessClient) {
      return {
        ok: false,
        error: `permission respond requires harness server mode (${HARNESS_SERVER_ENV}=1)`,
      };
    }
    try {
      const result = await this.harnessClient.permissionRespond(id, decision);
      return { ok: true, result };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** t63: settle an ask_user.request (answer null = dismiss). */
  async askUserRespond(
    runId: string | undefined,
    requestId: string,
    answer: string | null,
  ): Promise<{ ok: true; result: Record<string, unknown> } | { ok: false; error: string }> {
    if (!this.active) return { ok: false, error: 'No active run' };
    if (runId && this.active.run.id !== runId) {
      return { ok: false, error: `Run ${runId} is not active` };
    }
    const id = requestId?.trim();
    if (!id) return { ok: false, error: 'requestId is required' };
    if (answer != null && typeof answer !== 'string') {
      return { ok: false, error: 'answer must be a string or null' };
    }
    if (!this.active.harnessSessionId || !this.harnessClient) {
      return {
        ok: false,
        error: `ask respond requires harness server mode (${HARNESS_SERVER_ENV}=1)`,
      };
    }
    try {
      const result = await this.harnessClient.askUserRespond(id, answer);
      return { ok: true, result };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  cancel(runId?: string): { ok: true } | { ok: false; error: string } {
    if (!this.active) {
      return { ok: false, error: 'No active run' };
    }
    if (runId && this.active.run.id !== runId) {
      return { ok: false, error: `Run ${runId} is not active` };
    }
    const { run } = this.active;
    run.status = 'cancelled';
    run.finishedAt = Date.now();
    this.emit({
      type: 'log',
      message: `[companion] cancelling run ${run.id}`,
    });
    // t32 client mode: cooperative cancel on the harness session (the turn
    // process is shared — there is no per-run child to kill). Before the
    // session is connected, cancelRequested makes driveHarnessTurn dispose
    // the session as soon as createSession resolves.
    const harnessSessionId = this.active.harnessSessionId;
    this.active.cancelRequested = true;
    if (harnessSessionId && this.harnessClient) {
      void this.harnessClient
        .cancel(harnessSessionId, 'companion cancel')
        .catch(() => undefined);
      return { ok: true };
    }
    const child = this.active.child;
    if (!child) return { ok: true }; // client mode, still connecting
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

  /**
   * t32: tear the harness client + transport down (idempotent). The default
   * stdio transport is a child that dies with the host process, so serve
   * shutdown works without this; explicit hosts call it for clean disposal.
   */
  async close(): Promise<void> {
    const client = this.harnessClient;
    this.harnessClient = null;
    this.harnessTransport = null;
    if (client) await client.close();
  }
}
