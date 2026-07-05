/**
 * council-nfrSpec-schema.test.ts
 *
 * Regression: createNfrSpec is registered as an executable stub (parameters: [])
 * but had no entry in the provider tool-schema map (PARAM_SCHEMAS in
 * toolSchemas.ts). getProviderTools looks up `PARAM_SCHEMAS[name]` first and,
 * finding none (and the stub's own parameters being an empty array), skipped it
 * with `[toolSchemas] tool "createNfrSpec" has no JSON Schema; skipping.` — so
 * the model never saw the tool and could never emit an NFR spec.
 *
 * The fix adds the JSON schema to PARAM_SCHEMAS. This test mirrors the CLI
 * runtime registration (registerCustomTool with parameters: []) and asserts the
 * advertised schema now comes from PARAM_SCHEMAS.
 */
import { describe, it, expect, afterAll } from 'vitest';
import {
  getProviderTools,
  registerCustomTool,
  unregisterCustomTool,
} from '@zelari/core/skills';

describe('createNfrSpec provider schema (regression)', () => {
  afterAll(() => unregisterCustomTool('createNfrSpec'));

  it('is advertised with its PARAM_SCHEMAS schema once registered (no longer skipped)', () => {
    registerCustomTool({
      name: 'createNfrSpec',
      description: 'Persist machine-readable NFR constraints.',
      category: 'project',
      parameters: [],
      execute: async () => 'ok',
    } as unknown as Parameters<typeof registerCustomTool>[0]);

    const tools = getProviderTools(['createNfrSpec']);
    expect(tools).toHaveLength(1);
    const params = tools[0]?.function.parameters as {
      type?: string;
      properties?: Record<string, unknown>;
    };
    expect(params?.type).toBe('object');
    // Schema must match the args the stub reads (stubs.ts createNfrSpecStub).
    expect(Object.keys(params?.properties ?? {})).toEqual(
      expect.arrayContaining([
        'targets',
        'compositorOnly',
        'forbidLayoutProps',
        'inlineJsMaxBytes',
        'planFeatureKeywords',
      ]),
    );
  });
});
