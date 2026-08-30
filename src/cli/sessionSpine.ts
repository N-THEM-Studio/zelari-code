/**
 * sessionSpine — bridge onto the 2.0 session spine (ADR-0016/0021/0024).
 *
 * As of 2.0.0-alpha.5 the spine is the ONLY source of the model context on
 * every hot path (headless kraken/council/zelari + TUI single/council): the
 * harness seed is derived via `deriveMessages()` from
 * `<workspace>/.zelari/sessions/<sessionId>/events.jsonl` (P1: model-visible
 * ⟺ logged — including user prompts, which the 1.x log never recorded).
 * Resume/fork/lineage/export and verification + mission state events live in
 * the same log.
 *
 * The 1.x JSONL sidecar (BrainEvent log) and the in-process rolling store
 * remain as a mirrored export/UI surface (ADR-0024): they feed render plus
 * the declared discrete fallback. Mirror removal is explicitly re-planned
 * (deferred decision — plan task W5 in .zelari/plan.json); preconditions:
 * strict gate green on desktop QA t21 and no mirror reads in telemetry for
 * one minor. The old "remove at 2.0.0-rc" deadline is retired.
 *
 * Failure discipline (the "declared discrete fallback"): a spine error NEVER
 * breaks the turn — the mirror marks itself degraded, warns once on stderr
 * and stops writing; the model seed falls back to the 1.x store.
 * `ZELARI_SESSION_SPINE=0` is an emergency/debug kill switch only.
 */
import type { BrainEvent } from '@zelari/core/events';
import type { SessionJsonlWriter } from '@zelari/core/harness';
import { TOOL_CALL_TRUNCATED_RECOVERY_USER, TEXT_TOOLS_FAILED_USER, TEXT_TOOLS_PARTIAL_USER } from '@zelari/core/harness';
import {
  SessionLogWriter,
  SessionLogLockedError,
  resolveSessionsDir,
  readSessionLog,
  buildProjection,
  deriveMessages,
  type SessionEventInput,
  buildCompactionStateSnapshot,
  type CompactionStateSnapshot,
  type SessionProjection,
  type DerivedMessage,
} from '@zelari/core/session';
import { ACTOR_AGENT, ACTOR_SYSTEM, ACTOR_USER, deriveInitialContract } from '@zelari/core/session';
import {
  lastVerificationRun as lastVerificationRunFromLog,
  type SessionVerificationRunSnapshot,
} from '@zelari/core/verification';
import type { ResourceSnapshotPayload } from './budget/resourceSnapshot.js';
import type { ToolFingerprint } from '@zelari/core';
import { BudgetRuntime, resolveResourceEnforcement } from './budget/budgetRuntime.js';
import { lastHarnessManifestHash, restoreBudgetRuntimeFromSession } from './budget/restoreRuntime.js';
import { resolveProfile } from '@zelari/core/runtime';
import { buildHarnessManifest } from './harnessManifest.js';
import { contractEventData, latestTaskContract, updateTaskContract } from './kraken/taskContract.js';
import path from 'node:path';

/** Kill switch — default ON in the 2.0 alpha. */
export function spineEnabled(): boolean {
  return process.env.ZELARI_SESSION_SPINE !== '0';
}

/** The narrow writer surface the TUI loop actually uses. */
export interface SessionWriterLike {
  append(ev: BrainEvent): void | Promise<void>;
  flush?(): Promise<void>;
  close(): void | Promise<void>;
  readonly path?: string;
}

export type SpineStatus = 'active' | 'disabled' | 'locked' | 'degraded' | 'closed';

