/**
 * Web Speech API helper (WebView2 / Chromium).
 * Continuous listen until toggle off; interim + final chunks.
 */
import { useCallback, useEffect, useRef, useState } from "react";

export type MicState = "off" | "listening";

interface SpeechRecognitionLike extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  abort?: () => void;
  onresult: ((ev: SpeechRecognitionEventLike) => void) | null;
  onerror: ((ev: { error?: string }) => void) | null;
  onend: (() => void) | null;
}

interface SpeechRecognitionEventLike {
  resultIndex?: number;
  results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal?: boolean }>;
}

export function getSpeechRecognitionCtor():
  | (new () => SpeechRecognitionLike)
  | null {
  const w = window as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function useSpeechToText(options?: {
  /** Called with each finalized transcript segment. */
  onFinal?: (text: string) => void;
  /** Disable start (e.g. while agent is running). */
  disabled?: boolean;
  lang?: string;
}) {
  const onFinal = options?.onFinal;
  const disabled = options?.disabled ?? false;
  const lang = options?.lang;

  const [speechOk, setSpeechOk] = useState(false);
  const [mic, setMic] = useState<MicState>("off");
  const [interim, setInterim] = useState("");
  const [error, setError] = useState<string | null>(null);

  const recogRef = useRef<SpeechRecognitionLike | null>(null);
  const wantListen = useRef(false);
  const listenGen = useRef(0);
  const onFinalRef = useRef(onFinal);
  onFinalRef.current = onFinal;

  useEffect(() => {
    setSpeechOk(!!getSpeechRecognitionCtor());
  }, []);

  const stop = useCallback(() => {
    wantListen.current = false;
    listenGen.current += 1;
    const r = recogRef.current;
    recogRef.current = null;
    try {
      r?.abort?.();
    } catch {
      /* ignore */
    }
    try {
      r?.stop();
    } catch {
      /* ignore */
    }
    setMic("off");
    setInterim("");
  }, []);

  // Stop if disabled while listening (e.g. send started)
  useEffect(() => {
    if (disabled && mic === "listening") stop();
  }, [disabled, mic, stop]);

  useEffect(() => () => stop(), [stop]);

  const start = useCallback(() => {
    if (disabled) return;
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) {
      setError("Speech recognition not available in this WebView");
      return;
    }
    stop();
    const gen = ++listenGen.current;
    const rec = new Ctor();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = lang || navigator.language || "it-IT";
    wantListen.current = true;
    setMic("listening");
    setError(null);
    setInterim("");

    const attachHandlers = (target: SpeechRecognitionLike) => {
      target.onresult = (ev) => {
        if (listenGen.current !== gen || !wantListen.current) return;
        let interimText = "";
        let finalChunk = "";
        const results = ev.results;
        const resultIndex =
          typeof ev.resultIndex === "number" ? ev.resultIndex : 0;
        for (let i = resultIndex; i < results.length; i++) {
          const row = results[i];
          const piece = row?.[0]?.transcript ?? "";
          if ((row as { isFinal?: boolean }).isFinal) finalChunk += piece;
          else interimText += piece;
        }
        if (interimText) setInterim(interimText);
        else setInterim("");
        if (finalChunk.trim()) {
          const piece = finalChunk.trim();
          onFinalRef.current?.(piece);
          setInterim("");
        }
      };
      target.onerror = (ev) => {
        if (listenGen.current !== gen) return;
        if (ev.error === "aborted" || ev.error === "no-speech") return;
        setError(ev.error || "mic error");
        wantListen.current = false;
        setMic("off");
        setInterim("");
      };
      target.onend = () => {
        if (listenGen.current !== gen) return;
        recogRef.current = null;
        if (wantListen.current) {
          try {
            const again = new Ctor();
            again.continuous = true;
            again.interimResults = true;
            again.lang = lang || navigator.language || "it-IT";
            attachHandlers(again);
            recogRef.current = again;
            again.start();
          } catch {
            wantListen.current = false;
            setMic("off");
            setInterim("");
          }
        } else {
          setMic("off");
        }
      };
    };

    attachHandlers(rec);
    recogRef.current = rec;
    try {
      rec.start();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      wantListen.current = false;
      setMic("off");
    }
  }, [disabled, lang, stop]);

  const toggle = useCallback(() => {
    if (mic === "listening") {
      stop();
      return;
    }
    if (disabled) return;
    start();
  }, [mic, disabled, start, stop]);

  return {
    speechOk,
    mic,
    listening: mic === "listening",
    interim,
    error,
    start,
    stop,
    toggle,
    clearError: () => setError(null),
  };
}
