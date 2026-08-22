/**
 * src/cli/budget/budgetRuntime.ts — live host-owned budget runtime (2.6
 * Track B, doc §9–§12 rollout Phase 2/3). Wires the pure core primitives
 * (ResourcePolicy/ResourceBudget) to the running loop:
 *
 *   - counts every tool.call that lands on the spine (via SessionSpineMirror
 *     attach) and emits `resource.snapshot` events at §10.4 frequency;
 *   - exposes the LATEST snapshot for the model-visible RESOURCE STATUS
 *     block (injected by buildModelContext);
 *   - gates tool calls when the protected verification zone is entered
 *     (§11.3): `advisory` (default, Phase 2) lets everything through with a
 *     warning; `protected` (Phase 3, ZELARI_RESOURCE_ENFORCEMENT=protected)
 *     denies non-essential tools and tells the model to verify/finalize.
 *
 * The model never mutates this state — only the host appends (§9.5).
 */

import { defaultResourcePolicy, type ResourcePolicy, type ResourceStage } from '@zelari/core';
import type { SessionEventEnvelope } from '@zelari/core';
import { ResourceLedger, rebuildLedgerFromEvents } from './resourceLedger.js';
import {
  buildResourceSnapshot,
  shouldEmitSnapshot,
  type ResourceSnapshotPayload,
} from './resourceSnapshot.js';

export type ResourceEnforcement = 'advisory' | 'protected';

/**
 * §11.3 verification-essential tools: test/typecheck/build/diff/read
 * failure/targeted repair/retest. Everything else (delegation, speculative
 * search, new architecture) is non-essential inside the protected zone.
 */
const DEFAULT_ESSENTIAL_TOOLS: readonly string[] = [
  'bash',
  'read_file',
  'edit_file',
  'write_file',
  'apply_diff',
  'grep_content',
  'list_files',
  'show_diff',
];

const ADVISORY_NOTICE =
  'Resource advisory: verification reserve reached. Prioritize test/typecheck/build/diff and targeted repair; avoid broad exploration or delegation.';

const PROTECTED_DENIAL =
  'Resource protected: remaining tool calls are reserved for verification and targeted repair. Run the required checks (test/typecheck/build), read the failure, apply a minimal fix, retest — or report BLOCKED with the evidence you have.';

/** Phase selector — advisory by default (§11.4), protected via env (Phase 3). */
export function resolveResourceEnforcement(env: NodeJS.ProcessEnv = process.env): ResourceEnforcement {
  return env.ZELARI_RESOURCE_ENFORCEMENT === 'protected' ? 'protected' : 'advisory';
}

export interface BudgetRuntimeOptions {
  enforcement?: ResourceEnforcement;
  /** Defaults to defaultResourcePolicy(profileId). */
  policy?: ResourcePolicy;
  essentialTools?: readonly string[];
  stage?: ResourceStage;
}

export interface ToolGateResult {
  allowed: boolean;
  /** True when allowed but inside the protected zone (advisory mode). */
  advisory: boolean;
  reason?: string;
  snapshot: ResourceSnapshotPayload;
}

export class BudgetRuntime {
  readonly policy: ResourcePolicy;
  readonly enforcement: ResourceEnforcement;
  private readonly ledger: ResourceLedger;
  private readonly essential: ReadonlySet<string>;
  private stage: ResourceStage;
  private lastEmitted?: ResourceSnapshotPayload;

  constructor(profileId: string, opts: BudgetRuntimeOptions = {}) {
    this.policy = opts.policy ?? defaultResourcePolicy(profileId);
    this.enforcement = opts.enforcement ?? 'advisory';
    this.essential = new Set(opts.essentialTools ?? DEFAULT_ESSENTIAL_TOOLS);
    this.stage = opts.stage ?? 'implement';
    this.ledger = new ResourceLedger();
  }

  /**
   * Count one tool call; returns the snapshot to emit when §10.4 says so
   * (first sight, stage/pressure change, reserve crossing, any usage delta).
   */
  noteToolCall(): ResourceSnapshotPayload | null {
    this.ledger.record('tool-call');
    return this.emitIfDue();
  }

  /** §10.4 verification start: stage change (and a zero-cost ledger mark). */
  noteVerificationStart(): ResourceSnapshotPayload | null {
    this.ledger.record('verification', 0);
    return this.setStage('verify');
  }

  /** §10.4 repair start. */
  noteRepairStart(): ResourceSnapshotPayload | null {
    return this.setStage('repair');
  }

  /** Stage transition; emits when the stage actually changes. */
  setStage(stage: ResourceStage): ResourceSnapshotPayload | null {
    if (stage === this.stage) return null;
    this.stage = stage;
    return this.emitIfDue();
  }

  /** Current projection without emitting. */
  current(): ResourceSnapshotPayload {
    return buildResourceSnapshot(this.ledger.budget(this.policy, this.stage), this.policy);
  }

  /** §11.3 gate — advisory mode never blocks; protected mode guards the zone. */
  gateToolCall(toolName: string): ToolGateResult {
    const snapshot = this.current();
    if (!snapshot.reserveProtected) return { allowed: true, advisory: false, snapshot };
    if (this.enforcement === 'advisory') {
      return { allowed: true, advisory: true, reason: ADVISORY_NOTICE, snapshot };
    }
    if (this.essential.has(toolName)) {
      return { allowed: true, advisory: true, reason: ADVISORY_NOTICE, snapshot };
    }
    return { allowed: false, advisory: false, reason: PROTECTED_DENIAL, snapshot };
  }

  /** Resume path (§9.5): rebuild usage from the session log, no emission. */
  adoptLedgerFromEvents(events: readonly SessionEventEnvelope[]): void {
    const rebuilt = rebuildLedgerFromEvents(events);
    this.ledger.resetTo(rebuilt.snapshot());
    this.lastEmitted = undefined;
  }

  /** Latest emitted snapshot (what the model surface shows), if any. */
  latestEmitted(): ResourceSnapshotPayload | undefined {
    return this.lastEmitted;
  }

  private emitIfDue(): ResourceSnapshotPayload | null {
    const next = this.current();
    if (shouldEmitSnapshot(this.lastEmitted, next)) {
      this.lastEmitted = next;
      return next;
    }
    return null;
  }
}
