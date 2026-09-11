/**
 * Ops-knowledge promotion (Cursor-Projects steal, slice 1.1 / 3.2).
 *
 * After a strict completion gate PASSes with deterministic, event-backed
 * evidence, remember a `procedure` candidate in Memory V2 so the next
 * agent can reuse the command that actually passed.
 *
 * Slice 3.2: a REPAIR_REQUIRED / BLOCKED gate records a `failure` node keyed
 * by a stable fingerprint (command + exit code + output digest). Seeing the
 * SAME fingerprint a second time promotes a `constraint` candidate ("stesso
 * fallimento ripetuto") that a human may lint or `/memory promote` by hand —
 * this module never writes AGENTS.md and never emits lint files.
 *
 * Default OFF (`ZELARI_PROMOTE_OPS_KNOWLEDGE`). Never writes AGENTS.md.
 * Never throws to the parent run.
 */
import { createHash } from 'node:crypto';
import type { MemoryNode, MemoryService, RememberInput } from '@zelari/core/memory';
import type { EvidenceRef, VerificationResult } from '@zelari/core/verification';
import type { StrictBuildGateEvaluation } from '../kraken/verificationBridge.js';
import { formatPromoteNotice, meetsPromoteThreshold } from './promotion.js';
import {
  CONSTRAINT_CONFIDENCE,
  CONSTRAINT_IMPORTANCE,
  constraintNodeId,
  failureFingerprint,
  failureNodeId,
  guessExitCode,
  repeatConstraintText,
} from './repeatFailure.js';

export {
  constraintNodeId,
  failureFingerprint,
  failureNodeId,
  repeatConstraintText,
} from './repeatFailure.js';

const ALLOWED_TIERS = new Set<EvidenceRef['tier']>(['command-output', 'fs-observation']);

export function isOpsKnowledgePromotionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.ZELARI_PROMOTE_OPS_KNOWLEDGE?.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on' || v === 'yes';
}

export interface OpsKnowledgeCandidate {
  criterionId: string;
  command: string;
  digest: string;
  seq: number;
  key: string;
  status: 'pass' | 'fail';
}

export interface OpsKnowledgeResult {
  enabled: boolean;
  skippedReason?: string;
  created: number;
  skippedDuplicate: number;
  /** Slice 3.2: constraints created from a fingerprint seen twice. */
  constraintsCreated: number;
  proposals: string[];
}

export interface OpsKnowledgeMemory {
  get(id: string): Promise<MemoryNode | null>;
  remember(input: RememberInput): Promise<MemoryNode>;
}

export function opsKnowledgeKey(command: string, digest: string, criterionId: string): string {
  return createHash('sha256')
    .update(`${command}\0${digest}\0${criterionId}`)
    .digest('hex')
    .slice(0, 24);
}

function pickEligibleEvidence(result: VerificationResult): EvidenceRef | undefined {
  return result.evidence.find(
    (ref) =>
      ALLOWED_TIERS.has(ref.tier) &&
      typeof ref.seq === 'number' &&
      ref.seq > 0 &&
      typeof ref.digest === 'string' &&
      ref.digest.length > 0,
  );
}

function candidatesFromResults(
  results: readonly VerificationResult[],
  status: 'pass' | 'fail',
): OpsKnowledgeCandidate[] {
  const out: OpsKnowledgeCandidate[] = [];
  for (const result of results) {
    if (result.status !== status) continue;
    if (result.source !== 'deterministic-engine') continue;
    const evidence = pickEligibleEvidence(result);
    if (!evidence || evidence.seq === undefined || !evidence.digest) continue;
    const command = evidence.ref.trim();
    if (!command) continue;
    out.push({
      criterionId: result.criterionId,
      command,
      digest: evidence.digest,
      seq: evidence.seq,
      key: opsKnowledgeKey(command, evidence.digest, result.criterionId),
      status,
    });
  }
  return out;
}

/** Pure: PASS + deterministic engine + event-backed command/fs evidence. */
export function extractOpsKnowledgeCandidates(gate: StrictBuildGateEvaluation): OpsKnowledgeCandidate[] {
  if (gate.evaluation?.verdict !== 'PASS') return [];
  if ((gate.anchoring?.noteFallback ?? 0) > 0) return [];
  return candidatesFromResults(gate.results ?? [], 'pass');
}

