/**
 * Shared primitives for the redesigned Settings UI.
 *
 * Every control commits immediately (autosave); text inputs commit on
 * blur/Enter. Feedback flows through the toast provider instead of a
 * global footer banner.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

/* ---------------- Toasts ---------------- */

export type ToastTone = "ok" | "error";

export interface ToastItem {
  id: number;
  tone: ToastTone;
  message: string;
  detail?: string;
}

export interface SettingsToast {
  push: (tone: ToastTone, message: string, detail?: string) => void;
}

const ToastCtx = createContext<SettingsToast | null>(null);

/** Access the settings toast host. Throws if used outside SettingsShell. */
export function useSettingsToast(): SettingsToast {
  const ctx = useContext(ToastCtx);
  if (!ctx) throw new Error("useSettingsToast must be used inside SettingsToastProvider");
  return ctx;
}

export function SettingsToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const seq = useRef(0);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (tone: ToastTone, message: string, detail?: string) => {
      const id = ++seq.current;
      setToasts((prev) => [...prev.slice(-2), { id, tone, message, detail }]);
      // Errors stay longer so the user can read / copy details.
      window.setTimeout(() => dismiss(id), tone === "error" ? 6000 : 2500);
    },
    [dismiss],
  );

  return (
    <ToastCtx.Provider value={{ push }}>
      {children}
      <div className="s-toast-host" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`s-toast ${t.tone}`}>
            <div className="s-toast-msg">
              {t.message}
              {t.detail ? <div className="s-toast-detail">{t.detail}</div> : null}
            </div>
            <button
              type="button"
              className="s-toast-close"
              aria-label="Dismiss notification"
              onClick={() => dismiss(t.id)}
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

/* ---------------- Card / Row ---------------- */

export function SettingsCard({
  title,
  description,
  help,
  actions,
  children,
  className = "",
}: {
  title?: string;
  description?: ReactNode;
  /** Optional ⓘ help next to the title (use <SettingHelp/>). */
  help?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`s-card ${className}`}>
      {title ? (
        <h3 className="s-card-title">
          {title}
          {help ? <span className="s-row-help-inline">{help}</span> : null}
        </h3>
      ) : null}
      {description ? <p className="s-card-desc">{description}</p> : null}
      {children}
      {actions ? <div className="s-card-actions">{actions}</div> : null}
    </section>
  );
}

/* ---------------- Choices & disclosure ---------------- */

export interface ChoiceOption<T extends string> {
  value: T;
  label: string;
  /** One plain-language line under the label. */
  description: string;
  /** Small tag after the label, e.g. "Recommended". */
  badge?: string;
}

/**
 * Radio-card list: every option shows its label AND what it does, so a new
 * user never has to decode a terse select value. Keyboard: native radios
 * (arrow keys move within the group).
 */
export function ChoiceList<T extends string>({
  name,
  value,
  options,
  onChange,
  ariaLabel,
  disabled = false,
}: {
  name: string;
  value: T;
  options: readonly ChoiceOption<T>[];
  onChange: (next: T) => void;
  ariaLabel: string;
  disabled?: boolean;
}) {
  return (
    <div className="s-choice-list" role="radiogroup" aria-label={ariaLabel}>
      {options.map((o) => {
        const checked = o.value === value;
        return (
          <label key={o.value} className={`s-choice${checked ? " active" : ""}`}>
            <input
              type="radio"
              name={name}
              value={o.value}
              checked={checked}
              disabled={disabled}
              onChange={() => onChange(o.value)}
            />
            <span className="s-choice-body">
              <span className="s-choice-label">
                {o.label}
                {o.badge ? <span className="s-choice-badge">{o.badge}</span> : null}
              </span>
              <span className="s-choice-desc">{o.description}</span>
            </span>
          </label>
        );
      })}
    </div>
  );
}

/** Collapsible block for advanced / rarely-changed settings. */
export function Collapsible({
  summary,
  hint,
  defaultOpen = false,
  children,
}: {
  summary: string;
  hint?: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  return (
    <details className="s-collapsible" open={defaultOpen}>
      <summary>
        <span className="s-collapsible-title">{summary}</span>
        {hint ? <span className="s-collapsible-hint">{hint}</span> : null}
      </summary>
      <div className="s-collapsible-body">{children}</div>
    </details>
  );
}

export function SettingsRow({
  label,
  hint,
  help,
  stacked = false,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  /** Optional ⓘ help rendered on the label column (use <SettingHelp/>). */
  help?: ReactNode;
  stacked?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={`s-row${stacked ? " stack" : ""}`}>
      <div>
        <div className="s-row-label">
          {label}
          {help ? <span className="s-row-help-inline">{help}</span> : null}
        </div>
        {hint ? <div className="s-row-hint">{hint}</div> : null}
      </div>
      {!stacked ? <div className="s-row-control">{children}</div> : null}
      {stacked ? <div className="s-row-control">{children}</div> : null}
      {!stacked ? <span /> : null}
    </div>
  );
}

/* ---------------- Controls ---------------- */

/** Custom switch toggle (replaces native checkboxes in settings rows). */
export function Toggle({
  checked,
  onChange,
  disabled = false,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={`s-toggle${checked ? " on" : ""}`}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    />
  );
}

/** Text input that commits on blur / Enter (never on each keystroke). */
export function TextInput({
  value,
  onCommit,
  placeholder,
  type = "text",
  disabled = false,
  ariaLabel,
  style,
}: {
  value: string;
  onCommit: (next: string) => void;
  placeholder?: string;
  type?: string;
  disabled?: boolean;
  ariaLabel?: string;
  style?: CSSProperties;
}) {
  const [draft, setDraft] = useState(value);
  const lastCommitted = useRef(value);

  useEffect(() => {
    if (value !== lastCommitted.current) {
      setDraft(value);
      lastCommitted.current = value;
    }
  }, [value]);

  const commit = () => {
    const next = draft.trim();
    if (next === lastCommitted.current) return;
    lastCommitted.current = next;
    onCommit(next);
  };

  return (
    <input
      className="s-input"
      type={type}
      value={draft}
      placeholder={placeholder}
      disabled={disabled}
      aria-label={ariaLabel}
      style={style}
      autoComplete="off"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        }
      }}
    />
  );
}

/** Minimal styled select — options stay native. */
export function SelectInput({
  value,
  onChange,
  disabled = false,
  ariaLabel,
  children,
  style,
}: {
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
  ariaLabel?: string;
  children: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <select
      className="s-select"
      value={value}
      disabled={disabled}
      aria-label={ariaLabel}
      style={style}
      onChange={(e) => onChange(e.target.value)}
    >
      {children}
    </select>
  );
}

export function StatusPill({
  tone,
  children,
}: {
  tone: "ok" | "warn" | "neutral";
  children: ReactNode;
}) {
  return <span className={`s-pill ${tone}`}>{children}</span>;
}

/** Inline busy spinner used next to autosaving controls. */
export function BusyDot() {
  return <span className="s-busy-dot" aria-label="Saving" role="img" />;
}