/** Map one BrainEvent onto a spine event; null when not spine-relevant. */
export function mapBrainEventToSpine(ev: BrainEvent): SessionEventInput | null {
  switch (ev.type) {
    case 'tool_execution_start':
      return {
        kind: 'tool.call',
        actor: ACTOR_AGENT,
        data: { tool: ev.toolName, args: ev.args ?? {}, callId: ev.toolCallId },
      };
    case 'tool_execution_end':
      return {
        kind: 'tool.result',
        actor: { type: 'tool' },
        data: {
          callId: ev.toolCallId,
          output: ev.result,
          ok: !ev.isError,
          durationMs: ev.durationMs,
        },
      };
    case 'session_compacted': {
      const compact = ev as {
        summary?: unknown;
        messagesRemoved?: unknown;
        fromSeq?: unknown;
        toSeq?: unknown;
        checkpoint?: unknown;
        strategy?: unknown;
        sourceEventSeqs?: unknown;
        retainedCriterionIds?: unknown;
        retainedEvidenceRefs?: unknown;
        retainedState?: unknown;
        stateSnapshot?: unknown;
        sourceRequestFingerprint?: unknown;
        headerFingerprint?: unknown;
        sourceEstimatedTokens?: unknown;
        cacheReuseExpected?: unknown;
        inputTokens?: unknown;
        outputTokens?: unknown;
        savedTokens?: unknown;
        recompactionRate?: unknown;
        summaryStrategy?: unknown;
        provider?: unknown;
        model?: unknown;
      };
      const data: Record<string, unknown> = { summary: compact.summary ?? '' };
      if (typeof compact.messagesRemoved === 'number') data.messagesRemoved = compact.messagesRemoved;
      if (typeof compact.fromSeq === 'number' && typeof compact.toSeq === 'number') {
        data.fromSeq = compact.fromSeq;
        data.toSeq = compact.toSeq;
      }
      if (compact.checkpoint && typeof compact.checkpoint === 'object') data.checkpoint = compact.checkpoint;
      if (compact.strategy === 'extractive' || compact.strategy === 'llm') data.strategy = compact.strategy;
      if (Array.isArray(compact.sourceEventSeqs)) data.sourceEventSeqs = compact.sourceEventSeqs;
      if (Array.isArray(compact.retainedCriterionIds)) {
        data.retainedCriterionIds = compact.retainedCriterionIds;
      }
      if (Array.isArray(compact.retainedEvidenceRefs)) {
        data.retainedEvidenceRefs = compact.retainedEvidenceRefs;
      }
      if (compact.retainedState && typeof compact.retainedState === 'object') {
        data.retainedState = compact.retainedState;
      }
      if (compact.stateSnapshot && typeof compact.stateSnapshot === 'object') data.stateSnapshot = compact.stateSnapshot;
      if (typeof compact.sourceRequestFingerprint === 'string') {
        data.sourceRequestFingerprint = compact.sourceRequestFingerprint;
      }
      if (typeof compact.headerFingerprint === 'string') data.headerFingerprint = compact.headerFingerprint;
      if (typeof compact.sourceEstimatedTokens === 'number') {
        data.sourceEstimatedTokens = compact.sourceEstimatedTokens;
      }
      if (typeof compact.cacheReuseExpected === 'boolean') data.cacheReuseExpected = compact.cacheReuseExpected;
      if (typeof compact.inputTokens === 'number') data.inputTokens = compact.inputTokens;
      if (typeof compact.outputTokens === 'number') data.outputTokens = compact.outputTokens;
      if (typeof compact.savedTokens === 'number') data.savedTokens = compact.savedTokens;
      if (typeof compact.recompactionRate === 'number') data.recompactionRate = compact.recompactionRate;
      if (compact.summaryStrategy === 'extractive' || compact.summaryStrategy === 'llm') {
        data.summaryStrategy = compact.summaryStrategy;
      }
      if (typeof compact.provider === 'string') data.provider = compact.provider;
      if (typeof compact.model === 'string') data.model = compact.model;
      return { kind: 'session.compacted', actor: ACTOR_SYSTEM, data };
    }
    case 'agent_start':
      return {
        kind: 'note',
        actor: ACTOR_SYSTEM,
        data: {
          note: 'agent_start',
          model: ev.model,
          provider: ev.provider,
          ...(ev.memberName ? { member: ev.memberName } : {}),
        },
      };
    case 'error':
      // A provider-truncated tool call must reach the model context on the
      // spine path too: the harness pushes the same guidance into its rolling
      // history (fallback path), but buildModelContext prefers the
      // spine-derived surface, so mirror the note as a model-visible
      // user.message. Any other error code stays out of the spine vocabulary.
      if (ev.code === 'tool_call_truncated') {
        return {
          kind: 'user.message',
          actor: ACTOR_USER,
          data: { text: TOOL_CALL_TRUNCATED_RECOVERY_USER },
        };
      }
      // 2.18.1 (t49): same contract for text-format tool feedback — a
      // ---TOOLS--- block that parsed partially or not at all. Mirrors the
      // exact constants the harness pushes on the fallback-history path.
      if (ev.code === 'text_tools_parse_failed') {
        return {
          kind: 'user.message',
          actor: ACTOR_USER,
          data: { text: TEXT_TOOLS_FAILED_USER },
        };
      }
      if (ev.code === 'text_tools_truncated') {
        return {
          kind: 'user.message',
          actor: ACTOR_USER,
          data: { text: TEXT_TOOLS_PARTIAL_USER },
        };
      }
      return null;
    default:
      // message deltas are coalesced at message_end by the mirror;
      // ui/progress/metrics events are not part of the spine vocabulary.
      return null;
  }
}

