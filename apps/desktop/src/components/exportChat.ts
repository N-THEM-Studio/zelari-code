/**
 * Export active conversation as Markdown or JSON (browser download).
 */
import type { Conversation } from "../types";

function downloadBlob(filename: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function safeFilename(title: string): string {
  const base = title
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "")
    .replace(/\s+/g, "-")
    .slice(0, 48);
  return base || "chat";
}

export function exportConversationJson(conv: Conversation): void {
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
  downloadBlob(
    `${safeFilename(conv.title)}.json`,
    JSON.stringify(payload, null, 2),
    "application/json",
  );
}

export function exportConversationMarkdown(conv: Conversation): void {
  const lines: string[] = [
    `# ${conv.title}`,
    "",
    `- Mode: ${conv.mode}`,
    `- Phase: ${conv.phase}`,
    conv.provider ? `- Provider: ${conv.provider}${conv.model ? ` / ${conv.model}` : ""}` : "",
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
      lines.push(
        `### Tool · ${m.toolName ?? "tool"} (${status})`,
      );
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

  downloadBlob(
    `${safeFilename(conv.title)}.md`,
    lines.join("\n"),
    "text/markdown;charset=utf-8",
  );
}
