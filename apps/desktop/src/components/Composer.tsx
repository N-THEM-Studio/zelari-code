/**
 * Composer input (W3.2): textarea + mention popup + toolbar + send/stop.
 *
 * The typed text lives HERE, not in App, so a keystroke re-renders only this
 * component and its siblings — never the message list or the sidebar. App reads
 * or writes the value imperatively (queued-follow-up prefill, steer recovery,
 * new-chat focus) through the {@link ComposerHandle} ref.
 */
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ComponentProps,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import type { DispatchMode } from "../types";
import type { WorkspaceHit } from "../agentClient";
import { ComposerToolbar } from "./ComposerToolbar";
import {
  MentionPopup,
  applyMentionInsert,
  detectMentionQuery,
} from "./MentionPopup";
import { ComposerMediaButtons } from "./ComposerMediaButtons";
import { ComposerSendButtons } from "./ComposerSendButtons";

export interface ComposerHandle {
  /** Current text (mirrors state synchronously for outside readers). */
  getValue(): string;
  setValue(value: string): void;
  updateValue(updater: (prev: string) => string): void;
  focus(): void;
}

interface SpeechSlice {
  listening: boolean;
  speechOk: boolean;
  interim: string;
  error: string | null;
  toggle: () => void;
}

interface Props {
  /** Workspace cwd for @-mention autocomplete. */
  cwd: string | null;
  /** Seed text applied when it changes and the field is still empty. */
  prefill: string;
  running: boolean;
  /** `cli !== null && !cli.ok` — blocks send until the CLI is fixed. */
  cliBlocked: boolean;
  mode: DispatchMode;
  liveSendMode: "steer" | "queue";
  steerSupported: boolean;
  attachmentCount: number;
  hasPendingSkill: boolean;
  /** Speech-to-text slice; the hook itself lives in App (send reads interim). */
  speech: SpeechSlice;
  /** Props forwarded verbatim to <ComposerToolbar>. */
  toolbar: ComponentProps<typeof ComposerToolbar>;
  onSubmit: (text: string) => void;
  onStop: () => void;
  onPickExternalFiles: () => void;
  onOpenSkillPicker: () => void;
  onAttachPath: (hit: WorkspaceHit) => void;
}

