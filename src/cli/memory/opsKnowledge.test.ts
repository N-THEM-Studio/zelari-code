import { describe, expect, it } from 'vitest';
import type { MemoryNode, RememberInput } from '@zelari/core/memory';
import type { StrictBuildGateEvaluation } from '../kraken/verificationBridge.js';
import type { CompletionEvaluation } from '@zelari/core/verification';
import {
  extractOpsFailureCandidates,
  extractOpsKnowledgeCandidates,
  failureFingerprint,
  opsKnowledgeKey,
  promoteOpsKnowledge,
  type OpsKnowledgeMemory,
} from './opsKnowledge.js';
import { constraintNodeId, failureNodeId, repeatConstraintText } from './repeatFailure.js';

const OPEN_GATE = {
  total: 0,
  passed: 0,
  failedChecks: [],
  unknownChecks: [],
  blocked: false,
  selectionUsed: false,
};

function evaluation(overrides: Partial<CompletionEvaluation> = {}): CompletionEvaluation {
  return {
    verdict: 'PASS',
    satisfied: ['typecheck'],
    unsatisfied: [],
    evidenceComplete: true,
    eventBackedEvidenceComplete: true,
    summary: 'ok',
    ...overrides,
  };
}

function passGate(overrides: Partial<StrictBuildGateEvaluation> = {}): StrictBuildGateEvaluation {
  return {
    gate: { ...OPEN_GATE, selectionUsed: true, total: 1, passed: 1 },
    strict: true,
    results: [
      {
        criterionId: 'typecheck',
        status: 'pass',
        source: 'deterministic-engine',
        evidence: [
          {
            tier: 'command-output',
            ref: 'npm run typecheck → exit 0',
            capturedAt: 1,
            digest: 'abc123',
            seq: 42,
          },
        ],
        evaluatedAt: 1,
        durationMs: 10,
      },
    ],
    evaluation: evaluation(),
    native: null,
    blocked: false,
    summary: 'open (strict PASS)',
    anchoring: { toolResultAnchored: 1, noteFallback: 0 },
    ...overrides,
  };
}

function fakeMemory(): OpsKnowledgeMemory & { store: Map<string, MemoryNode> } {
  const store = new Map<string, MemoryNode>();
  return {
    store,
    async get(id) {
      return store.get(id) ?? null;
    },
    async remember(input: RememberInput) {
      const node: MemoryNode = {
        id: input.id ?? `gen-${store.size}`,
        schemaVersion: 1,
        projectId: 'test',
        kind: input.kind,
        content: input.content,
        importance: input.importance ?? 0.5,
        confidence: input.confidence ?? 0.5,
        status: 'active',
        visibility: input.visibility ?? 'project',
        tags: input.tags ?? [],
        source: input.source ?? {},
        createdAt: 't',
        updatedAt: 't',
        recordedAt: 't',
        metadata: input.metadata ?? {},
      };
      store.set(node.id, node);
      return node;
    },
  };
}