export interface SpineMirrorOptions {
  /** Explicit sessions base dir (tests). */
  baseDir?: string;
  /** Workspace root — sessions live at `<workspaceRoot>/.zelari/sessions`. */
  workspaceRoot?: string;
  now?: () => number;
  /** Suppress the one-time degraded warning (tests). */
  quiet?: boolean;
  /**
   * Extra fields merged into the first `session.started` / `session.resumed`
   * data payload (profile id, workspace, tool-manifest hash).
   */
  extraStarted?: Record<string, unknown>;
  /**
   * 2.6 Track A: canonical harness manifest parts/builder output recorded as
   * a `session.harness_manifest` state event right after session start.
   * Opt-in — callers that pass it own the {manifest, manifestHash} payload
   * (see src/cli/harnessManifest.ts buildHarnessManifest).
   */
  harnessManifest?: { manifest: unknown; manifestHash: string };
  /**
   * 2.6.1 (plan §7): deep tool specs (name + description + JSON schema) from the
   * live registry — feeds the harness manifest fingerprint. Optional: hosts
   * without a registry in scope degrade to shallow tool names.
   */
  toolSpecs?: readonly ToolFingerprint[];
}

const MAX_STREAM_BUFFERS = 32;

/**
 * Owns the spine writer for one session. All appends are serialized; every
 * public method swallows errors (degrade-and-stop) — the spine must never
 * take the interactive loop down with it.
 */
export class SessionSpineMirror {
  private writer: SessionLogWriter | null = null;
  private chain: Promise<number | null> = Promise.resolve(null);
  private readonly streamBuffers = new Map<string, string>();
  private warned = false;
  /** Host-owned budget runtime (attached via attachBudgetRuntime). */
  private budgetRuntime: BudgetRuntime | null = null;
  /** True after the host prepared an epoch but before its user.message lands. */
  private resourceTurnPrepared = false;
  /** 2.6 Track A: set once a task.contract has been seeded (or the log had one). */
  private contractSeeded = false;
  status: SpineStatus = 'disabled';
  /** Seq the log continued from when adopting an existing session. */
  resumedFromSeq: number | undefined;
  readonly sessionsDir: string;

  private constructor(
    readonly sessionId: string,
    private readonly options: SpineMirrorOptions,
  ) {
    this.sessionsDir = resolveSessionsDir({
      baseDir: options.baseDir,
      workspaceRoot: options.workspaceRoot,
    });
  }

  /**
   * Adopt a 1.x sessionId into the spine: continue the seq when the log
   * already exists (resume), otherwise start fresh with `session.started`.
   * Returns the mirror (never throws — check `.status`).
   */
  static async adopt(sessionId: string, options: SpineMirrorOptions = {}): Promise<SessionSpineMirror> {
    const mirror = new SessionSpineMirror(sessionId, options);
    if (!spineEnabled()) return mirror;
    try {
      const sessionDir = path.join(mirror.sessionsDir, sessionId);
      const report = await readSessionLog(path.join(sessionDir, 'events.jsonl'));
      const existed = report.events.length > 0 || report.issues.length > 0;
      // 2.6 Track A: a resumed session already carries its contract/user
      // history — never re-seed from a later steer (version authority §14.3).
      if (report.events.some((e) => e.kind === 'task.contract' || e.kind === 'user.message')) {
        mirror.contractSeeded = true;
      }
      const lastSeq = report.events[report.events.length - 1]?.seq ?? 0;
      mirror.writer = await SessionLogWriter.open(sessionDir, sessionId, lastSeq + 1, {
        now: options.now,
      });
      mirror.resumedFromSeq = existed ? lastSeq : undefined;
      await mirror.append({
        kind: existed ? 'session.resumed' : 'session.started',
        actor: ACTOR_SYSTEM,
        data: {
          reason: existed ? 'host-resume' : 'host-bootstrap',
          bridge: 'cli-dual-write',
          continuedFromSeq: existed ? lastSeq : undefined,
          replayIssues: report.issues.length || undefined,
          ...options.extraStarted,
        },
      });
      if (options.harnessManifest) {
        await mirror.append({
          kind: 'session.harness_manifest',
          actor: ACTOR_SYSTEM,
          data: {
            manifest: options.harnessManifest.manifest,
            manifestHash: options.harnessManifest.manifestHash,
          },
        });
      }
      mirror.status = 'active';
    } catch (err) {
      if (err instanceof SessionLogLockedError) {
        mirror.status = 'locked';
      } else {
        mirror.status = 'degraded';
        mirror.warnOnce(err);
      }
      mirror.writer = null;
    }
    return mirror;
  }

