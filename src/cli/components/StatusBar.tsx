import React from 'react';
import { Box, Text } from 'ink';
import { formatDuration } from '../utils/duration.js';
import { formatCost, formatTokens } from '../modelPricing.js';
import { Spinner } from './Spinner.js';
import { TUI_PALETTE, modeColor } from './tuiPalette.js';

/** Dispatch mode. `kraken` is the single-harness super-agent (legacy alias: agent). */
export type ChatMode = 'kraken' | 'council' | 'zelari';
/** @deprecated Use ChatMode; kept for external docs that still say "agent". */
export type LegacyChatModeAlias = 'agent';

export type WorkPhaseLabel = 'plan' | 'build';

export interface StatusBarProps {
  model: string;
  provider: string;
  sessionId: string;
  sessionActive: boolean;
  queueCount?: number;
  busy?: boolean;
  /** Dispatch mode for free-form prompts — toggled with shift+tab (v0.7.9). */
  mode?: ChatMode;
  /** Work phase — plan (design) or build (implement). v1.8.0. */
  phase?: WorkPhaseLabel;
  /** Current working directory, already shortened by the caller. */
  cwd?: string;
  /** Milliseconds elapsed in the current run; null while idle (v0.7.9). */
  elapsedMs?: number | null;
  /** Duration of the last completed run; null before the first run. */
  lastMs?: number | null;
  /** Cumulative session cost in USD; shown when > 0 (v1.2 prompt caching). */
  costUsd?: number;
  /** Cumulative prompt tokens served from cache; shown as "Nk cached" when > 0. */
  cachedTokens?: number;
  /** Session prompt-cache hit rate 0..1; shown as "N% hit" when prompt volume > 0. */
  cacheHitRate?: number;
  /** Estimated context used (tokens). v1.8.0 meter. */
  contextUsed?: number;
  /** Context window limit (tokens). */
  contextLimit?: number;
  /**
   * Compact session-todo summary (e.g. "todos 2/5"). Omitted when empty.
   * @since v1.21.0
   */
  todoSummary?: string | null;
  /** Kraken live tentacle summary chip (e.g. "tentacles 1↑ 2✓"). @since v1.26.0 */
  krakenLive?: string | null;
  /** Kraken graph-run summary chip (e.g. "graph 3/8 · 2↑"). @since graph engine F5 */
  krakenGraph?: string | null;
  /**
   * Verifica chip — the session proof contract (prova: PASS | RIPARA |
   * BLOCCATO), visible at all times. Identity wave: P1 as product.
   */
  verify?: { label: string; tone: 'green' | 'yellow' | 'red' } | null;
  /**
   * Permessi chip — what the agent may write right now: the phase gate
   * (plan never writes) plus the strict-done declaration (P2+P3 honesty).
   */
  permissions?: { label: string; tone: 'green' | 'yellow' } | null;
  /**
   * OS jail chip — honesty about the exec sandbox: "jail: on (bwrap)" when a
   * real backend is active and required, "jail: advisory (win32)" when the
   * platform has no honest backend and execution is a VISIBLE fail-open.
   * @since v2.32.0 (S4)
   */
  jail?: { label: string; tone: 'green' | 'yellow' } | null;
  /**
   * Verdict chip — verification progress of the current run, derived from the
   * spine (`verdictFeed`, derive-only, ADR-0016/0024). Opt-in via
   * `/statusline on verdict`. `red` = BLOCKED, `green` = PASS.
   * @since v2.53.0 (openharness-steal t124)
   */
  verdict?: { label: string; tone: 'green' | 'yellow' | 'red' } | null;
  /**
   * Inbox chip — what is waiting on YOU (unanswered ask_user, open needs,
   * tentacle completions), derived from the current session spine
   * (`inboxFeed`, derive-only, ADR-0016/0024). Opt-in via `/statusline on
   * inbox`; `red` = a need is waiting for a decision.
   * @since 2.55.0 (WS2 — inbox as notification bus)
   */
  inbox?: { label: string; tone: 'yellow' | 'red' } | null;
}

