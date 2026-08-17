import type { ZodSchema, ZodTypeAny } from 'zod';

/** Convert a Zod schema into a JSON Schema-like object suitable for LLM
 *  function-calling definitions. Best-effort: handles primitives, objects,
 *  arrays, unions, optionals. Does not handle refinements beyond type.
 *
 *  v1.47.2 — the returned schema is guaranteed to have a `type: "object"`
 *  ROOT whenever the input is a union (or discriminated union) of object
 *  variants. Strict providers (DeepSeek first, live report 2026-08-17) reject
 *  any function whose parameters schema is not a root object — HTTP 400
 *  `schema must be a JSON Schema of 'type: "object"', got 'type: null'` —
 *  because Zod 4 serializes unions as a bare `anyOf` with no root `type`.
 *  Union branches are merged into ONE object: union of properties,
 *  `required` = intersection of the branch required lists, discriminator
 *  literals (`const`) collapse into an `enum`. Runtime validation is
 *  unaffected: the ToolRegistry still parses inputs against the original
 *  (strict) Zod schema — this only shapes what the MODEL is shown. */
export function zodToJsonSchema(schema: ZodSchema): Record<string, unknown> {
  let out: Record<string, unknown>;
  if (typeof (schema as any).toJSONSchema === 'function') {
    const res = (schema as any).toJSONSchema();
    if (res && typeof res === 'object') {
      const copy = { ...res };
      delete copy['$schema'];
      out = copy;
    } else {
      out = _convert(schema as ZodTypeAny);
    }
  } else {
    out = _convert(schema as ZodTypeAny);
  }
  return ensureRootObjectType(out);
}

/**
 * Merge a root union-of-objects into a single root object schema.
 *
 * Returns the schema UNCHANGED when it already has `type: "object"` or when
 * no safe single-object form exists (non-object branches, empty variant list,
 * missing anyOf/oneOf) — never invents constraints it cannot derive.
 *
 * Merge rules:
 *  - properties: union of every branch's properties, first-wins per key
 *  - discriminator (same key with a different `const` per branch): the
 *    distinct const values become `enum: [...]` (+ `type` when homogeneous)
 *  - same key with incompatible non-const shapes: nested `anyOf` on the
 *    property (only the ROOT must be an object, nested unions are legal)
 *  - required: intersection of the branches' required lists (so a field
 *    required by just one variant stays optional at the root; discriminators
 *    are required in every branch and therefore survive the intersection)
 *  - additionalProperties: false only when EVERY branch had it
 */
function ensureRootObjectType(schema: Record<string, unknown>): Record<string, unknown> {
  if (schema.type === 'object') return schema;
  const variants: unknown = schema.anyOf ?? schema.oneOf;
  if (!Array.isArray(variants) || variants.length === 0) return schema;
  const branches: Array<Record<string, unknown>> = [];
  for (const v of variants) {
    if (!v || typeof v !== 'object' || Array.isArray(v) || (v as Record<string, unknown>).type !== 'object') {
      return schema; // non-object branch: no safe single-object form
    }
    branches.push(v as Record<string, unknown>);
  }

  // Union of all branch properties; track DISTINCT schemas per key so the
  // discriminator (same key, different literal per branch) can become an enum.
  const distinct = new Map<string, Array<unknown>>();
  for (const b of branches) {
    const props = (b.properties ?? {}) as Record<string, unknown>;
    for (const [key, val] of Object.entries(props)) {
      const list = distinct.get(key) ?? [];
      if (!list.some((s) => JSON.stringify(s) === JSON.stringify(val))) list.push(val);
      distinct.set(key, list);
    }
  }
  const properties: Record<string, unknown> = {};
  for (const [key, schemas] of distinct) {
    if (schemas.length === 1) {
      properties[key] = schemas[0];
      continue;
    }
    const consts: unknown[] = [];
    let allConst = true;
    for (const s of schemas) {
      if (s && typeof s === 'object' && 'const' in (s as Record<string, unknown>)) {
        consts.push((s as Record<string, unknown>).const);
      } else {
        allConst = false;
        break;
      }
    }
    if (allConst) {
      const merged: Record<string, unknown> = { enum: consts };
      const t = typeof consts[0];
      if (consts.every((c) => typeof c === t)) {
        if (t === 'string') merged.type = 'string';
        else if (t === 'boolean') merged.type = 'boolean';
        else if (t === 'number') merged.type = Number.isInteger(consts[0]) ? 'integer' : 'number';
      }
      properties[key] = merged;
    } else {
      properties[key] = { anyOf: schemas };
    }
  }

  // required = keys required in EVERY branch (discriminators always qualify).
  let required: string[] | undefined;
  for (const b of branches) {
    const req = Array.isArray(b.required)
      ? (b.required as unknown[]).filter((k): k is string => typeof k === 'string')
      : [];
    required = required === undefined ? [...req] : required.filter((k) => req.includes(k));
  }

  const merged: Record<string, unknown> = {
    type: 'object',
    properties,
    required: required ?? [],
  };
  if (branches.every((b) => b.additionalProperties === false)) {
    merged.additionalProperties = false;
  }
  return merged;
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