/** Pure: fail evidence from a blocked/repair gate (for consolidate ×2). */
export function extractOpsFailureCandidates(gate: StrictBuildGateEvaluation): OpsKnowledgeCandidate[] {
  const verdict = gate.evaluation?.verdict;
  if (verdict === 'PASS' || verdict == null) return [];
  if ((gate.anchoring?.noteFallback ?? 0) > 0) return [];
  return candidatesFromResults(gate.results ?? [], 'fail');
}

async function rememberProcedure(
  memory: OpsKnowledgeMemory,
  candidate: OpsKnowledgeCandidate,
  deps: { sessionId?: string },
): Promise<'created' | 'duplicate' | 'error'> {
  const id = `ops-${candidate.key}`;
  try {
    const existing = await memory.get(id);
    if (existing && existing.status === 'active') return 'duplicate';
    await memory.remember({
      id,
      kind: 'procedure',
      content: `${candidate.command} → pass (${candidate.criterionId})`,
      importance: 0.75,
      confidence: 0.9,
      visibility: 'project',
      tags: ['ops-knowledge', 'strict-pass', candidate.criterionId],
      source: {
        agent: 'ops-knowledge',
        sessionId: deps.sessionId,
        verificationId: String(candidate.seq),
      },
      metadata: {
        command: candidate.command,
        digest: candidate.digest,
        criterionId: candidate.criterionId,
        seq: candidate.seq,
        opsKnowledgeKey: candidate.key,
        verified: true,
        writeClass: 'candidate',
      },
      writeClass: 'candidate',
    });
    return 'created';
  } catch {
    return 'error';
  }
}

/** Slice 3.2 outcome: what the failure fingerprint produced on this pass. */
export interface FailureRecallOutcome {
  /** `repeated` = the identical fingerprint was already recorded. */
  failure: 'created' | 'repeated' | 'error';
  constraint: 'created' | 'duplicate' | 'skipped' | 'error';
  fingerprint: string;
  constraintId: string;
}

/**
 * Record ONE failure node per fingerprint; the SECOND sighting of the same
 * fingerprint proposes a `constraint` candidate.
 *
 * The constraint is created here (not by `memory.consolidate`) because the
 * fingerprint is the dedupe key: the second run finds the first node and
 * writes nothing, so consolidation would never see two matching failures.
 * Consolidation stays the consumer — the constraint carries
 * `writeClass: 'candidate'`, and its importance/confidence clear the
 * promotion bar so the same notice channel used for procedures surfaces it.
 */
async function rememberFailure(
  memory: OpsKnowledgeMemory,
  candidate: OpsKnowledgeCandidate,
  deps: { sessionId?: string },
): Promise<FailureRecallOutcome> {
  const exitCode = guessExitCode(candidate.command);
  const fingerprint = failureFingerprint(candidate.command, exitCode, candidate.digest);
  const failureId = failureNodeId(fingerprint);
  const constraintId = constraintNodeId(fingerprint);
  try {
    // Legacy id from slice 1.1 (pre-fingerprint) counts as a first sighting.
    const prior =
      (await memory.get(failureId)) ?? (await memory.get(`fail-${candidate.key}`));
    if (!prior || prior.status !== 'active') {
      await memory.remember({
        id: failureId,
        kind: 'failure',
        content: `${candidate.command} → fail (${candidate.criterionId})`,
        importance: 0.55,
        confidence: 0.9,
        visibility: 'project',
        tags: ['ops-knowledge', 'strict-fail', candidate.criterionId],
        source: {
          agent: 'ops-knowledge',
          sessionId: deps.sessionId,
          verificationId: String(candidate.seq),
        },
        metadata: {
          command: candidate.command,
          digest: candidate.digest,
          criterionId: candidate.criterionId,
          seq: candidate.seq,
          opsKnowledgeKey: candidate.key,
          fingerprint,
          exitCode,
          writeClass: 'candidate',
        },
        writeClass: 'candidate',
      });
      return { failure: 'created', constraint: 'skipped', fingerprint, constraintId };
    }
  } catch {
    return { failure: 'error', constraint: 'skipped', fingerprint, constraintId };
  }
  // Second sighting: propose the constraint (never lint, never AGENTS.md).
  try {
    const existing = await memory.get(constraintId);
    if (existing && existing.status === 'active') {
      return { failure: 'repeated', constraint: 'duplicate', fingerprint, constraintId };
    }
    await memory.remember({
      id: constraintId,
      kind: 'constraint',
      content: repeatConstraintText(candidate.command, exitCode),
      importance: CONSTRAINT_IMPORTANCE,
      confidence: CONSTRAINT_CONFIDENCE,
      visibility: 'project',
      tags: ['ops-knowledge', 'strict-fail', 'repeat-failure', candidate.criterionId],
      source: {
        agent: 'ops-knowledge',
        sessionId: deps.sessionId,
        verificationId: String(candidate.seq),
      },
      metadata: {
        command: candidate.command,
        digest: candidate.digest,
        criterionId: candidate.criterionId,
        seq: candidate.seq,
        opsKnowledgeKey: candidate.key,
        fingerprint,
        exitCode,
        failureNodeId: failureId,
        writeClass: 'candidate',
      },
      writeClass: 'candidate',
    });
    return { failure: 'repeated', constraint: 'created', fingerprint, constraintId };
  } catch {
    return { failure: 'repeated', constraint: 'error', fingerprint, constraintId };
  }
}

