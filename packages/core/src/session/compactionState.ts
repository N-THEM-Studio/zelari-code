/**
 * Deterministic state retained across durable session compaction.
 *
 * This metadata is derived from the append-only prefix before narrative
 * summarization, so criteria, failures, evidence and mission state do not
 * depend on a lossy prose summary.
 */

import type { SessionEventEnvelope } from './types.js';

function asPositiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

export interface CompactionCriterionRef {
  id: string;
  required: boolean;
  status?: string;
}

export interface CompactionIssueRef {
  id: string;
  status: string;
  reason?: string;
}

export interface RetainedEvidenceRef {
  seq?: number;
  tier?: string;
  ref?: string;
  digest?: string;
  capturedAt?: number;
}

export interface CompactionStateSnapshot {
  version: 1;
  activeCriteria: CompactionCriterionRef[];
  unresolvedIssues: CompactionIssueRef[];
  latestVerification?: {
    seq: number;
    verdict?: string;
    summary?: string;
  };
  retainedEvidenceRefs: RetainedEvidenceRef[];
  affectedFiles: string[];
  userConstraints: string[];
  missionState?: {
    phase?: string;
    recommendation?: string;
    blockers?: string[];
  };
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function recordsOf(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.map(recordOf).filter((v): v is Record<string, unknown> => v !== undefined)
    : [];
}

function stringsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function addBounded(target: Set<string>, value: string, maxLength = 260): void {
  const normalized = value.trim().replace(/\\/g, '/');
  if (normalized && normalized.length <= maxLength) target.add(normalized);
}

function collectPaths(value: unknown, target: Set<string>, depth = 0): void {
  if (depth > 4 || value === null || value === undefined) return;
  if (Array.isArray(value)) {
    for (const item of value) collectPaths(item, target, depth + 1);
    return;
  }
  const record = recordOf(value);
  if (record) {
    for (const [key, item] of Object.entries(record)) {
      if (
        typeof item === 'string' &&
        ['path', 'file', 'filepath', 'filePath', 'file_path', 'target', 'cwd'].includes(key)
      ) {
        addBounded(target, item);
      } else {
        collectPaths(item, target, depth + 1);
      }
    }
    return;
  }
  if (typeof value !== 'string') return;
  const pathLike = /(?:^|[\s"'])((?:[\w.@-]+[\\/])+[\w.@-]+\.[A-Za-z0-9]{1,10})/g;
  let match: RegExpExecArray | null;
  while ((match = pathLike.exec(value)) !== null && target.size < 64) {
    addBounded(target, match[1]!);
  }
}

function evidenceFromResults(results: readonly Record<string, unknown>[]): RetainedEvidenceRef[] {
  const seen = new Set<string>();
  const out: RetainedEvidenceRef[] = [];
  for (const result of results) {
    for (const raw of recordsOf(result.evidence)) {
      const seq = asPositiveInt(raw.seq);
      const tier = typeof raw.tier === 'string' ? raw.tier : undefined;
      const ref = typeof raw.ref === 'string' ? raw.ref : undefined;
      const digest = typeof raw.digest === 'string' ? raw.digest : undefined;
      const capturedAt =
        typeof raw.capturedAt === 'number' && Number.isInteger(raw.capturedAt)
          ? raw.capturedAt
          : undefined;
      if (seq === undefined && tier === undefined && ref === undefined && digest === undefined) continue;
      const key = [seq ?? '', tier ?? '', ref ?? '', digest ?? ''].join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        ...(seq !== undefined ? { seq } : {}),
        ...(tier !== undefined ? { tier } : {}),
        ...(ref !== undefined ? { ref } : {}),
        ...(digest !== undefined ? { digest } : {}),
        ...(capturedAt !== undefined ? { capturedAt } : {}),
      });
    }
  }
  return out;
}

const CONSTRAINT_RE =
  /\b(must|never|required|only|do not|don't|constraint|vincolo|deve|devono|non\s+deve|senza)\b/i;

/**
 * Deterministic state retained beside the narrative checkpoint. Only events
 * inside the compacted prefix contribute; later events remain visible raw.
 */
export function buildCompactionStateSnapshot(
  events: readonly SessionEventEnvelope[],
  toSeq: number,
): CompactionStateSnapshot {
  const scoped = events.filter((event) => event.seq <= toSeq);
  const latestVerification = [...scoped].reverse().find((event) => event.kind === 'verification.run');
  const verificationData = latestVerification?.data ?? {};
  const native = recordOf(verificationData.native);
  const results = recordsOf(native?.results ?? verificationData.results);
  const criteriaRaw = recordsOf(native?.criteria ?? verificationData.criteria);
  const statusById = new Map(
    results
      .filter((result) => typeof result.criterionId === 'string')
      .map((result) => [String(result.criterionId), String(result.status ?? 'unknown')]),
  );
  const evidenceState = recordOf(verificationData.evidence);
  const satisfied = stringsOf(evidenceState?.satisfied);
  const unsatisfiedRaw = recordsOf(evidenceState?.unsatisfied);

  const activeCriteria: CompactionCriterionRef[] = criteriaRaw
    .filter((criterion) => typeof criterion.id === 'string')
    .map((criterion) => ({
      id: String(criterion.id),
      required: criterion.required !== false,
      ...(statusById.has(String(criterion.id))
        ? { status: statusById.get(String(criterion.id)) }
        : {}),
    }));
  if (activeCriteria.length === 0) {
    const ids = new Set([
      ...results.map((result) => String(result.criterionId ?? '')).filter(Boolean),
      ...satisfied,
      ...unsatisfiedRaw.map((issue) => String(issue.id ?? '')).filter(Boolean),
    ]);
    for (const id of ids) {
      activeCriteria.push({
        id,
        required: true,
        status: statusById.get(id) ?? (satisfied.includes(id) ? 'pass' : 'unknown'),
      });
    }
  }

  const unresolvedIssues: CompactionIssueRef[] =
    unsatisfiedRaw.length > 0
      ? unsatisfiedRaw
          .filter((issue) => typeof issue.id === 'string')
          .map((issue) => ({
            id: String(issue.id),
            status: String(issue.status ?? 'unknown'),
            ...(typeof issue.reason === 'string' ? { reason: issue.reason } : {}),
          }))
      : results
          .filter((result) => String(result.status ?? 'unknown') !== 'pass')
          .map((result) => ({
            id: String(result.criterionId ?? 'unknown'),
            status: String(result.status ?? 'unknown'),
            ...(typeof result.detail === 'string' ? { reason: result.detail } : {}),
          }));

  const affectedFiles = new Set<string>();
  for (const event of scoped.slice(-500)) {
    if (event.kind === 'tool.call' || event.kind === 'tool.result' || event.kind === 'verification.evidence') {
      collectPaths(event.data, affectedFiles);
    }
  }

  const userConstraints = new Set<string>();
  for (const event of scoped) {
    if (event.kind !== 'user.message') continue;
    for (const constraint of stringsOf(event.data.constraints ?? event.data.userConstraints)) {
      addBounded(userConstraints, constraint, 320);
    }
    const messageText = typeof event.data.text === 'string' ? event.data.text : '';
    for (const line of messageText.split(/\r?\n/)) {
      if (CONSTRAINT_RE.test(line)) addBounded(userConstraints, line, 320);
      if (userConstraints.size >= 12) break;
    }
  }

  const lastMissionPhase = [...scoped].reverse().find((event) => event.kind === 'mission.phase');
  const lastMissionAdvice = [...scoped].reverse().find((event) => event.kind === 'mission.progress');
  const missionState =
    lastMissionPhase || lastMissionAdvice
      ? {
          ...(typeof lastMissionPhase?.data.phase === 'string'
            ? { phase: lastMissionPhase.data.phase }
            : {}),
          ...(typeof lastMissionAdvice?.data.recommendation === 'string'
            ? { recommendation: lastMissionAdvice.data.recommendation }
            : {}),
          ...(stringsOf(lastMissionAdvice?.data.blockers).length > 0
            ? { blockers: stringsOf(lastMissionAdvice?.data.blockers) }
            : {}),
        }
      : undefined;

  // 2.6 (doc section 14.5): prefer the first-class TaskContract when the
  // session carries one; the regex extraction above stays as fallback.
  const latestContractEvent = [...scoped]
    .reverse()
    .find((event) => event.kind === 'task.contract' || event.kind === 'task.contract_updated');
  const contractRaw =
    latestContractEvent && typeof latestContractEvent.data.contract === 'object'
      ? (latestContractEvent.data.contract as {
          goal?: unknown;
          constraints?: unknown;
          acceptanceCriteria?: unknown;
        })
      : undefined;
  const contractConstraints =
    Array.isArray(contractRaw?.constraints)
      ? (contractRaw!.constraints as Array<{ text?: unknown; source?: unknown; required?: unknown }>)
          .filter((c) => c.source === 'user' && c.required === true && typeof c.text === 'string')
          .map((c) => String(c.text))
      : undefined;
  const contractCriteria =
    Array.isArray(contractRaw?.acceptanceCriteria)
      ? (contractRaw!.acceptanceCriteria as Array<{ id?: unknown; required?: unknown }>)
          .filter((c) => typeof c.id === 'string')
          .map((c) => ({ id: String(c.id), required: c.required === true }))
      : undefined;
  return {
    version: 1,
    activeCriteria: contractCriteria ?? activeCriteria,
    unresolvedIssues,
    ...(latestVerification
      ? {
          latestVerification: {
            seq: latestVerification.seq,
            ...(typeof verificationData.verdict === 'string'
              ? { verdict: verificationData.verdict }
              : {}),
            ...(typeof verificationData.summary === 'string'
              ? { summary: verificationData.summary }
              : {}),
          },
        }
      : {}),
    retainedEvidenceRefs: evidenceFromResults(results),
    affectedFiles: [...affectedFiles].slice(0, 64),
    userConstraints: contractConstraints ?? [...userConstraints].slice(-12),
    ...(missionState ? { missionState } : {}),
  };
}

export function formatCompactionStateSnapshot(snapshot: CompactionStateSnapshot): string {
  const lines = ['<compaction-state version="1">'];
  if (snapshot.activeCriteria.length > 0) {
    lines.push('activeCriteria: ' + JSON.stringify(snapshot.activeCriteria));
  }
  if (snapshot.unresolvedIssues.length > 0) {
    lines.push('unresolvedIssues: ' + JSON.stringify(snapshot.unresolvedIssues));
  }
  if (snapshot.latestVerification) {
    lines.push('latestVerification: ' + JSON.stringify(snapshot.latestVerification));
  }
  if (snapshot.affectedFiles.length > 0) {
    lines.push('affectedFiles: ' + JSON.stringify(snapshot.affectedFiles));
  }
  if (snapshot.userConstraints.length > 0) {
    lines.push('userConstraints: ' + JSON.stringify(snapshot.userConstraints));
  }
  if (snapshot.missionState) {
    lines.push('missionState: ' + JSON.stringify(snapshot.missionState));
  }
  lines.push('</compaction-state>');
  return lines.join('\n');
}
