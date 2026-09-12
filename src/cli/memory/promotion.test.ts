import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { MemoryNode } from '@zelari/core/memory';
import {
  PROMOTE_USAGE,
  meetsPromoteThreshold,
  parsePromoteArgs,
  promoteMemoryToAgentsMd,
} from './promotion.js';
import { confirmCheck, constraintFromNode, proposalFromConstraint } from './repeatCheck.js';

function node(overrides: Partial<MemoryNode> = {}): MemoryNode {
  return {
    id: 'mem-1',
    schemaVersion: 1,
    projectId: 'p',
    kind: 'procedure',
    content: 'npm test → pass',
    importance: 0.75,
    confidence: 0.9,
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

describe('meetsPromoteThreshold', () => {
  it('accepts importance≥0.7 and confidence≥0.8', () => {
    expect(meetsPromoteThreshold(node())).toBe(true);
    expect(meetsPromoteThreshold(node({ importance: 0.69, confidence: 0.9 }))).toBe(false);
    expect(meetsPromoteThreshold(node({ importance: 0.9, confidence: 0.79 }))).toBe(false);
  });

  it('accepts metadata.verified even below numeric threshold', () => {
    expect(
      meetsPromoteThreshold(
        node({ importance: 0.1, confidence: 0.1, metadata: { verified: true } }),
      ),
    ).toBe(true);
  });
});

describe('promoteMemoryToAgentsMd', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('rejects nodes below threshold with a structured reason', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'zelari-promote-'));
    dirs.push(root);
    const result = await promoteMemoryToAgentsMd(
      root,
      node({ importance: 0.2, confidence: 0.2 }),
    );
    expect(result.added).toBe(false);
    expect(result.reason).toBe('below-threshold');
  });

  it('promotes a verified procedure into the memory-promotions block', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'zelari-promote-'));
    dirs.push(root);
    const result = await promoteMemoryToAgentsMd(
      root,
      node({ metadata: { verified: true }, importance: 0.1, confidence: 0.1 }),
    );
    expect(result.added).toBe(true);
    const body = await readFile(path.join(root, 'AGENTS.md'), 'utf8');
    expect(body).toContain('memory:mem-1');
    expect(body).toContain('zelari:memory-promotions:start');
  });
});

describe('parsePromoteArgs / --as-check (slice A)', () => {
  it('keeps the legacy `<id>` shape', () => {
    expect(parsePromoteArgs(['mem-1'])).toEqual({ id: 'mem-1', asCheck: false });
    expect(parsePromoteArgs([])).toEqual({ asCheck: false });
  });

  it('parses the id, the flag, the command and an exit override', () => {
    const parsed = parsePromoteArgs([
      'con-abc',
      '--as-check',
      '--command',
      'npx',
      'vitest',
      'run',
      'tests/unit/cli-worldModel.test.ts',
      '--expect-exit',
      '1',
    ]);
    expect(parsed).toEqual({
      id: 'con-abc',
      asCheck: true,
      command: 'npx vitest run tests/unit/cli-worldModel.test.ts',
      expectExit: 1,
    });
  });

  it('accepts inline and quoted values', () => {
    expect(parsePromoteArgs(['con-abc', '--as-check', '--command="npm test"'])).toEqual({
      id: 'con-abc',
      asCheck: true,
      command: 'npm test',
    });
    expect(parsePromoteArgs(['con-abc', '-c', '"npm run typecheck"', '-e', '0'])).toEqual({
      id: 'con-abc',
      asCheck: false,
      command: 'npm run typecheck',
      expectExit: 0,
    });
  });

  it('refuses unknown flags and non-integer exit codes', () => {
    expect(parsePromoteArgs(['con-abc', '--nope']).error).toMatch(/unknown flag/);
    expect(parsePromoteArgs(['con-abc', '--as-check', '--command']).error).toMatch(/missing value/);
    expect(parsePromoteArgs(['con-abc', '--expect-exit', 'two']).error).toMatch(/integer/);
    expect(PROMOTE_USAGE).toContain('--as-check');
  });

  it('confirms a constraint into a WorldCheck only with a human-typed command', () => {
    const constraintNode = node({
      kind: 'constraint',
      metadata: {
        fingerprint: 'fp-123',
        command: 'npm test → exit 1',
        digest: 'deadbeef',
        exitCode: 1,
        criterionId: 'tests',
      },
    });
    const constraint = constraintFromNode(constraintNode);
    expect(constraint).not.toBeNull();
    const proposal = proposalFromConstraint(constraint!);
    expect(proposal.checkId).toBe('con-fp-123');

    const parsed = parsePromoteArgs(['con-fp-123', '--as-check']);
    expect(parsed.command).toBeUndefined();
    expect(confirmCheck(proposal, { command: parsed.command })).toBeNull();

    const confirmed = parsePromoteArgs([
      'con-fp-123',
      '--as-check',
      '--command',
      'npx vitest run src/cli/memory/opsKnowledge.test.ts',
    ]);
    expect(confirmCheck(proposal, { command: confirmed.command })).toEqual({
      id: 'con-fp-123',
      command: 'npx vitest run src/cli/memory/opsKnowledge.test.ts',
      expectExit: 0,
    });
  });
});
