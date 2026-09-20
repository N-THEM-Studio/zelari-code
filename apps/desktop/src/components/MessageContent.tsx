/**
 * Light display renderer: structured text/tables without raw markdown artifacts.
 * Not a full editor — view-only.
 */

import { memo, type ReactNode } from "react";
import type { MessageStats } from "../types";
import { scrubDisplayText } from "./scrubDisplayText";
import { CopyButton } from "./CopyButton";
import {
  hasIncompleteQuestionBlock,
  hasQuestionMarker,
  parseClarificationRequest,
  stripQuestionBlocks,
} from "./parseClarification";
import { ClarificationCard } from "./ClarificationCard";
import { WeaknessBadge } from "./WeaknessBadge";

type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "code"; lang?: string; text: string }
  | { kind: "table"; headers: string[]; rows: string[][] }
  | { kind: "quote"; text: string };

const INLINE_RE =
  /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(__[^_\n]+__)|(\*(?!\s)[^*\n]+?(?<!\s)\*)|(~~[^~\n]+~~)|(\[[^\]\n]+\]\(https?:\/\/[^)\s]+\))/g;

/**
 * Remove orphan emphasis/code markers left behind by partial streaming,
 * WITHOUT touching the leading/trailing whitespace. The fragments this runs
 * on (inline gaps and tails) sit BETWEEN rendered tokens: trimming them
 * glues bold/code/em to the adjacent words ("word**bold**word" — the
 * glued-spacing bug). Only the whole-text variant below may trim.
 */
function stripOrphanMarkersCore(s: string): string {
  return s
    .replace(/\*\*/g, "")
    .replace(/(?<![\w])\*(?![\w])/g, "")
    .replace(/__/g, "")
    .replace(/~~/g, "")
    .replace(/`+/g, "")
    .replace(/[ \t]{2,}/g, " ");
}

/** Whole-text variant: trimming is safe only on complete strings. */
function stripOrphanMarkers(s: string): string {
  return stripOrphanMarkersCore(s).trim();
}

/**
 * Render inline markdown (bold / italic / inline code / strike / links) as
 * React nodes instead of flattening it, so agent replies stay readable.
 */
function renderInline(text: string): ReactNode {
  const out: ReactNode[] = [];
  let last = 0;
  let k = 0;
  let m: RegExpExecArray | null;
  INLINE_RE.lastIndex = 0;
  while ((m = INLINE_RE.exec(text)) !== null) {
    if (m.index > last) {
      const gap = stripOrphanMarkersCore(text.slice(last, m.index));
      if (gap) out.push(gap);
    }
    const tok = m[0];
    if (tok.startsWith("`")) {
      out.push(
        <code key={k++} className="md-inline-code">
          {tok.slice(1, -1)}
        </code>,
      );
    } else if (tok.startsWith("**") || tok.startsWith("__")) {
      out.push(
        <strong key={k++} className="md-strong">
          {tok.slice(2, -2)}
        </strong>,
      );
    } else if (tok.startsWith("~~")) {
      out.push(
        <del key={k++} className="md-del">
          {tok.slice(2, -2)}
        </del>,
      );
    } else if (tok.startsWith("*")) {
      out.push(
        <em key={k++} className="md-em">
          {tok.slice(1, -1)}
        </em>,
      );
    } else {
      const lm = /\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/.exec(tok);
      if (lm) {
        out.push(
          <a
            key={k++}
            className="md-link"
            href={lm[2]}
            target="_blank"
            rel="noreferrer noopener"
          >
            {lm[1]}
          </a>,
        );
      } else {
        out.push(stripOrphanMarkers(tok));
      }
    }
    last = m.index + tok.length;
  }
  if (last < text.length) {
    const tail = stripOrphanMarkersCore(text.slice(last));
    if (tail) out.push(tail);
  }
  if (out.length === 0) return stripOrphanMarkers(text);
  return out;
}