  /** Log the user prompt — the P1 gap the 1.x log never closed. */
  userMessage(
    text: string,
    options: { beginResourceTurn?: boolean; imported?: string } = {},
  ): void {
    // Direct callers still get correct per-turn semantics. Hot paths prepare
    // (and await) this epoch before model-context derivation, so this is
    // idempotent there and only consumes the prepared marker.
    if (options.beginResourceTurn !== false) {
      void this.beginResourceTurn();
      this.resourceTurnPrepared = false;
    }
    const seqP = this.append({
      kind: 'user.message',
      actor: ACTOR_USER,
      data: { text, ...(options.imported ? { imported: options.imported } : {}) },
    });
    // NOTE (2.6 Track A): task.contract seeding happens INSIDE append() on
    // the same write chain (user.message -> task.contract, deterministic
    // order, flush() awaits both). A .then() here would race flush()'s
    // chain capture - the exact bug CI caught on Linux.
    void seqP;
    // 2.6 Track A (doc section 14): seed the first-class task contract from
    // the FIRST user message of a fresh session. Env-gated pilot
    // (ZELARI_TASK_CONTRACT=1), state-only, version-monotone - the derived
    // contract anchors constraints/criteria the compaction snapshot prefers
    // over regex extraction (F7). Later steers remain user messages and also
    // emit task.contract_updated below; degrade-and-stop applies.
  }

  /**
   * Log an assistant message outside the streaming path — legacy
   * `--history` import (Exit-1/E1.2). Same event shape the message_end
   * coalescer emits, so deriveMessages() treats both identically.
   */
  assistantMessage(text: string, extra?: Record<string, unknown>): void {
    void this.append({
      kind: 'assistant.message',
      actor: ACTOR_AGENT,
      data: { text, ...extra },
    });
  }

  /** Await all pending appends (import → derive read-back needs this). */
  /**
   * Record the canonical harness manifest (2.6 Track A, doc section 6.5): one
   * state-only event at session start / manifest change. Degrade-and-stop
   * like every other mirror method - the spine never breaks the loop.
   */
  harnessManifest(manifest: unknown, manifestHash: string): void {
    void this.append({
      kind: 'session.harness_manifest',
      actor: ACTOR_SYSTEM,
      data: { manifest, manifestHash },
    });
  }
  /**
   * Attach the host-owned budget runtime (2.6 Track B, Phase 2/3). From here
   * on every `tool.call` that lands on the spine is counted and — at §10.4
   * frequency — a `resource.snapshot` event is appended right after it.
   * Degrade-and-stop discipline applies: budget wiring never breaks a turn.
   */
  attachBudgetRuntime(runtime: BudgetRuntime): void {
    this.budgetRuntime = runtime;
    this.resourceTurnPrepared = false;
  }

  /**
   * Prepare a fresh per-user-turn execution epoch before model context is
   * derived. The cumulative ResourceLedger is retained; enforcement and the
   * latest RESOURCE STATUS restart at 0 / policy.maxToolCalls.
   */
  beginResourceTurn(): Promise<void> {
    if (!this.budgetRuntime || this.resourceTurnPrepared) {
      return this.chain.then(() => undefined);
    }
    const snapshot = this.budgetRuntime.beginTurn();
    this.resourceTurnPrepared = true;
    void this.append({
      kind: 'resource.epoch_started',
      actor: ACTOR_SYSTEM,
      data: {
        epoch: snapshot.epoch,
        kind: 'turn',
        sessionToolCallsUsed: snapshot.sessionToolCallsUsed,
      },
    });
    return this.append({
      kind: 'resource.snapshot',
      actor: ACTOR_SYSTEM,
      data: { ...snapshot },
    }).then(() => undefined);
  }