describe('extractOpsKnowledgeCandidates', () => {
  it('fires on strict PASS with deterministic command-output + seq', () => {
    const found = extractOpsKnowledgeCandidates(passGate());
    expect(found).toHaveLength(1);
    expect(found[0]!.command).toBe('npm run typecheck → exit 0');
    expect(found[0]!.criterionId).toBe('typecheck');
    expect(found[0]!.seq).toBe(42);
  });

  it('does not fire on REPAIR_REQUIRED / BLOCKED', () => {
    expect(
      extractOpsKnowledgeCandidates(
        passGate({
          blocked: true,
          evaluation: evaluation({ verdict: 'REPAIR_REQUIRED', unsatisfied: ['typecheck'] }),
        }),
      ),
    ).toEqual([]);
    expect(
      extractOpsKnowledgeCandidates(
        passGate({
          blocked: true,
          evaluation: evaluation({ verdict: 'BLOCKED' }),
        }),
      ),
    ).toEqual([]);
  });

  it('skips verify-agent / missing seq / note-fallback (pattern B)', () => {
    expect(
      extractOpsKnowledgeCandidates(
        passGate({
          results: [
            {
              criterionId: 'typecheck',
              status: 'pass',
              source: 'verify-agent',
              evidence: [
                { tier: 'command-output', ref: 'npm test', capturedAt: 1, digest: 'x', seq: 1 },
              ],
              evaluatedAt: 1,
              durationMs: 1,
            },
          ],
        }),
      ),
    ).toEqual([]);
    expect(
      extractOpsKnowledgeCandidates(
        passGate({
          results: [
            {
              criterionId: 'typecheck',
              status: 'pass',
              source: 'deterministic-engine',
              evidence: [{ tier: 'command-output', ref: 'npm test', capturedAt: 1, digest: 'x' }],
              evaluatedAt: 1,
              durationMs: 1,
            },
          ],
        }),
      ),
    ).toEqual([]);
    expect(
      extractOpsKnowledgeCandidates(
        passGate({ anchoring: { toolResultAnchored: 0, noteFallback: 1 } }),
      ),
    ).toEqual([]);
  });
});

describe('extractOpsFailureCandidates', () => {
  it('fingerprints deterministic fails on a blocked gate', () => {
    const gate = passGate({
      blocked: true,
      evaluation: evaluation({ verdict: 'REPAIR_REQUIRED' }),
      results: [
        {
          criterionId: 'tests',
          status: 'fail',
          source: 'deterministic-engine',
          evidence: [
            {
              tier: 'command-output',
              ref: 'npm test → exit 1',
              capturedAt: 1,
              digest: 'deadbeef',
              seq: 9,
            },
          ],
          evaluatedAt: 1,
          durationMs: 20,
        },
      ],
    });
    const found = extractOpsFailureCandidates(gate);
    expect(found).toHaveLength(1);
    expect(found[0]!.command).toContain('npm test');
    expect(failureFingerprint(found[0]!.command, 1, found[0]!.digest)).toHaveLength(24);
  });
});

describe('promoteOpsKnowledge', () => {
  const env = { ZELARI_PROMOTE_OPS_KNOWLEDGE: '1' };

  it('is a no-op when the flag is off (default)', () => {
    return promoteOpsKnowledge(passGate(), {
      projectRoot: '/tmp',
      env: {},
      memory: fakeMemory(),
    }).then((result) => {
      expect(result.enabled).toBe(false);
      expect(result.skippedReason).toBe('flag-off');
      expect(result.created).toBe(0);
    });
  });

  it('remembers a procedure on PASS and dedups the second run', async () => {
    const memory = fakeMemory();
    const first = await promoteOpsKnowledge(passGate(), {
      projectRoot: '/tmp',
      env,
      memory,
    });
    expect(first.created).toBe(1);
    expect(first.skippedDuplicate).toBe(0);
    expect(first.proposals[0]).toContain('/memory promote');
    const key = opsKnowledgeKey('npm run typecheck → exit 0', 'abc123', 'typecheck');
    expect(memory.store.get(`ops-${key}`)?.kind).toBe('procedure');

    const second = await promoteOpsKnowledge(passGate(), {
      projectRoot: '/tmp',
      env,
      memory,
    });
    expect(second.created).toBe(0);
    expect(second.skippedDuplicate).toBe(1);
    expect(memory.store.size).toBe(1);
  });

  it('does not remember procedures on REPAIR_REQUIRED', async () => {
    const memory = fakeMemory();
    const result = await promoteOpsKnowledge(
      passGate({
        blocked: true,
        evaluation: evaluation({ verdict: 'REPAIR_REQUIRED' }),
        results: [
          {
            criterionId: 'typecheck',
            status: 'fail',
            source: 'deterministic-engine',
            evidence: [
              {
                tier: 'command-output',
                ref: 'npm run typecheck → exit 2',
                capturedAt: 1,
                digest: 'ff',
                seq: 7,
              },
            ],
            evaluatedAt: 1,
            durationMs: 1,
          },
        ],
      }),
      { projectRoot: '/tmp', env, memory },
    );
    expect(result.created).toBe(1);
    const node = [...memory.store.values()][0];
    expect(node?.kind).toBe('failure');
  });
});