/**
 * StatusBar — single one-line status bar rendered below the input box.
 *
 * v0.7.10: extended to the full terminal width. Two groups justified with
 * space-between: identity on the left (mode · provider · model · cwd) and
 * run state on the right (spinner+timer / last, queue, session). Both groups
 * truncate instead of wrapping, so the bar is always exactly one row — the
 * old layout wrapped on narrow terminals, squashing the dynamic region.
 *
 * Why one line: the static-scrollback model (v0.7.0) needs the dynamic
 * region as short as possible. A single status line + the input bar + the
 * streaming tail is always well under a screen, so no full repaint.
 */
function StatusBarImpl({
  model,
  provider,
  sessionId,
  sessionActive,
  queueCount = 0,
  busy = false,
  mode = 'kraken',
  phase = 'build',
  cwd,
  elapsedMs = null,
  lastMs = null,
  costUsd = 0,
  cachedTokens = 0,
  cacheHitRate = 0,
  contextUsed = 0,
  contextLimit = 0,
  todoSummary = null,
  krakenLive = null,
  krakenGraph = null,
  verify = null,
  permissions = null,
  jail = null,
  verdict = null,
  inbox = null,
}: StatusBarProps): React.ReactElement {
  const ctxLabel =
    contextLimit > 0
      ? `${formatTokens(contextUsed)}/${formatTokens(contextLimit)}`
      : contextUsed > 0
        ? formatTokens(contextUsed)
        : null;

  const modeLabel =
    mode === 'council' ? 'council' : mode === 'zelari' ? 'zelari' : 'kraken';
  // TUI palette: the accent follows the label that is actually painted, so the
  // token and the text can never disagree.
  const modeTone = modeColor(modeLabel);

  return (
    <Box paddingX={1} width="100%" justifyContent="space-between" gap={2}>
      {/* Left group shrinks (truncates) before the right one on narrow panes. */}
      <Box flexShrink={2}>
      <Text wrap="truncate">
        <Text color={sessionActive ? TUI_PALETTE.success : TUI_PALETTE.muted}>
          {sessionActive ? '●' : '○'}
        </Text>
        <Text dimColor> </Text>
        <Text bold color={phase === 'plan' ? TUI_PALETTE.warn : TUI_PALETTE.success}>
          {phase === 'plan' ? '◇ plan' : '◆ build'}
        </Text>
        <Text dimColor> · </Text>
        <Text bold color={modeTone}>
          {modeLabel}
        </Text>
        {verify ? (
          <>
            <Text dimColor> · </Text>
            <Text bold color={verify.tone}>
              {verify.label}
            </Text>
          </>
        ) : null}
        {permissions ? (
          <>
            <Text dimColor> · </Text>
            <Text bold color={permissions.tone}>
              {permissions.label}
            </Text>
          </>
        ) : null}
        <Text dimColor> · </Text>
        {jail ? (
          <>
            <Text dimColor> · </Text>
            <Text bold color={jail.tone}>
              {jail.label}
            </Text>
          </>
        ) : null}
        {verdict ? (
          <>
            <Text dimColor> · </Text>
            <Text bold color={verdict.tone}>
              {verdict.label}
            </Text>
          </>
        ) : null}
        {inbox ? (
          <>
            <Text dimColor> · </Text>
            <Text bold color={inbox.tone}>
              {inbox.label}
            </Text>
          </>
        ) : null}
        <Text bold color={TUI_PALETTE.brand}>{provider}</Text>
        <Text dimColor> · </Text>
        <Text>{model}</Text>
        {cwd ? (
          <>
            <Text dimColor> · </Text>
            <Text color={TUI_PALETTE.info}>{cwd}</Text>
          </>
        ) : null}
      </Text>
      </Box>
      <Box flexShrink={1}>
      <Text wrap="truncate">
        {busy && elapsedMs !== null ? (
          <>
            <Spinner color={TUI_PALETTE.warn} />
            <Text color={TUI_PALETTE.warn}> {formatDuration(elapsedMs)}</Text>
            <Text dimColor> · </Text>
          </>
        ) : lastMs !== null ? (
          <>
            <Text dimColor>last {formatDuration(lastMs)}</Text>
            <Text dimColor> · </Text>
          </>
        ) : null}
        {queueCount > 0 ? (
          <>
            <Text color={TUI_PALETTE.brandAlt}>queue {queueCount}</Text>
            <Text dimColor> · </Text>
          </>
        ) : null}
        {todoSummary ? (
          <>
            <Text color={TUI_PALETTE.warn}>{todoSummary}</Text>
            <Text dimColor> · </Text>
          </>
        ) : null}
        {krakenLive ? (
          <>
            <Text color={TUI_PALETTE.brandAlt}>{krakenLive}</Text>
            <Text dimColor> · </Text>
          </>
        ) : null}
        {krakenGraph ? (
          <>
            <Text color={TUI_PALETTE.brandAlt}>{krakenGraph}</Text>
            <Text dimColor> · </Text>
          </>
        ) : null}
        {ctxLabel ? (
          <>
            <Text color={TUI_PALETTE.brand}>{ctxLabel}</Text>
            <Text dimColor> · </Text>
          </>
        ) : null}
        {costUsd > 0 ? (
          <>
            <Text color={TUI_PALETTE.success}>{formatCost(costUsd)}</Text>
            {cachedTokens > 0 ? (
              <Text dimColor> ({formatTokens(cachedTokens)} cached)</Text>
            ) : null}
            {cacheHitRate > 0 ? (
              <Text dimColor> {Math.round(cacheHitRate * 100)}% hit</Text>
            ) : null}
            <Text dimColor> · </Text>
          </>
        ) : null}
        <Text dimColor>session {sessionId}</Text>
      </Text>
      </Box>
    </Box>
  );
}

