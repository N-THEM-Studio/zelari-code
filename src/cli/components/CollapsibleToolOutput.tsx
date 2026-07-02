import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';

/**
 * CollapsibleToolOutput — Task B.2.
 *
 * Renders a single tool invocation as a one-line summary with a clickable
 * expand toggle. Ink doesn't have mouse support reliably, so we expose the
 * expanded state via prop OR default to local useState if `expanded` is
 * uncontrolled.
 *
 * Output modes:
 *   - collapsed: "[bash] cat package.json ▼"  (single line, color-coded border)
 *   - expanded:  "[bash] cat package.json ▲" + full body (multi-line)
 *
 * Color coding by tool name prefix:
 *   - read_* / cat / grep → green
 *   - write_* / edit_* → yellow
 *   - bash / shell / exec → red (warning)
 *   - everything else → cyan
 *
 * Performance: React.memo with custom comparator. The body is rendered as a
 * SINGLE <Text> with embedded \n instead of mapping each line into its own
 * <Text> — Ink coalesces consecutive text in one Text into a single draw
 * call. The previous implementation created N draw calls for an N-line
 * body, causing visible "row reflow" during the brief moment when the tool
 * finishes and the body is fully expanded (the border sometimes redrew one
 * row too high before settling).
 */

export type CollapsibleToolOutputProps = {
  toolName: string;
  /** Short summary (e.g. "cat package.json" or first arg). */
  summary: string;
  /** Full output body (shown only when expanded). */
  body: string;
  /** Duration in ms (rendered next to summary). */
  durationMs?: number;
  /** ok=true, error=false. */
  ok?: boolean;
  /** Controlled expanded state. If undefined, falls back to local state. */
  expanded?: boolean;
  /** Default expanded value when uncontrolled. */
  defaultExpanded?: boolean;
};

function borderColor(toolName: string, ok?: boolean): string {
  if (ok === false) return 'red';
  const lower = toolName.toLowerCase();
  if (lower.includes('read') || lower === 'cat' || lower.includes('grep') || lower.includes('search')) return 'green';
  if (lower.includes('write') || lower.includes('edit')) return 'yellow';
  if (lower === 'bash' || lower === 'shell' || lower === 'exec') return 'red';
  return 'cyan';
}

function CollapsibleToolOutputImpl(props: CollapsibleToolOutputProps): React.ReactElement {
  const { toolName, summary, body, durationMs, ok, defaultExpanded = false } = props;
  const isControlled = typeof props.expanded === 'boolean';
  const [localExpanded, setLocalExpanded] = useState(defaultExpanded);

  // Sync uncontrolled state when the controlled prop is undefined and
  // defaultExpanded changes post-mount (rare but possible on session
  // resume, where the restored message carries defaultExpanded=true).
  useEffect(() => {
    if (!isControlled) setLocalExpanded(defaultExpanded);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultExpanded, isControlled]);

  const expanded = isControlled ? (props.expanded as boolean) : localExpanded;
  const color = borderColor(toolName, ok);

  // Status glyph: pending (no verdict yet) / ok / error. Check `ok` first
  // so undefined-with-defined-duration (rare but possible) shows ⋯ not ✓.
  // v0.6.2 audit LOW-4.
  const status = ok === true ? '✓' : ok === false ? '✗' : '⋯';
  const summaryLine = [
    status,
    `[${toolName}]`,
    summary,
    durationMs !== undefined ? `(${durationMs}ms)` : '',
    expanded ? '▲' : '▼',
  ].filter(Boolean).join(' ');

  return (
    <Box flexDirection="column" marginLeft={2}>
      <Box>
        <Text color={color}>{summaryLine}</Text>
      </Box>
      {expanded && (
        <Box flexDirection="column" marginLeft={2} borderStyle="single" borderColor={color} paddingX={1}>
          {/* Single <Text> with embedded \n — Ink draws this as one cohesive
              block. Avoids the N-draw-call cost of mapping each line. */}
          <Text dimColor={ok === false}>{body}</Text>
        </Box>
      )}
    </Box>
  );
}

export const CollapsibleToolOutput = React.memo(CollapsibleToolOutputImpl, (prev, next) => {
  return (
    prev.toolName === next.toolName &&
    prev.summary === next.summary &&
    prev.body === next.body &&
    prev.durationMs === next.durationMs &&
    prev.ok === next.ok &&
    prev.expanded === next.expanded &&
    prev.defaultExpanded === next.defaultExpanded
  );
});

/**
 * Pure helper: classify tool color (exported for unit tests).
 */
export function classifyToolColor(toolName: string, ok?: boolean): string {
  return borderColor(toolName, ok);
}