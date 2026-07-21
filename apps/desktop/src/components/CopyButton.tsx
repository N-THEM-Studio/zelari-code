/**
 * Small ghost icon button that copies text to the clipboard and shows a
 * transient "copied" checkmark. Clipboard + feedback are self-contained so
 * the button can be dropped into message headers, bubbles, and code blocks.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { copyTextToClipboard } from "../exportSession";

interface Props {
  /** Lazily read the text to copy at click time (avoids stale closures). */
  getText: () => string;
  /** Accessible label / tooltip. */
  title?: string;
  className?: string;
}

export function CopyButton({ getText, title = "Copy", className = "" }: Props) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  const onCopy = useCallback(
    async (e: React.MouseEvent) => {
      // Don't toggle an ancestor accordion / trigger text selection.
      e.stopPropagation();
      e.preventDefault();
      const ok = await copyTextToClipboard(getText());
      if (!ok) return;
      setCopied(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 1500);
    },
    [getText],
  );

  return (
    <button
      type="button"
      className={`copy-btn${copied ? " is-copied" : ""}${className ? ` ${className}` : ""}`}
      title={copied ? "Copied!" : title}
      aria-label={title}
      onClick={(e) => void onCopy(e)}
    >
      {copied ? (
        <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden>
          <path
            fill="none"
            stroke="currentColor"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
            d="m5 13 4 4L19 7"
          />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden>
          <rect
            x="9"
            y="9"
            width="11"
            height="11"
            rx="2"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          />
          <path
            d="M5 15V5a2 2 0 0 1 2-2h10"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
      )}
    </button>
  );
}
