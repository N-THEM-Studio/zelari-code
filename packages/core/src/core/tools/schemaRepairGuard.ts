/**
 * schemaRepairGuard — K4.4 (F26): cap + structured hint + escalation for the
 * Zod-validation repair loop. No more silent iteration until the turn budget.
 *
 * Failure (F26, plan 2026-09-18): every schema violation returned a generic
 * `Invalid input: …` typedErr and the model simply re-sent the tool call until
 * `maxToolCallsPerTurn` ended the turn — a weak model iterating error shapes
 * forever, with the per-turn counters moving as if the turn were productive.
 *
 * Contract (plan K4.4):
 *   - after `hintAt` schema violations on the SAME tool, a structured hint
 *     (tool purpose + input JSON Schema + a minimal example) joins the error,
 *     so the model can fix the shape in ONE retry instead of guessing;
 *   - at `capAt` the tool is disabled for the rest of the run: every further
 *     call fails immediately with the stable guard code
 *     `tool_schema_repair_capped` and an explicit escalation directive
 *     (stronger model / higher thinking — or fail the node/task honestly);
 *   - a capped tool never executes again ("FAIL del nodo" branch of the K4.4
 *     disjunction — escalation is directed, iteration is not).
 *
 * Pure counting + message building — no I/O, no registry imports.
 * `ToolRegistry` owns one instance per registry (session-scoped) and threads
 * it through `invoke`.
 */
export const SCHEMA_REPAIR_HINT_AT = 3;
export const SCHEMA_REPAIR_CAP_AT = 6;
/** Stable guard codes — greppable in traces and metrics (I4 vocabulary). */
export const SCHEMA_REPAIR_HINT_GUARD = 'tool_schema_repair_hint';
export const SCHEMA_REPAIR_CAPPED_GUARD = 'tool_schema_repair_capped';

export type SchemaRepairKind = 'plain' | 'hint' | 'capped';

export interface SchemaRepairState {
  /** Violations recorded for this tool INCLUDING the current one. */
  violations: number;
  kind: SchemaRepairKind;
}

/**
 * Per-tool schema-violation counter with hint/cap thresholds. One instance
 * per ToolRegistry (i.e. per session/host registry); `reset()` re-arms.
 */
export class SchemaRepairGuard {
  private readonly counts = new Map<string, number>();
  private readonly hintAt: number;
  private readonly capAt: number;

  constructor(hintAt: number = SCHEMA_REPAIR_HINT_AT, capAt: number = SCHEMA_REPAIR_CAP_AT) {
    this.hintAt = Math.max(1, hintAt);
    this.capAt = Math.max(this.hintAt, capAt);
  }

  /** Record one schema violation and classify the error shape to return. */
  record(toolName: string): SchemaRepairState {
    const violations = (this.counts.get(toolName) ?? 0) + 1;
    this.counts.set(toolName, violations);
    if (violations >= this.capAt) return { violations, kind: 'capped' };
    if (violations >= this.hintAt) return { violations, kind: 'hint' };
    return { violations, kind: 'plain' };
  }

  /** True once the tool hit the cap — further calls fail without executing. */
  isCapped(toolName: string): boolean {
    return (this.counts.get(toolName) ?? 0) >= this.capAt;
  }

  violations(toolName: string): number {
    return this.counts.get(toolName) ?? 0;
  }

  /** Re-arm every tool (host-owned turn/run boundary). */
  reset(): void {
    this.counts.clear();
  }
}

/** Deterministic placeholder example derived from a JSON Schema object. */
function exampleValue(schema: unknown, depth = 0): unknown {
  if (!schema || typeof schema !== 'object' || depth > 4) return null;
  const s = schema as Record<string, unknown>;
  if (Array.isArray(s.enum) && s.enum.length > 0) return s.enum[0];
  switch (s.type) {
    case 'string':
      return '<string>';
    case 'number':
    case 'integer':
      return 0;
    case 'boolean':
      return true;
    case 'array':
      return [];
    case 'object': {
      const props = (s.properties ?? {}) as Record<string, unknown>;
      const required = Array.isArray(s.required) ? (s.required as string[]) : Object.keys(props);
      const out: Record<string, unknown> = {};
      for (const key of required) {
        const v = exampleValue(props[key], depth + 1);
        if (v !== null) out[key] = v;
      }
      return out;
    }
    default:
      return null;
  }
}

/** JSON string of a minimal example, or null when the schema yields none. */
export function exampleFromSchema(jsonSchema: unknown): string | null {
  const v = exampleValue(jsonSchema);
  return v && typeof v === 'object' && Object.keys(v).length > 0 ? JSON.stringify(v) : null;
}

/**
 * Structured hint appended to the error from `hintAt` violations on:
 * tool purpose + full input JSON Schema + minimal example (schema + esempio,
 * plan K4.4). Deterministic — safe for prefix caching.
 */
export function buildSchemaHint(
  toolName: string,
  violations: number,
  jsonSchema: Record<string, unknown> | undefined,
  description: string | undefined,
): string {
  const lines = [
    `[${SCHEMA_REPAIR_HINT_GUARD}] invalid input for "${toolName}" (schema violation ${violations}). Fix the arguments to match the schema exactly — do not resend the same shape.`,
  ];
  if (description) lines.push(`Tool purpose: ${description}`);
  if (jsonSchema) lines.push(`Input JSON Schema: ${JSON.stringify(jsonSchema)}`);
  const example = exampleFromSchema(jsonSchema);
  if (example) lines.push(`Minimal example: ${example}`);
  return lines.join('\n');
}

/**
 * Terminal capped error: the tool is disabled for the rest of the run and the
 * message directs escalation (stronger model / higher thinking) or an honest
 * node/task failure — never another blind retry.
 */
export function buildCappedError(toolName: string, violations: number): string {
  return (
    `[${SCHEMA_REPAIR_CAPPED_GUARD}] tool "${toolName}" is disabled after ${violations} schema violations — no further calls will run. ` +
    `Escalate now: re-run this work on a stronger model or with higher thinking, or fail the task with a clear error. Do NOT retry this tool.`
  );
}