export const Composer = forwardRef<ComposerHandle, Props>(function Composer(
  {
    cwd,
    prefill,
    running,
    cliBlocked,
    mode,
    liveSendMode,
    steerSupported,
    attachmentCount,
    hasPendingSkill,
    speech,
    toolbar,
    onSubmit,
    onStop,
    onPickExternalFiles,
    onOpenSkillPicker,
    onAttachPath,
  },
  ref,
) {
  const [draft, setDraft] = useState("");
  const draftRef = useRef("");
  draftRef.current = draft;
  const taRef = useRef<HTMLTextAreaElement>(null);
  /** @-mention autocomplete (path after @). */
  const [mention, setMention] = useState<{ start: number; query: string } | null>(
    null,
  );
  const [mentionIndex, setMentionIndex] = useState(0);
  const [mentionHits, setMentionHits] = useState<WorkspaceHit[]>([]);

  // Persisted follow-up prefill: only fills an empty field (never clobbers typing).
  useEffect(() => {
    if (!prefill) return;
    setDraft((prev) => (prev.trim() ? prev : prefill));
  }, [prefill]);

  useImperativeHandle(
    ref,
    () => ({
      getValue: () => draftRef.current,
      setValue: (value) => setDraft(value),
      updateValue: (updater) => setDraft((prev) => updater(prev)),
      focus: () => taRef.current?.focus(),
    }),
    [],
  );

  const onDraftChange = useCallback((value: string, caret?: number) => {
    setDraft(value);
    const c = caret ?? value.length;
    const det = detectMentionQuery(value, c);
    setMention(det);
    if (!det) setMentionIndex(0);
  }, []);

  const onPickMention = useCallback(
    (hit: WorkspaceHit) => {
      const ta = taRef.current;
      const caret = ta?.selectionStart ?? draft.length;
      const det = mention ?? detectMentionQuery(draft, caret);
      if (!det) return;
      const { text, caret: nextCaret } = applyMentionInsert(
        draft,
        det.start,
        caret,
        hit.path,
      );
      setDraft(text);
      setMention(null);
      onAttachPath(hit);
      requestAnimationFrame(() => {
        const el = taRef.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(nextCaret, nextCaret);
      });
    },
    [draft, mention, onAttachPath],
  );

  /** Enter / send button: hand the composed text up, clear any open mention. */
  const submit = useCallback(() => {
    if (!running) setMention(null);
    onSubmit([draft, speech.interim].filter(Boolean).join(" ").trim());
  }, [running, draft, speech.interim, onSubmit]);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (mention) {
      if (e.key === "Escape") {
        e.preventDefault();
        setMention(null);
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMentionIndex((i) =>
          mentionHits.length ? (i + 1) % mentionHits.length : 0,
        );
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMentionIndex((i) =>
          mentionHits.length
            ? (i - 1 + mentionHits.length) % mentionHits.length
            : 0,
        );
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        const hit = mentionHits[mentionIndex];
        if (hit) {
          e.preventDefault();
          onPickMention(hit);
          return;
        }
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="composer-stack">
      {mention && (
        <MentionPopup
          cwd={cwd}
          query={mention.query}
          open
          onPick={onPickMention}
          onClose={() => setMention(null)}
          activeIndex={mentionIndex}
          onActiveIndexChange={setMentionIndex}
          onHitsChange={setMentionHits}
        />
      )}
      <div
        className={`composer glass-capsule${speech.listening ? " is-listening" : ""}`}
      >
        <ComposerMediaButtons
          running={running}
          speechOk={speech.speechOk}
          listening={speech.listening}
          onPickExternalFiles={onPickExternalFiles}
          onOpenSkillPicker={onOpenSkillPicker}
          onToggleSpeech={speech.toggle}
        />
        <div className="composer-input-wrap">
          <textarea
            ref={taRef}
            value={draft}
            onChange={(e) => {
              const el = e.target;
              onDraftChange(el.value, el.selectionStart ?? el.value.length);
            }}
            onClick={(e) => {
              const el = e.currentTarget;
              onDraftChange(el.value, el.selectionStart ?? el.value.length);
            }}
            onKeyUp={(e) => {
              const el = e.currentTarget;
              if (
                e.key === "ArrowLeft" ||
                e.key === "ArrowRight" ||
                e.key === "Home" ||
                e.key === "End"
              ) {
                onDraftChange(el.value, el.selectionStart ?? el.value.length);
              }
            }}
            onKeyDown={onKeyDown}
            placeholder={
              speech.listening
                ? "Listening… speak now"
                : running
                  ? liveSendMode === "steer" && steerSupported
                    ? "Steer the running agent… (applied at the next tool boundary)"
                    : "Queue a follow-up… (sends when this run ends)"
                  : mode === "zelari"
                    ? "Describe the mission… (@file to tag)"
                    : mode === "council"
                      ? "Ask the council… (@file · Skills ★)"
                      : "Message the agent… (@file to tag paths)"
            }
            rows={1}
          />
          {speech.interim ? (
            <div className="speech-interim" aria-live="polite">
              {speech.interim}
            </div>
          ) : null}
          {speech.error ? (
            <div className="speech-error" role="status">
              {speech.error}
            </div>
          ) : null}
        </div>
        {/* grok-round: pills bottom-left, send bottom-right, both on the
            row under the input (CSS grid in App.css — no wrapper needed here). */}
        <ComposerToolbar {...toolbar} />
        <div className="composer-actions">
          <ComposerSendButtons
            running={running}
            liveSendMode={liveSendMode}
            steerSupported={steerSupported}
            hasText={Boolean(draft.trim() || speech.interim.trim())}
            attachmentCount={attachmentCount}
            hasPendingSkill={hasPendingSkill}
            cliBlocked={cliBlocked}
            onSubmit={submit}
            onStop={onStop}
          />
        </div>
      </div>
    </div>
  );
});