  /** Latest emitted resource snapshot (available for request-tail injection). */
  latestResourceSnapshot(): ResourceSnapshotPayload | null {
    return this.budgetRuntime?.latestEmitted() ?? null;
  }

  /**
   * 2.6.1 (plan §8): session ResourcePolicy cap for hosts that need to derive
   * per-turn limits — the policy stays the single authority. Null when no
   * runtime is attached (hosts keep their own default).
   */
  /** Full budget shape for evaluateResourceReserveGate (plan §14). */
  resourceBudgetSummary(): import('@zelari/core').ResourceBudget | null {
    return this.budgetRuntime?.budgetSnapshot() ?? null;
  }

  resourceBudgetLimit(): { maxToolCalls: number; remaining: number; verificationReserve: number } | null {
    const snap = this.budgetRuntime?.current();
    return snap
      ? {
          maxToolCalls: snap.toolCallsLimit,
          remaining: snap.toolCallsRemaining,
          verificationReserve: snap.verificationReserve,
        }
      : null;
  }

  /**
   * §11.3 pre-dispatch gate for hosts that enforce the protected zone
   * (Phase 3): delegates to the attached runtime, never throws. Null when
   * no runtime is attached (hosts treat as "no budget info, allow").
   * 2.6.1 (plan §13): argument-aware — pass the tool args so `bash` is only
   * essential when it is a test/typecheck/build/git-diff command.
   */
  gateResourceToolCall(toolName: string, args?: unknown): { allowed: boolean; reason?: string; hardLimit?: boolean } | null {
    const gate = this.budgetRuntime?.gateToolCall({ toolName, args });
    if (!gate) return null;
    return {
      allowed: gate.allowed,
      ...(gate.reason ? { reason: gate.reason } : {}),
      ...(gate.hardLimit ? { hardLimit: gate.hardLimit } : {}),
    };
  }

  /**
   * Count a landed tool.call; returns the snapshot due (§10.4) plus the
   * hard-limit event due on this call (2.6.1 plan §9), if any.
   */
  private onToolCallBudget(): { snapshot: ResourceSnapshotPayload | null; hardEvent: { kind: 'resource.limit_reached' | 'resource.overrun'; data: Record<string, unknown> } | null } {
    return this.budgetRuntime?.consumeToolCall() ?? { snapshot: null, hardEvent: null };
  }

  async flush(): Promise<void> {
    await this.chain;
  }

  /**
   * Derive prior-turn model context from the on-disk log. Null when the
   * log is missing/empty — callers decide whether that means "fresh".
   */
  async derivedPriorTurns(): Promise<DerivedMessage[] | null> {
    if (this.status !== 'active' && this.status !== 'closed') return null;
    const report = await readSessionLog(
      path.join(this.sessionsDir, this.sessionId, 'events.jsonl'),
    ).catch(() => null);
    if (!report || report.events.length === 0) return null;
    return deriveMessages(report.events);
  }

  /** Deterministic operational state retained beside a compact checkpoint. */
  async compactionStateSnapshot(toSeq: number): Promise<CompactionStateSnapshot | null> {
    if (this.status !== 'active' && this.status !== 'closed') return null;
    await this.flush();
    const report = await readSessionLog(
      path.join(this.sessionsDir, this.sessionId, 'events.jsonl'),
    ).catch(() => null);
    if (!report || report.events.length === 0) return null;
    return buildCompactionStateSnapshot(report.events, toSeq);
  }

  /**
   * E2.1 (ADR-0023 × ADR-0021): last recognizable strict verification record
   * in this session's log — the completion verdict is reconstructible from
   * the spine alone (null when degraded/disabled or no record).
   */
  async lastVerificationRun(): Promise<SessionVerificationRunSnapshot | null> {
    if (this.status !== 'active' && this.status !== 'closed') return null;
    const report = await readSessionLog(
      path.join(this.sessionsDir, this.sessionId, 'events.jsonl'),
    ).catch(() => null);
    if (!report) return null;
    return lastVerificationRunFromLog(report.events);
  }

