import {
  useCallback,
  useEffect,
  useId,
  useState,
  type ReactNode,
} from "react";

export type SettingHelpProps = {
  id?: string;
  label: string;
  children: ReactNode;
};

/**
 * Accessible ⓘ help: visible on hover and keyboard focus, closable with Escape.
 * Do not rely on CSS :hover alone — the trigger is a real button.
 */
export function SettingHelp({ id, label, children }: SettingHelpProps) {
  const autoId = useId();
  const tooltipId = id ?? `setting-help-${autoId.replace(/:/g, "")}`;
  const [open, setOpen] = useState(false);

  const close = useCallback(() => setOpen(false), []);

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
      className={`setting-help${open ? " is-open" : ""}`}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={close}
    >
      <button
        type="button"
        className="setting-help-trigger"
        aria-label={`Help: ${label}`}
        aria-describedby={tooltipId}
        aria-expanded={open}
        onFocus={() => setOpen(true)}
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
      <span id={tooltipId} role="tooltip" className="setting-help-tooltip">
        {children}
      </span>
    </span>
  );
}
