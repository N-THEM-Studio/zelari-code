/**
 * System — versions, updates (Desktop + CLI), config paths and shortcuts.
 */
import { useEffect, useState } from "react";
import type { CliStatus, DesktopConfig } from "../../types";
import { getAppVersion } from "../../updater";
import { CliUpdateSection } from "../CliUpdateSection";
import { UpdateSection } from "../UpdateSection";
import { useSettingsToast } from "./primitives";

export interface SystemSectionProps {
  cli: CliStatus | null;
  config: DesktopConfig | null;
  onRefresh: () => Promise<void>;
}

export function SystemSection({ cli, config, onRefresh }: SystemSectionProps) {
  const toast = useSettingsToast();
  const [appVersion, setAppVersion] = useState("…");

  useEffect(() => {
    void getAppVersion().then(setAppVersion);
  }, []);

  const revealConfigDir = async () => {
    const p = config?.configPaths.provider;
    if (!p) return;
    try {
      const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
      await revealItemInDir(p);
    } catch (e) {
      toast.push("error", "Could not open config folder", e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <>
      <div className="settings-section-head">
        <h2>System</h2>
        <p>Versions, updates, config paths and keyboard shortcuts.</p>
      </div>

      <div className="settings-stack">
        <section className="s-card">
          <h3 className="s-card-title">Versions</h3>
          <p className="s-card-desc">Desktop app and bundled CLI status.</p>
          <dl className="kv">
            <dt>Desktop</dt>
            <dd>
              <code>v{appVersion}</code>
            </dd>
            <dt>CLI</dt>
            <dd>
              <code>
                {cli?.cliVersion ? cli.cliVersion.replace(/^zelari-code\s+/i, "") : "—"}
              </code>
            </dd>
            <dt>CLI status</dt>
            <dd>{cli?.ok ? "OK" : (cli?.message ?? "—")}</dd>
          </dl>
        </section>

        <UpdateSection autoCheck />
        <CliUpdateSection cli={cli} onCliRefreshed={onRefresh} />

        <section className="s-card">
          <h3 className="s-card-title">Paths</h3>
          <p className="s-card-desc">Where the Desktop and the CLI keep their state.</p>
          <dl className="kv">
            <dt>CLI path</dt>
            <dd>
              <code>{cli?.cliPath ?? "—"}</code>
            </dd>
            <dt>provider.json</dt>
            <dd>
              <code>{config?.configPaths.provider ?? "—"}</code>
            </dd>
            <dt>keys.json</dt>
            <dd>
              <code>{config?.configPaths.keys ?? "—"}</code>
            </dd>
          </dl>
          {config?.configPaths.provider && (
            <div className="s-card-actions" style={{ justifyContent: "flex-start" }}>
              <button type="button" className="btn-ghost" onClick={() => void revealConfigDir()}>
                Open config folder
              </button>
            </div>
          )}
        </section>

        <section className="s-card">
          <h3 className="s-card-title">Keyboard shortcuts</h3>
          <dl className="kv">
            <dt>
              <kbd>Ctrl</kbd>+<kbd>,</kbd>
            </dt>
            <dd>Open settings</dd>
            <dt>
              <kbd>Esc</kbd>
            </dt>
            <dd>Close settings / stop active run</dd>
            <dt>
              <kbd>Ctrl</kbd>+<kbd>N</kbd>
            </dt>
            <dd>New chat</dd>
            <dt>
              <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>D</kbd>
            </dt>
            <dd>Cycle mode (Kraken → Council → Zelari)</dd>
            <dt>
              <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd>
            </dt>
            <dd>Toggle phase (Plan / Build)</dd>
            <dt>
              <kbd>Enter</kbd>
            </dt>
            <dd>Send message (Shift+Enter for newline)</dd>
          </dl>
          <p className="s-card-desc" style={{ marginTop: 10 }}>
            On macOS use <kbd>⌘</kbd> instead of Ctrl.
          </p>
        </section>

        <section className="s-card">
          <h3 className="s-card-title">MCP tools</h3>
          <p className="s-card-desc" style={{ marginBottom: 0 }}>
            Project MCP servers load from <code>.zelari/mcp.json</code> (or{" "}
            <code>~/.zelari-code/mcp.json</code>) when a headless task runs — Desktop inherits
            the same tools as the CLI. Kill switch: env <code>ZELARI_MCP=0</code>.
          </p>
        </section>
      </div>
    </>
  );
}
