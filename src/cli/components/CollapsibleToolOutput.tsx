import React, { useState } from 'react';
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

export function CollapsibleToolOutput(props: CollapsibleToolOutputProps): React.ReactElement {
  const { toolName, summary, body, durationMs, ok, defaultExpanded = false } = props;
  const isControlled = typeof props.expanded === 'boolean';
  const [localExpanded, setLocalExpanded] = useState(defaultExpanded);
  const expanded = isControlled ? (props.expanded as boolean) : localExpanded;
  const color = borderColor(toolName, ok);

  const summaryLine = [
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
          {body.split('\n').map((line, idx) => (
            <Text key={idx} dimColor={ok === false}>{line}</Text>
          ))}
        </Box>
      )}
    </Box>
  );
}

/**
 * Pure helper: classify tool color (exported for unit tests).
 */
export function classifyToolColor(toolName: string, ok?: boolean): string {
  return borderColor(toolName, ok);
}