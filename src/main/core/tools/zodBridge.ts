import type { ZodSchema, ZodTypeAny } from 'zod';

/** Convert a Zod schema into a JSON Schema-like object suitable for LLM
 *  function-calling definitions. Best-effort: handles primitives, objects,
 *  arrays, unions, optionals. Does not handle refinements beyond type. */
export function zodToJsonSchema(schema: ZodSchema): Record<string, unknown> {
  if (typeof (schema as any).toJSONSchema === 'function') {
    const res = (schema as any).toJSONSchema();
    if (res && typeof res === 'object') {
      const copy = { ...res };
      delete copy['$schema'];
      return copy;
    }
  }
  return _convert(schema as ZodTypeAny);
}

function _convert(schema: ZodTypeAny): Record<string, unknown> {
  const def = (schema as { _def?: { typeName?: string; innerType?: ZodTypeAny; schema?: ZodTypeAny; options?: ZodTypeAny[] } })._def;
  if (!def) return {};
  switch (def.typeName) {
    case 'ZodString': return { type: 'string' };
    case 'ZodNumber': return { type: 'number' };
    case 'ZodBoolean': return { type: 'boolean' };
    case 'ZodObject': {
      const shape = (schema as unknown as { shape: Record<string, ZodTypeAny> }).shape;
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(shape)) {
        properties[key] = _convert(value);
        // If inner type is not ZodOptional, mark required
        const vDef = (value as { _def?: { typeName?: string; innerType?: ZodTypeAny } })._def;
        if (vDef?.typeName !== 'ZodOptional') {
          required.push(key);
        }
      }
      return { type: 'object', properties, required };
    }
    case 'ZodArray': {
      const inner = def.innerType as ZodTypeAny;
      return { type: 'array', items: _convert(inner) };
    }
    case 'ZodOptional': {
      const inner = def.innerType as ZodTypeAny;
      return _convert(inner);
    }
    case 'ZodUnion': {
      const options = (def.options as ZodTypeAny[]) ?? [];
      return { anyOf: options.map(_convert) };
    }
    case 'ZodEnum': {
      const values = (schema as unknown as { options: readonly string[] }).options;
      return { type: 'string', enum: values };
    }
    default: return {};
  }
}
