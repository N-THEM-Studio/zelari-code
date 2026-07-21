/**
 * Copy-to-clipboard + Markdown session export for Zelari Desktop.
 *
 * Pure helpers (conversationToMarkdown, exportFileName) are unit-tested under
 * tests/unit/desktop-export-session.test.ts. The DOM-touching helpers
 * (copyTextToClipboard, downloadTextFile) degrade gracefully outside a browser.
 */
import type { ChatMessage, Conversation } from "./types";
import { scrubDisplayText } from "./components/scrubDisplayText";
import { stripQuestionBlocks } from "./components/parseClarification";

/* ------------------------------------------------------------------ */
/* Clipboard                                                          */
/* ------------------------------------------------------------------ */

/**
 * Copy text to the clipboard. Uses the async Clipboard API when available and
 * falls back to a temporary textarea + execCommand for older WebViews.
 * Resolves to true on success.
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (
      typeof navigator !== "undefined" &&
      navigator.clipboard &&
      typeof navigator.clipboard.writeText === "function"
    ) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to legacy path */
  }
  try {
    if (typeof document === "undefined") return false;
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-9999px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Markdown transcript                                                */
/* ------------------------------------------------------------------ */

function formatExportTime(ts: number): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(ts));
  } catch {
    return "";
  }
}

function formatExportDate(ts: number): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(ts));
  } catch {
    return "";
  }
}

/**
 * Same visibility filter as the chat stream in App.tsx: drop tool messages,
 * legacy headless bootstrap noise, and thinking-only reasoning streams.
 */
function isExportableMessage(m: ChatMessage): boolean {
  if (m.role === "tool") return false;
  if (m.meta === "thinking") return false;
  if (m.role === "system") {
    const t = m.content.trim();
    if (/^\[headless\]\s*mode=/i.test(t)) return false;
    if (/^\[headless\]\s*MCP tools\s*:/i.test(t)) return false;
  }
  return true;
}

/** Clean assistant prose with the same pipeline the chat display uses. */
export function cleanAssistantContent(raw: string): string {
  return scrubDisplayText(stripQuestionBlocks(raw || ""));
}

/** True when the conversation has at least one user or assistant message. */
export function hasExportableMessages(conv: Conversation): boolean {
  return conv.messages.some(
    (m) =>
      (m.role === "user" || m.role === "assistant") &&
      isExportableMessage(m) &&
      (m.content || "").trim().length > 0,
  );
}

/**
 * Render a conversation as a readable Markdown transcript: header with
 * metadata, then one section per message (User / member name for council
 * replies). Assistant bodies are scrubbed of tool-call scaffolding.
 */
export function conversationToMarkdown(conv: Conversation): string {
  const lines: string[] = [];
  const title = conv.title.trim() || "Zelari session";

  lines.push(`# ${title}`, "");
  lines.push(
    `- **Mode:** ${conv.mode} · **Phase:** ${conv.phase}`,
  );
  if (conv.provider || conv.model) {
    const model = [conv.provider, conv.model].filter(Boolean).join(" / ");
    lines.push(`- **Model:** ${model}`);
  }
  lines.push(
    `- **Created:** ${formatExportDate(conv.createdAt)} ${formatExportTime(conv.createdAt)}`.trimEnd(),
    `- **Updated:** ${formatExportDate(conv.updatedAt)} ${formatExportTime(conv.updatedAt)}`.trimEnd(),
  );
  const exportable = conv.messages.filter(isExportableMessage);
  lines.push(`- **Messages:** ${exportable.length}`);
  lines.push("", "---", "");

  for (const m of exportable) {
    const time = formatExportTime(m.createdAt);
    if (m.role === "user") {
      lines.push(`## User${time ? ` · ${time}` : ""}`, "");
      lines.push(m.content.trim(), "");
    } else if (m.role === "assistant") {
      const body = cleanAssistantContent(m.content);
      if (!body) continue;
      const who = m.memberName || "Zelari";
      lines.push(`## ${who}${time ? ` · ${time}` : ""}`, "");
      lines.push(body, "");
    } else if (m.role === "system") {
      const body = m.content.trim();
      if (!body) continue;
      lines.push(
        ...body.split("\n").map((l) => `> ${l}`),
        "",
      );
    }
  }

  // Collapse trailing blank lines into a single newline at EOF.
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

/* ------------------------------------------------------------------ */
/* Download                                                           */
/* ------------------------------------------------------------------ */

/** Windows-safe slug from the conversation title (fallback "chat"). */
export function slugifyTitle(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return slug || "chat";
}

function timestampForFileName(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

/** e.g. zelari-my-session-20260721-1432.md */
export function exportFileName(conv: Conversation): string {
  return `zelari-${slugifyTitle(conv.title)}-${timestampForFileName(conv.updatedAt)}.md`;
}

/** Trigger a browser/WebView download of a UTF-8 text file. */
export function downloadTextFile(fileName: string, content: string): void {
  if (typeof document === "undefined") return;
  const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Release the object URL on the next tick so the download has started.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Export a conversation as a Markdown file downloaded to the Downloads dir. */
export function exportConversation(conv: Conversation): void {
  downloadTextFile(exportFileName(conv), conversationToMarkdown(conv));
}
