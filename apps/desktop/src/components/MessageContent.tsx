/**
 * Light display renderer: structured text/tables without raw markdown artifacts.
 * Not a full editor — view-only.
 */

import type { MessageStats } from "../types";

type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "code"; lang?: string; text: string }
  | { kind: "table"; headers: string[]; rows: string[][] }
  | { kind: "quote"; text: string };

function stripInlineArtifacts(s: string): string {
  return s
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1")
    .replace(/^#{1,6}\s+/, "")
    .trim();
}

function isTableSeparator(line: string): boolean {
  return /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line.trim());
}

function parseTableRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => stripInlineArtifacts(c.trim()));
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
        text: stripInlineArtifacts(hm[2]),
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
        text: stripInlineArtifacts(parts.join(" ")),
      });
      continue;
    }

    // list
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
        items.push(
          stripInlineArtifacts(lines[i].replace(/^\s*([-*+]|\d+\.)\s+/, "")),
        );
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
        text: stripInlineArtifacts(parts.join(" ")),
      });
    }
  }

  return blocks;
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
}

export function MessageContent({
  content,
  streaming,
  thinking,
  stats,
  showThinking,
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

  const blocks = parseBlocks(content || "");

  return (
    <div className={`md-content${streaming ? " is-streaming" : ""}`}>
      {blocks.map((b, idx) => {
        switch (b.kind) {
          case "heading":
            return (
              <div
                key={idx}
                className={`md-h md-h${Math.min(b.level, 3)}`}
              >
                {b.text}
              </div>
            );
          case "paragraph":
            return (
              <p key={idx} className="md-p">
                {b.text}
              </p>
            );
          case "list":
            return b.ordered ? (
              <ol key={idx} className="md-list">
                {b.items.map((it, j) => (
                  <li key={j}>{it}</li>
                ))}
              </ol>
            ) : (
              <ul key={idx} className="md-list">
                {b.items.map((it, j) => (
                  <li key={j}>{it}</li>
                ))}
              </ul>
            );
          case "code":
            return (
              <pre key={idx} className="md-code" data-lang={b.lang || ""}>
                <code>{b.text}</code>
              </pre>
            );
          case "table":
            return (
              <div key={idx} className="md-table-wrap">
                <table className="md-table">
                  <thead>
                    <tr>
                      {b.headers.map((h, j) => (
                        <th key={j}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {b.rows.map((row, ri) => (
                      <tr key={ri}>
                        {row.map((cell, ci) => (
                          <td key={ci}>{cell}</td>
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
                {b.text}
              </blockquote>
            );
          default:
            return null;
        }
      })}
      {streaming && <span className="stream-cursor" aria-hidden />}
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
          {stats.charCount != null && stats.charCount > 0 && (
            <span>{stats.charCount.toLocaleString()} chars</span>
          )}
        </div>
      )}
    </div>
  );
}

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
