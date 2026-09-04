/**
 * Live run stage: fixed kicker (Council / Agent / Mission) + rotating body
 * with soft fade (thinking phrases, tools, member names) and a running
 * tool-step feed so the user can see what the agent is doing.
 */
import { useEffect, useState } from "react";
import type { DispatchMode } from "../types";
import {
  COUNCIL_THINKING_PHRASES,
  THINKING_PHRASES,
} from "./toolLabels";

export interface LiveToolStep {
  id: string;
  name: string;
  summary: string;
  status: "running" | "done" | "error";
}

interface Props {
  running: boolean;
  mode: DispatchMode;
  /** Active council / agent display name */
  memberName?: string | null;
  /** Current tool activity line (friendly English) */
  toolLabel?: string | null;
  /** This-turn tool calls (newest last). */
  steps?: LiveToolStep[];
  /** Wall-clock start of the current run (elapsed ticker). */
  startedAt?: number;
  /** True while the provider is emitting hidden thinking tokens. */
  reasoning?: boolean;
}

function modeKicker(mode: DispatchMode): string {
  if (mode === "council") return "Council";
  if (mode === "zelari") return "Zelari mission";
  return "Kraken";
}

export function formatRunElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0s";
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

export function RunActivity({
  running,
  mode,
  memberName,
  toolLabel,
  steps = [],
  startedAt,
  reasoning = false,
}: Props) {
  const phrases =
    mode === "council" ? COUNCIL_THINKING_PHRASES : THINKING_PHRASES;
  const [phraseIdx, setPhraseIdx] = useState(0);
  const [fade, setFade] = useState(true);
  const [now, setNow] = useState(() => Date.now());
  const [line, setLine] = useState<{ title: string; sub?: string }>({
    title: phrases[0],
  });
  /** Feed starts collapsed to the last few steps; tap to expand. */
  const [stepsOpen, setStepsOpen] = useState(false);

  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [running]);

  const elapsed =
    startedAt && startedAt > 0 ? formatRunElapsed(now - startedAt) : undefined;

  // Rotate thinking phrases when idle (no active tool label)
  useEffect(() => {
    if (!running || toolLabel) return;
    const id = window.setInterval(() => {
      setFade(false);
      window.setTimeout(() => {
        setPhraseIdx((i) => (i + 1) % phrases.length);
        setFade(true);
      }, 320);
    }, 2800);
    return () => window.clearInterval(id);
  }, [running, toolLabel, phrases.length]);

  // Resolve rotating body only (kicker stays fixed)
  useEffect(() => {
    if (!running) return;
    setFade(false);
    const t = window.setTimeout(() => {
      if (toolLabel) {
        setLine({
          title: toolLabel,
          sub: [memberName, elapsed].filter(Boolean).join(" · ") || undefined,
        });
      } else if (memberName && mode === "council") {
        setLine({
          title: memberName,
          sub: elapsed ? `speaking · ${elapsed}` : "speaking…",
        });
      } else if (reasoning) {
        setLine({
          title: elapsed ? `Reasoning · ${elapsed}` : "Reasoning",
        });
      } else {
        setLine({
          title: phrases[phraseIdx % phrases.length],
          sub: elapsed,
        });
      }
      setFade(true);
    }, 280);
    return () => window.clearTimeout(t);
  }, [running, toolLabel, memberName, mode, phraseIdx, phrases, reasoning, elapsed]);

  if (!running) return null;

  const kicker = modeKicker(mode);

  return (
    <div className="run-activity" aria-live="polite" aria-busy="true">
      <div className="run-activity-orb" aria-hidden />
      <div className="run-activity-main">
        {/* Fixed mini-title — does not fade/rotate */}
        <div className="run-activity-kicker">{kicker}</div>
        <div
          className={`run-activity-stage${fade ? " is-in" : " is-out"}`}
          key={line.title + (line.sub ?? "")}
        >
          <div className="run-activity-title">{line.title}</div>
          {line.sub ? (
            <div className="run-activity-sub">{line.sub}</div>
          ) : null}
        </div>
        {steps.length > 0 ? (
          <ol className="run-activity-steps" aria-label="Live tool activity">
            {(stepsOpen ? steps.slice(-8) : steps.slice(-3)).map((s) => (
              <li
                key={s.id}
                className={`run-activity-step is-${s.status}`}
              >
                <span className="run-activity-step-mark" aria-hidden>
                  {s.status === "running"
                    ? "▶"
                    : s.status === "error"
                      ? "✗"
                      : "✓"}
                </span>
                <span className="run-activity-step-name">{s.name}</span>
                {s.summary ? (
                  <span className="run-activity-step-sum">{s.summary}</span>
                ) : null}
              </li>
            ))}
          </ol>
        ) : null}
        {!stepsOpen && steps.length > 3 ? (
          <button
            type="button"
            className="run-activity-steps-toggle"
            onClick={() => setStepsOpen(true)}
          >
            +{steps.length - 3} more tool call
            {steps.length - 3 === 1 ? "" : "s"} this turn
          </button>
        ) : null}
      </div>
    </div>
  );
}