/**
 * Chip props are plain `{label, tone}` objects recreated on every App render,
 * so prop IDENTITY is not the contract — the visible chip is. Comparing the
 * fields keeps `<StatusBar>` from repainting when (and only when) nothing on
 * the bar actually changed.
 */
export function statusChipPropsEqual(
  prev: { label: string; tone: string } | null | undefined,
  next: { label: string; tone: string } | null | undefined,
): boolean {
  if (prev === next) return true;
  if (!prev || !next) return false;
  return prev.label === next.label && prev.tone === next.tone;
}

/**
 * Memo comparator — the whole bar is a pure function of its props, so equal
 * props mean a skipped repaint. During a run App re-renders up to ~30×/s
 * (streaming deltas + timer); the status line and its chips only re-render
 * when something shown on it really moved (diagnosi 2026-09-15, slice 5).
 */
export function statusBarPropsEqual(prev: StatusBarProps, next: StatusBarProps): boolean {
  return (
    prev.model === next.model &&
    prev.provider === next.provider &&
    prev.sessionId === next.sessionId &&
    prev.sessionActive === next.sessionActive &&
    prev.queueCount === next.queueCount &&
    prev.busy === next.busy &&
    prev.mode === next.mode &&
    prev.phase === next.phase &&
    prev.cwd === next.cwd &&
    prev.elapsedMs === next.elapsedMs &&
    prev.lastMs === next.lastMs &&
    prev.costUsd === next.costUsd &&
    prev.cachedTokens === next.cachedTokens &&
    prev.cacheHitRate === next.cacheHitRate &&
    prev.contextUsed === next.contextUsed &&
    prev.contextLimit === next.contextLimit &&
    prev.todoSummary === next.todoSummary &&
    prev.krakenLive === next.krakenLive &&
    prev.krakenGraph === next.krakenGraph &&
    statusChipPropsEqual(prev.verify, next.verify) &&
    statusChipPropsEqual(prev.permissions, next.permissions) &&
    statusChipPropsEqual(prev.jail, next.jail) &&
    statusChipPropsEqual(prev.verdict, next.verdict) &&
    statusChipPropsEqual(prev.inbox, next.inbox)
  );
}

export const StatusBar = React.memo(StatusBarImpl, statusBarPropsEqual);