function isTableSeparator(line: string): boolean {
  return /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line.trim());
}

function parseTableRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}

/**
 * Collapse consecutive identical paragraphs so a model text-loop does not
 * paint dozens of the same card in the chat UI. Keeps the first two, then
 * a single ×N marker.
 */
function collapseRepeatedParagraphBlocks(blocks: Block[]): Block[] {
  if (blocks.length < 3) return blocks;
  const out: Block[] = [];
  let i = 0;
  while (i < blocks.length) {
    const b = blocks[i]!;
    if (b.kind !== "paragraph") {
      out.push(b);
      i++;
      continue;
    }
    const key = b.text.trim();
    let j = i + 1;
    while (
      j < blocks.length &&
      blocks[j]!.kind === "paragraph" &&
      (blocks[j] as { kind: "paragraph"; text: string }).text.trim() === key
    ) {
      j++;
    }
    const count = j - i;
    if (count >= 3 && key.length >= 40) {
      out.push(b);
      if (count >= 2) out.push(blocks[i + 1]!);
      out.push({
        kind: "paragraph",
        text: `⋯ repeated ×${count} (model loop — generation stopped or truncated)`,
      });
      i = j;
    } else {
      out.push(b);
      i++;
    }
  }
  return out;
}

function parseBlocks(raw: string): Block[] {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // fenced code
    if (line.trimStart().startsWith("```")) {
      const lang = line.trim().slice(3).trim() || undefined;
      i++;
      const body: string[] = [];
      while (i < lines.length && !lines[i].trimStart().startsWith("```")) {
        body.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++; // closing fence
      blocks.push({ kind: "code", lang, text: body.join("\n") });
      continue;
    }

    // table: header + separator
    if (
      line.includes("|") &&
      i + 1 < lines.length &&
      isTableSeparator(lines[i + 1])
    ) {
      const headers = parseTableRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
        rows.push(parseTableRow(lines[i]));
        i++;
      }
      blocks.push({ kind: "table", headers, rows });
      continue;
    }

    // blank
    if (!line.trim()) {
      i++;
      continue;
    }

    // heading
    const hm = /^(#{1,6})\s+(.*)$/.exec(line);
    if (hm) {
      blocks.push({
        kind: "heading",
        level: hm[1].length,
        text: hm[2].trim(),
      });
      i++;
      continue;
    }

    // blockquote
    if (line.trimStart().startsWith(">")) {
      const parts: string[] = [];
      while (i < lines.length && lines[i].trimStart().startsWith(">")) {
        parts.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      blocks.push({
        kind: "quote",
        text: parts.join(" ").trim(),
      });
      continue;
    }

    // list
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*([-*+]|\d+\.)\s+/, "").trim());
        i++;
      }
      blocks.push({ kind: "list", ordered, items });
      continue;
    }

    // paragraph (merge consecutive non-special lines)
    const parts: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !lines[i].trimStart().startsWith("```") &&
      !/^(#{1,6})\s+/.test(lines[i]) &&
      !/^\s*([-*+]|\d+\.)\s+/.test(lines[i]) &&
      !lines[i].trimStart().startsWith(">") &&
      !(
        lines[i].includes("|") &&
        i + 1 < lines.length &&
        isTableSeparator(lines[i + 1])
      )
    ) {
      parts.push(lines[i]);
      i++;
    }
    if (parts.length) {
      blocks.push({
        kind: "paragraph",
        text: parts.join(" ").trim(),
      });
    }
  }

  return collapseRepeatedParagraphBlocks(blocks);
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return `${m}m ${rem}s`;
}

interface Props {
  content: string;
  streaming?: boolean;
  thinking?: boolean;
  stats?: MessageStats;
  /** When true, show thinking animation even if content empty */
  showThinking?: boolean;
  /** Disable clarification buttons while another run is active */
  clarificationDisabled?: boolean;
  /** User picked a choice from ---QUESTION--- */
  onClarificationChoose?: (choice: string) => void;
}

