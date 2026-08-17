import { describe, it, expect } from 'vitest';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInspectCommandTool } from './inspectCommand.js';
import { createBuiltinToolRegistry, type CreateRegistryOptions } from '../toolRegistry.js';
import { AuditLogger } from '../safety/auditLogger.js';
import { defaultPermissionPolicy } from '../safety/toolPermissions.js';
import { cliToolToEnhanced } from '@zelari/core/skills';
import type { ToolDefinition } from '@zelari/core/harness/tools/toolTypes';

/**
 * v1.47.2 regression — DeepSeek (strict JSON Schema validation, live report
 * 2026-08-17) rejected the whole tool catalog with HTTP 400
 * `Invalid schema for function 'inspect_command': schema must be a JSON
 * Schema of 'type: "object"', got 'type: null'.` because inspect_command's
 * inputSchema is a root discriminated union (Zod 4 → root `anyOf`, no type).
 *
 * These tests pin the three layers of the fix:
 *  1. the tool carries an explicit flattened `jsonSchema` (operation enum)
 *  2. every registry profile serializes EVERY tool with `parameters.type
 *     === 'object'` (jsonSchema preference + zodBridge union flattening)
 *  3. the council catalog bridge (cliToolToEnhanced) does not degrade the
 *     union tool to `properties: {}`
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function makeRegistry(extra: Partial<CreateRegistryOptions> = {}) {
  return createBuiltinToolRegistry({
    root: repoRoot,
    lspProvider: null,
    audit: new AuditLogger(path.join(tmpdir(), `zelari-schema-audit-${Date.now()}-${Math.random().toString(36).slice(2)}.log`)),
    permissionPolicy: defaultPermissionPolicy({ auto: true }),
    ...extra,
  });
}

describe('inspect_command provider schema (DeepSeek 400 regression)', () => {
  const tool = createInspectCommandTool(repoRoot);
  const jsonSchema = tool.jsonSchema as {
    type?: string;
    properties?: Record<string, { enum?: string[] }>;
    required?: string[];
    anyOf?: unknown;
    oneOf?: unknown;
  };

  it('exposes an explicit flattened object schema (no root anyOf/oneOf)', () => {
    expect(jsonSchema.type).toBe('object');
    expect(jsonSchema.anyOf).toBeUndefined();
    expect(jsonSchema.oneOf).toBeUndefined();
  });

  it('derives the operation enum from the zod union (all 11 operations)', () => {
    const ops = jsonSchema.properties?.operation?.enum;
    expect(ops).toHaveLength(11);
    expect(ops).toContain('git_status');
    expect(ops).toContain('typecheck');
    expect(ops).toContain('npm_view');
  });

  it('requires only `operation` at the schema level (per-op requirements stay runtime-enforced)', () => {
    expect(jsonSchema.required).toEqual(['operation']);
  });

  it.each([
    ['readOnly', { readOnly: true }],
    ['planMode', { planMode: true }],
    ['full', {}],
  ])('%s registry: EVERY serialized tool has parameters.type === "object"', (_label, extra) => {
    const { registry } = makeRegistry(extra as Partial<CreateRegistryOptions>);
    const serialized = registry.toOpenAITools();
    expect(serialized.length).toBeGreaterThan(0);
    for (const entry of serialized) {
      expect((entry.function.parameters as { type?: string }).type).toBe('object');
    }
  });

  it('readOnly/planMode registries serialize inspect_command through the curated schema', () => {
    for (const extra of [{ readOnly: true }, { planMode: true }]) {
      const { registry } = makeRegistry(extra);
      const entry = registry.toOpenAITools().find((t) => t.function.name === 'inspect_command');
      expect(entry).toBeDefined();
      const params = entry!.function.parameters as {
        type?: string;
        properties?: Record<string, { enum?: string[] }>;
      };
      expect(params.type).toBe('object');
      expect(params.properties?.operation?.enum).toHaveLength(11);
    }
  });

  it('council catalog bridge keeps the union tool intact (no properties:{} degradation)', () => {
    const enhanced = cliToolToEnhanced(tool as unknown as ToolDefinition<never, unknown>);
    const params = enhanced.parameters as {
      type?: string;
      properties?: Record<string, { enum?: string[] }>;
    };
    expect(params.type).toBe('object');
    expect(params.properties?.operation?.enum).toHaveLength(11);
    expect(Object.keys(params.properties ?? {}).length).toBeGreaterThan(1);
  });
});
