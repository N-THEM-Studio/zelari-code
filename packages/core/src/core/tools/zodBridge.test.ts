import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { zodToJsonSchema } from './zodBridge.js';
import { ToolRegistry } from './registry.js';
import { typedOk, type ToolDefinition } from './toolTypes.js';

/**
 * v1.47.2 regression — strict providers (DeepSeek first, live 2026-08-17)
 * reject any function schema whose ROOT is not `type: "object"`:
 *   HTTP 400 "Invalid schema for function 'inspect_command': schema must be
 *   a JSON Schema of 'type: \"object\"', got 'type: null'."
 * Root cause: Zod 4 serializes (discriminated) unions as a bare `anyOf`
 * with no root `type`. zodToJsonSchema must flatten union-of-objects roots
 * into a single object schema.
 */
describe('zodToJsonSchema — root type:"object" guarantee', () => {
  it('flattens a discriminated union of objects into one root object', () => {
    const schema = z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('a'), x: z.string() }),
      z.object({ kind: z.literal('b'), y: z.number().optional() }),
    ]);
    const out = zodToJsonSchema(schema) as {
      type?: string;
      properties?: Record<string, { enum?: unknown[]; type?: string }>;
      required?: string[];
    };
    expect(out.type).toBe('object');
    // discriminator: distinct literals collapse into an enum
    expect(out.properties?.kind?.enum).toEqual(['a', 'b']);
    expect(out.properties?.kind?.type).toBe('string');
    expect(out.properties?.x).toEqual({ type: 'string' });
    // `x` is required in branch a only → optional at the root
    expect(out.required).toEqual(['kind']);
  });

  it('keeps a property required only when required in EVERY branch', () => {
    const schema = z.union([
      z.object({ shared: z.string(), onlyA: z.string() }),
      z.object({ shared: z.string(), onlyB: z.string().optional() }),
    ]);
    const out = zodToJsonSchema(schema) as { type?: string; required?: string[] };
    expect(out.type).toBe('object');
    expect(out.required).toEqual(['shared']);
  });

  it('does NOT merge unions with non-object branches (no safe object form)', () => {
    const schema = z.union([z.object({ a: z.string() }), z.string()]);
    const out = zodToJsonSchema(schema) as { type?: string; anyOf?: unknown[] };
    expect(out.type).toBeUndefined();
    expect(Array.isArray(out.anyOf)).toBe(true);
  });

  it('leaves plain object schemas untouched (idempotent)', () => {
    const out = zodToJsonSchema(z.object({ a: z.string(), b: z.number().optional() })) as {
      type?: string;
      properties?: Record<string, unknown>;
      required?: string[];
    };
    expect(out.type).toBe('object');
    expect(out.properties?.a).toEqual({ type: 'string' });
    expect(out.required).toEqual(['a']);
  });

  it('ToolRegistry.toOpenAITools() serializes a union-root tool with object parameters', () => {
    const tool = {
      name: 'union_tool',
      description: 'test',
      permissions: [],
      inputSchema: z.discriminatedUnion('op', [
        z.object({ op: z.literal('one') }),
        z.object({ op: z.literal('two'), n: z.number() }),
      ]),
      execute: async () => typedOk('ok'),
    } as unknown as ToolDefinition;
    const reg = new ToolRegistry();
    reg.register(tool);
    const serialized = reg.toOpenAITools()[0];
    expect(serialized.function.name).toBe('union_tool');
    expect((serialized.function.parameters as { type?: string }).type).toBe('object');
  });
});
