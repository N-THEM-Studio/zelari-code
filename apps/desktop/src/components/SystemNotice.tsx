/**
 * SystemNotice — one system line rendered by what it means, not as a red box.
 *
 * Tone drives the color and icon (error / warning / info / success); a card
 * shows a short title, a plain explanation, the next step ("→") and — when the
 * line came with raw provider output — collapsible technical details. Progress
 * notes and confirmations use the compact one-line variant so they never
 * compete with the conversation. Classification lives in ../systemNotice.ts.
 */
import type { Notice, NoticeTone } from "../systemNotice";
import { CopyButton } from "./CopyButton";
import "./systemNotice.css";

function ToneIcon({ tone }: { tone: NoticeTone }) {
  const common = {
    viewBox: "0 0 16 16",
    className: "notice-icon-svg",
    "aria-hidden": true as const,
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.6,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  if (tone === "error") {
    return (
      <svg {...common}>
        <circle cx="8" cy="8" r="6.2" />
        <path d="M5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4" />
      </svg>
    );
  }
  if (tone === "warning") {
    return (
      <svg {...common}>
        <path d="M8 2.2l6 10.6H2z" />
        <path d="M8 6.4v3M8 11.2h.01" />
      </svg>
    );
  }
  if (tone === "success") {
    return (
      <svg {...common}>
        <circle cx="8" cy="8" r="6.2" />
        <path d="M5.3 8.2l1.9 1.9 3.6-3.8" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <circle cx="8" cy="8" r="6.2" />
      <path d="M8 7.3v3.6M8 5.1h.01" />
    </svg>
  );
}

export function SystemNotice({ notice, raw }: { notice: Notice; raw: string }) {
  const role = notice.tone === "error" ? "alert" : "status";
  if (notice.compact) {
    return (
      <div className={`notice notice-compact notice-${notice.tone}`} role={role}>
        <span className="notice-icon">
          <ToneIcon tone={notice.tone} />
        </span>
        <span className="notice-compact-text">
          <span className="notice-title">{notice.title}</span>
          {notice.body ? <span className="notice-compact-body">{notice.body}</span> : null}
        </span>
      </div>
    );
  }
  return (
    <div className={`notice notice-card notice-${notice.tone}`} role={role}>
      <span className="notice-icon">
        <ToneIcon tone={notice.tone} />
      </span>
      <div className="notice-main">
        <div className="notice-title">{notice.title}</div>
        {notice.body ? <div className="notice-body">{notice.body}</div> : null}
        {notice.hint ? (
          <div className="notice-hint">
            <span aria-hidden>→</span> {notice.hint}
          </div>
        ) : null}
        {notice.details ? (
          <details className="notice-details">
            <summary>Technical details</summary>
            <pre>{notice.details}</pre>
          </details>
        ) : null}
      </div>
      <CopyButton className="notice-copy" getText={() => raw} title="Copy message" />
    </div>
  );
}
