/**
 * Floating HUD: voice → agent, show final answer only (no tools / thinking).
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { LogicalSize, getCurrentWindow } from "@tauri-apps/api/window";
import {
  cancelRun,
  extractDelta,
  getAppConfig,
  getCliStatus,
  onAgentEvent,
  onRunFinished,
  runTask,
} from "../agentClient";
import {
  OVERLAY_DEFAULT_WIDTH,
  OVERLAY_MAX_HEIGHT,
  OVERLAY_MIN_HEIGHT,
} from "../overlayWindow";
import type { DispatchMode, WorkPhase } from "../types";

type MicState = "off" | "listening" | "processing" | "agent_working";

const LS_DEFAULTS = "zelari-desktop-defaults-v1";
const LS_WORKDIR = "zelari-desktop-workdir";

interface SpeechRecognitionLike extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((ev: SpeechRecognitionEventLike) => void) | null;
  onerror: ((ev: { error?: string }) => void) | null;
  onend: (() => void) | null;
}

interface SpeechRecognitionEventLike {
  results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal?: boolean }>;
}

function getSpeechRecognitionCtor():
  | (new () => SpeechRecognitionLike)
  | null {
  const w = window as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

function readDefaults(): { mode: DispatchMode; phase: WorkPhase } {
  try {
    const raw = localStorage.getItem(LS_DEFAULTS);
    if (!raw) return { mode: "agent", phase: "build" };
    const j = JSON.parse(raw) as { mode?: string; phase?: string };
    const mode =
      j.mode === "council" || j.mode === "zelari" || j.mode === "agent"
        ? j.mode
        : "agent";
    const phase = j.phase === "plan" ? "plan" : "build";
    return { mode, phase };
  } catch {
    return { mode: "agent", phase: "build" };
  }
}

function writeDefaults(mode: DispatchMode, phase: WorkPhase) {
  try {
    localStorage.setItem(LS_DEFAULTS, JSON.stringify({ mode, phase }));
  } catch {
    /* ignore */
  }
}

function MicIcon({ state }: { state: MicState }) {
  if (state === "off") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden>
        <path d="M12 14a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v5a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z" />
        <path
          d="M4 4l16 16"
          stroke="currentColor"
          strokeWidth="2"
          fill="none"
        />
      </svg>
    );
  }
  if (state === "listening") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden>
        <path d="M12 14a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v5a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z" />
      </svg>
    );
  }
  // processing / agent_working — solid mic + activity
  return (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path d="M12 14a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v5a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z" />
      <circle cx="19" cy="5" r="2.5" />
    </svg>
  );
}

