// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { fireEvent, render } from "@testing-library/react";
import { ChatTranscript } from "./ChatTranscript";
import type { ChatMessage } from "../types";

// CopyButton pulls a hook-bearing tree that resolves a second React copy in
// the jsdom test env (pre-existing quirk, works in the real app) — the same
// stub as MessageContent.test.tsx. The spy doubles as the observer for the
// memo test below: it is re-invoked exactly when the row sub-tree re-renders.
const copySpy = vi.hoisted(() => vi.fn());
vi.mock("./CopyButton", () => ({
  CopyButton: (props: { getText: () => string }) => {
    copySpy(props.getText);
    return <div data-testid="copy-stub" />;
  },
}));

// ReplyAccordion (and TurnStatsCard under it) call hooks, which trips the same
// jsdom double-React quirk documented in MessageContent.test.tsx. The shell's
// own markup is not what this suite covers, so stub it as a pass-through: the
// assistant row still renders the real MessageContent inside it.
vi.mock("./ReplyAccordion", () => ({
  ReplyAccordion: ({ children }: { children: ReactNode }) => (
    <div className="reply-accordion">{children}</div>
  ),
}));

function msg(
  over: Pick<ChatMessage, "id" | "role" | "content"> & Partial<ChatMessage>,
): ChatMessage {
  return { createdAt: 1, ...over };
}

// Module-scope handlers: stable identities, exactly like the ones App builds
// with useStableHandler/useCallback. Re-created inline arrows would (rightly)
// break the memo assertion further down.
const noop = () => {};
const handlers = {
  running: false,
  onClarificationChoose: noop,
  onPermissionDecide: noop,
  onAskUserChoose: noop,
};

describe("ChatTranscript", () => {
  it("renders every user/assistant row in order", () => {
    const messages = [
      msg({ id: "u1", role: "user", content: "domanda utente" }),
      msg({ id: "a1", role: "assistant", content: "risposta uno" }),
      msg({ id: "a2", role: "assistant", content: "risposta due" }),
    ];
    const { container } = render(
      <ChatTranscript messages={messages} {...handlers} />,
    );
    const rows = container.querySelectorAll<HTMLElement>(".message");
    expect(rows.length).toBe(3);
    expect(rows[0]?.className).toBe("message user");
    expect(rows[1]?.className).toContain("message assistant");
    expect(rows[0]?.textContent).toContain("domanda utente");
    expect(rows[1]?.textContent).toContain("risposta uno");
    expect(rows[2]?.textContent).toContain("risposta due");
  });

  it("hides tool rows and legacy headless bootstrap noise", () => {
    const messages = [
      msg({ id: "u1", role: "user", content: "ciao" }),
      msg({ id: "t1", role: "tool", content: "tool noise" }),
      msg({ id: "s1", role: "system", content: "[headless] mode=kraken" }),
      msg({ id: "s2", role: "system", content: "[headless] MCP tools: bash" }),
      msg({ id: "a1", role: "assistant", content: "risposta" }),
    ];
    const { container } = render(
      <ChatTranscript messages={messages} {...handlers} />,
    );
    expect(container.querySelectorAll(".message").length).toBe(2);
    expect(container.textContent).not.toContain("tool noise");
    expect(container.textContent).not.toContain("[headless]");
  });

  it("keeps legacy system prose visible and renders markdown replies", () => {
    const messages = [
      msg({ id: "s1", role: "system", content: "nota di sistema" }),
      msg({ id: "a1", role: "assistant", content: "**grassetto** e `codice`" }),
    ];
    const { container } = render(
      <ChatTranscript messages={messages} {...handlers} />,
    );
    expect(container.querySelector(".system-bubble")?.textContent).toBe(
      "nota di sistema",
    );
    expect(container.querySelector("strong.md-strong")?.textContent).toBe(
      "grassetto",
    );
    expect(container.querySelector("code.md-inline-code")?.textContent).toBe(
      "codice",
    );
  });

  it("forwards a permission decision with its request id", () => {
    const onPermissionDecide = vi.fn();
    const ask: ChatMessage = msg({
      id: "p1",
      role: "system",
      content: "",
      permissionAsk: {
        requestId: "req-7",
        tool: "Bash",
        category: "exec",
        categories: ["exec"],
        status: "pending",
      },
    });
    const { container } = render(
      <ChatTranscript
        messages={[ask]}
        {...handlers}
        onPermissionDecide={onPermissionDecide}
      />,
    );
    const buttons =
      container.querySelectorAll<HTMLButtonElement>(".clarification-choice");
    expect(buttons.length).toBe(4);
    fireEvent.click(buttons[0]!);
    expect(onPermissionDecide).toHaveBeenCalledTimes(1);
    expect(onPermissionDecide).toHaveBeenCalledWith("req-7", "allow");
  });

  it("forwards an ask_user answer and shows the settled answer", () => {
    const onAskUserChoose = vi.fn();
    const pending = msg({
      id: "q1",
      role: "system",
      content: "quale?",
      askUserAsk: {
        requestId: "ask-3",
        question: "Quale?",
        choices: ["A", "B"],
        status: "pending",
      },
    });
    const { container } = render(
      <ChatTranscript
        messages={[pending]}
        {...handlers}
        onAskUserChoose={onAskUserChoose}
      />,
    );
    const buttons =
      container.querySelectorAll<HTMLButtonElement>(".clarification-choice");
    expect(buttons.length).toBe(2);
    fireEvent.click(buttons[1]!);
    expect(onAskUserChoose).toHaveBeenCalledWith("ask-3", "B");

    const answered = msg({
      id: "q2",
      role: "system",
      content: "quale?",
      askUserAsk: {
        requestId: "ask-4",
        question: "Quale?",
        choices: ["A"],
        status: "answered",
        answer: "A",
      },
    });
    const { container: settled } = render(
      <ChatTranscript messages={[answered]} {...handlers} />,
    );
    expect(settled.querySelector(".system-bubble")?.textContent).toBe(
      "Answered: A",
    );
    expect(settled.querySelectorAll(".clarification-choice").length).toBe(0);
  });

  it("bails out of the row sub-tree when nothing changed (memo)", () => {
    const list = [
      msg({ id: "u1", role: "user", content: "domanda" }),
      msg({ id: "a1", role: "assistant", content: "risposta" }),
    ];
    const { rerender } = render(
      <ChatTranscript messages={list} {...handlers} />,
    );
    const before = copySpy.mock.calls.length;
    expect(before).toBeGreaterThan(0);

    // Same array reference + same handler identities: React.memo must bail
    // out, so the rows (and their CopyButtons) are not re-rendered.
    rerender(<ChatTranscript messages={list} {...handlers} />);
    expect(copySpy.mock.calls.length).toBe(before);

    // A new array (what the reducer produces on a delta) does re-render.
    rerender(
      <ChatTranscript
        messages={[
          ...list,
          msg({ id: "u2", role: "user", content: "seconda" }),
        ]}
        {...handlers}
      />,
    );
    expect(copySpy.mock.calls.length).toBeGreaterThan(before);
  });
});
