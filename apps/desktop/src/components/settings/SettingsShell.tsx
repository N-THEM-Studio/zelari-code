/**
 * SettingsShell — the redesigned settings surface.
 *
 * Six sections with one mental purpose each, autosave everywhere,
 * toasts instead of a footer banner, Esc to go back. The old tab key
 * (zelari-desktop-settings-tab) is migrated old→new section ids.
 */
import { useEffect, useState, type ReactNode } from "react";
import type { CliStatus, DesktopConfig, DispatchMode, WorkPhase } from "../../types";
import { type DesktopPrefs } from "../../desktopPrefs";
import { SettingsToastProvider } from "./primitives";
import { GeneralSection } from "./GeneralSection";
import { ProviderSection } from "./ProviderSection";
import { AgentsSection } from "./AgentsSection";
import { ExtensionsSection } from "./ExtensionsSection";
import { ConnectionsSection } from "./ConnectionsSection";
import { SystemSection } from "./SystemSection";
import "./settings.css";

export type UiTheme = "dark" | "light";

export type SettingsSectionId =
  | "general"
  | "models"
  | "agents"
  | "extensions"
  | "connections"
  | "system";

const LS_TAB = "zelari-desktop-settings-tab";

/** Old SettingsView tab ids → new section ids. */
const TAB_MIGRATION: Record<string, SettingsSectionId> = {
  provider: "models",
  defaults: "agents",
  updates: "system",
  extensions: "extensions",
  connections: "connections",
  system: "system",
  general: "general",
  models: "models",
  agents: "agents",
};

const SECTIONS: { id: SettingsSectionId; label: string; hint: string }[] = [
  { id: "general", label: "General", hint: "Theme, new-chat defaults" },
  { id: "models", label: "Models & Providers", hint: "Provider, model, auth" },
  { id: "agents", label: "Agents", hint: "Delegation, routing, verification" },
  { id: "extensions", label: "Extensions", hint: "MCP servers, skills" },
  { id: "connections", label: "Connections", hint: "Mobile QR, SSH" },
  { id: "system", label: "System", hint: "Versions, updates, paths" },
];

function SectionIcon({ id }: { id: SettingsSectionId }) {
  const common = {
    viewBox: "0 0 16 16",
    className: "settings-tab-icon",
    "aria-hidden": true as const,
  };
  if (id === "models") {
    return (
      <svg {...common}>
        <circle cx="8" cy="8" r="2.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path
          d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.2 3.2l1.4 1.4M11.4 11.4l1.4 1.4M3.2 12.8l1.4-1.4M11.4 4.6l1.4-1.4"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  if (id === "agents") {
    return (
      <svg {...common}>
        <rect x="3" y="5" width="10" height="7" rx="2" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path d="M8 2v3M1.5 8.5h1.5M13 8.5h1.5M6 8.5h.01M10 8.5h.01" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    );
  }
  if (id === "extensions") {
    return (
      <svg {...common}>
        <path
          d="M6 2.5h4v3h3v4h-3v3H6v-3H3V5.5h3z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (id === "connections") {
    return (
      <svg {...common}>
        <path
          d="M4 10.5a3 3 0 0 1 0-6h2M12 5.5a3 3 0 0 1 0 6h-2M6 8h4"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  if (id === "system") {
    return (
      <svg {...common}>
        <rect x="2.5" y="2.5" width="11" height="11" rx="2" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path d="M5.5 6h5M5.5 8.5h5M5.5 11h3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <path
        d="M2.5 6h11M2.5 10h11"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <circle cx="6" cy="6" r="1.6" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="10.5" cy="10" r="1.6" fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function loadSection(): SettingsSectionId {
  try {
    const t = localStorage.getItem(LS_TAB);
    if (t && t in TAB_MIGRATION) return TAB_MIGRATION[t];
  } catch {
    /* ignore */
  }
  return "general";
}

export interface SettingsShellProps {
  config: DesktopConfig | null;
  cli: CliStatus | null;
  defaultMode: DispatchMode;
  defaultPhase: WorkPhase;
  workdir?: string | null;
  theme: UiTheme;
  prefs: DesktopPrefs;
  onThemeChange: (theme: UiTheme) => void;
  onBack: () => void;
  onRefresh: () => Promise<void>;
  onDefaultsChange: (mode: DispatchMode, phase: WorkPhase) => void;
  onProviderModelChange: (provider: string, model: string) => void;
  onPrefsChange: (partial: Partial<DesktopPrefs>) => void;
}

export function SettingsShell(props: SettingsShellProps) {
  const {
    config,
    cli,
    defaultMode,
    defaultPhase,
    workdir = null,
    theme,
    prefs,
    onThemeChange,
    onBack,
    onRefresh,
    onDefaultsChange,
    onProviderModelChange,
    onPrefsChange,
  } = props;
  const [section, setSection] = useState<SettingsSectionId>(() => loadSection());

  useEffect(() => {
    try {
      localStorage.setItem(LS_TAB, section);
    } catch {
      /* ignore */
    }
  }, [section]);

  // Esc closes settings (tooltips stopPropagation so they close first).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onBack();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onBack]);

  const activeProvider = config?.activeProviderId ?? null;
  const activeModel = activeProvider
    ? (config?.modelByProvider[activeProvider] ?? null)
    : null;

  let content: ReactNode = null;
  if (section === "general") {
    content = (
      <GeneralSection
        theme={theme}
        onThemeChange={onThemeChange}
        defaultMode={defaultMode}
        defaultPhase={defaultPhase}
        onDefaultsChange={onDefaultsChange}
        profile={prefs.profile}
        onProfileChange={(profile) => onPrefsChange({ profile })}
      />
    );
  } else if (section === "models") {
    content = (
      <ProviderSection
        config={config}
        onRefresh={onRefresh}
        onActiveProviderChange={onProviderModelChange}
      />
    );
  } else if (section === "agents") {
    content = (
      <AgentsSection
        config={config}
        prefs={prefs}
        onPrefsChange={onPrefsChange}
        onRefresh={onRefresh}
      />
    );
  } else if (section === "extensions") {
    content = (
      <ExtensionsSection workdir={workdir} provider={activeProvider} model={activeModel} />
    );
  } else if (section === "connections") {
    content = <ConnectionsSection workdir={workdir} />;
  } else {
    content = <SystemSection cli={cli} config={config} onRefresh={onRefresh} />;
  }

  return (
    <SettingsToastProvider>
      <div className="settings-shell">
        <header className="settings-header">
          <button type="button" className="btn-ghost" onClick={onBack}>
            ← Back
          </button>
          <h1>Settings</h1>
          <button
            type="button"
            className="btn-ghost settings-header-refresh"
            onClick={() => void onRefresh()}
            title="Reload CLI config & status"
          >
            Refresh
          </button>
        </header>

        <div className="settings-frame">
          <nav className="settings-nav" role="tablist" aria-label="Settings sections">
            {SECTIONS.map((s) => (
              <button
                key={s.id}
                type="button"
                role="tab"
                aria-selected={section === s.id}
                className={`settings-nav-item${section === s.id ? " active" : ""}`}
                title={s.hint}
                onClick={() => setSection(s.id)}
              >
                <span className="settings-nav-row">
                  <SectionIcon id={s.id} />
                  <span className="settings-nav-label">{s.label}</span>
                </span>
                <span className="settings-nav-hint">{s.hint}</span>
              </button>
            ))}
          </nav>

          <div className="settings-content" role="tabpanel">
            {content}
          </div>
        </div>
      </div>
    </SettingsToastProvider>
  );
}