export function OverlayApp() {
  const defaults = readDefaults();
  const [mic, setMic] = useState<MicState>("off");
  const [draft, setDraft] = useState("");
  const [interim, setInterim] = useState("");
  const [answer, setAnswer] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [speechOk, setSpeechOk] = useState(false);
  const [hint, setHint] = useState("Final answer only");
  const [mode, setMode] = useState<DispatchMode>(defaults.mode);
  const [phase, setPhase] = useState<WorkPhase>(defaults.phase);
  /** User collapsed the answer panel (window shrinks). */
  const [answerCollapsed, setAnswerCollapsed] = useState(false);

  const answerBuf = useRef("");
  const recogRef = useRef<SpeechRecognitionLike | null>(null);
  const wantListen = useRef(false);
  /** Prevent double runTask (StrictMode / double speech final / Enter+click). */
  const submitLock = useRef(false);
  const shellRef = useRef<HTMLDivElement | null>(null);
  const answerPanelRef = useRef<HTMLDivElement | null>(null);
  const resizeRaf = useRef(0);
  const lastH = useRef(0);

  useEffect(() => {
    setSpeechOk(!!getSpeechRecognitionCtor());
  }, []);

  /** Grow/shrink the OS window to fit content (compact at rest, expand for answer). */
  const syncWindowSize = useCallback(() => {
    if (resizeRaf.current) cancelAnimationFrame(resizeRaf.current);
    resizeRaf.current = requestAnimationFrame(() => {
      const el = shellRef.current;
      if (!el) return;
      const contentH = Math.ceil(el.getBoundingClientRect().height);
      const nextH = Math.min(
        OVERLAY_MAX_HEIGHT,
        Math.max(OVERLAY_MIN_HEIGHT, contentH + 2),
      );
      if (Math.abs(nextH - lastH.current) < 2) return;
      lastH.current = nextH;
      const win = getCurrentWindow();
      void (async () => {
        try {
          const [phys, scale] = await Promise.all([
            win.innerSize(),
            win.scaleFactor(),
          ]);
          const w = Math.max(
            280,
            Math.round(phys.width / (scale || 1)) || OVERLAY_DEFAULT_WIDTH,
          );
          await win.setSize(new LogicalSize(w, nextH));
        } catch {
          /* non-tauri / permission */
        }
      })();
    });
  }, []);

  useLayoutEffect(() => {
    syncWindowSize();
  }, [
    answer,
    error,
    interim,
    running,
    mic,
    hint,
    answerCollapsed,
    mode,
    phase,
    syncWindowSize,
  ]);

  useEffect(() => {
    const el = shellRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => syncWindowSize());
    ro.observe(el);
    return () => ro.disconnect();
  }, [syncWindowSize]);

  // Keep answer panel scrolled to bottom while streaming
  useEffect(() => {
    const p = answerPanelRef.current;
    if (!p) return;
    p.scrollTop = p.scrollHeight;
  }, [answer, interim, error]);

  // Track agent runs — must unlisten even if cleanup races async setup
  // (React StrictMode remounts; missing unlisten → doubled deltas "CCiaoiao").
  useEffect(() => {
    let cancelled = false;
    const unsubs: Array<() => void> = [];

    const track = (fn: () => void) => {
      if (cancelled) {
        fn();
        return;
      }
      unsubs.push(fn);
    };

    void (async () => {
      const u1 = await onAgentEvent((ev) => {
        if (ev.type === "thinking_delta") return;
        if (
          ev.type === "tool_execution_start" ||
          ev.type === "tool_execution_end"
        )
          return;
        if (ev.type === "message_delta") {
          const d = extractDelta(ev);
          if (!d) return;
          answerBuf.current += d;
          setAnswer(answerBuf.current);
          setRunning(true);
          setMic((m) => (m === "listening" ? m : "agent_working"));
        }
      });
      track(u1);

      const u2 = await onRunFinished(() => {
        submitLock.current = false;
        setRunning(false);
        setMic((m) => (m === "listening" ? "listening" : "off"));
        setHint("Done");
      });
      track(u2);

      const { listen } = await import("@tauri-apps/api/event");
      const u3 = await listen("run-started", () => {
        answerBuf.current = "";
        setAnswer("");
        setError(null);
        setAnswerCollapsed(false);
        setRunning(true);
        setMic("agent_working");
        setHint("Working…");
      });
      track(u3);
    })();

    return () => {
      cancelled = true;
      for (const u of unsubs) {
        try {
          u();
        } catch {
          /* ignore */
        }
      }
      unsubs.length = 0;
    };
  }, []);

  const stopRecognition = useCallback(() => {
    wantListen.current = false;
    try {
      recogRef.current?.stop();
    } catch {
      /* ignore */
    }
    recogRef.current = null;
  }, []);

  const submitPrompt = useCallback(async (text: string) => {
    const prompt = text.trim();
    if (!prompt) return;
    if (submitLock.current) return;
    submitLock.current = true;

    setError(null);
    setDraft("");
    setInterim("");
    answerBuf.current = "";
    setAnswer("");
    setRunning(true);
    setMic("agent_working");
    setHint("Agent working…");

    try {
      const cli = await getCliStatus();
      if (!cli.ok) {
        throw new Error(cli.message || "CLI not ready");
      }
      const cfg = await getAppConfig();
      const workdir = localStorage.getItem(LS_WORKDIR);
      const provider = cfg.activeProviderId;
      const model =
        cfg.modelByProvider[provider] ||
        cfg.providers.find((p) => p.id === provider)?.defaultModel;

      writeDefaults(mode, phase);
      await runTask({
        prompt,
        mode,
        phase,
        provider: provider || undefined,
        model: model || undefined,
        cwd: workdir || undefined,
      });
    } catch (e) {
      submitLock.current = false;
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      setRunning(false);
      setMic("off");
      setHint("Error");
    }
  }, [mode, phase]);
  const startListening = useCallback(() => {
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) {
      setError("Speech recognition not available in this WebView");
      return;
    }
    stopRecognition();
    const rec = new Ctor();
    rec.continuous = false;
    rec.interimResults = true;
    rec.lang = navigator.language || "it-IT";
    wantListen.current = true;
    setMic("listening");
    setError(null);
    setHint("Listening…");
    setInterim("");

    rec.onresult = (ev) => {
      let interimText = "";
      let finalText = "";
      const results = ev.results;
      for (let i = 0; i < results.length; i++) {
        const row = results[i];
        const piece = row?.[0]?.transcript ?? "";
        if ((row as { isFinal?: boolean }).isFinal) finalText += piece;
        else interimText += piece;
      }
      if (interimText) setInterim(interimText);
      if (finalText.trim()) {
        // One-shot: stop before submit so onend/onresult cannot re-fire send
        wantListen.current = false;
        try {
          rec.stop();
        } catch {
          /* ignore */
        }
        recogRef.current = null;
        setMic("processing");
        setHint("Sending…");
        setDraft(finalText.trim());
        setInterim("");
        void submitPrompt(finalText.trim());
      }
    };
    rec.onerror = (ev) => {
      if (ev.error === "aborted" || ev.error === "no-speech") {
        if (wantListen.current) setMic("off");
        return;
      }
      setError(ev.error || "mic error");
      setMic("off");
      wantListen.current = false;
    };
    rec.onend = () => {
      recogRef.current = null;
      if (wantListen.current && !running) {
        // one-shot ended without final — back off
        setMic("off");
        wantListen.current = false;
        setHint("Mic off");
      }
    };

    recogRef.current = rec;
    try {
      rec.start();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setMic("off");
    }
  }, [running, stopRecognition, submitPrompt]);

  const toggleMic = useCallback(() => {
    if (mic === "listening") {
      stopRecognition();
      setMic("off");
      setInterim("");
      setHint("Mic off");
      return;
    }
    if (running || mic === "agent_working" || mic === "processing") return;
    startListening();
  }, [mic, running, startListening, stopRecognition]);

  const onSend = () => {
    if (running) return;
    void submitPrompt(draft || interim);
  };

  const onStopAgent = async () => {
    try {
      await cancelRun();
      setHint("Cancelling…");
    } catch {
      /* ignore */
    }
  };

  const closeWin = () => {
    stopRecognition();
    void getCurrentWindow().close().catch(() => undefined);
  };

  const startDrag = () => {
    void getCurrentWindow().startDragging().catch(() => undefined);
  };

  const displayAnswer = error
    ? error
    : answer || (interim ? `… ${interim}` : "");
  const hasAnswer = Boolean(displayAnswer);
  const showAnswerBody = hasAnswer && !answerCollapsed;
  const showHint = Boolean(error) || mic === "listening" || running;

  const onModeChange = (m: DispatchMode) => {
    setMode(m);
    writeDefaults(m, phase);
  };
  const onPhaseChange = (p: WorkPhase) => {
    setPhase(p);
    writeDefaults(mode, p);
  };

  return (
    <div className="overlay-shell" ref={shellRef}>
      <div className="overlay-top">
        <button
          type="button"
          className={`mic-btn ${mic}`}
          title={
            mic === "listening"
              ? "Stop listening"
              : speechOk
                ? "Start voice input"
                : "Voice unavailable — type below"
          }
          aria-label="Microphone"
          disabled={
            (!speechOk && mic === "off") ||
            mic === "processing" ||
            (running && mic !== "listening")
          }
          onClick={toggleMic}
        >
          <MicIcon state={mic} />
        </button>

        <span
          className={`status-pill ${running ? "working" : ""}`}
          title={hint}
        >
          <span className="dot" />
          {running
            ? "Work"
            : mic === "listening"
              ? "Mic"
              : mic === "processing"
                ? "…"
                : "Idle"}
        </span>

        <div className="overlay-drag" onMouseDown={startDrag} />

        <select
          className="overlay-select"
          value={mode}
          disabled={running}
          title="Mode"
          aria-label="Mode"
          onChange={(e) => onModeChange(e.target.value as DispatchMode)}
        >
          <option value="agent">agent</option>
          <option value="council">council</option>
          <option value="zelari">zelari</option>
        </select>
        <select
          className="overlay-select"
          value={phase}
          disabled={running}
          title="Phase"
          aria-label="Phase"
          onChange={(e) => onPhaseChange(e.target.value as WorkPhase)}
        >
          <option value="plan">plan</option>
          <option value="build">build</option>
        </select>

        {running ? (
          <button
            type="button"
            className="overlay-close"
            title="Stop agent"
            onClick={() => void onStopAgent()}
          >
            ■
          </button>
        ) : null}
        <button
          type="button"
          className="overlay-close"
          title="Close overlay"
          onClick={closeWin}
        >
          ×
        </button>
      </div>

      <div className="overlay-row">
        <input
          className="overlay-input"
          value={draft}
          placeholder={speechOk ? "Speak or type…" : "Type…"}
          disabled={running}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              onSend();
            }
          }}
        />
        <button
          type="button"
          className="overlay-send"
          disabled={running || !(draft.trim() || interim.trim())}
          onClick={onSend}
        >
          →
        </button>
      </div>

      {hasAnswer ? (
        <div className="answer-chrome">
          <button
            type="button"
            className="answer-toggle"
            onClick={() => setAnswerCollapsed((c) => !c)}
            title={answerCollapsed ? "Expand answer" : "Collapse answer"}
          >
            <span className="answer-toggle-label">
              {answerCollapsed ? "Answer" : "Answer"}
            </span>
            <span className="answer-toggle-chevron" aria-hidden>
              {answerCollapsed ? "▸" : "▾"}
            </span>
          </button>
          {showAnswerBody ? (
            <div
              ref={answerPanelRef}
              className={`answer-panel ${error ? "error" : ""}`}
            >
              {displayAnswer}
            </div>
          ) : null}
        </div>
      ) : null}

      {showHint ? <div className="hint">{hint}</div> : null}
    </div>
  );
}