function kindsOf(memory: { store: Map<string, MemoryNode> }): string[] {
  return [...memory.store.values()].map((node) => node.kind).sort();
}

function nodesOfKind(
  memory: { store: Map<string, MemoryNode> },
  kind: string,
): MemoryNode[] {
  return [...memory.store.values()].filter((node) => node.kind === kind);
}

function failGate(
  overrides: {
    command?: string;
    digest?: string;
    seq?: number;
    criterionId?: string;
    verdict?: 'REPAIR_REQUIRED' | 'BLOCKED';
  } = {},
): StrictBuildGateEvaluation {
  const {
    command = 'npm test → exit 1',
    digest = 'deadbeef',
    seq = 9,
    criterionId = 'tests',
    verdict = 'REPAIR_REQUIRED',
  } = overrides;
  return passGate({
    blocked: true,
    evaluation: evaluation({ verdict, unsatisfied: [criterionId] }),
    results: [
      {
        criterionId,
        status: 'fail',
        source: 'deterministic-engine',
        evidence: [{ tier: 'command-output', ref: command, capturedAt: 1, digest, seq }],
        evaluatedAt: 1,
        durationMs: 20,
      },
    ],
  });
}

describe('repeat failures → constraint candidate (slice 3.2)', () => {
  const env = { ZELARI_PROMOTE_OPS_KNOWLEDGE: '1' };

  it('fingerprints identically for identical command / exit / digest', () => {
    const baseline = failureFingerprint('npm test → exit 1', 1, 'deadbeef');
    expect(baseline).toHaveLength(24);
    expect(failureFingerprint('npm test → exit 1', 1, 'deadbeef')).toBe(baseline);
    expect(failureFingerprint('npm test → exit 1', 1, 'cafe')).not.toBe(baseline);
    expect(failureFingerprint('npm test → exit 1', 2, 'deadbeef')).not.toBe(baseline);
    expect(failureFingerprint('npm run build → exit 1', 1, 'deadbeef')).not.toBe(baseline);
    expect(failureNodeId(baseline)).toBe(`fail-${baseline}`);
    expect(constraintNodeId(baseline)).toBe(`con-${baseline}`);
    expect(repeatConstraintText('npm test → exit 1', 1)).toBe(
      'Stesso fallimento ripetuto: npm test exit 1. Considera lint/SKILL/AGENTS.MD.',
    );
  });

  it('records ONLY a failure on the first sighting, never a constraint', async () => {
    const memory = fakeMemory();
    const result = await promoteOpsKnowledge(failGate(), { projectRoot: '/tmp', env, memory });

    expect(result.enabled).toBe(true);
    expect(result.created).toBe(1);
    expect(result.constraintsCreated).toBe(0);
    expect(kindsOf(memory)).toEqual(['failure']);
    const failure = nodesOfKind(memory, 'failure')[0]!;
    const fingerprint = String(failure.metadata.fingerprint);
    expect(fingerprint).toBe(failureFingerprint('npm test → exit 1', 1, 'deadbeef'));
    expect(failure.metadata.writeClass).toBe('candidate');
    expect(failure.metadata.exitCode).toBe(1);
    expect(failure.visibility).toBe('project');
    expect(memory.store.has(failureNodeId(fingerprint))).toBe(true);
    expect(memory.store.has(constraintNodeId(fingerprint))).toBe(false);
  });

  it('promotes a constraint candidate when the same fingerprint repeats', async () => {
    const memory = fakeMemory();
    const gate = failGate();
    await promoteOpsKnowledge(gate, { projectRoot: '/tmp', env, memory });
    const second = await promoteOpsKnowledge(gate, { projectRoot: '/tmp', env, memory });

    expect(second.created).toBe(1);
    expect(second.constraintsCreated).toBe(1);
    expect(second.proposals[0]).toContain('/memory promote');
    expect(kindsOf(memory)).toEqual(['constraint', 'failure']);

    const constraint = nodesOfKind(memory, 'constraint')[0]!;
    expect(constraint.content).toBe(
      'Stesso fallimento ripetuto: npm test exit 1. Considera lint/SKILL/AGENTS.MD.',
    );
    expect(constraint.metadata.writeClass).toBe('candidate');
    expect(constraint.metadata.fingerprint).toBe(
      failureFingerprint('npm test → exit 1', 1, 'deadbeef'),
    );
    expect(constraint.visibility).toBe('project');
    expect(constraint.importance).toBeGreaterThanOrEqual(0.7);
    expect(constraint.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it('keeps ONE node per fingerprint when the failure repeats a third time', async () => {
    const memory = fakeMemory();
    const gate = failGate();
    await promoteOpsKnowledge(gate, { projectRoot: '/tmp', env, memory });
    await promoteOpsKnowledge(gate, { projectRoot: '/tmp', env, memory });
    const third = await promoteOpsKnowledge(gate, { projectRoot: '/tmp', env, memory });

    expect(third.created).toBe(0);
    expect(third.constraintsCreated).toBe(0);
    expect(third.skippedDuplicate).toBe(2);
    expect(memory.store.size).toBe(2);
  });

  it('treats a different digest / exit code as a different failure', async () => {
    const memory = fakeMemory();
    await promoteOpsKnowledge(failGate(), { projectRoot: '/tmp', env, memory });
    await promoteOpsKnowledge(
      failGate({ digest: 'cafe', command: 'npm test → exit 2' }),
      { projectRoot: '/tmp', env, memory },
    );

    expect(kindsOf(memory)).toEqual(['failure', 'failure']);
    expect(nodesOfKind(memory, 'constraint')).toEqual([]);
  });

  it('does not fire on a BLOCKED gate without deterministic evidence (verify-agent)', async () => {
    const memory = fakeMemory();
    const blocked = failGate({ verdict: 'BLOCKED' });
    blocked.results = [
      {
        criterionId: 'tests',
        status: 'fail',
        source: 'verify-agent',
        evidence: [{ tier: 'command-output', ref: 'npm test → exit 1', capturedAt: 1, digest: 'x', seq: 3 }],
        evaluatedAt: 1,
        durationMs: 1,
      },
    ];
    const first = await promoteOpsKnowledge(blocked, { projectRoot: '/tmp', env, memory });
    const second = await promoteOpsKnowledge(blocked, { projectRoot: '/tmp', env, memory });
    expect(first.created).toBe(0);
    expect(second.created).toBe(0);
    expect(memory.store.size).toBe(0);
  });

  it('writes nothing at all when the flag is off', async () => {
    const memory = fakeMemory();
    const result = await promoteOpsKnowledge(failGate(), { projectRoot: '/tmp', env: {}, memory });
    expect(result.enabled).toBe(false);
    expect(result.skippedReason).toBe('flag-off');
    expect(result.constraintsCreated).toBe(0);
    expect(memory.store.size).toBe(0);
  });

  it('keeps the PASS path on procedures only', async () => {
    const memory = fakeMemory();
    const gate = passGate();
    await promoteOpsKnowledge(gate, { projectRoot: '/tmp', env, memory });
    const second = await promoteOpsKnowledge(gate, { projectRoot: '/tmp', env, memory });

    expect(second.skippedDuplicate).toBe(1);
    expect(kindsOf(memory)).toEqual(['procedure']);
    expect(nodesOfKind(memory, 'constraint')).toEqual([]);
    expect(second.constraintsCreated).toBe(0);
  });
});
