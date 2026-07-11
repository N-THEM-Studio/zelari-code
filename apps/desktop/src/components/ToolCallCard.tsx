/**
 * Compact tool-call card for the desktop chat stream.
 * Mirrors CLI ToolOutput color families without the full result formatter.
 */
import type { ChatMessage } from "../types";

function toolFamily(name: string): "read" | "write" | "exec" | "default" {
  const lower = name.toLowerCase();
  if (
    lower.includes("read") ||
    lower === "cat" ||
    lower.includes("grep") ||
    lower.includes("search") ||
    lower.includes("find") ||
    lower.includes("list") ||
    lower.includes("glob")
  ) {
    return "read";
  }
  if (lower.includes("write") || lower.includes("edit") || lower.includes("create")) {
    return "write";
  }
  if (
    lower === "bash" ||
    lower === "shell" ||
    lower === "exec" ||
    lower.includes("run") ||
    lower.includes("terminal")
  ) {
    return "exec";
  }
  return "default";
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function shouldShowPreview(content: string, name: string): boolean {
  if (!content.trim()) return false;
  const t = content.trim();
  if (/^[✓✗⋯]/.test(t) && t.length < name.length + 8) return false;
  if (t.startsWith("Running ") && t.endsWith("…")) return false;
  if (t === name || t === `✓ ${name}` || t === `✗ ${name}`) return false;
  return true;
}

interface Props {
  message: ChatMessage;
}

export function ToolCallCard({ message }: Props) {
  const name = message.toolName || "tool";
  const family = toolFamily(name);
  // New messages set toolStatus; legacy rows used "Running …" / "✓ name"
  const isRunning =
    message.toolStatus === "running" ||
    (message.toolStatus == null &&
      (message.content.endsWith("…") || message.content.startsWith("Running ")));
  const isError = !isRunning && message.toolOk === false;
  const statusClass = isRunning ? "running" : isError ? "error" : "ok";
  const preview =
    !isRunning && message.content && shouldShowPreview(message.content, name)
      ? message.content
      : "";

  return (
    <div
      className={`tool-card tool-card-${family} tool-card-${statusClass}`}
      data-tool={name}
      role="status"
      aria-label={
        isRunning
          ? `Running ${name}`
          : isError
            ? `${name} failed`
            : `${name} completed`
      }
    >
      <div className="tool-card-head">
        <span className="tool-card-status" aria-hidden>
          {isRunning ? <span className="tool-spinner" /> : isError ? "✗" : "✓"}
        </span>
        <span className="tool-card-name">{name}</span>
        {message.toolSummary ? (
          <span className="tool-card-summary" title={message.toolSummary}>
            {message.toolSummary}
          </span>
        ) : null}
        {message.toolDurationMs != null && !isRunning ? (
          <span className="tool-card-duration">
            {formatDuration(message.toolDurationMs)}
          </span>
        ) : null}
      </div>
      {preview ? <pre className="tool-card-preview">{preview}</pre> : null}
    </div>
  );
}
