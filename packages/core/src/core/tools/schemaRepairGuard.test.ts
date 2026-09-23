/**
 * K4.4 (F26) — schema-repair cap with structured hint + escalation.
 *
 * Fail-before contract (plan 2026-09-18 F26): before this guard the registry
 * returned a plain `Invalid input: …` for EVERY violation and the model could
 * iterate until `maxToolCallsPerTurn` — these cases pin the new behavior:
 * plain → structured hint (schema + example) → capped (guard code + escalate
 * directive, tool disabled even for valid input).
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { ToolRegistry } from './registry.js';
import { typedOk, type ToolDefinition } from './toolTypes.js';
import {
  SchemaRepairGuard,
  buildCappedError,
  buildSchemaHint,
  exampleFromSchema,
  SCHEMA_REPAIR_CAP_AT,
  SCHEMA_REPAIR_CAPPED_GUARD,
  SCHEMA_REPAIR_HINT_AT,
  SCHEMA_REPAIR_HINT_GUARD,
} from './schemaRepairGuard.js';

function def<I, O>(partial: ToolDefinition<I, O>): ToolDefinition<I, O> {
  return partial;
}

/** Registry tool with a strict schema and an execution probe. */
function makeRegistry(): { reg: ToolRegistry; executed: () => number } {
  let executed = 0;
  const reg = new ToolRegistry();
  reg.register(
    def({
      name: 'alpha',
      description: 'edit a file at path',
      permissions: [],
      inputSchema: z.object({ path: z.string() }),
      execute: async () => {
        executed += 1;
        return typedOk('ok');
      },
    }),
  );
  reg.register(
    def({
      name: 'beta',
      description: 'other tool',
      permissions: [],
      inputSchema: z.object({ path: z.string() }),
      execute: async () => {
        executed += 1;
        return typedOk('ok');
      },
    }),
  );
  return { reg, executed: () => executed };
}

const BAD = {}; // violates z.object({ path: z.string() })
const GOOD = { path: 'ok.txt' };

describe('SchemaRepairGuard (K4.4/F26)', () => {
  it('counts plain violations below the hint threshold', () => {
    const guard = new SchemaRepairGuard();
    expect(guard.record('t')).toEqual({ violations: 1, kind: 'plain' });
    expect(guard.record('t')).toEqual({ violations: 2, kind: 'plain' });
    expect(guard.isCapped('t')).toBe(false);
    expect(guard.violations('t')).toBe(2);
  });

  it('classifies hint from hintAt and capped from capAt (defaults 3/6)', () => {
    const guard = new SchemaRepairGuard();
    guard.record('t');
    guard.record('t');
    expect(guard.record('t').kind).toBe('hint'); // 3rd = SCHEMA_REPAIR_HINT_AT
    expect(guard.record('t').kind).toBe('hint');
    expect(guard.record('t').kind).toBe('hint');
    const capped = guard.record('t'); // 6th = SCHEMA_REPAIR_CAP_AT
    expect(capped).toEqual({ violations: SCHEMA_REPAIR_CAP_AT, kind: 'capped' });
    expect(guard.isCapped('t')).toBe(true);
  });

  it('keeps per-tool counters independent and supports reset', () => {
    const guard = new SchemaRepairGuard(2, 3);
    guard.record('a');
    expect(guard.record('a').kind).toBe('hint');
    expect(guard.record('b')).toEqual({ violations: 1, kind: 'plain' });
    guard.reset();
    expect(guard.violations('a')).toBe(0);
    expect(guard.isCapped('a')).toBe(false);
  });

  it('buildSchemaHint carries purpose, JSON Schema and a minimal example', () => {
    const schema = {
      type: 'object',
      properties: { path: { type: 'string' }, dryRun: { type: 'boolean' } },
      required: ['path'],
    };
    const hint = buildSchemaHint('alpha', 3, schema, 'edit a file at path');
    expect(hint).toContain(SCHEMA_REPAIR_HINT_GUARD);
    expect(hint).toContain('Tool purpose: edit a file at path');
    expect(hint).toContain('"path":"<string>"');
    expect(hint).toContain('Input JSON Schema:');
    expect(exampleFromSchema(schema)).toBe('{"path":"<string>"}');
  });

  it('buildCappedError names the guard code and directs escalation', () => {
    const err = buildCappedError('alpha', 6);
    expect(err).toContain(SCHEMA_REPAIR_CAPPED_GUARD);
    expect(err).toContain('Escalate now');
    expect(err).toContain('Do NOT retry this tool');
  });
});

describe('ToolRegistry.invoke — schema repair cap wiring (K4.4/F26)', () => {
  it('keeps the plain error below the hint threshold', async () => {
    const { reg, executed } = makeRegistry();
    const res = await reg.invoke('alpha', BAD);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toMatch(/^Invalid input:/);
      expect(res.error).not.toContain(SCHEMA_REPAIR_HINT_GUARD);
      expect(res.error).not.toContain(SCHEMA_REPAIR_CAPPED_GUARD);
    }
    expect(executed()).toBe(0);
  });

  it('adds the structured hint (schema + example) at the hint threshold', async () => {
    const { reg } = makeRegistry();
    await reg.invoke('alpha', BAD);
    await reg.invoke('alpha', BAD);
    const res = await reg.invoke('alpha', BAD); // 3rd = SCHEMA_REPAIR_HINT_AT
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain(SCHEMA_REPAIR_HINT_GUARD);
      expect(res.error).toContain('Input JSON Schema:');
      expect(res.error).toContain('Minimal example:');
      expect(res.error).toContain('Tool purpose: edit a file at path');
    }
  });

  it('caps the tool at capAt and disables it even for VALID input', async () => {
    const { reg, executed } = makeRegistry();
    for (let i = 0; i < SCHEMA_REPAIR_CAP_AT - 1; i++) await reg.invoke('alpha', BAD);
    const capped = await reg.invoke('alpha', BAD); // hits SCHEMA_REPAIR_CAP_AT
    expect(capped.ok).toBe(false);
    if (!capped.ok) {
      expect(capped.error).toContain(SCHEMA_REPAIR_CAPPED_GUARD);
      expect(capped.error).toContain('Escalate now');
    }
    // Post-cap: a perfectly valid call must fail immediately and never execute.
    const after = await reg.invoke('alpha', GOOD);
    expect(after.ok).toBe(false);
    if (!after.ok) expect(after.error).toContain(SCHEMA_REPAIR_CAPPED_GUARD);
    expect(executed()).toBe(0);
  });

  it('does not leak the cap across tools; valid input never counts', async () => {
    const { reg, executed } = makeRegistry();
    for (let i = 0; i < SCHEMA_REPAIR_CAP_AT; i++) await reg.invoke('alpha', BAD);
    const ok = await reg.invoke('beta', GOOD);
    expect(ok.ok).toBe(true);
    expect(executed()).toBe(1);
    const bad = await reg.invoke('beta', BAD);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).not.toContain(SCHEMA_REPAIR_HINT_GUARD);
  });

  it('resetSchemaRepair() re-arms a capped tool', async () => {
    const { reg, executed } = makeRegistry();
    for (let i = 0; i < SCHEMA_REPAIR_CAP_AT; i++) await reg.invoke('alpha', BAD);
    reg.resetSchemaRepair();
    const res = await reg.invoke('alpha', GOOD);
    expect(res.ok).toBe(true);
    expect(executed()).toBe(1);
  });
});
