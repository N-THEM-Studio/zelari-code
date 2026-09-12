import { describe, expect, it } from 'vitest';
import type { MemoryNode } from '@zelari/core/memory';
import {
  PLACEHOLDER_COMMAND,
  checkConfirmationHint,
  checkIdForFingerprint,
  confirmCheck,
  constraintFromNode,
  formatCheckProposalNotice,
  pickFixProcedure,
  proposalFromConstraint,
} from './repeatCheck.js';
import { failureFingerprint } from './repeatFailure.js';

const FAIL_COMMAND = 'npm test → exit 1';
const DIGEST = 'deadbeef';
const FP = failureFingerprint(FAIL_COMMAND, 1, DIGEST);

function node(overrides: Partial<MemoryNode> = {}): MemoryNode {
  return {
    id: 'mem-1',
    schemaVersion: 1,
    projectId: 'p',
    kind: 'constraint',
    content: 'Stesso fallimento ripetuto: npm test exit 1.',
    importance: 0.72,
    confidence: 0.85,
    status: 'active',
    tags: [],
    source: {},
    createdAt: 't',
    updatedAt: 't',
    recordedAt: 't',
    metadata: {},
    ...overrides,
  };
}

function constraintNode(overrides: Partial<MemoryNode> = {}): MemoryNode {
  return node({
    id: checkIdForFingerprint(FP),
    metadata: {
      fingerprint: FP,
      command: FAIL_COMMAND,
      digest: DIGEST,
      exitCode: 1,
      criterionId: 'tests',
      writeClass: 'candidate',
    },
    ...overrides,
  });
}

function procedureNode(overrides: Partial<MemoryNode> = {}): MemoryNode {
  return node({
    id: 'ops-abc',
    kind: 'procedure',
    content: 'npm test -- --runInBand → pass (tests)',
    importance: 0.75,
    confidence: 0.9,
    metadata: {
      command: 'npm test -- --runInBand',
      digest: DIGEST,
      criterionId: 'tests',
      opsKnowledgeKey: 'abc',
      verified: true,
    },
    ...overrides,
  });
}

describe('constraintFromNode', () => {
  it('reads fingerprint, command, digest, exit and criterion', () => {
    expect(constraintFromNode(constraintNode())).toEqual({
      fingerprint: FP,
      command: FAIL_COMMAND,
      digest: DIGEST,
      exitCode: 1,
      criterionId: 'tests',
    });
  });

  it('is null for a node that is not a repeat-failure constraint', () => {
    expect(constraintFromNode(null)).toBeNull();
    expect(constraintFromNode(undefined)).toBeNull();
    expect(constraintFromNode(procedureNode())).toBeNull();
    expect(
      constraintFromNode(node({ metadata: { fingerprint: FP, command: FAIL_COMMAND } })),
    ).toBeNull();
  });

  it('falls back to the exit code carried by the evidence label', () => {
    const parsed = constraintFromNode(
      node({
        metadata: {
          fingerprint: FP,
          command: 'npm test → exit 2',
          digest: DIGEST,
        },
      }),
    );
    expect(parsed?.exitCode).toBe(2);
  });
});

describe('proposalFromConstraint', () => {
  it('suggests an un-edited template, never a re-run of the failing command', () => {
    const proposal = proposalFromConstraint(constraintFromNode(constraintNode())!);

    expect(proposal.checkId).toBe(`con-${FP}`);
    expect(proposal.fp).toBe(FP);
    expect(proposal.exit).toBe(1);
    expect(proposal.digest).toBe(DIGEST);
    expect(proposal.derivedFromProcedure).toBe(false);
    expect(proposal.suggestedCheck).toEqual({
      id: `con-${FP}`,
      command: PLACEHOLDER_COMMAND,
      expectExit: 0,
    });
    // The hard rule: the failed command is never proposed as the check.
    expect(proposal.suggestedCheck.command).not.toBe(proposal.command);
  });

  it('derives the command from a verified procedure for the same digest', () => {
    const proposal = proposalFromConstraint(constraintFromNode(constraintNode())!, [
      procedureNode(),
    ]);

    expect(proposal.derivedFromProcedure).toBe(true);
    expect(proposal.suggestedCheck.command).toBe('npm test -- --runInBand');
    expect(proposal.suggestedCheck.expectExit).toBe(0);
  });

  it('ignores unverified procedures and procedures with another digest', () => {
    const unverified = procedureNode({ metadata: { command: 'x', digest: DIGEST } });
    const otherDigest = procedureNode({
      metadata: { command: 'y', digest: 'cafe', verified: true },
    });
    const proposal = proposalFromConstraint(constraintFromNode(constraintNode())!, [
      unverified,
      otherDigest,
    ]);
    expect(proposal.derivedFromProcedure).toBe(false);
    expect(proposal.suggestedCheck.command).toBe(PLACEHOLDER_COMMAND);
  });

  it('never treats the failing command itself as a fix procedure', () => {
    const sameCommand = procedureNode({
      metadata: { command: 'npm test', digest: DIGEST, verified: true },
    });
    expect(pickFixProcedure(constraintFromNode(constraintNode())!, [sameCommand])).toBeUndefined();
    const proposal = proposalFromConstraint(constraintFromNode(constraintNode())!, [sameCommand]);
    expect(proposal.derivedFromProcedure).toBe(false);
    expect(proposal.suggestedCheck.command).toBe(PLACEHOLDER_COMMAND);
  });
});

describe('confirmCheck', () => {
  const proposal = proposalFromConstraint(constraintFromNode(constraintNode())!);

  it('refuses to apply anything without a human-typed command', () => {
    expect(confirmCheck(proposal)).toBeNull();
    expect(confirmCheck(proposal, { command: '   ' })).toBeNull();
    expect(confirmCheck(proposal, { command: PLACEHOLDER_COMMAND })).toBeNull();
  });

  it('builds the WorldCheck from the confirmed command (default exit 0)', () => {
    expect(confirmCheck(proposal, { command: 'npx vitest run tests/unit/cli-worldModel.test.ts' }))
      .toEqual({
        id: `con-${FP}`,
        command: 'npx vitest run tests/unit/cli-worldModel.test.ts',
        expectExit: 0,
      });
  });

  it('honours a human expect-exit override and strips stray quotes', () => {
    expect(confirmCheck(proposal, { command: '"npm run typecheck"', expectExit: 2 })).toEqual({
      id: `con-${FP}`,
      command: 'npm run typecheck',
      expectExit: 2,
    });
  });
});

describe('notices', () => {
  it('formats the check proposal like the AGENTS.md promote notice', () => {
    const notice = formatCheckProposalNotice(
      proposalFromConstraint(constraintFromNode(constraintNode())!),
    );
    expect(notice).toContain('[memory] candidato WorldCheck');
    expect(notice).toContain(`/memory promote con-${FP} --as-check`);
    expect(notice).toContain('exit 1');
  });

  it('tells the human how to confirm', () => {
    expect(checkConfirmationHint(
      proposalFromConstraint(constraintFromNode(constraintNode())!, [procedureNode()]),
    )).toContain('npm test -- --runInBand');
    expect(checkConfirmationHint(
      proposalFromConstraint(constraintFromNode(constraintNode())!),
    )).toContain('--as-check --command "<comando>"');
  });
});
