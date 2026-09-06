/**
 * In-chat permission / ask_user cards — pure helpers so App.tsx stays thin
 * and the request/settled reducer is unit-testable.
 */
import type { ChatMessage } from "./types";

export type PermissionAskStatus =
  | "pending"
  | "allow"
  | "deny"
  | "always-tool"
  | "always-category"
  | "timeout";

export interface PermissionAskState {
  requestId: string;
  tool: string;
  category: string;
  categories: string[];
  reason?: string;
  preview?: string;
  status: PermissionAskStatus;
}

export type AskUserAskStatus = "pending" | "answered" | "timeout";

export interface AskUserAskState {
  requestId: string;
  question: string;
  choices: string[];
  context?: string;
  status: AskUserAskStatus;
  answer?: string;
}

export function permissionAskFromEvent(
  ev: Record<string, unknown>,
): PermissionAskState | null {
  const requestId = typeof ev.requestId === "string" ? ev.requestId.trim() : "";
  if (!requestId) return null;
  const tool = typeof ev.tool === "string" && ev.tool.trim() ? ev.tool.trim() : "tool";
  const category = typeof ev.category === "string" ? ev.category.trim() : "";
  const categories = Array.isArray(ev.categories)
    ? ev.categories.filter((c): c is string => typeof c === "string" && c.trim().length > 0)
    : category
      ? category.split(",").map((c) => c.trim()).filter(Boolean)
      : [];
  return {
    requestId,
    tool,
    category: category || categories.join(",") || "other",
    categories,
    reason: typeof ev.reason === "string" ? ev.reason : undefined,
    preview: typeof ev.inputPreview === "string" ? ev.inputPreview : undefined,
    status: "pending",
  };
}

export function askUserAskFromEvent(
  ev: Record<string, unknown>,
): AskUserAskState | null {
  const requestId = typeof ev.requestId === "string" ? ev.requestId.trim() : "";
  const question = typeof ev.question === "string" ? ev.question.trim() : "";
  const choices = Array.isArray(ev.choices)
    ? ev.choices.filter((c): c is string => typeof c === "string" && c.trim().length > 0)
    : [];
  if (!requestId || !question || choices.length < 2) return null;
  return {
    requestId,
    question,
    choices,
    context: typeof ev.context === "string" ? ev.context.trim() : undefined,
    status: "pending",
  };
}

export function applyPermissionSettled(
  messages: ChatMessage[],
  requestId: string,
  decision: string,
  timedOut = false,
): ChatMessage[] {
  const status: PermissionAskStatus = timedOut
    ? "timeout"
    : decision === "allow" ||
        decision === "deny" ||
        decision === "always-tool" ||
        decision === "always-category"
      ? decision
      : "deny";
  return messages.map((m) =>
    m.permissionAsk?.requestId === requestId && m.permissionAsk.status === "pending"
      ? { ...m, permissionAsk: { ...m.permissionAsk, status } }
      : m,
  );
}

export function applyAskUserSettled(
  messages: ChatMessage[],
  requestId: string,
  answer: string | null,
  timedOut = false,
): ChatMessage[] {
  const status: AskUserAskStatus = timedOut ? "timeout" : "answered";
  return messages.map((m) =>
    m.askUserAsk?.requestId === requestId && m.askUserAsk.status === "pending"
      ? {
          ...m,
          askUserAsk: {
            ...m.askUserAsk,
            status,
            answer: answer ?? undefined,
          },
        }
      : m,
  );
}
