/**
 * automations/gardenerMigration.ts — F0 back-compat (ADR-0037 §1).
 *
 * Before F1 the only automation was the hard-coded Gardener job. On first
 * contact we materialize it as an AutomationSpec so the registry is the single
 * source of truth. Contract:
 *   - create ONLY when `gardener` is absent;
 *   - NEVER overwrite an existing spec (hand edits win);
 *   - NEVER throw — callers get a status object instead.
 *
 * Desktop-side legacy prefs are intentionally ignored in F1: defaults suffice.
 */
import { getAutomation, upsertAutomation } from './registry.js';
import { RESERVED_AUTOMATION_ID, type AutomationSpec } from './types.js';

/** Outcome of a migration attempt (never throws). */
export interface GardenerMigrationStatus {
  /** true when the spec was written this call; false when it already existed. */
  created: boolean;
  /** Present only when an unexpected error was swallowed. */
  error?: string;
}

/** Ensure a `gardener` spec exists. Idempotent and non-destructive. */
export async function ensureGardenerSpec(root: string): Promise<GardenerMigrationStatus> {
  try {
    const existing = await getAutomation(root, RESERVED_AUTOMATION_ID);
    if (existing) return { created: false };
    const spec: AutomationSpec = {
      id: RESERVED_AUTOMATION_ID,
      name: 'Gardener',
      enabled: false,
      kind: 'gardener',
      schedule: { intervalMin: 1440, timezone: 'Europe/Rome' },
      budget: { maxCostUsd: 1 },
    };
    await upsertAutomation(root, spec);
    return { created: true };
  } catch (err) {
    return { created: false, error: err instanceof Error ? err.message : String(err) };
  }
}