  /** Mirror one BrainEvent (coalescing message deltas until message_end). */
  mirrorBrainEvent(ev: BrainEvent): void {
    if (this.status !== 'active' || !this.writer) return;
    if (ev.type === 'message_delta') {
      const key = ev.messageId;
      const prev = this.streamBuffers.get(key) ?? '';
      this.streamBuffers.set(key, prev + ev.delta);
      return;
    }
    if (ev.type === 'message_end') {
      const text = this.streamBuffers.get(ev.messageId);
      this.streamBuffers.delete(ev.messageId);
      if (this.streamBuffers.size > MAX_STREAM_BUFFERS) {
        this.streamBuffers.clear(); // defensive — bounded memory
      }
      // The buffered text is the full body; when the buffer is missing
      // (e.g. mirror started mid-stream) fall back to nothing rather than
      // logging a truncated claim.
      if (text !== undefined && text.length > 0) {
        void this.append({
          kind: 'assistant.message',
          actor: ACTOR_AGENT,
          data: {
            text,
            messageId: ev.messageId,
            finishReason: ev.finishReason,
            ...(ev.memberName ? { member: ev.memberName } : {}),
          },
        });
      }
      return;
    }
    const mapped = mapBrainEventToSpine(ev);
    if (mapped) void this.append(mapped);
  }

  /** Append a `verification.run` event (machine-readable completion evidence). */
  verificationRun(payload: Record<string, unknown>): void {
    void this.append({ kind: 'verification.run', actor: ACTOR_SYSTEM, data: payload });
  }

  /** Append a `mission.phase` transition (Fase 4 mission reliability). */
  missionPhase(phase: string, note?: string): void {
    void this.append({
      kind: 'mission.phase',
      actor: ACTOR_SYSTEM,
      data: { phase, ...(note ? { note } : {}) },
    });
  }

  /**
   * F4 (doc §6): append an advisory continuation record. State-only — the
   * recommendation must never feed the model loop or rewrite the goal.
   */
  missionProgress(advice: {
    recommendation: string;
    rationale: string;
    blockers?: string[];
    trend?: { tier: string; value: number | null };
    iteration?: number;
  }): void {
    void this.append({
      kind: 'mission.progress',
      actor: ACTOR_SYSTEM,
      data: {
        recommendation: advice.recommendation,
        rationale: advice.rationale,
        ...(advice.blockers ? { blockers: advice.blockers } : {}),
        ...(advice.trend ? { trend: advice.trend } : {}),
        ...(advice.iteration !== undefined ? { iteration: advice.iteration } : {}),
      },
    });
  }

  note(text: string, data?: Record<string, unknown>): void {
    void this.append({ kind: 'note', actor: ACTOR_SYSTEM, data: { note: text, ...data } });
  }

