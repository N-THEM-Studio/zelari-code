/**
 * Settings → Extensions: installed MCP servers + curated install catalog.
 */
import { useCallback, useEffect, useState } from "react";
import {
  printMcp,
  removeMcp,
  setMcp,
  type McpConfigSnapshot,
  type McpServerEntryDto,
} from "../agentClient";
import { MCP_CATALOG, type McpCatalogItem } from "../mcpCatalog";

interface Props {
  /** Open Folder path — used for project-scoped mcp.json */
  workdir: string | null;
  onStatus?: (msg: string) => void;
}

export function McpSection({ workdir, onStatus }: Props) {
  const [snap, setSnap] = useState<McpConfigSnapshot | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scope, setScope] = useState<"user" | "project">("user");

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const s = await printMcp({ cwd: workdir });
      setSnap(s);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSnap(null);
    }
  }, [workdir]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const installedNames = new Set((snap?.servers ?? []).map((s) => s.name));

  const installCatalog = async (item: McpCatalogItem) => {
    if (scope === "project" && !workdir) {
      setError("Open a project folder first for project-scoped install.");
      return;
    }
    setBusy(item.id);
    setError(null);
    try {
      await setMcp({
        name: item.id,
        command: item.command,
        args: item.args,
        scope,
        enabled: true,
        cwd: workdir,
      });
      onStatus?.(`MCP "${item.id}" installed (${scope})`);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const toggleEnabled = async (s: McpServerEntryDto) => {
    setBusy(s.name);
    setError(null);
    try {
      await setMcp({
        name: s.name,
        command: s.command,
        args: s.args,
        scope: s.scope,
        enabled: s.enabled === false,
        cwd: workdir,
      });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const uninstall = async (s: McpServerEntryDto) => {
    if (!window.confirm(`Remove MCP server "${s.name}" from ${s.scope} config?`)) {
      return;
    }
    setBusy(s.name);
    setError(null);
    try {
      await removeMcp({ name: s.name, scope: s.scope, cwd: workdir });
      onStatus?.(`Removed MCP "${s.name}"`);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="settings-stack">
      <section className="settings-card">
        <h2>MCP servers</h2>
        <p className="muted">
          Self-hosted stdio servers (Claude Desktop–compatible). Config:{" "}
          <code>{snap?.userPath ?? "~/.zelari-code/mcp.json"}</code>
          {snap?.projectPath ? (
            <>
              {" "}
              · project <code>{snap.projectPath}</code>
            </>
          ) : null}
          . Loaded on the next agent/council run. Kill switch:{" "}
          <code>ZELARI_MCP=0</code>.
        </p>

        <div className="mcp-scope-row">
          <span className="muted">Install scope</span>
          <select
            value={scope}
            onChange={(e) =>
              setScope(e.target.value === "project" ? "project" : "user")
            }
          >
            <option value="user">User (~/.zelari-code)</option>
            <option value="project" disabled={!workdir}>
              Project (.zelari){!workdir ? " — open folder" : ""}
            </option>
          </select>
          <button
            type="button"
            className="btn-ghost"
            onClick={() => void refresh()}
          >
            Refresh
          </button>
        </div>

        {error && <p className="error-banner">{error}</p>}

        <h3 className="settings-subhead">Installed</h3>
        {!snap ? (
          <p className="muted">Loading…</p>
        ) : snap.servers.length === 0 ? (
          <p className="muted">No MCP servers configured yet.</p>
        ) : (
          <ul className="mcp-list">
            {snap.servers.map((s) => (
              <li key={`${s.scope}:${s.name}`} className="mcp-item">
                <div className="mcp-item-main">
                  <strong>{s.name}</strong>
                  <span className="mcp-meta">
                    {s.scope} · {s.enabled === false ? "disabled" : "enabled"}
                  </span>
                  <code className="mcp-cmd">
                    {s.command} {(s.args ?? []).join(" ")}
                  </code>
                </div>
                <div className="mcp-item-actions">
                  <button
                    type="button"
                    className="btn-ghost"
                    disabled={busy === s.name}
                    onClick={() => void toggleEnabled(s)}
                  >
                    {s.enabled === false ? "Enable" : "Disable"}
                  </button>
                  <button
                    type="button"
                    className="btn-ghost"
                    disabled={busy === s.name}
                    onClick={() => void uninstall(s)}
                  >
                    Remove
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="settings-card">
        <h2>Store (self-hosted MCP)</h2>
        <p className="muted">
          Curated npx packages. Install writes an entry to mcp.json; the server
          starts on demand when the agent runs (requires Node + network).
        </p>
        <ul className="mcp-catalog">
          {MCP_CATALOG.map((item) => {
            const installed = installedNames.has(item.id);
            return (
              <li key={item.id} className="mcp-catalog-item">
                <div>
                  <strong>{item.name}</strong>
                  <p className="muted">{item.description}</p>
                  <code className="mcp-cmd">
                    {item.command} {item.args.join(" ")}
                  </code>
                </div>
                <button
                  type="button"
                  className="btn-send"
                  disabled={installed || busy === item.id}
                  onClick={() => void installCatalog(item)}
                >
                  {installed
                    ? "Installed"
                    : busy === item.id
                      ? "…"
                      : "Install"}
                </button>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
