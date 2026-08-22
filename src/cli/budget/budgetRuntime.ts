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
 * 2.6.1 (closure plan §9/§13):
 *   - maxToolCalls is a HARD limit: once remaining hits 0 every further
 *     billable call is denied (both enforcement modes) and the overrun is
 *     projected (`used` never clamped; `resource.limit_reached` /
 *     `resource.overrun` events land on the spine);
 *   - the verification gate is ARGUMENT-AWARE: an essential `bash` is a
 *     test/typecheck/build/git-diff command, not any shell line.
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
 * `bash` is NOT blanket-essential (2.6.1 §13) — see isVerificationEssential.
 */
const DEFAULT_ESSENTIAL_TOOLS: readonly string[] = [
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

const HARD_LIMIT_DENIAL =
  'Resource exhausted: the session tool budget (maxToolCalls) is spent. No further billable tool calls are allowed — summarize what was verified and report BLOCKED/resource-exhausted with the evidence already collected.';

/** bash commands that count as verification-essential (plan §13). */
const ESSENTIAL_BASH = [
  /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(test|vitest|jest)\b/,
  /\b(npm|pnpm|yarn|bun)\s+run\s+[\w:-]*(typecheck|lint|build)\b/,
  /\bnpx\s+(vitest|tsc|typescript|eslint)\b/,
  /\b(npx\s+)?tsc\b/,
  /\bvitest\b/,
  /\bjest\b/,
  /\bnode\s+--run\b/,
  /\bgit\s+(diff|status|log|show)\b/,
];

/** Phase selector — advisory by default (§11.4), protected via env (Phase 3). */
export function resolveResourceEnforcement(env: NodeJS.ProcessEnv = process.env): ResourceEnforcement {
  return env.ZELARI_RESOURCE_ENFORCEMENT === 'protected' ? 'protected' : 'advisory';
}

/** Extract the command string from a bash-ish tool args payload. */
function bashCommand(args: unknown): string {
  if (!args || typeof args !== 'object') return '';
  const rec = args as Record<string, unknown>;
  for (const key of ['command', 'cmd', 'script']) {
    if (typeof rec[key] === 'string') return rec[key] as string;
  }
  return '';
}

/**
 * 2.6.1 (plan §13): argument-aware essential classifier.
 * Essential = test/typecheck/build/lint, git diff/status, targeted
 * read/grep/repair. NOT essential = arbitrary bash, repo-wide speculative
 * grep, dependency install, delegation.
 */
export function isVerificationEssential(
  toolName: string,
  args: unknown,
  _stage: ResourceStage = 'implement',
): boolean {
  if (toolName === 'bash') {
    const cmd = bashCommand(args);
    if (!cmd) return false;
    return ESSENTIAL_BASH.some((re) => re.test(cmd));
  }
  if (toolName === 'grep_content') {
    // Targeted grep: bounded by an explicit path/pattern scope is essential;
    // a bare repo-wide sweep is not (plan §13 "repo-wide speculative grep").
    if (!args || typeof args !== 'object') return true;
    const rec = args as Record<string, unknown>;
    const hasScope = typeof rec.path === 'string' && rec.path !== '.' && rec.path !== './';
    return hasScope || typeof rec.pattern === 'string';
  }
  return DEFAULT_ESSENTIAL_TOOLS.includes(toolName);
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
  /** 2.6.1 §9: the denial came from the HARD limit, not the reserve zone. */
  hardLimit?: boolean;
}

/** Gate input: name + args (+ stage) — plan §13 seam. */
export interface ToolCallGateInput {
  toolName: string;
  args?: unknown;
  stage?: ResourceStage;
}

/** State-only hard-limit event appended next to its tool.call (plan §9). */
export interface HardLimitEvent {
  kind: 'resource.limit_reached' | 'resource.overrun';
  data: Record<string, unknown>;
}

export interface ToolCallBudgetEffect {
  snapshot: ResourceSnapshotPayload | null;
  hardEvent: HardLimitEvent | null;
}

export class BudgetRuntime {
  readonly policy: ResourcePolicy;
  readonly enforcement: ResourceEnforcement;
  private readonly ledger: ResourceLedger;
  private readonly essential: ReadonlySet<string>;
  private stage: ResourceStage;
  private lastEmitted?: ResourceSnapshotPayload;
  private hardLimitAnnounced = false;

  constructor(profileId: string, opts: BudgetRuntimeOptions = {}) {
    const basePolicy = opts.policy ?? defaultResourcePolicy(profileId);
    // 2.6.1 (plan §8): ZELARI_MAX_TOOL_CALLS is a CONFIG ALIAS for the session
    // ResourcePolicy.maxToolCalls — NOT a second independent limit. Setting it
    // rewrites the single session budget (and its manifest hash); every cap,
    // gate and snapshot derives from that one number.
    const envCap = Number.parseInt(process.env.ZELARI_MAX_TOOL_CALLS ?? '', 10);
    this.policy =
      Number.isFinite(envCap) && envCap >= 1 ? { ...basePolicy, maxToolCalls: envCap } : basePolicy;
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
    return this.consumeToolCall().snapshot;
  }

  /**
   * 2.6.1 (plan §9): count one tool call AND surface the hard-limit event
   * due on this call — `resource.limit_reached` once at the crossing,
   * `resource.overrun` for every call past the limit. The spine appends the
   * event right after its tool.call.
   */
  consumeToolCall(): ToolCallBudgetEffect {
    this.ledger.record('tool-call');
    const next = this.current();
    let hardEvent: HardLimitEvent | null = null;
    const data = { used: next.toolCallsUsed, limit: next.toolCallsLimit, overrun: next.overrun };
    if (!this.hardLimitAnnounced && next.toolCallsRemaining <= 0) {
      this.hardLimitAnnounced = true;
      hardEvent = { kind: 'resource.limit_reached', data };
    } else if (next.overrun > 0) {
      hardEvent = { kind: 'resource.overrun', data };
    }
    const snapshot = shouldEmitSnapshot(this.lastEmitted, next) ? ((this.lastEmitted = next), next) : null;
    return { snapshot, hardEvent };
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

  /** 2.6.1 (plan §14): canonical budget for the reserve gate. */
  budgetSnapshot(): import('@zelari/core').ResourceBudget {
    return this.ledger.budget(this.policy, this.stage);
  }

  /** Current projection without emitting. */
  current(): ResourceSnapshotPayload {
    return buildResourceSnapshot(this.ledger.budget(this.policy, this.stage), this.policy);
  }

  /**
   * §11.3 gate — argument-aware (2.6.1 §13). Hard limit denies first in BOTH
   * modes; advisory mode never blocks inside the protected zone; protected
   * mode guards the zone with isVerificationEssential(tool, args).
   */
  gateToolCall(toolNameOrInput: string | ToolCallGateInput): ToolGateResult {
    const input: ToolCallGateInput =
      typeof toolNameOrInput === 'string' ? { toolName: toolNameOrInput } : toolNameOrInput;
    const snapshot = this.current();
    // §9 hard limit: no new billable call once remaining is 0 — even
    // essential ones (verification had the reserve to happen in).
    if (snapshot.toolCallsRemaining <= 0) {
      return { allowed: false, advisory: false, reason: HARD_LIMIT_DENIAL, snapshot, hardLimit: true };
    }
    if (!snapshot.reserveProtected) return { allowed: true, advisory: false, snapshot };
    if (this.enforcement === 'advisory') {
      return { allowed: true, advisory: true, reason: ADVISORY_NOTICE, snapshot };
    }
    const essential =
      input.toolName === 'bash' || input.toolName === 'grep_content'
        ? isVerificationEssential(input.toolName, input.args, input.stage ?? this.stage)
        : this.essential.has(input.toolName);
    if (essential) {
      return { allowed: true, advisory: true, reason: ADVISORY_NOTICE, snapshot };
    }
    return { allowed: false, advisory: false, reason: PROTECTED_DENIAL, snapshot };
  }

  /** Resume path (§9.5): rebuild usage from the session log, no emission. */
  adoptLedgerFromEvents(events: readonly SessionEventEnvelope[]): void {
    const rebuilt = rebuildLedgerFromEvents(events);
    this.ledger.resetTo(rebuilt.snapshot());
    this.lastEmitted = undefined;
    const now = this.current();
    this.hardLimitAnnounced = now.toolCallsRemaining <= 0;
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
