/**
 * K1.2 / F2 — graph unresolved findings as strict-gate criteria.
 *
 * A writer FAIL (or unknown trailer) after rework budget becomes an
 * unsatisfied required criterion — same weight as a failed check. The
 * composition can only ADD this blocker; it never rescues a green
 * selection/pack.
 */
import type { UnresolvedFinding } from '@zelari/core';
import type { Criterion, VerificationResult } from '@zelari/core/verification';

export interface UnresolvedContract {
  criteria: Criterion[];
  results: VerificationResult[];
  nodeIds: string[];
}

export function unresolvedFindingsToContract(
  findings: readonly UnresolvedFinding[],
  now: number = Date.now(),
): UnresolvedContract {
  const criteria: Criterion[] = [];
  const results: VerificationResult[] = [];
  const nodeIds: string[] = [];
  for (const u of findings) {
    const id = `unresolved-${u.nodeId}`;
    nodeIds.push(u.nodeId);
    criteria.push({
      id,
      text: `graph node ${u.nodeId} (${u.label}) left unresolved`,
      source: 'task',
      required: true,
      check: { kind: 'none', reason: `unresolved verify: ${u.reason}` },
    });
    results.push({
      criterionId: id,
      status: u.reason === 'fail' ? 'fail' : 'unknown',
      source: 'verify-agent',
      evidence: [],
      evaluatedAt: now,
      durationMs: 0,
      detail: u.findings || `node ${u.nodeId} unresolved (${u.reason})`,
    });
  }
  return { criteria, results, nodeIds };
}

export function formatUnresolvedNodeIds(nodeIds: readonly string[]): string {
  if (nodeIds.length === 0) return '';
  return `unresolved nodes: ${nodeIds.join(', ')}`;
}
