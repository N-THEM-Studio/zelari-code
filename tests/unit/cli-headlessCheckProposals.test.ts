/**
 * cli-headlessCheckProposals.test.ts — Slice B: the WorldCheck proposal notice
 * must reach the human on the MISSION path too.
 *
 * Slice A wired `formatCheckProposalNotice` into the kraken turn
 * (headless/runOneTurn.ts) and into the chat host (hooks/useChatTurn.ts). The
 * mission close in `runHeadless.ts` awaited `writeProofSafe(...)` and DROPPED
 * its `OpsKnowledgeResult`, so a repeated failure that produced a constraint —
 * and the applyable check built from it — stayed invisible exactly where an
 * unattended run ends.
 *
 * Two halves, both pinned here:
 *  - behavior: the shared surfacing helper prints the notice on the plain
 *    (stderr) channel and on the NDJSON `log` channel, and stays quiet when
 *    there is nothing to propose;
 *  - wiring: the mission-success branch feeds the proof write's result into
 *    that helper. The call site is read from source (same idiom as
 *    cli-headless-cwd.test.ts): driving a full mission through runHeadless
 *    needs a live provider, but the discarded-result regression is source-level.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { surfaceOpsKnowledgeNotices } from '../../src/cli/headless/runOneTurn.js';
import type { OpsKnowledgeResult } from '../../src/cli/memory/opsKnowledge.js';
import { PLACEHOLDER_COMMAND, type CheckProposal } from '../../src/cli/memory/repeatCheck.js';

const FP = 'deadbeefcafe';
const CHECK_ID = `con-${FP}`;

/** Exactly what `proposalFromConstraint` yields for a constraint node. */
const PROPOSAL: CheckProposal = {
  fp: FP,
  command: 'npm test',
  exit: 1,
  digest: 'cafe',
  checkId: CHECK_ID,
  derivedFromProcedure: false,
  suggestedCheck: { id: CHECK_ID, command: PLACEHOLDER_COMMAND, expectExit: 0 },
};

function opsResult(overrides: Partial<OpsKnowledgeResult> = {}): OpsKnowledgeResult {
  return {
    enabled: true,
    created: 1,
    skippedDuplicate: 0,
    constraintsCreated: 1,
    proposals: ['[memory] candidato AGENTS.MD: failure “npm test” — /memory promote fail-1'],
    checkProposals: [PROPOSAL],
    ...overrides,
  };
}

function capture(stream: 'stdout' | 'stderr'): { read(): string; restore(): void } {
  const chunks: string[] = [];
  const target = process[stream];
  const original = target.write.bind(target);
  target.write = ((chunk: string | Buffer) => {
    chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    return true;
  }) as typeof target.write;
  return { read: () => chunks.join(''), restore: () => { target.write = original; } };
}

function missionCloseSource(): string {
  const src = readFileSync(path.resolve(__dirname, '../../src/cli/runHeadless.ts'), 'utf8');
  const block = src
    .split("if (state.status === 'success')")[1]
    ?.split("} else if (state.status === 'stalled' || state.status === 'stopped')")[0];
  expect(block, 'mission success branch not found in runHeadless.ts').toBeTruthy();
  return block!;
}

describe('mission path — check-proposal notices (slice B)', () => {
  it('prints the WorldCheck notice on stderr for plain output', () => {
    const err = capture('stderr');
    try {
      surfaceOpsKnowledgeNotices(opsResult(), { output: 'plain' });
    } finally {
      err.restore();
    }

    const written = err.read();
    expect(written).toContain('[memory] candidato WorldCheck');
    expect(written).toContain(`/memory promote ${CHECK_ID} --as-check --command "<comando>"`);
    expect(written).toContain('exit 1');
    // The AGENTS.MD candidate channel is untouched by the slice-B addition.
    expect(written).toContain('/memory promote fail-1');
  });

  it('emits the notice as an NDJSON log event for json output', () => {
    const out = capture('stdout');
    let lines: string[] = [];
    try {
      surfaceOpsKnowledgeNotices(opsResult(), { output: 'json' });
    } finally {
      lines = out.read().split('\n').filter((line) => line.trim().length > 0);
      out.restore();
    }

    expect(lines).toHaveLength(2);
    const events = lines.map((line) => JSON.parse(line) as { type: string; message: string });
    expect(events.every((event) => event.type === 'log')).toBe(true);
    expect(events.map((event) => event.message).join('\n')).toContain(
      `[memory] candidato WorldCheck`,
    );
  });

  it('prints nothing when the turn produced no proposal', () => {
    const err = capture('stderr');
    const out = capture('stdout');
    try {
      surfaceOpsKnowledgeNotices(
        opsResult({ created: 0, constraintsCreated: 0, proposals: [], checkProposals: [] }),
        { output: 'plain' },
      );
      surfaceOpsKnowledgeNotices(
        opsResult({ created: 0, constraintsCreated: 0, proposals: [], checkProposals: [] }),
        { output: 'json' },
      );
    } finally {
      err.restore();
      out.restore();
    }

    expect(err.read()).toBe('');
    expect(out.read()).toBe('');
  });

  it('mission close surfaces the proof write result instead of dropping it', () => {
    const block = missionCloseSource();

    // P0.3 is preserved: the mission proof is still written in both branches.
    expect(block).toContain('await writeProofSafe(missionGate');
    expect(block).toContain("surface: 'mission'");
    // Slice B: that very result is surfaced — the proof write's result IS the
    // argument, so the nesting (not the textual order) is what proves it.
    const compact = block.replace(/\s+/g, '');
    expect(compact).toContain('surfaceOpsKnowledgeNotices(awaitwriteProofSafe(missionGate');
    // ...before the exit code is chosen, and without ever influencing it:
    // the helper owns the proposals, the mission close only routes them.
    expect(block.indexOf('surfaceOpsKnowledgeNotices(')).toBeLessThan(
      block.indexOf('if (missionGate.blocked)'),
    );
    expect(block).not.toContain('checkProposals');
  });

  it('runHeadless imports the shared surfacing helper', () => {
    const src = readFileSync(path.resolve(__dirname, '../../src/cli/runHeadless.ts'), 'utf8');
    expect(src).toMatch(
      /import \{[^}]*surfaceOpsKnowledgeNotices[^}]*\} from '\.\/headless\/runOneTurn\.js';/,
    );
  });
});
