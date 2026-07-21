/**
 * Export active conversation as Markdown or JSON.
 * In Tauri Desktop: native folder picker + write to disk.
 * Fallback: browser download (Vite-only / no dialog).
 */
import { open } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "../agentClient";
import type { Conversation } from "../types";

const LS_EXPORT_DIR = "zelari-desktop-export-dir";

function downloadBlob(filename: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function safeFilename(title: string): string {
  const base = title
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "")
    .replace(/\s+/g, "-")
    .slice(0, 48);
  return base || "chat";
}

function joinPath(dir: string, file: string): string {
  const sep = dir.includes("\\") ? "\\" : "/";
  return dir.replace(/[/\\]+$/, "") + sep + file;
}

function loadLastExportDir(): string | undefined {
  try {
    const d = localStorage.getItem(LS_EXPORT_DIR);
    return d && d.trim() ? d.trim() : undefined;
  } catch {
    return undefined;
  }
}

function saveLastExportDir(dir: string): void {
  try {
    localStorage.setItem(LS_EXPORT_DIR, dir);
  } catch {
    /* ignore quota / private mode */
  }
}

function stampedFilename(base: string, ext: string): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `${base}-${stamp}.${ext}`;
}

export function conversationToJson(conv: Conversation): string {
  const payload = {
    id: conv.id,
    title: conv.title,
    mode: conv.mode,
    phase: conv.phase,
    provider: conv.provider,
    model: conv.model,
    createdAt: conv.createdAt,
    updatedAt: conv.updatedAt,
    messages: conv.messages.map((m) => ({
      role: m.role,
      content: m.content,
      toolName: m.toolName,
      toolSummary: m.toolSummary,
      memberName: m.memberName,
      createdAt: m.createdAt,
      stats: m.stats,
    })),
  };
  return JSON.stringify(payload, null, 2);
}

export function conversationToMarkdown(conv: Conversation): string {
  const lines: string[] = [
    `# ${conv.title}`,
    "",
    `- Mode: ${conv.mode}`,
    `- Phase: ${conv.phase}`,
    conv.provider
      ? `- Provider: ${conv.provider}${conv.model ? ` / ${conv.model}` : ""}`
      : "",
    `- Updated: ${new Date(conv.updatedAt).toISOString()}`,
    "",
    "---",
    "",
  ].filter(Boolean) as string[];

  for (const m of conv.messages) {
    if (m.role === "tool") {
      const status =
        m.toolStatus === "running"
          ? "running"
          : m.toolOk === false
            ? "error"
            : "ok";
      lines.push(`### Tool · ${m.toolName ?? "tool"} (${status})`);
      if (m.toolSummary) lines.push(`\`${m.toolSummary}\``);
      if (m.content.trim()) {
        lines.push("```", m.content.trim(), "```");
      }
      lines.push("");
      continue;
    }
    const who =
      m.role === "user"
        ? "You"
        : m.role === "assistant"
          ? m.memberName || "Zelari"
          : "System";
    lines.push(`### ${who}`, "", m.content || "_(empty)_", "");
  }

  return lines.join("\n");
}

/** Browser download fallback (no folder choice). */
export function exportConversationJson(conv: Conversation): void {
  downloadBlob(
    `${safeFilename(conv.title)}.json`,
    conversationToJson(conv),
    "application/json",
  );
}

/** Browser download fallback (no folder choice). */
export function exportConversationMarkdown(conv: Conversation): void {
  downloadBlob(
    `${safeFilename(conv.title)}.md`,
    conversationToMarkdown(conv),
    "text/markdown;charset=utf-8",
  );
}

export interface ExportToFolderResult {
  path: string;
}

async function pickExportFolder(): Promise<string | null> {
  const defaultPath = loadLastExportDir();
  const selected = await open({
    directory: true,
    multiple: false,
    ...(defaultPath ? { defaultPath } : {}),
  });
  if (typeof selected !== "string" || !selected.trim()) return null;
  saveLastExportDir(selected);
  return selected;
}

/**
 * Ask for a destination folder, write `{title}.md` (timestamp if name collides
 * is handled by always preferring the base name; write overwrites).
 * Returns null if the user cancels the dialog.
 */
export async function exportConversationMarkdownToFolder(
  conv: Conversation,
): Promise<ExportToFolderResult | null> {
  const dir = await pickExportFolder();
  if (!dir) return null;

  const base = safeFilename(conv.title);
  const preferred = joinPath(dir, `${base}.md`);
  const content = conversationToMarkdown(conv);

  try {
    const path = await writeTextFile(preferred, content);
    return { path };
  } catch (first) {
    // If overwrite is blocked or path odd, try a stamped name once.
    const alt = joinPath(dir, stampedFilename(base, "md"));
    try {
      const path = await writeTextFile(alt, content);
      return { path };
    } catch {
      throw first instanceof Error ? first : new Error(String(first));
    }
  }
}

export async function exportConversationJsonToFolder(
  conv: Conversation,
): Promise<ExportToFolderResult | null> {
  const dir = await pickExportFolder();
  if (!dir) return null;

  const base = safeFilename(conv.title);
  const preferred = joinPath(dir, `${base}.json`);
  const content = conversationToJson(conv);

  try {
    const path = await writeTextFile(preferred, content);
    return { path };
  } catch (first) {
    const alt = joinPath(dir, stampedFilename(base, "json"));
    try {
      const path = await writeTextFile(alt, content);
      return { path };
    } catch {
      throw first instanceof Error ? first : new Error(String(first));
    }
  }
}
