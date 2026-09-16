// @vitest-environment jsdom
/**
 * ChatComposer (SLICE1 — composer isolation) contract under test:
 *   - the capsule OWNS the draft: typing re-renders it and tells App nothing
 *     (no `onDraftChange` prop exists, so a keystroke cannot reach App);
 *   - Enter sends, Shift+Enter does not, the send button sends the same text,
 *     and the speech interim tail is still merged into what `onSend` receives
 *     (the string App's `send()` used to build from `[draft, speech.interim]`);
 *   - the imperative `ChatComposerHandle` does everything App's old
 *     `draftRef` + `setDraft` pair did: read, prefill, updater-write;
 *   - the DOM App mounts is the same capsule: `.composer.glass-capsule`, the
 *     attach/skills/mic buttons, the input, and the `.composer-actions` row.
 *
 * vi.mock('react'): same double-React pin as ComposerToolbar.test.tsx and
 * Sidebar.test.tsx (apps/desktop has its own node_modules copy of React while
 * @testing-library/react at the root uses the root one — two Reacts in one
 * module graph break hooks with "Cannot read properties of null (reading
 * 'useState')").
 */
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatComposer, type ChatComposerHandle } from "./ChatComposer";
import { loadDesktopPrefs } from "../desktopPrefs";
import type { WorkPhase } from "../types";

vi.mock("react", async () => {
  // @ts-expect-error tsc: importing the runtime entry loses type info by design
  return await import("../../../../node_modules/react/index.js");
});

afterEach(cleanup);

const noop = () => {};

function mount(
  onSend: (text: string) => void,
  ref: { current: ChatComposerHandle | null },
  speechInterim = "",
  speechListening = false,
) {
  const textareaRef = { current: null as HTMLTextAreaElement | null };
  const view = render(
    <ChatComposer
      ref={ref}
      running={false}
      placeholder="Message the agent… (@file to tag paths)"
      textareaRef={textareaRef}
      onSend={onSend}
      onStop={noop}
      speechListening={speechListening}
      speechOk={speechListening}
      speechInterim={speechInterim}
      speechError={null}
      onToggleSpeech={noop}
      cliBlocked={false}
      attachmentsCount={0}
      hasPendingSkill={false}
      liveSendMode="queue"
      steerSupported={false}
      onPickExternalFiles={noop}
      onOpenSkillPicker={noop}
      onAttachPath={noop}
      mentionCwd={null}
      config={null}
      provider=""
      model=""
      onProviderChange={noop}
      onModelChange={noop}
      onThinkingChange={noop}
      setConfig={noop}
      setStatusLine={noop}
      prefs={loadDesktopPrefs()}
      setPrefs={noop}
      mode="zelari"
      onModeChange={noop}
      phase={"code" as unknown as WorkPhase}
      onPhaseChange={noop}
      krakenGraph={false}
      setGraphMode={noop}
      setGauntletLoop={noop}
    />,
  );
  return { textareaRef, view };
}

const textarea = () => screen.getByRole("textbox") as HTMLTextAreaElement;
const sendButton = () => screen.getByLabelText("Send") as HTMLButtonElement;