function MessageContentImpl({
  content,
  streaming,
  thinking,
  stats,
  showThinking,
  clarificationDisabled,
  onClarificationChoose,
}: Props) {
  if (showThinking || (thinking && !content.trim())) {
    return (
      <div className="thinking-block" aria-live="polite" aria-busy="true">
        <span className="thinking-orb" />
        <span className="thinking-orb" />
        <span className="thinking-orb" />
        <span className="thinking-label">Thinking</span>
      </div>
    );
  }

  const raw = content || "";
  const clarification = parseClarificationRequest(raw);
  // Prose without the private question channel (card renders it separately).
  // While streaming an incomplete QUESTION, hide the raw marker tail.
  let proseSource = stripQuestionBlocks(raw);
  if (streaming && hasQuestionMarker(raw) && !clarification) {
    proseSource = stripQuestionBlocks(raw);
  }

  // Strip tool-call XML / MiniMax invoke noise that leaked into prose.
  // Streaming: only closed blocks (never eat prose after an unclosed open tag).
  const clean = scrubDisplayText(proseSource, { streaming: !!streaming });
  if (!clean.trim() && streaming && !clarification) {
    return (
      <div className="thinking-block" aria-live="polite" aria-busy="true">
        <span className="thinking-orb" />
        <span className="thinking-orb" />
        <span className="thinking-orb" />
        <span className="thinking-label">Working</span>
      </div>
    );
  }

  const blocks = parseBlocks(clean);
  const showIncompleteQuestion =
    !streaming && hasIncompleteQuestionBlock(raw);

  return (
    <div className={`md-content${streaming ? " is-streaming" : ""}`}>
      {!streaming && raw.includes("VERDICT:") ? (
        <div className="weakness-badge-row">
          <WeaknessBadge text={raw} />
        </div>
      ) : null}
      {blocks.map((b, idx) => {
        switch (b.kind) {
          case "heading":
            return (
              <div
                key={idx}
                className={`md-h md-h${Math.min(b.level, 3)}`}
              >
                {renderInline(b.text)}
              </div>
            );
          case "paragraph":
            return (
              <p key={idx} className="md-p">
                {renderInline(b.text)}
              </p>
            );
          case "list":
            return b.ordered ? (
              <ol key={idx} className="md-list">
                {b.items.map((it, j) => (
                  <li key={j}>{renderInline(it)}</li>
                ))}
              </ol>
            ) : (
              <ul key={idx} className="md-list">
                {b.items.map((it, j) => (
                  <li key={j}>{renderInline(it)}</li>
                ))}
              </ul>
            );
          case "code":
            return (
              <div key={idx} className="md-code-wrap">
                <pre className="md-code" data-lang={b.lang || ""}>
                  <code>{b.text}</code>
                </pre>
                <CopyButton
                  getText={() => b.text}
                  title="Copy code"
                  className="code-copy"
                />
              </div>
            );
          case "table":
            return (
              <div key={idx} className="md-table-wrap">
                <table className="md-table">
                  <thead>
                    <tr>
                      {b.headers.map((h, j) => (
                        <th key={j}>{renderInline(h)}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {b.rows.map((row, ri) => (
                      <tr key={ri}>
                        {row.map((cell, ci) => (
                          <td key={ci}>{renderInline(cell)}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case "quote":
            return (
              <blockquote key={idx} className="md-quote">
                {renderInline(b.text)}
              </blockquote>
            );
          default:
            return null;
        }
      })}
      {streaming && <span className="stream-cursor" aria-hidden />}
      {clarification && !streaming && onClarificationChoose ? (
        <ClarificationCard
          request={clarification}
          disabled={clarificationDisabled}
          onChoose={onClarificationChoose}
        />
      ) : null}
      {showIncompleteQuestion ? (
        <div className="clarification-card is-incomplete" role="status">
          <div className="clarification-kicker">Incomplete question</div>
          <div className="clarification-hint">
            The agent started a ---QUESTION--- block but did not finish the JSON.
            Type your answer in the composer, or ask it to re-state the choices.
          </div>
        </div>
      ) : null}
      {stats && !streaming && (
        <div className="msg-stats">
          {stats.durationMs != null && (
            <span>{formatDuration(stats.durationMs)}</span>
          )}
          {stats.toolCount != null && stats.toolCount > 0 && (
            <span>
              {stats.toolCount} tool{stats.toolCount === 1 ? "" : "s"}
            </span>
          )}
          {stats.totalTokens != null && stats.totalTokens > 0 && (
            <span>
              {stats.totalTokens.toLocaleString()} tok
              {stats.promptTokens != null && stats.completionTokens != null
                ? ` (↑${stats.promptTokens.toLocaleString()} ↓${stats.completionTokens.toLocaleString()})`
                : ""}
            </span>
          )}
          {stats.charCount != null && stats.charCount > 0 && (
            <span>{stats.charCount.toLocaleString()} chars</span>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * SLICE2(transcript-memo): prop equality for the MessageContent React.memo
 * wrapper (exported at the bottom of this file as `memo(...)`, the same
 * convention as ChatComposer).
 *
 * This component is the expensive one: every render re-runs `parseBlocks` +
 * `renderInline` (regexes) over the whole message body. App re-renders on
 * EVERY streaming delta, so without a memo every message already on screen
 * would be re-parsed for each chunk — O(conversation length) per chunk.
 *
 * Design choice: the reducer only spreads the single message that received the
 * delta (`m.id === aid ? { ...m, ... } : m`), so every other message object —
 * and therefore the `content`/`streaming`/`stats` props derived from it — keeps
 * its identity across chunks. Comparing those props by value is enough to skip
 * the untouched rows; no per-message clone exists that would defeat it.
 *
 * `stats` is compared field-by-field rather than by reference so a caller that
 * rebuilds the object (a spread, a mapped copy) cannot silently kill the memo.
 * Callbacks are compared by reference: callers must pass a stable handler
 * (see ChatTranscript + App's useStableHandler).
 */
function statsEqual(
  a: MessageStats | undefined,
  b: MessageStats | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.durationMs === b.durationMs &&
    a.toolCount === b.toolCount &&
    a.charCount === b.charCount &&
    a.promptTokens === b.promptTokens &&
    a.completionTokens === b.completionTokens &&
    a.totalTokens === b.totalTokens &&
    a.contextTokens === b.contextTokens &&
    a.contextLimit === b.contextLimit &&
    a.cachedTokens === b.cachedTokens &&
    a.cacheHitRate === b.cacheHitRate
  );
}

/** Exported for tests — the memo contract, not a public API. */
export function messageContentPropsEqual(prev: Props, next: Props): boolean {
  return (
    prev.content === next.content &&
    prev.streaming === next.streaming &&
    prev.thinking === next.thinking &&
    prev.showThinking === next.showThinking &&
    prev.clarificationDisabled === next.clarificationDisabled &&
    prev.onClarificationChoose === next.onClarificationChoose &&
    statsEqual(prev.stats, next.stats)
  );
}

/** React.memo — the comparator above is the whole point (SLICE2). */
export const MessageContent = memo(
  MessageContentImpl,
  messageContentPropsEqual,
);

/** Global thinking indicator while a run is active but no assistant text yet. */
export function ThinkingIndicator({ label = "Working" }: { label?: string }) {
  return (
    <div className="thinking-block thinking-block-lg" aria-live="polite">
      <div className="thinking-pulse" />
      <div className="thinking-copy">
        <div className="thinking-title">{label}</div>
        <div className="thinking-orbs">
          <span className="thinking-orb" />
          <span className="thinking-orb" />
          <span className="thinking-orb" />
        </div>
      </div>
    </div>
  );
}
