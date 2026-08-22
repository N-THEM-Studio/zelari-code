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

export const TaskContractSchema = z.object({
  version: z.number().int().positive(),
  goal: z.string().min(1),
  constraints: z.array(TaskConstraintSchema),
  acceptanceCriteria: z.array(TaskCriterionSchema),
  source: z.object({
    /** Seq of the user.message the contract was extracted from. */
    userSeq: z.number().int().positive(),
  }),
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

/** Derive an initial contract from the first user message (heuristic, CLI-side seed). */
export function deriveInitialContract(userSeq: number, text: string): TaskContract {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  // Strip list markers before heuristic matching ("- do not…" → "do not…").
  const stripped = lines.map((l) => l.replace(/^[-*]\s+/, ''));
  const constraintLines = stripped.filter((l) => /^(do not|don't|never|no |non |without changing|keep)/i.test(l));
  const criteriaLines = stripped
    .filter((l) => /^\[?\s*[x ]?\s*\]?\s*/.test(l) === false ? /^(acceptance|verify|test)[:\s]/i.test(l) : true)
    .map((l) => l.replace(/^\[?\s*[x ]?\s*\]?\s*/, '').replace(/^(acceptance|verify|test)[:\s]+/i, ''));
  return TaskContractSchema.parse({
    version: 1,
    goal: lines[0] ?? text.slice(0, 200),
    constraints: constraintLines.map((t, i) => ({
      id: `uc-${i + 1}`,
      text: t,
      source: 'user' as const,
      required: true,
    })),
    acceptanceCriteria: criteriaLines.map((t, i) => ({
      id: `ac-${i + 1}`,
      text: t,
      source: 'user' as const,
      required: true,
    })),
    source: { userSeq },
  });
}