export async function promoteOpsKnowledge(
  gate: StrictBuildGateEvaluation,
  deps: {
    projectRoot: string;
    memory?: OpsKnowledgeMemory | null;
    env?: NodeJS.ProcessEnv;
    sessionId?: string;
  },
): Promise<OpsKnowledgeResult> {
  const env = deps.env ?? process.env;
  if (!isOpsKnowledgePromotionEnabled(env)) {
    return emptyResult(false, 'flag-off');
  }
  const pass = extractOpsKnowledgeCandidates(gate);
  const fails = extractOpsFailureCandidates(gate);
  if (pass.length === 0 && fails.length === 0) {
    const reason = gate.evaluation?.verdict === 'PASS' ? 'no-eligible-evidence' : 'not-pass';
    return emptyResult(true, reason);
  }
  const memory = deps.memory ?? (await openMemory(deps.projectRoot, env));
  if (!memory) return emptyResult(true, 'memory-unavailable');

  let created = 0;
  let skippedDuplicate = 0;
  let constraintsCreated = 0;
  const proposals: string[] = [];
  for (const candidate of pass) {
    const outcome = await rememberProcedure(memory, candidate, { sessionId: deps.sessionId });
    if (outcome === 'created') {
      created += 1;
      const node = await memory.get(`ops-${candidate.key}`);
      if (node && meetsPromoteThreshold(node)) proposals.push(formatPromoteNotice(node));
    } else if (outcome === 'duplicate') {
      skippedDuplicate += 1;
    }
  }
  for (const candidate of fails) {
    const outcome = await rememberFailure(memory, candidate, { sessionId: deps.sessionId });
    if (outcome.failure === 'created') created += 1;
    else if (outcome.failure === 'repeated') skippedDuplicate += 1;
    if (outcome.constraint === 'created') {
      created += 1;
      constraintsCreated += 1;
      const node = await memory.get(outcome.constraintId);
      if (node && meetsPromoteThreshold(node)) proposals.push(formatPromoteNotice(node));
    } else if (outcome.constraint === 'duplicate') {
      skippedDuplicate += 1;
    }
  }
  return { enabled: true, created, skippedDuplicate, constraintsCreated, proposals };
}

/** Best-effort wrapper: never rejects. */
export async function promoteOpsKnowledgeSafe(
  gate: StrictBuildGateEvaluation,
  deps: {
    projectRoot: string;
    memory?: OpsKnowledgeMemory | null;
    env?: NodeJS.ProcessEnv;
    sessionId?: string;
  },
): Promise<OpsKnowledgeResult> {
  try {
    return await promoteOpsKnowledge(gate, deps);
  } catch {
    return emptyResult(true, 'error');
  }
}

function emptyResult(enabled: boolean, skippedReason: string): OpsKnowledgeResult {
  return {
    enabled,
    skippedReason,
    created: 0,
    skippedDuplicate: 0,
    constraintsCreated: 0,
    proposals: [],
  };
}

async function openMemory(projectRoot: string, env: NodeJS.ProcessEnv): Promise<MemoryService | null> {
  try {
    const factory = await import('./serviceFactory.js');
    if (!factory.isMemoryV2Enabled(env) && env.ZELARI_MEMORY !== 'force') return null;
    return await factory.getMemoryService(projectRoot, env);
  } catch {
    return null;
  }
}
