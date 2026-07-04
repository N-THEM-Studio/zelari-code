import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveWorkspaceRoot } from './paths.js';

/** True when the workspace has a non-empty plan in plan.json. */
export function hasWorkspacePlan(projectRoot: string = process.cwd()): boolean {
  const planPath = join(resolveWorkspaceRoot(projectRoot), 'plan.json');
  if (!existsSync(planPath)) return false;
  try {
    const parsed = JSON.parse(readFileSync(planPath, 'utf8')) as { phases?: unknown[] };
    return Array.isArray(parsed.phases) && parsed.phases.length > 0;
  } catch {
    return false;
  }
}
