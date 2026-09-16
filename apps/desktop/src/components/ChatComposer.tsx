/**
 * ChatComposer — the chat input capsule, and the only place that owns the draft.
 *
 * SLICE1(composer-isolation): `draft` (plus the @-mention autocomplete state,
 * which only ever existed for the popover and the caret) used to be top-level
 * state in App.tsx, next to 50 other useStates — so every keystroke
 * re-rendered the sidebar, the transcript and every panel. The text now lives
 * HERE: typing re-renders this capsule and nothing else.
 *
 * App keeps only what is genuinely shared: the textarea node (`textareaRef`,
 * focused on new chat / Ctrl+N), the send path (`onSend`, fed the text already
 * composed with the speech interim tail exactly as `send()` used to build it),
 * and the switches that live outside the capsule (attachments, skills, live
 * run). The old `draftRef` + `setDraft` contract survives as
 * `ChatComposerHandle`, whose writes are state updates INSIDE this component —
 * so App's prefill / transcript / clear / steer-restore call sites never
 * re-render App.
 * The DOM is unchanged: same `.composer glass-capsule` wrapper, same order.
 */
import {
  memo, useCallback, useImperativeHandle, useRef, useState, type Dispatch,
  type KeyboardEvent as ReactKeyboardEvent, type Ref, type RefObject,
  type SetStateAction,
} from "react";
import { MentionPopup, applyMentionInsert, detectMentionQuery } from "./MentionPopup";
import { ComposerToolbar } from "./ComposerToolbar";
import { patchDesktopPrefs, type DesktopPrefs } from "../desktopPrefs";
import type { WorkspaceHit } from "../agentClient";
import type { DesktopConfig, DispatchMode, WorkPhase } from "../types";

/** Imperative surface App uses instead of a top-level `draft` useState. */
export interface ChatComposerHandle {
  /** Raw draft text, no speech tail — the old `draftRef.current`. */
  getText: () => string;
  /** The old `setDraft`: a value or an updater, applied inside the capsule. */
  setText: (next: string | ((prev: string) => string)) => void;
  /** The old `setMention(null)` in send(): drop a stale popover. */
  clearMention: () => void;
}

export interface ChatComposerProps {
  /** A run is live on this conversation: choices disable, send steers/queues. */
  running: boolean;
  /** Already resolved by App (speech > steer/queue > mode wording). */
  placeholder: string;
  /** The one textarea node: App owns focus and caret juggling (`taRef`). */
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  /** Composed text (draft + speech interim) — what `send()` expects. */
  onSend: (text: string) => void;
  onStop: () => void;
  speechListening: boolean; speechOk: boolean; speechInterim: string;
  speechError: string | null; onToggleSpeech: () => void;
  /** `cli !== null && !cli.ok`: the CLI is unusable, send is dead. */
  cliBlocked: boolean;
  attachmentsCount: number;
  /** A skill is pending: an empty composer is still sendable. */
  hasPendingSkill: boolean;
  liveSendMode: "steer" | "queue"; steerSupported: boolean;
  onPickExternalFiles: () => void; onOpenSkillPicker: () => void;
  onAttachPath: (hit: WorkspaceHit) => void; mentionCwd: string | null;
  /* --- pills (ComposerToolbar): the same props/handlers as before --- */
  config: DesktopConfig | null; provider: string; model: string;
  onProviderChange: (id: string) => void; onModelChange: (id: string) => void;
  onThinkingChange: (spec: string) => void; setConfig: (cfg: DesktopConfig) => void;
  setStatusLine: (msg: string) => void; setPrefs: Dispatch<SetStateAction<DesktopPrefs>>;
  prefs: DesktopPrefs; mode: DispatchMode;
  onModeChange: (mode: DispatchMode) => void; phase: WorkPhase;
  onPhaseChange: (phase: WorkPhase) => void; krakenGraph: boolean;
  setGraphMode: (value: boolean) => void; setGauntletLoop: (value: boolean) => void;
  /** React 19 ref-as-prop. */
  ref?: Ref<ChatComposerHandle>;
}

