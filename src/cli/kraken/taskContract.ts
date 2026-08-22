/**
 * src/cli/kraken/taskContract.ts — seeds and updates the first-class task
 * contract on the spine (2.6 Track A, doc §14). The first user.message of a
 * session derives the initial contract; later user steers produce versioned
 * updates. All authority rules live in @zelari/core (session/taskContract).
 */

import { applyTaskContractUpdate, deriveInitialContract, type TaskContract, type TaskContractUpdate } from '@zelari/core';
import type { SessionEventEnvelope } from '@zelari/core';

/** Latest contract from the log (undefined when the session has none). */
export function latestTaskContract(events: readonly SessionEventEnvelope[]): TaskContract | undefined {
  let latest: TaskContract | undefined;
  for (const e of events) {
    if (e.kind !== 'task.contract' && e.kind !== 'task.contract_updated') continue;
    const raw = e.data.contract;
    if (raw && typeof raw === 'object') {
      const candidate = raw as TaskContract;
      if (!latest || candidate.version > latest.version) latest = candidate;
    }
  }
  return latest;
}

/**
 * Bootstrap the contract at session start: derive from the first user
 * message. Returns undefined when no user message exists yet.
 */
export function seedTaskContract(events: readonly SessionEventEnvelope[]): TaskContract | undefined {
  const existing = latestTaskContract(events);
  if (existing) return existing;
  const firstUser = events.find((e) => e.kind === 'user.message');
  if (!firstUser || typeof firstUser.data.text !== 'string') return undefined;
  return deriveInitialContract(firstUser.seq, firstUser.data.text);
}

/** Apply a steer/update under the authority rules; throws on conflicts. */
export function updateTaskContract(contract: TaskContract, update: TaskContractUpdate): TaskContract {
  return applyTaskContractUpdate(contract, update);
}

/** Event payloads (append-only, monotone version). */
export function contractEventData(contract: TaskContract, updated: boolean): Record<string, unknown> {
  return { contract, kind: updated ? 'task.contract_updated' : 'task.contract' };
}
