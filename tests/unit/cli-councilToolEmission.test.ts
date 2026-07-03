/**
 * cli-councilToolEmission.test.ts — post-condition check on member tool calls.
 *
 * Background: Bug C + Fix e987284 anchor role prompts to workspace tools
 * (createDocument, createTask, etc.) but the model can still skip them in
 * a single turn — leaving the deliverable incomplete (Minosse's risks.md
 * missing, Lucifero's synthesis.md missing, Nettuno's tasks missing).
 *
 * This test pins the **post-condition check** added in councilApi.ts: after
 * each member's turn, the system verifies that the tools the member was
 * REQUIRED to call were actually emitted. If not, a warning is logged.
 *
 * The check is implemented as a pure helper exported from councilApi.ts so
 * it can be unit-tested without spinning up a full AgentHarness.
 */
import { describe, it, expect } from 'vitest';
import { checkMemberToolEmissions } from '@zelari/core/council';

describe('checkMemberToolEmissions — pure helper', () => {
  it('returns ok=true when all required tools are emitted with min count', () => {
    const result = checkMemberToolEmissions(
      'minos',
      ['createDocument', 'createDocument', 'searchDocuments'],
      [{ name: 'createDocument', min: 1 }],
    );
    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it('returns ok=false and lists missing tools when required tool is absent', () => {
    const result = checkMemberToolEmissions(
      'minos',
      ['searchDocuments', 'searchDocuments'],
      [{ name: 'createDocument', min: 1 }],
    );
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(['createDocument (got 0, need >= 1)']);
  });

  it('returns ok=false when tool emitted below the minimum count', () => {
    const result = checkMemberToolEmissions(
      'geryon',
      ['createDocument'], // only 1 of 3 required
      [{ name: 'createDocument', min: 3 }],
    );
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(['createDocument (got 1, need >= 3)']);
  });

  it('handles multiple required tools at once', () => {
    const result = checkMemberToolEmissions(
      'nettun',
      ['createPhase', 'createPhase', 'createPhase', 'createPhase', 'createTask'],
      [
        { name: 'createPhase', min: 3 },
        { name: 'createTask', min: 3 },
        { name: 'createMilestone', min: 1 },
      ],
    );
    expect(result.ok).toBe(false);
    // createPhase: 4 >= 3 ✓
    // createTask: 1 < 3 ✗
    // createMilestone: 0 < 1 ✗
    expect(result.missing).toEqual([
      'createTask (got 1, need >= 3)',
      'createMilestone (got 0, need >= 1)',
    ]);
  });

  it('treats empty requirements as vacuously ok', () => {
    const result = checkMemberToolEmissions('charont', [], []);
    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
  });
});