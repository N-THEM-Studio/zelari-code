/**
 * session/taskContract.ts — first-class task contract (2.6 Track A, doc §14).
 *
 * Goal + constraints + acceptance criteria extracted from user prose into a
 * versioned, append-only structure (`task.contract` / `task.contract_updated`
 * events). Authority is explicit: user > agent-derived. A derived item may
 * never contradict a user constraint, rewrite the goal, or drop a required
 * user criterion. CompactionStateSnapshot prefers the contract; the legacy
 * regex extraction stays as fallback compatibility.
 */

import { z } from 'zod';

export const TaskConstraintSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  source: z.enum(['user', 'agent-derived']),
  required: z.boolean(),
});
export type TaskConstraint = z.infer<typeof TaskConstraintSchema>;

export const TaskCriterionSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  source: z.enum(['user', 'agent-derived']),
  required: z.boolean(),
  verificationHint: z
    .object({
      kind: z.enum(['command', 'tool', 'semantic', 'manual']),
      value: z.string().optional(),
    })
    .optional(),
});
export type TaskCriterion = z.infer<typeof TaskCriterionSchema>;

/**
 * t22 (§P1.C): optional execution scope for the contract compiler — glob
 * patterns relative to the workspace root (`src/**`, `vendor/**`). BOTH
 * arrays optional; an absent `scope` means "no compiled capability layer"
 * (exactly today's behavior), so old spines replay unchanged.
 */
export const TaskContractScopeSchema = z.object({
  allowedPaths: z.array(z.string().min(1)).optional(),
  forbiddenPaths: z.array(z.string().min(1)).optional(),
});
export type TaskContractScope = z.infer<typeof TaskContractScopeSchema>;

/** Risk taxonomy carried verbatim from user intent (descriptive metadata). */
export const TASK_RISKS = ['low', 'medium', 'high', 'critical'] as const;
export type TaskRisk = (typeof TASK_RISKS)[number];

export const TaskContractSchema = z.object({
  version: z.number().int().positive(),
  goal: z.string().min(1),
  constraints: z.array(TaskConstraintSchema),
  acceptanceCriteria: z.array(TaskCriterionSchema),
  source: z.object({
    /** Seq of the user.message the contract was extracted from. */
    userSeq: z.number().int().positive(),
  }),
  /** Optional compile-time scope (contractCompiler → policy layer). */
  scope: TaskContractScopeSchema.optional(),
  /** Optional declared task risk (metadata; digest-relevant like everything). */
  risk: z.enum(TASK_RISKS).optional(),
});
export type TaskContract = z.infer<typeof TaskContractSchema>;

/** Merge rules: monotone version, user authority, no required-item loss. */
export interface TaskContractUpdate {
  goal?: string;
  addConstraints?: TaskConstraint[];
  addCriteria?: TaskCriterion[];
  /** Ids the AGENT wants to drop — user-sourced/required items survive. */
  removeConstraintIds?: string[];
  removeCriterionIds?: string[];
  nextUserSeq?: number;
}

export class TaskContractConflictError extends Error {
  readonly code = 'TASK_CONTRACT_CONFLICT';
  constructor(readonly reason: string) {
    super(`task contract update rejected: ${reason}`);
    this.name = 'TaskContractConflictError';
  }
}

/** Apply an update under the authority rules (doc §14.3). Pure. */
export function applyTaskContractUpdate(
  contract: TaskContract,
  update: TaskContractUpdate,
): TaskContract {
  if (update.goal !== undefined && update.goal !== contract.goal) {
    // Goal changes only when the update itself is user-driven (nextUserSeq
    // present = a new user message authorized the rewrite).
    if (update.nextUserSeq === undefined) {
      throw new TaskContractConflictError('agent-derived update may not rewrite the goal');
    }
  }
  const constraints = contract.constraints.filter((c) => {
    if (!update.removeConstraintIds?.includes(c.id)) return true;
    if (c.source === 'user' && c.required) {
      throw new TaskContractConflictError(`required user constraint "${c.id}" cannot be removed`);
    }
    return false;
  });
  const criteria = contract.acceptanceCriteria.filter((c) => {
    if (!update.removeCriterionIds?.includes(c.id)) return true;
    if (c.source === 'user' && c.required) {
      throw new TaskContractConflictError(`required user criterion "${c.id}" cannot be removed`);
    }
    return false;
  });
  for (const add of update.addConstraints ?? []) {
    if (constraints.some((c) => c.id === add.id) || (update.addConstraints ?? []).filter((x) => x.id === add.id).length > 1) {
      throw new TaskContractConflictError(`duplicate constraint id "${add.id}"`);
    }
  }
  for (const add of update.addCriteria ?? []) {
    if (criteria.some((c) => c.id === add.id) || (update.addCriteria ?? []).filter((x) => x.id === add.id).length > 1) {
      throw new TaskContractConflictError(`duplicate criterion id "${add.id}"`);
    }
  }
  return TaskContractSchema.parse({
    version: contract.version + 1,
    goal: update.goal ?? contract.goal,
    constraints: [...constraints, ...(update.addConstraints ?? [])],
    acceptanceCriteria: [...criteria, ...(update.addCriteria ?? [])],
    source: {
      userSeq: update.nextUserSeq ?? contract.source.userSeq,
    },
    // t22: scope/risk have no update path yet (user-authored only) but MUST
    // survive a steer intact — a dropped scope would silently disarm the
    // compiled capability layer at version 2. Absent stays absent (replay-safe).
    ...(contract.scope ? { scope: contract.scope } : {}),
    ...(contract.risk !== undefined ? { risk: contract.risk } : {}),
  });
}