/** `[draft, interim].filter(Boolean).join(" ").trim()` — old `fromSpeech`. */
function composedText(draft: string, interim: string): string {
  return [draft, interim].filter(Boolean).join(" ").trim();
}

function ChatComposerImpl({
  ref, running, placeholder, textareaRef, onSend, onStop,
  speechListening, speechOk, speechInterim, speechError, onToggleSpeech,
  cliBlocked, attachmentsCount, hasPendingSkill, liveSendMode, steerSupported,
  onPickExternalFiles, onOpenSkillPicker, onAttachPath, mentionCwd, config,
  provider, model, onProviderChange, onModelChange, onThinkingChange,
  setConfig, setStatusLine, prefs, setPrefs, mode, onModeChange, phase,
  onPhaseChange, krakenGraph, setGraphMode, setGauntletLoop,
}: ChatComposerProps) {
  /** SLICE1(composer-isolation): the draft lives here now, not in App. */
  const [draft, setDraft] = useState("");
  const draftRef = useRef("");
  draftRef.current = draft;
  /** @-mention autocomplete (path after @): popover + caret only. */
  const [mention, setMention] = useState<{
    start: number;
    query: string;
  } | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [mentionHits, setMentionHits] = useState<WorkspaceHit[]>([]);

  // SLICE1(composer-isolation): App's handle on the text — reads, prefills,
  // restores and clears all go through here, so none of them needs a
  // top-level useState (and none of them re-renders App).
  useImperativeHandle(
    ref,
    () => ({
      getText: () => draftRef.current,
      setText: (next) => setDraft(next),
      clearMention: () => setMention(null),
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
      const ta = textareaRef.current;
      const caret = ta?.selectionStart ?? draft.length;
      const det = mention ?? detectMentionQuery(draft, caret);
      if (!det) return;
      const { text, caret: nextCaret } = applyMentionInsert(draft, det.start, caret, hit.path);
      setDraft(text);
      setMention(null);
      void onAttachPath(hit);
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(nextCaret, nextCaret);
      });
    },
    [draft, mention, onAttachPath, textareaRef],
  );

  /**
   * Enter / the send button. The capsule never clears itself here: `send()`
   * decides (it keeps the text when the CLI is unusable, restores it when a
   * steer lands too late) and clears through the handle — same order as
   * before the slice, minus the App re-render.
   */
  const submit = useCallback(() => {
    onSend(composedText(draft, speechInterim));
  }, [draft, speechInterim, onSend]);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (mention) {
      if (e.key === "Escape") { e.preventDefault(); setMention(null); return; }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMentionIndex((i) => (mentionHits.length ? (i + 1) % mentionHits.length : 0));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMentionIndex((i) => (mentionHits.length ? (i - 1 + mentionHits.length) % mentionHits.length : 0));
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        const hit = mentionHits[mentionIndex];
        if (hit) { e.preventDefault(); onPickMention(hit); return; }
      }
    }
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
  };

  return (
    <>
      {mention && (
        <MentionPopup
          cwd={mentionCwd}
          query={mention.query}
          open
          onPick={onPickMention}
          onClose={() => setMention(null)}
          activeIndex={mentionIndex}
          onActiveIndexChange={setMentionIndex}
          onHitsChange={setMentionHits}
        />
      )}
      <div className={`composer glass-capsule${speechListening ? " is-listening" : ""}`}>
        <button
          type="button" className="btn-skill-pick" title="Attach files (any folder)"
          aria-label="Attach files" onClick={() => void onPickExternalFiles()}
        >
          <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden>
            <path fill="currentColor" d="M16.5 6.5v10a4.5 4.5 0 1 1-9 0V7a3 3 0 1 1 6 0v9.5a1.5 1.5 0 1 1-3 0V8H12v8.5a3 3 0 1 0 6 0V6.5a4.5 4.5 0 1 0-9 0V16a6 6 0 1 0 12 0V7h-1.5z" />
          </svg>
        </button>
        <button
          type="button" className="btn-skill-pick" title="List & select a skill"
          aria-label="Skills" disabled={running} onClick={() => onOpenSkillPicker()}
        >
          <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden>
            <path fill="currentColor" d="M12 2l2.4 7.2H22l-6 4.4 2.3 7.2L12 16.8 5.7 20.8 8 13.6 2 9.2h7.6L12 2z" />
          </svg>
        </button>
        <button
          type="button"
          className={`btn-mic${speechListening ? " is-on" : ""}${!speechOk ? " is-unavailable" : ""}`}
          title={!speechOk ? "Speech recognition not available in this WebView" : speechListening ? "Stop listening" : "Speech to text"}
          aria-label="Speech to text" aria-pressed={speechListening}
          disabled={!speechOk || running} onClick={() => onToggleSpeech()}
        >
          {speechListening ? (
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden>
              <path fill="currentColor" d="M12 14a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v5a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden>
              <path fill="currentColor" d="M12 14a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v5a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z" />
            </svg>
          )}
        </button>
        <div className="composer-input-wrap">
          <textarea
            ref={textareaRef} value={draft}
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
              if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "Home" || e.key === "End") {
                onDraftChange(el.value, el.selectionStart ?? el.value.length);
              }
            }}
            onKeyDown={onKeyDown}
            placeholder={placeholder} rows={1}
          />
          {speechInterim ? (<div className="speech-interim" aria-live="polite">{speechInterim}</div>) : null}
          {speechError ? (<div className="speech-error" role="status">{speechError}</div>) : null}
        </div>
        {/* grok-round: pills bottom-left, send bottom-right, both on the
            row under the input (CSS grid in App.css — no wrapper needed here). */}
        <ComposerToolbar
          config={config} provider={provider} model={model} disabled={running}
          onProviderChange={onProviderChange} onModelChange={onModelChange}
          onThinkingChange={onThinkingChange} onConfigRefresh={setConfig}
          onStatus={setStatusLine} permissionPreset={prefs.permissionPreset}
          onPermissionPresetChange={(permissionPreset) => setPrefs((prev) => patchDesktopPrefs(prev, { permissionPreset }))}
          krakenExploreThinking={prefs.krakenExploreThinking}
          onKrakenExploreThinkingChange={(krakenExploreThinking) => setPrefs((prev) => patchDesktopPrefs(prev, { krakenExploreThinking }))}
          krakenGeneralThinking={prefs.krakenGeneralThinking}
          onKrakenGeneralThinkingChange={(krakenGeneralThinking) => setPrefs((prev) => patchDesktopPrefs(prev, { krakenGeneralThinking }))}
          krakenVerifyThinking={prefs.krakenVerifyThinking}
          onKrakenVerifyThinkingChange={(krakenVerifyThinking) => setPrefs((prev) => patchDesktopPrefs(prev, { krakenVerifyThinking }))}
          mode={mode} onModeChange={onModeChange} phase={phase}
          onPhaseChange={onPhaseChange} krakenGraph={krakenGraph}
          onKrakenGraphChange={setGraphMode} gauntlet={prefs.gauntletLoop}
          onGauntletChange={setGauntletLoop}
        />
        <div className="composer-actions">
          {running ? (
            <>
              <button
                type="button" className="btn-send"
                disabled={!(draft.trim() || speechInterim.trim()) && attachmentsCount === 0}
                onClick={() => submit()}
                title={liveSendMode === "steer" && steerSupported ? "Steer — applied at the next tool boundary" : "Queue follow-up — sends when this run ends"}
                aria-label={liveSendMode === "steer" && steerSupported ? "Steer running agent" : "Queue follow-up"}
              >
                <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M3 12h16M13 6l6 6-6 6" />
                </svg>
              </button>
              <button type="button" className="btn-stop" onClick={() => void onStop()} title="Stop">
                Stop
              </button>
            </>
          ) : (
            <button
              type="button" className="btn-send"
              disabled={(!(draft.trim() || speechInterim.trim()) && attachmentsCount === 0 && !hasPendingSkill) || cliBlocked}
              onClick={() => submit()}
              title="Send" aria-label="Send"
            >
              <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M12 19V5M5 12l7-7 7 7" />
              </svg>
            </button>
          )}
        </div>
      </div>
    </>
  );
}

/** Memoised: the capsule re-renders on its own props, never on App's deltas. */
export const ChatComposer = memo(ChatComposerImpl);
