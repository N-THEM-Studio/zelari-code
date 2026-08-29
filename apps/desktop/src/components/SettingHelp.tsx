import {
  useCallback,
  useEffect,
 useId,
  useRef,
  useState,
  type ReactNode,
} from "react";

export type SettingHelpProps = {
  id?: string;
  label: string;
  children: ReactNode;
};

type Placement = { flipLeft: boolean; dropBelow: boolean; maxWidth: number };

const TOOLTIP_WIDTH = 300;

/**
 * Accessible ⓘ help: visible on hover and keyboard focus, closable with Escape.
 * Do not rely on CSS :hover alone — the trigger is a real button.
 *
 * Placement is measured before opening: the tooltip flips to the left and/or
 * drops below the trigger when there is not enough room, so it never gets
 * clipped by scroll containers (which used to cut it and cause overflow).
 */
export function SettingHelp({ id, label, children }: SettingHelpProps) {
  const autoId = useId();
  const tooltipId = id ?? `setting-help-${autoId.replace(/:/g, "")}`;
  const wrapRef = useRef<HTMLSpanElement | null>(null);
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<Placement>({
    flipLeft: false,
    dropBelow: false,
    maxWidth: TOOLTIP_WIDTH,
  });

  const close = useCallback(() => setOpen(false), []);

  const measureAndOpen = useCallback(() => {
    const el = wrapRef.current;
    if (!el) {
      setOpen(true);
      return;
    }
    const rect = el.getBoundingClientRect();
    const roomRight = window.innerWidth - rect.left - 12;
    const roomLeft = rect.right - 12;
    const flipLeft =
      roomRight < Math.min(TOOLTIP_WIDTH, 240) && roomLeft > roomRight;
    const available = Math.max(
      200,
      Math.min(TOOLTIP_WIDTH, flipLeft ? roomLeft : roomRight),
    );
    setPlacement({
      flipLeft,
      dropBelow: rect.top < 200,
      maxWidth: available,
    });
    setOpen(true);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  return (
    <span
      ref={wrapRef}
      className={`setting-help${open ? " is-open" : ""}${
        placement.flipLeft ? " flip-left" : ""
      }${placement.dropBelow ? " drop-below" : ""}`}
      onMouseEnter={measureAndOpen}
      onMouseLeave={close}
    >
      <button
        type="button"
        className="setting-help-trigger"
        aria-label={`Help: ${label}`}
        aria-describedby={tooltipId}
        aria-expanded={open}
        onFocus={measureAndOpen}
        onBlur={close}
      >
        <svg
          viewBox="0 0 16 16"
          aria-hidden="true"
          className="setting-help-icon"
        >
          <circle
            cx="8"
            cy="8"
            r="6"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
          />
          <path
            d="M8 7.2v4M8 4.6v.2"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
        </svg>
      </button>
      <span
        id={tooltipId}
        role="tooltip"
        className="setting-help-tooltip"
        style={{ maxWidth: placement.maxWidth }}
      >
        {children}
      </span>
    </span>
  );
}
