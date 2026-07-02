import React from 'react';
import { Box, Text } from 'ink';
import { useStdout } from 'ink';
import { formatToolResult } from './toolFormat.js';

/**
 * ToolOutput — stateless, policy-driven tool invocation renderer (v0.7.0).
 *
 * Replaces `CollapsibleToolOutput` (v0.6.2) now that the TUI uses Ink's
 * `<Static>` for finalized messages. There is no interactive expand/collapse
 * in the static-scrollback model: once a tool message is printed into the
 * scrollback it is immutable. So this component is pure — no `useState`, no
 * memo comparator on an `expanded` prop.
 *
 * v0.7.1 (plan B1+B3): the body is formatted via `formatToolResult` (no more
 * raw JSON envelope with escaped `\n`), and one-line results (write_file /
 * edit_file success) print inline with NO bordered box. Bordered boxes use a
 * clamped `width = min(terminalWidth - 6, 100)` so the wall of mixed-width
 * boxes is gone.
 *
 * Two render modes:
 *
 *   - `live` (pending, in the dynamic region): a single `⋯ [name] summary`
 *     line. No body, no duration — the invocation hasn't ended. This keeps
 *     the dynamic region exactly one line per in-flight tool.
 *
 *   - finalized (printed into scrollback): the form is decided ONCE here via
 *     formatToolResult, which keys off the tool name to render the right
 *     shape (stdout lines for bash, content for read_file, etc.).
 *
 * Color coding by tool name prefix mirrors the v0.6.2 CollapsibleToolOutput.
 */

export type ToolOutputProps = {
  toolName: string;
  /** Short summary (e.g. "cat package.json" or the formatted args line). */
  summary: string;
  /** Full output body (shown when finalized, formatted per tool policy). */
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

function ToolOutputImpl(props: ToolOutputProps): React.ReactElement {
  const { toolName, summary, body, ok, durationMs, live = false } = props;
  const color = borderColor(toolName, ok);
  const { stdout } = useStdout();
  // B3: clamp bordered box width so boxes don't stretch to full terminal and
  // produce the mixed-width wall seen in v0.7.0.
  const termWidth = stdout?.columns ?? 80;
  const boxWidth = Math.min(Math.max(40, termWidth - 6), 100);

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

  // Finalized — format the body per tool policy (B1).
  const isError = ok === false;
  const formatted = formatToolResult(toolName, body);
  const status = ok ? '✓' : '✗';
  const summaryLine = [
    status,
    `[${toolName}]`,
    summary,
    durationMs !== undefined ? `(${durationMs}ms)` : '',
  ].filter(Boolean).join(' ');

  // B3: one-line results (write_file/edit_file success) print inline — no box.
  if (formatted.oneLine && !isError) {
    const inline = formatted.lines[0] ?? '';
    return (
      <Box flexDirection="column" marginLeft={2}>
        <Box>
          <Text color={color}>{summaryLine}</Text>
        </Box>
        <Box marginLeft={2}>
          <Text dimColor>{inline}</Text>
        </Box>
      </Box>
    );
  }

  const bodyText = formatted.lines.join('\n');
  const metaSuffix = formatted.meta ? `\n${formatted.meta}` : '';

  return (
    <Box flexDirection="column" marginLeft={2}>
      <Box>
        <Text color={color}>{summaryLine}</Text>
      </Box>
      <Box
        flexDirection="column"
        marginLeft={2}
        width={boxWidth}
        borderStyle="single"
        borderColor={color}
        paddingX={1}
      >
        {/* Single <Text> with embedded \n — Ink draws this as one cohesive
            block, avoiding the N-draw-call cost of mapping each line. */}
        <Text dimColor={isError}>{bodyText}{metaSuffix}</Text>
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
