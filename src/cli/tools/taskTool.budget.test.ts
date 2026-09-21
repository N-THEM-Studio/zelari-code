/**
 * taskTool.budget.test - t158 (P2b, 2026-09-21 tentacle plan).
 *
 * The nominal tentacle budget is a kind x thoroughness table (`TURN_BUDGETS`)
 * read through the single `resolveBudget(kind, thoroughness)` lookup, so
 * quick/medium/deep really differ INSIDE a kind and the documented multipliers
 * hold. The tool schema must ADVERTISE those budgets as partial/best-effort:
 * the runtime can extend the loop and a spent budget ends a tentacle with
 * partial work, so the description may never read as a completeness
 * guarantee (Claude Code marks `maxTurns` the same way).
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  TURN_BUDGETS,
  createTaskTool,
  maxToolCallsForThoroughness,
  resolveBudget,
  type TaskAgentKind,
  type TaskThoroughness,
  type TaskToolDeps,
} from './taskTool.js';

const KINDS: readonly TaskAgentKind[] = ['explore', 'general', 'verify'];
const THOROUGHNESS: readonly TaskThoroughness[] = ['quick', 'medium', 'deep'];

/**
 * Pre-t158 baseline: what the old if-chain returned. t158 may WIDEN a cell
 * (verify.deep 14 -> 16) but must never cut one - capability is not for a
 * budget refactor to take away.
 */
const BASELINE: Readonly<Record<TaskAgentKind, Readonly<Record<TaskThoroughness, number>>>> = {
  explore: { quick: 4, medium: 6, deep: 12 },
  general: { quick: 8, medium: 12, deep: 20 },
  verify: { quick: 6, medium: 10, deep: 14 },
};

/** The minimal deps the tool BUILDER needs: `execute` is never called here. */
function buildTaskTool() {
  const deps: TaskToolDeps = { createSubAgentContext: async () => null };
  return createTaskTool(deps);
}

/** JSON-Schema view of a field description, i.e. what the model is shown. */
function fieldDescription(schema: z.ZodType, field: string): string {
  const json = z.toJSONSchema(schema, { io: 'input' }) as {
    properties?: Record<string, { description?: string }>;
  };
  const description = json.properties?.[field]?.description;
  expect(description, `the schema must expose a ${field} description`).toBeTruthy();
  return description as string;
}

describe('t158 - budget table scales with thoroughness (P2b)', () => {
  it('resolveBudget returns the documented kind x thoroughness table', () => {
    for (const kind of KINDS) {
      for (const thoroughness of THOROUGHNESS) {
        expect(resolveBudget(kind, thoroughness)).toBe(TURN_BUDGETS[kind][thoroughness]);
      }
    }
    // The table itself, pinned: three DISTINCT values per kind, no flat cap.
    expect(TURN_BUDGETS).toEqual({
      explore: { quick: 4, medium: 6, deep: 12 },
      general: { quick: 8, medium: 12, deep: 20 },
      verify: { quick: 6, medium: 10, deep: 16 },
    });
  });

  it('quick < medium < deep inside every kind (no shared ceiling)', () => {
    for (const kind of KINDS) {
      const { quick, medium, deep } = TURN_BUDGETS[kind];
      expect(quick, `${kind}: quick must be below medium`).toBeLessThan(medium);
      expect(deep, `${kind}: deep must be above medium`).toBeGreaterThan(medium);
      expect(new Set([quick, medium, deep]).size).toBe(3);
    }
  });

  it('keeps the P2b multiplier convention (quick ~0.6x, deep ~1.6x of medium)', () => {
    for (const kind of KINDS) {
      const { quick, medium, deep } = TURN_BUDGETS[kind];
      // quick: shrunk, never gutted (0.5x floor guards a "quick" that cannot work).
      expect(quick).toBeGreaterThanOrEqual(Math.ceil(medium * 0.5));
      expect(quick).toBeLessThanOrEqual(Math.floor(medium * 0.7));
      // deep: at least the plan's 1.6x (explore is deliberately wider at 2.0x).
      expect(deep).toBeGreaterThanOrEqual(Math.ceil(medium * 1.6));
    }
  });

  it('never cuts a pre-t158 budget; the only delta is the documented widening', () => {
    const widened: string[] = [];
    for (const kind of KINDS) {
      for (const thoroughness of THOROUGHNESS) {
        const before = BASELINE[kind][thoroughness];
        const now = resolveBudget(kind, thoroughness);
        expect(now, `${kind}.${thoroughness} must not shrink below ${before}`).toBeGreaterThanOrEqual(
          before,
        );
        if (now !== before) widened.push(`${kind}.${thoroughness}: ${before} -> ${now}`);
      }
    }
    expect(widened).toEqual(['verify.deep: 14 -> 16']);
  });

  it('an out-of-enum thoroughness degrades to the kind medium baseline', () => {
    for (const kind of KINDS) {
      const rogue = 'ultra' as unknown as TaskThoroughness;
      expect(resolveBudget(kind, rogue)).toBe(TURN_BUDGETS[kind].medium);
    }
  });

  it('keeps the deprecated alias in sync with resolveBudget', () => {
    for (const kind of KINDS) {
      for (const thoroughness of THOROUGHNESS) {
        expect(maxToolCallsForThoroughness(thoroughness, kind)).toBe(
          resolveBudget(kind, thoroughness),
        );
      }
    }
  });
});

describe('t158 - the tool advertises the budget as PARTIAL (P2b)', () => {
  it('marks `thoroughness` partial/best-effort and quotes the real budgets', () => {
    const tool = buildTaskTool();
    const description = fieldDescription(tool.inputSchema as z.ZodType, 'thoroughness');

    expect(description).toContain('PARTIAL');
    expect(description).toContain('best-effort');
    expect(description).toContain('Default medium');
    // NOT a guarantee: the runtime can stretch the loop, and hitting the
    // budget yields partial work (hence no exhaustiveness promise).
    expect(description).toContain('non-exhaustive');

    // Drift guard: the numbers quoted to the model ARE the table's numbers.
    for (const kind of KINDS) {
      const { quick, medium, deep } = TURN_BUDGETS[kind];
      expect(description, `${kind} budgets must be advertised`).toContain(
        `${kind} ${quick}/${medium}/${deep}`,
      );
    }
  });

  it('marks the tool description partial too (budget is best-effort, not exhaustiveness)', () => {
    const tool = buildTaskTool();
    expect(tool.name).toBe('task');
    expect(tool.description).toContain('PARTIAL');
    expect(tool.description).toContain('best-effort');
    expect(tool.description).toContain('never a guaranteed-exhaustive answer');
  });

  it('the enum still accepts exactly quick/medium/deep (marking changed no contract)', () => {
    const tool = buildTaskTool();
    const schema = tool.inputSchema as { safeParse: (v: unknown) => { success: boolean } };
    for (const thoroughness of THOROUGHNESS) {
      expect(
        schema.safeParse({ description: 'd', prompt: 'p', thoroughness }).success,
        `${thoroughness} must stay valid`,
      ).toBe(true);
    }
    expect(schema.safeParse({ description: 'd', prompt: 'p', thoroughness: 'ultra' }).success).toBe(
      false,
    );
  });
});
