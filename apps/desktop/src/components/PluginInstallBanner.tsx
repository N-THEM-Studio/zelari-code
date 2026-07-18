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

interface Props {
  plugins: PluginStatusRow[];
  installingId: string | null;
  onInstall: (id: string) => void;
  onDismiss: () => void;
}

export function PluginInstallBanner({
  plugins,
  installingId,
  onInstall,
  onDismiss,
}: Props) {
  const missing = plugins.filter((p) => !p.present);
  if (missing.length === 0) return null;

  return (
    <div className="plugin-banner" role="region" aria-label="Optional plugins">
      <div className="plugin-banner-main">
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
