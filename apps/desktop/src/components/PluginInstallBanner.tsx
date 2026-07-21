/**
 * Offer to install optional plugins (e.g. Playwright) when missing.
 * Desktop never mounted CLI PluginGate — browser_check always looked "unavailable".
 */

export interface PluginStatusRow {
  id: string;
  label: string;
  present: boolean;
  description?: string;
  postInstallHint?: string;
}

/** A failed plugin install — carries the real npm error + output tail. */
export interface PluginInstallError {
  id: string;
  message: string;
  output?: string;
}

interface Props {
  plugins: PluginStatusRow[];
  installingId: string | null;
  onInstall: (id: string) => void;
  onDismiss: () => void;
  /** Last failed install (rendered below the list). */
  error?: PluginInstallError | null;
  /** User dismissed the error box. */
  onClearError?: () => void;
}

export function PluginInstallBanner({
  plugins,
  installingId,
  onInstall,
  onDismiss,
  error,
  onClearError,
}: Props) {
  const missing = plugins.filter((p) => !p.present);
  if (missing.length === 0 && !error) return null;

  // Resolve the failed plugin's label for a friendlier error line.
  const errorLabel = error
    ? (plugins.find((p) => p.id === error.id)?.label ?? error.id)
    : null;

  return (
    <div className="plugin-banner" role="region" aria-label="Optional plugins">
      <div className="plugin-banner-main">
        {missing.length > 0 && (
          <>
            <strong>Optional tools missing</strong>
            <span className="plugin-banner-sub">
              Install for browser smoke tests, diagnostics, and LSP. Zelari works
              without them, but features degrade.
            </span>
            <ul className="plugin-banner-list">
              {missing.map((p) => (
                <li key={p.id}>
                  <span className="plugin-banner-label">{p.label}</span>
                  <button
                    type="button"
                    className="plugin-banner-install"
                    disabled={installingId !== null}
                    onClick={() => onInstall(p.id)}
                  >
                    {installingId === p.id ? "Installing…" : "Install"}
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
        {error && (
          <div className="plugin-banner-error" role="alert">
            <div className="plugin-banner-error-head">
              <span className="plugin-banner-error-icon" aria-hidden>
                ⚠
              </span>
              <span className="plugin-banner-error-text">
                <strong>{errorLabel}</strong> — {error.message}
              </span>
              {onClearError && (
                <button
                  type="button"
                  className="plugin-banner-error-close"
                  title="Dismiss error"
                  onClick={onClearError}
                >
                  ×
                </button>
              )}
            </div>
            {error.output && error.output.trim() && (
              <details className="plugin-banner-error-details">
                <summary>npm output</summary>
                <pre className="plugin-banner-error-output">
                  {error.output.trim()}
                </pre>
              </details>
            )}
          </div>
        )}
      </div>
      <button
        type="button"
        className="plugin-banner-dismiss"
        onClick={onDismiss}
        title="Dismiss for this session"
      >
        ×
      </button>
    </div>
  );
}