/** Project the contract onto the compaction state shape (§14.5). */
export function contractToCompactionFields(contract: TaskContract): {
  userConstraints: string[];
  activeCriteria: Array<{ id: string; required: boolean }>;
  goal: string;
} {
  return {
    goal: contract.goal,
    userConstraints: contract.constraints.filter((c) => c.source === 'user' && c.required).map((c) => c.text),
    activeCriteria: contract.acceptanceCriteria.map((c) => ({ id: c.id, required: c.required })),
  };
}

/**
 * Derive an initial contract from the first user message (heuristic, CLI-side seed).
 *
 * 2.6.1 parser fix (closure plan §3): a line becomes an acceptance criterion
 * ONLY when it carries an explicit marker — a checkbox (`- [ ]` / `- [x]`,
 * with or without the list dash) or a keyword lead-in (`Acceptance:`,
 * `Criterion:`, `Verify:`, `Test:`, `Success:` with an explicit `:`/`#`
 * separator). Prose without markers NEVER produces criteria (no more false
 * criteria from arbitrary lines); normative lines stay constraints.
 */
const CHECKBOX_CRITERION = /^\[([ xX])\]\s*(.+)$/;
const KEYWORD_CRITERION = /^(acceptance|criterion|criteria|verify|test|success)\s*[:#]\s*(.+)$/i;
/** Command-looking values on Verify:/Test: lines become a command hint. */
const COMMAND_HINT = /^(npm|pnpm|yarn|bun|npx|node|vitest|jest|tsc|eslint|prettier|git)\b/;
const CONSTRAINT_LEAD = /^(do not|don't|never|no\s|non\s|without changing|keep|must not|avoid)\b/i;

export function deriveInitialContract(userSeq: number, text: string): TaskContract {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  // Strip list markers before heuristic matching ("- do not…" → "do not…").
  const stripped = lines.map((l) => l.replace(/^[-*]\s+/, ''));

  const acceptanceCriteria: TaskCriterion[] = [];
  const criterionLines = new Set<number>();
  stripped.forEach((line, i) => {
    const checkbox = CHECKBOX_CRITERION.exec(line);
    if (checkbox) {
      criterionLines.add(i);
      acceptanceCriteria.push({
        id: `ac-${acceptanceCriteria.length + 1}`,
        text: checkbox[2]!.trim(),
        source: 'user' as const,
        required: true,
      });
      return;
    }
    const keyword = KEYWORD_CRITERION.exec(line);
    if (keyword) {
      criterionLines.add(i);
      const value = keyword[2]!.trim();
      const lead = keyword[1]!.toLowerCase();
      const hint =
        (lead === 'verify' || lead === 'test') && COMMAND_HINT.test(value)
          ? { kind: 'command' as const, value }
          : undefined;
      acceptanceCriteria.push({
        id: `ac-${acceptanceCriteria.length + 1}`,
        text: value,
        source: 'user' as const,
        required: true,
        ...(hint ? { verificationHint: hint } : {}),
      });
    }
  });

  const isConstraint = (i: number): boolean =>
    !criterionLines.has(i) && CONSTRAINT_LEAD.test(stripped[i] ?? '');
  const constraints = stripped
    .map((text, i) => ({ text, i }))
    .filter(({ i }) => isConstraint(i))
    .map(({ text }, i) => ({
      id: `uc-${i + 1}`,
      text,
      source: 'user' as const,
      required: true,
    }));

  // Goal: the first line that is neither a criterion nor a constraint.
  const goalIdx = lines.findIndex((_, i) => !criterionLines.has(i) && !isConstraint(i));
  const goal = goalIdx >= 0 ? lines[goalIdx]! : (lines[0] ?? text.slice(0, 200));

  return TaskContractSchema.parse({
    version: 1,
    goal,
    constraints,
    acceptanceCriteria,
    source: { userSeq },
  });
}
