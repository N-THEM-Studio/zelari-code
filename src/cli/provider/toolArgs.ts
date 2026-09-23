/**
 * Shared tool-call args JSON parsing for the provider adapters (K4.1).
 *
 * Malformed tool-call args JSON used to degrade silently: anthropic /
 * chatgpt / responsesApi fell back to `args = {}`, openai-compatible dropped
 * the call with `if (args === null) continue`. Both swallow model-channel
 * corruption (plan F22/F23 "no silent model-channel degradation"). Every
 * parse failure is now a typed error carrying the guard code
 * `tool_args_parse_failed` (same snake_case family as `text_tools_parse_failed`
 * / `tool_call_truncated`), the tool-call id and a truncated excerpt of the
 * payload — surfaced through each adapter's existing `{ kind: 'error' }` delta.
 */

/** Guard code for a tool-call args JSON parse failure. */
export const TOOL_ARGS_PARSE_FAILED_CODE = 'tool_args_parse_failed';

/** Cap for the malformed-payload excerpt quoted in the error. */
export const TOOL_ARGS_EXCERPT_LIMIT = 200;

export interface ToolArgsParseError {
  /** Guard code — always {@link TOOL_ARGS_PARSE_FAILED_CODE}. */
  code: typeof TOOL_ARGS_PARSE_FAILED_CODE;
  /** Id of the tool call whose args failed to parse. */
  toolCallId: string;
  /** Why parsing failed. */
  detail: 'is not valid JSON' | 'is not a JSON object';
  /** Truncated (~200 chars) excerpt of the malformed payload. */
  excerpt: string;
}

export type ToolArgsParseResult =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; error: ToolArgsParseError };

/**
 * Parse accumulated tool-call args JSON.
 *
 * Success is byte-identical to the previous per-adapter parsing: an empty
 * payload (zero-argument calls stream `arguments: ""`) is `{}`, and a valid
 * JSON object is returned as-is. Malformed JSON and non-object JSON (`null`,
 * arrays, strings, numbers) produce the typed error instead.
 */
export function parseToolArgsJson(raw: string, toolCallId: string): ToolArgsParseResult {
  const t = raw.trim();
  if (t.length === 0) return { ok: true, args: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(t);
  } catch {
    return { ok: false, error: toolArgsParseError(toolCallId, 'is not valid JSON', t) };
  }
  if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return { ok: true, args: parsed as Record<string, unknown> };
  }
  return { ok: false, error: toolArgsParseError(toolCallId, 'is not a JSON object', t) };
}

/**
 * Format the error as the `message` of a `{ kind: 'error' }` provider delta.
 * The message leads with the guard code so downstream consumers can match it.
 */
export function formatToolArgsParseError(error: ToolArgsParseError): string {
  return (
    `${error.code}: tool call ${error.toolCallId} args ${error.detail}; call dropped. ` +
    `Excerpt: ${error.excerpt}`
  );
}

function toolArgsParseError(
  toolCallId: string,
  detail: ToolArgsParseError['detail'],
  payload: string,
): ToolArgsParseError {
  const excerpt =
    payload.length > TOOL_ARGS_EXCERPT_LIMIT
      ? `${payload.slice(0, TOOL_ARGS_EXCERPT_LIMIT)}…`
      : payload;
  return { code: TOOL_ARGS_PARSE_FAILED_CODE, toolCallId, detail, excerpt };
}