  private append(input: SessionEventInput): Promise<number | null> {
    // 2.6.1 (plan §25): TaskContract is default-ON (opt-out ZELARI_TASK_CONTRACT=0).
    if (!this.writer || this.status === 'closed') return Promise.resolve(null);
    // 2.6 Track B: count synchronously BEFORE enqueueing; when §10.4 says a
    // snapshot is due it lands right AFTER its tool.call on this same chain
    // (local variable — no re-entrant append racing the this.chain capture).
    // 2.6.1 (plan §9): hard-limit events land on the same chain too.
    const budgetEffect = input.kind === 'tool.call' ? this.onToolCallBudget() : null;
    // 2.6 Track A: capture contract seeding synchronously for the FIRST
    // user.message (env-gated pilot). Chained below on the same local seq
    // promise - deterministic order, never a re-entrant append race.
    const dueContract =
      input.kind === 'user.message' &&
      taskContractsEnabled() &&
      !this.contractSeeded
        ? ((this.contractSeeded = true), input.data?.text as string)
        : null;
    // 2.6.1 (plan §4): later user steers version the contract (append-only,
    // monotone version, user-sourced items never removable by agents).
    const steerText =
      input.kind === 'user.message' && taskContractsEnabled() && this.contractSeeded && !dueContract
        ? ((input.data?.text as string) ?? null)
        : null;
    let seq: Promise<number | null> = this.chain
      .then(() => this.writer!.append(input))
      .then((envelope) => envelope.seq);
    if (budgetEffect?.hardEvent) {
      const hard = budgetEffect.hardEvent;
      seq = seq.then((s) =>
        this.writer!
          .append({ kind: hard.kind, actor: ACTOR_SYSTEM, data: { ...hard.data } })
          .then(() => s),
      );
    }
    if (budgetEffect?.snapshot) {
      const dueSnapshot = budgetEffect.snapshot;
      seq = seq.then((s) =>
        this.writer!
          .append({ kind: 'resource.snapshot', actor: ACTOR_SYSTEM, data: { ...dueSnapshot } })
          .then(() => s),
      );
    }
    if (dueContract) {
      seq = seq.then(async (s) => {
        try {
          const contract = deriveInitialContract(s ?? 1, dueContract);
          if (contract) {
            await this.writer!.append({
              kind: 'task.contract',
              actor: ACTOR_SYSTEM,
              data: { contract, kind: 'task.contract' },
            });
          }
        } catch {
          /* degrade-and-stop: seeding failure never breaks the turn */
        }
        return s;
      });
    }
    if (steerText) {
      seq = seq.then(async (s) => {
        try {
          const eventsPath = path.join(this.sessionsDir, this.sessionId, 'events.jsonl');
          const report = await readSessionLog(eventsPath).catch(() => null);
          if (!report || typeof s !== 'number') return s;
          const current = latestTaskContract(report.events);
          if (!current) return s;
          const updated = updateTaskContract(current, {
            addConstraints: [{ id: `steer-${s}`, text: steerText, source: 'user', required: false }],
            nextUserSeq: s,
          });
          if (updated.version !== current.version) {
            await this.writer!.append({
              kind: 'task.contract_updated',
              actor: ACTOR_SYSTEM,
              data: contractEventData(updated, true),
            });
          }
        } catch {
          /* degrade-and-stop: steer versioning never breaks the turn */
        }
        return s;
      });
    }
    this.chain = seq
      .catch((err) => {
        this.status = 'degraded';
        this.writer = null;
        this.warnOnce(err);
        return null;
      });
    return this.chain;
  }

  /**
   * F3 (ADR-0023 §5): append one spine event and resolve to its assigned
   * seq — the anchor EvidenceRef.seq points at. Null when degraded or
   * disabled: callers must treat null as "not traceable", never as failure.
   */
  appendEvent(input: SessionEventInput): Promise<number | null> {
    return this.append(input);
  }

  private warnOnce(err: unknown): void {
    if (this.warned || this.options.quiet) return;
    this.warned = true;
    const msg = err instanceof Error ? err.message : String(err);
    try {
      process.stderr.write(
        `[zelari] session spine degraded for ${this.sessionId.slice(0, 8)}…: ${msg} (transcript continues on the 1.x log)\n`,
      );
    } catch {
      /* stderr gone — nothing more to do */
    }
  }

  /** Flush pending appends; append `session.ended` and release the lock. */
  async close(reason = 'host-exit'): Promise<void> {
    if (this.status === 'active' && this.writer) {
      await this.append({ kind: 'session.ended', actor: ACTOR_SYSTEM, data: { reason } });
    }
    await this.chain;
    const writer = this.writer;
    this.writer = null;
    if (this.status !== 'closed') this.status = 'closed';
    if (writer) await writer.close().catch(() => undefined);
  }

  /**
   * Release the lock WITHOUT appending `session.ended`.
   * Used on SIGINT / abort so deriveMissionState can project
   * `interrupted: true` and a later adopt continues the seq.
   */
  async release(): Promise<void> {
    await this.chain;
    const writer = this.writer;
    this.writer = null;
    if (this.status === 'active') this.status = 'closed';
    if (writer) await writer.close().catch(() => undefined);
  }
}

/** Writer that dual-writes: 1.x sidecar + spine mirror. */
export class SpineMirroringWriter implements SessionWriterLike {
  constructor(
    private readonly inner: SessionJsonlWriter,
    public readonly spine: SessionSpineMirror | null,
  ) {}

  get path(): string | undefined {
    return this.inner.path;
  }

  append(ev: BrainEvent): void | Promise<void> {
    const result = this.inner.append(ev);
    this.spine?.mirrorBrainEvent(ev);
    return result;
  }

  async flush(): Promise<void> {
    await this.inner.flush?.();
    await this.spine?.flush();
  }

  async close(): Promise<void> {
    await this.inner.close();
    await this.spine?.close();
  }
}

