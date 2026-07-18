/**
 * Live run stage: fixed kicker (Council / Agent / Mission) + rotating body
 * with soft fade (thinking phrases, tools, member names).
 */
import { useEffect, useState } from "react";
import type { DispatchMode } from "../types";
import {
  COUNCIL_THINKING_PHRASES,
  THINKING_PHRASES,
} from "./toolLabels";

interface Props {
  running: boolean;
  mode: DispatchMode;
  /** Active council / agent display name */
  memberName?: string | null;
  /** Current tool activity line (friendly English) */
  toolLabel?: string | null;
}

function modeKicker(mode: DispatchMode): string {
  if (mode === "council") return "Council";
  if (mode === "zelari") return "Mission";
  return "Agent";
}

export function RunActivity({
  running,
  mode,
  memberName,
  toolLabel,
}: Props) {
  const phrases =
    mode === "council" ? COUNCIL_THINKING_PHRASES : THINKING_PHRASES;
  const [phraseIdx, setPhraseIdx] = useState(0);
  const [fade, setFade] = useState(true);
  const [line, setLine] = useState<{ title: string; sub?: string }>({
    title: phrases[0],
  });

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
          sub: memberName || undefined,
        });
      } else if (memberName && mode === "council") {
        setLine({
          title: memberName,
          sub: "speaking…",
        });
      } else {
        setLine({
          title: phrases[phraseIdx % phrases.length],
        });
      }
      setFade(true);
    }, 280);
    return () => window.clearTimeout(t);
  }, [running, toolLabel, memberName, mode, phraseIdx, phrases]);

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
      </div>
    </div>
  );
}
