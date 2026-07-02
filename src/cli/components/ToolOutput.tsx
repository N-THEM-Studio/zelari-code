import React from 'react';
import { Box, Text } from 'ink';

/**
 * ToolOutput — stateless, policy-driven tool invocation renderer (v0.7.0).
 *
 * Replaces `CollapsibleToolOutput` (v0.6.2) now that the TUI uses Ink's
 * `<Static>` for finalized messages. There is no interactive expand/collapse
 * in the static-scrollback model: once a tool message is printed into the
 * scrollback it is immutable. So this component is pure — no `useState`, no
 * memo comparator on an `expanded` prop.
 *
 * Two render modes:
 *
 *   - `live` (pending, in the dynamic region): a single `⋯ [name] summary`
 *     line. No body, no duration — the invocation hasn't ended. This keeps
 *     the dynamic region exactly one line per in-flight tool.
 *
 *   - finalized (printed into scrollback): the form is decided ONCE here:
 *       - error → summary + full body (bordered, as the v0.6.2 auto-expand).
 *       - success → summary + first `ZELARI_TOOL_OUTPUT_LINES` lines
 *         (default 5) of the result + `… (+K lines)` tail marker. The full
 *         body remains available in the session JSONL.
 *
 * `ZELARI_TOOL_OUTPUT_LINES` overrides the success cap (env, parsed once).
 *
 * Color coding by tool name prefix mirrors the v0.6.2 CollapsibleToolOutput.
 */

const TOOL_OUTPUT_LINES = (() => {
  const raw = process.env.ZELARI_TOOL_OUTPUT_LINES;
  const n = raw ? Number.parseInt(raw, 10) : 5;
  return Number.isFinite(n) && n >= 0 ? n : 5;
})();

export type ToolOutputProps = {
  toolName: string;
  /** Short summary (e.g. "cat package.json" or first arg / args preview). */
  summary: string;
  /** Full output body (shown when finalized + per the policy below). */
  body: string;
  /** ok=true, error=false, undefined=pending (only meaningful with live). */
  ok?: boolean;
  /** Duration in ms (rendered next to summary once finalized). */
  durationMs?: number;
  /** Pending invocation (dynamic region). Renders the one-liner only. */
  live?: boolean;
};

function borderColor(toolName: string, ok?: boolean): string {
  if (ok === false) return 'red';
  const lower = toolName.toLowerCase();
  if (lower.includes('read') || lower === 'cat' || lower.includes('grep') || lower.includes('search')) return 'green';
  if (lower.includes('write') || lower.includes('edit')) return 'yellow';
  if (lower === 'bash' || lower === 'shell' || lower === 'exec') return 'red';
  return 'cyan';
}

/**
 * Apply the success finalize policy to a body: keep the first
 * `ZELARI_TOOL_OUTPUT_LINES` lines, append a `… (+K lines)` marker when
 * truncated. Errors keep the full body (the v0.6.2 auto-expand behavior).
 */
function finalizeBody(body: string, isError: boolean): string {
  if (isError) return body;
  const lines = body.split('\n');
  if (lines.length <= TOOL_OUTPUT_LINES) return body;
  const head = lines.slice(0, TOOL_OUTPUT_LINES).join('\n');
  return `${head}\n… (+${lines.length - TOOL_OUTPUT_LINES} lines)`;
}

function ToolOutputImpl(props: ToolOutputProps): React.ReactElement {
  const { toolName, summary, body, ok, durationMs, live = false } = props;
  const color = borderColor(toolName, ok);

  // Pending (live region): single line, no body, no duration.
  if (live || ok === undefined) {
    const summaryLine = ['⋯', `[${toolName}]`, summary].filter(Boolean).join(' ');
    return (
      <Box flexDirection="column" marginLeft={2}>
        <Box>
          <Text color={color}>{summaryLine}</Text>
        </Box>
      </Box>
    );
  }

  // Finalized.
  const isError = ok === false;
  const printedBody = finalizeBody(body, isError);
  const status = ok ? '✓' : '✗';
  const summaryLine = [
    status,
    `[${toolName}]`,
    summary,
    durationMs !== undefined ? `(${durationMs}ms)` : '',
  ].filter(Boolean).join(' ');

  return (
    <Box flexDirection="column" marginLeft={2}>
      <Box>
        <Text color={color}>{summaryLine}</Text>
      </Box>
      <Box flexDirection="column" marginLeft={2} borderStyle="single" borderColor={color} paddingX={1}>
        {/* Single <Text> with embedded \n — Ink draws this as one cohesive
            block, avoiding the N-draw-call cost of mapping each line. */}
        <Text dimColor={isError}>{printedBody}</Text>
      </Box>
    </Box>
  );
}

export const ToolOutput = React.memo(ToolOutputImpl);

/**
 * Pure helper: classify tool color (exported for unit tests).
 */
export function classifyToolColor(toolName: string, ok?: boolean): string {
  return borderColor(toolName, ok);
}