/**
 * Bootstrap the dual-write writer for a TUI session: opens the spine mirror
 * (best-effort) and wraps the 1.x writer so the chat loop needs no changes.
 */
export async function wrapSessionWriter(
  inner: SessionJsonlWriter,
  sessionId: string,
  options: SpineMirrorOptions = {},
): Promise<SpineMirroringWriter> {
  const spine = await SessionSpineMirror.adopt(sessionId, options);
  if (spine.status === 'active') {
    // 2.6 Track B (Phase 2/3): count tool calls + emit resource.snapshot.
    const profile = options.extraStarted?.profile;
    const budget = new BudgetRuntime(typeof profile === 'string' ? profile : 'kraken/v1', {
      enforcement: resolveResourceEnforcement(),
    });
    // TUI/host parity — on resume, rebuild both cumulative telemetry and the
    // active epoch with the SAME helper headless uses. An interrupted 12/40
    // resumes at 28 remaining; the next user turn starts a fresh 0/40 epoch.
    if (spine.resumedFromSeq !== undefined && spine.resumedFromSeq > 0) {
      await restoreBudgetRuntimeFromSession(budget, sessionId, options.baseDir);
    }
    spine.attachBudgetRuntime(budget);
    // 2.6.1 (plan §6): manifest presence = 100% + resume drift detection.
    await noteHarnessLifecycle(
      spine,
      sessionId,
      typeof profile === 'string' ? profile : 'kraken/v1',
      budget,
      options.baseDir,
      (options.extraStarted as { phase?: string } | undefined)?.phase,
      options.toolSpecs,
      );
  }
  return new SpineMirroringWriter(inner, spine.status === 'active' ? spine : null);
}

export interface SpineResumeContext {
  projection: SessionProjection;
  /** deriveMessages() over the replayed log — the canonical 2.0 history. */
  derived: DerivedMessage[];
}

/**
 * Replay the spine for resume UX (headless + TUI status line). Returns null
 * when the session has no spine log yet.
 */
export async function resumeSpineContext(
  sessionId: string,
  baseDir?: string,
): Promise<SpineResumeContext | null> {
  const sessionsDir = resolveSessionsDir({ baseDir });
  const eventsPath = path.join(sessionsDir, sessionId, 'events.jsonl');
  const report = await readSessionLog(eventsPath).catch(() => null);
  if (!report || (report.events.length === 0 && report.issues.length === 0)) return null;
  return {
    projection: buildProjection(report.events, report.issues),
    derived: deriveMessages(report.events),
  };
}

/** 2.6.1 (plan §25): TaskContract default-ON; opt out with ZELARI_TASK_CONTRACT=0. */
function taskContractsEnabled(): boolean {
  return process.env.ZELARI_TASK_CONTRACT !== '0';
}

/**
 * 2.6.1 (plan §6): harness manifest lifecycle shared by EVERY host — fresh
 * session persists session.harness_manifest; a resume only backfills it on
 * pre-2.6.1 logs. Degrade-and-stop: manifest wiring never breaks a turn.
 */
export async function noteHarnessLifecycle(
  spine: SessionSpineMirror,
  sessionId: string,
  profileId: string,
  budget: BudgetRuntime,
  baseDir?: string,
  phaseHint?: unknown,
  toolSpecs?: readonly ToolFingerprint[],
): Promise<void> {
  try {
    const profile = resolveProfile(profileId);
    const { manifest, manifestHash } = buildHarnessManifest({
      profile,
      phase: phaseHint === 'plan' ? 'plan' : 'build',
      toolNames: profile.tools,
      // 2.6.1 (plan §7): deep specs when the host has a live registry in scope.
      toolSpecs,
      // plan §7/§8: the REAL session policy — never the {unset:true} marker.
      resourcePolicy: budget.policy,
    });
    if (spine.resumedFromSeq !== undefined && spine.resumedFromSeq > 0) {
      // Resume: backfill only when the log predates harness manifests.
      // (Drift detection on manifest change was retired with W5 — the event
      // kind no longer exists; old logs replay it as a schema-mismatch note.)
      if ((await lastHarnessManifestHash(sessionId, baseDir)) === null) {
        spine.harnessManifest(manifest, manifestHash);
      }
    } else {
      spine.harnessManifest(manifest, manifestHash);
    }
  } catch {
    /* degrade-and-stop */
  }
}
