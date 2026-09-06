import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../../apps/desktop/src/types";
import {
  applyAskUserSettled,
  applyPermissionSettled,
  askUserAskFromEvent,
  permissionAskFromEvent,
} from "../../apps/desktop/src/inChatAsk";

function sys(partial: Partial<ChatMessage>): ChatMessage {
  return {
    id: "m1",
    role: "system",
    content: "ask",
    createdAt: 1,
    ...partial,
  };
}

describe("permissionAskFromEvent / applyPermissionSettled", () => {
  it("parses a permission.request payload", () => {
    const ask = permissionAskFromEvent({
      type: "permission.request",
      requestId: "perm-1",
      tool: "bash",
      category: "execute",
      categories: ["execute"],
      inputPreview: "rm -rf /",
      reason: "execute ask",
    });
    expect(ask).toMatchObject({
      requestId: "perm-1",
      tool: "bash",
      status: "pending",
      preview: "rm -rf /",
    });
  });

  it("ignores malformed requests", () => {
    expect(permissionAskFromEvent({ type: "permission.request" })).toBeNull();
  });

  it("settles a pending card and leaves others alone", () => {
    const messages: ChatMessage[] = [
      sys({
        id: "a",
        permissionAsk: {
          requestId: "perm-1",
          tool: "bash",
          category: "execute",
          categories: ["execute"],
          status: "pending",
        },
      }),
      sys({
        id: "b",
        permissionAsk: {
          requestId: "perm-2",
          tool: "web_fetch",
          category: "network",
          categories: ["network"],
          status: "pending",
        },
      }),
    ];
    const next = applyPermissionSettled(messages, "perm-1", "always-tool");
    expect(next[0]!.permissionAsk?.status).toBe("always-tool");
    expect(next[1]!.permissionAsk?.status).toBe("pending");
  });

  it("marks timeout separately from a host deny", () => {
    const messages: ChatMessage[] = [
      sys({
        permissionAsk: {
          requestId: "perm-1",
          tool: "bash",
          category: "execute",
          categories: ["execute"],
          status: "pending",
        },
      }),
    ];
    const timed = applyPermissionSettled(messages, "perm-1", "deny", true);
    expect(timed[0]!.permissionAsk?.status).toBe("timeout");
    const denied = applyPermissionSettled(messages, "perm-1", "deny", false);
    expect(denied[0]!.permissionAsk?.status).toBe("deny");
  });
});

describe("askUserAskFromEvent / applyAskUserSettled", () => {
  it("requires a question and at least two choices", () => {
    expect(
      askUserAskFromEvent({
        requestId: "ask-1",
        question: "Only one?",
        choices: ["lonely"],
      }),
    ).toBeNull();
    expect(
      askUserAskFromEvent({
        requestId: "ask-1",
        question: "Which?",
        choices: ["A", "B"],
      })?.status,
    ).toBe("pending");
  });

  it("records the chosen answer", () => {
    const messages: ChatMessage[] = [
      sys({
        askUserAsk: {
          requestId: "ask-1",
          question: "Which?",
          choices: ["A", "B"],
          status: "pending",
        },
      }),
    ];
    const next = applyAskUserSettled(messages, "ask-1", "B");
    expect(next[0]!.askUserAsk?.status).toBe("answered");
    expect(next[0]!.askUserAsk?.answer).toBe("B");
  });
});
