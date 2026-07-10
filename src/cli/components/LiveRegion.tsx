import React from 'react';
import { Box, Text } from 'ink';
import { renderMessage } from './ChatStream.js';
import { WorkingIndicator } from './Spinner.js';
import type { LiveState } from '../hooks/chatState.js';

/**
 * Max lines of the streaming bubble kept in the dynamic region. The full
 * text is never lost — it lands complete in `<Static>` at finalize. This
 * clamp only bounds the live repaint footprint so the dynamic region fits
 * any terminal height, eliminating full-screen repaints by construction.
 */
const LIVE_STREAM_TAIL_LINES = 10;

interface LiveRegionProps {
  live: LiveState;
  busy: boolean;
  /** Elapsed ms of the in-flight run — shown by the working indicator. */
  elapsedMs?: number | null;
}

/**
 * LiveRegion — the small dynamic region Ink repaints every frame.
 *
 * Contains:
 *   - the currently-streaming assistant bubble (clamped to the last
 *     `LIVE_STREAM_TAIL_LINES` lines so the region stays short), and
 *   - one `⋯ [tool] summary` line per pending tool invocation.
 *
 * Because this region is always at most ~10 + N lines tall, it can never
 * exceed the terminal height → Ink never falls back to clear-screen + full
 * repaint → no flicker, by construction. Finalized messages live in the
 * terminal's native scrollback via `<Static>` (printed exactly once).
 */
/** Cap concurrent tool lines so resize + many tools never blow the viewport. */
const MAX_LIVE_TOOLS = 4;

export function LiveRegion({ live, busy, elapsedMs = null }: LiveRegionProps): React.ReactElement | null {
  const { streaming, runningTools } = live;

  // v0.7.10: `busy` keeps the region alive so the animated WorkingIndicator
  // shows between dispatch and the first streamed token / tool call. (The
  // old check dropped `busy`, which made the fallback line dead code.)
  if (!streaming && runningTools.length === 0 && !busy) return null;

  const visibleTools = runningTools.slice(0, MAX_LIVE_TOOLS);
  const hiddenTools = runningTools.length - visibleTools.length;

  return (
    <Box flexDirection="column" paddingX={1}>
      {streaming && streaming.role === 'assistant' && (
        <StreamingTail
          id={streaming.id}
          content={streaming.content}
          ts={streaming.ts}
          memberName={streaming.memberName}
          memberId={streaming.memberId}
        />
      )}
      {visibleTools.map((t) => (
        <Box key={t.id} flexDirection="column">
          {renderMessage(t, true)}
        </Box>
      ))}
      {hiddenTools > 0 ? (
        <Text dimColor>  … +{hiddenTools} more tools</Text>
      ) : null}
      {busy && runningTools.length === 0 && !streaming && (
        <WorkingIndicator elapsedMs={elapsedMs} />
      )}
    </Box>
  );
}

/**
 * Render the streaming bubble, clamped to the last N content lines. A leading
 * `…` marker is shown when the content was truncated so the user knows there
 * is more above (in the scrollback once finalized). The bubble uses the same
 * header style as `renderMessage` so it is visually continuous when it
 * crosses from live → finalized.
 */
function StreamingTail(m: {
  id: string;
  content: string;
  ts: number;
  memberName?: string;
  memberId?: string;
}): React.ReactElement {
  const lines = m.content.split('\n');
  const truncated = lines.length > LIVE_STREAM_TAIL_LINES;
  const tail = truncated ? lines.slice(-LIVE_STREAM_TAIL_LINES) : lines;
  return (
    <Box key={m.id} flexDirection="column" marginBottom={1}>
      <Text color="green" bold>
        ◆ assistant
        {m.memberName ? <Text color="magenta"> · {m.memberName}</Text> : null}
      </Text>
      <Box marginLeft={2} flexDirection="column">
        {truncated && <Text dimColor>…</Text>}
        <Text>{tail.join('\n')}</Text>
      </Box>
    </Box>
  );
}