describe("ChatComposer keeps the draft to itself", () => {
  it("typing updates the field in place, gates the send button, sends nothing", () => {
    const onSend = vi.fn();
    mount(onSend, { current: null });
    expect(sendButton().disabled).toBe(true); // empty draft → dead button
    fireEvent.change(textarea(), { target: { value: "ciao" } });
    expect(textarea().value).toBe("ciao");
    expect(sendButton().disabled).toBe(false);
    expect(onSend).not.toHaveBeenCalled();
  });

  it("Enter sends the local text, Shift+Enter does not", () => {
    const onSend = vi.fn();
    mount(onSend, { current: null });
    fireEvent.change(textarea(), { target: { value: "hello" } });
    fireEvent.keyDown(textarea(), { key: "Enter", shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(textarea(), { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("hello");
  });

  it("the send button sends the local text", () => {
    const onSend = vi.fn();
    mount(onSend, { current: null });
    fireEvent.change(textarea(), { target: { value: "from the button" } });
    fireEvent.click(sendButton());
    expect(onSend).toHaveBeenCalledWith("from the button");
  });

  it("the speech interim tail is still merged into what send() receives", () => {
    const onSend = vi.fn();
    mount(onSend, { current: null }, "detto a voce", true);
    fireEvent.change(textarea(), { target: { value: "testo" } });
    fireEvent.keyDown(textarea(), { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("testo detto a voce");
  });

  it("the handle reads, prefills and updater-writes the text", () => {
    const ref = { current: null as ChatComposerHandle | null };
    mount(noop, ref);
    fireEvent.change(textarea(), { target: { value: "draft text" } });
    expect(ref.current?.getText()).toBe("draft text");
    act(() => ref.current?.setText("prefilled from a chip"));
    expect(textarea().value).toBe("prefilled from a chip");
    // The `setDraft(prev => …)` shape App still uses (queue prefill, steer
    // restore): a non-empty field is left alone.
    act(() => ref.current?.setText((prev) => (prev.trim() ? prev : "ignored")));
    expect(ref.current?.getText()).toBe("prefilled from a chip");
    // …and a plain clear, the shape `newChat` / `Ctrl+N` use.
    act(() => ref.current?.setText(""));
    expect(textarea().value).toBe("");
  });
});

describe("ChatComposer owns the @-mention keys too", () => {
  it("typing @ opens the popover, Escape closes it", () => {
    mount(noop, { current: null });
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.change(textarea(), { target: { value: "@", selectionStart: 1 } });
    expect(screen.getByRole("listbox").textContent).toContain(
      "Open a project folder to @-tag files.",
    );
    fireEvent.keyDown(textarea(), { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("arrow keys move the highlight without touching the draft", () => {
    mount(noop, { current: null });
    fireEvent.change(textarea(), { target: { value: "@a", selectionStart: 2 } });
    const popover = screen.getByRole("listbox");
    fireEvent.keyDown(textarea(), { key: "ArrowDown" });
    fireEvent.keyDown(textarea(), { key: "ArrowUp" });
    expect(screen.getByRole("listbox")).toBe(popover); // still the same node
    expect(textarea().value).toBe("@a");
  });

  it("Tab and an empty popover never send; Enter still does (pre-slice rule)", () => {
    const onSend = vi.fn();
    mount(onSend, { current: null });
    fireEvent.change(textarea(), { target: { value: "@a", selectionStart: 2 } });
    fireEvent.keyDown(textarea(), { key: "Tab" });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(textarea(), { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("@a");
  });
});

describe("ChatComposer renders the same capsule App used to hold", () => {
  it("keeps the wrapper, the three lead buttons, the input and the send row", () => {
    const { view } = mount(noop, { current: null });
    const capsule = view.container.querySelector(".composer.glass-capsule");
    expect(capsule).not.toBeNull();
    const wrap = capsule as HTMLElement;
    expect(wrap.querySelector('[aria-label="Attach files"]')).not.toBeNull();
    expect(wrap.querySelector('[aria-label="Skills"]')).not.toBeNull();
    expect(wrap.querySelector('[aria-label="Speech to text"]')).not.toBeNull();
    expect(wrap.querySelector("textarea")).toBe(textarea());
    expect(wrap.querySelector(".composer-input-wrap")?.contains(textarea())).toBe(
      true,
    );
    expect(wrap.querySelector(".composer-actions")).not.toBeNull();
    expect(wrap.querySelector("[aria-label='Send']")).toBe(sendButton());
    expect(textarea().getAttribute("placeholder")).toBe(
      "Message the agent… (@file to tag paths)",
    );
  });

  it("shows the speech interim and error lines inside the input wrapper", () => {
    const { view } = mount(noop, { current: null }, "in ascolto…");
    const interim = view.container.querySelector(".speech-interim");
    expect(interim?.textContent).toBe("in ascolto…");
    expect(view.container.querySelector(".speech-error")).toBeNull();
  });
});
