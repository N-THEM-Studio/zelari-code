/**
 * Settings → Extensions: MCP servers as an integrations manager.
 *
 * Installed servers are cards (name, description, scope badge, on/off switch).
 * Catalog entries keep the install/uninstall/toggle flow they always had;
 * servers added by hand additionally get Edit + Remove. The heavy lifting stays
 * on the CLI side (mcpConfigIo) — this component only collects a draft and
 * ships it to `set_mcp`.
 */
import { useCallback, useEffect, useState } from "react";
import {
  printMcp,
  removeMcp,
  setMcp,
  type McpConfigSnapshot,
  type McpServerEntryDto,
} from "../agentClient";
import { catalogItemFor, MCP_CATALOG, type McpCatalogItem } from "../mcpCatalog";
import { SelectInput, StatusPill, Toggle } from "./settings/primitives";
import {
  buildCustomServerPayload,
  commandPreview,
  draftFromEntry,
  emptyDraft,
  type McpDraftErrors,
  type McpServerDraft,
} from "./mcpServerForm";
import "./mcpSection.css";

interface Props {
  /** Open Folder path — used for project-scoped mcp.json */
  workdir: string | null;
  onStatus?: (msg: string) => void;
}

const SCOPE_OPTIONS = [
  { value: "user", label: "User (~/.zelari-code)" },
  { value: "project", label: "Project (.zelari)" },
] as const;

export function McpSection({ workdir, onStatus }: Props) {
  const [snap, setSnap] = useState<McpConfigSnapshot | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scope, setScope] = useState<"user" | "project">("user");
  /** null → form closed; otherwise the server being added/edited. */
  const [draft, setDraft] = useState<McpServerDraft | null>(null);
  const [editing, setEditing] = useState<McpServerEntryDto | null>(null);
  const [draftErrors, setDraftErrors] = useState<McpDraftErrors>({});

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

  const servers = snap?.servers ?? [];
  const installedNames = new Set(servers.map((s) => s.name));
  const activeCount = servers.filter((s) => s.enabled !== false).length;

  const openAdd = () => {
    setEditing(null);
    setDraftErrors({});
    setDraft(emptyDraft(scope));
  };

  const openEdit = (s: McpServerEntryDto) => {
    setEditing(s);
    setDraftErrors({});
    setDraft(draftFromEntry(s));
  };

  const closeForm = () => {
    setDraft(null);
    setEditing(null);
    setDraftErrors({});
  };

  const scopeOptions = () =>
    SCOPE_OPTIONS.map((o) => (
      <option key={o.value} value={o.value} disabled={o.value === "project" && !workdir}>
        {o.value === "project" && !workdir ? `${o.label} — open folder` : o.label}
      </option>
    ));

  const saveDraft = async () => {
    if (!draft) return;
    const built = buildCustomServerPayload(draft, { workdir });
    if (!built.payload) {
      setDraftErrors(built.errors);
      return;
    }
    const payload = built.payload;
    setBusy(payload.name);
    setDraftErrors({});
    try {
      await setMcp({
        name: payload.name,
        command: payload.command,
        args: payload.args,
        env: payload.env ?? null,
        scope: payload.scope,
        // An edit keeps the entry's on/off state; a fresh add starts enabled.
        enabled: editing ? editing.enabled !== false : true,
        cwd: workdir,
      });
      onStatus?.(
        editing
          ? `MCP "${payload.name}" updated (${payload.scope})`
          : `MCP "${payload.name}" added (${payload.scope})`,
      );
      closeForm();
      await refresh();
    } catch (e) {
      setDraftErrors({ form: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  };

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
        // Re-send the stored env: an upsert without it would drop a map the
        // user (or another tool) wrote into mcp.json.
        env: s.env ?? null,
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
        <div className="mcp-head">
          <div>
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
          </div>
          <StatusPill tone={activeCount > 0 ? "ok" : "neutral"}>
            {activeCount} of {servers.length} active
          </StatusPill>
        </div>

        <div className="mcp-toolbar">
          <label className="mcp-field mcp-field-inline">
            <span>Install scope</span>
            <SelectInput
              value={scope}
              ariaLabel="Install scope"
              onChange={(v) => setScope(v === "project" ? "project" : "user")}
            >
              {scopeOptions()}
            </SelectInput>
          </label>
          <div className="mcp-toolbar-actions">
            <button type="button" className="btn-ghost" onClick={() => void refresh()}>
              Refresh
            </button>
            <button
              type="button"
              className="btn-send"
              aria-expanded={draft !== null}
              onClick={() => (draft ? closeForm() : openAdd())}
            >
              Add custom server
            </button>
          </div>
        </div>

        {error && <p className="error-banner">{error}</p>}

        {draft ? (
          <div
            className="mcp-form"
            role="group"
            aria-label={editing ? `Edit ${editing.name}` : "Add MCP server"}
          >
            <h3 className="settings-subhead">
              {editing ? `Edit "${editing.name}"` : "New server"}
            </h3>
            <div className="mcp-form-grid">
              <label className="mcp-field">
                <span>Name</span>
                <input
                  className="s-input"
                  value={draft.name}
                  readOnly={editing !== null}
                  aria-label="Server name"
                  placeholder="my-server"
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                />
                <em className="mcp-field-hint">
                  {editing
                    ? "Rename = remove + re-add."
                    : "Letters, digits, _ and - only."}
                </em>
                {draftErrors.name ? (
                  <p className="mcp-field-error">{draftErrors.name}</p>
                ) : null}
              </label>

              <label className="mcp-field">
                <span>Command</span>
                <input
                  className="s-input"
                  value={draft.command}
                  aria-label="Server command"
                  placeholder="npx"
                  onChange={(e) => setDraft({ ...draft, command: e.target.value })}
                />
                {draftErrors.command ? (
                  <p className="mcp-field-error">{draftErrors.command}</p>
                ) : null}
              </label>

              <label className="mcp-field">
                <span>Scope</span>
                <SelectInput
                  value={draft.scope}
                  ariaLabel="Server scope"
                  onChange={(v) =>
                    setDraft({ ...draft, scope: v === "project" ? "project" : "user" })
                  }
                >
                  {scopeOptions()}
                </SelectInput>
              </label>

              <label className="mcp-field mcp-field-wide">
                <span>Arguments</span>
                <textarea
                  className="s-input"
                  value={draft.argsText}
                  rows={3}
                  aria-label="Server arguments"
                  placeholder={"-y\n@modelcontextprotocol/server-memory"}
                  onChange={(e) => setDraft({ ...draft, argsText: e.target.value })}
                />
                <em className="mcp-field-hint">One argument per line.</em>
              </label>

              <label className="mcp-field mcp-field-wide">
                <span>Environment</span>
                <textarea
                  className="s-input"
                  value={draft.envText}
                  rows={3}
                  aria-label="Server environment"
                  placeholder="GITHUB_TOKEN=…"
                  onChange={(e) => setDraft({ ...draft, envText: e.target.value })}
                />
                {draftErrors.env ? (
                  <p className="mcp-field-error">{draftErrors.env}</p>
                ) : (
                  <em className="mcp-field-hint">
                    Optional — one KEY=VALUE per line.
                  </em>
                )}
              </label>
            </div>

            {draftErrors.form ? (
              <p className="error-banner">{draftErrors.form}</p>
            ) : null}

            <div className="mcp-form-actions">
              <button type="button" className="btn-ghost" onClick={closeForm}>
                Cancel
              </button>
              <button
                type="button"
                className="btn-send"
                disabled={busy !== null}
                onClick={() => void saveDraft()}
              >
                {editing ? "Save changes" : "Add server"}
              </button>
            </div>
          </div>
        ) : null}

        <h3 className="settings-subhead">Installed</h3>
        {!snap ? (
          <p className="muted">Loading…</p>
        ) : servers.length === 0 ? (
          <p className="muted">
            No MCP servers configured yet — add one above or install from the store.
          </p>
        ) : (
          <ul className="mcp-list">
            {servers.map((s) => {
              const item = catalogItemFor(s.name);
              const enabled = s.enabled !== false;
              const envCount = Object.keys(s.env ?? {}).length;
              return (
                <li key={`${s.scope}:${s.name}`} className="mcp-server-row">
                  <div className="mcp-server-info">
                    <div className="mcp-server-head">
                      <strong className="mcp-server-name">{item?.name ?? s.name}</strong>
                      <StatusPill tone={enabled ? "ok" : "neutral"}>
                        {enabled ? "On" : "Off"}
                      </StatusPill>
                      <StatusPill tone="neutral">{s.scope}</StatusPill>
                      {item ? null : <StatusPill tone="warn">custom</StatusPill>}
                    </div>
                    <p className="mcp-server-desc">
                      {item
                        ? item.description
                        : commandPreview(s.command, s.args)}
                    </p>
                    <code className="mcp-cmd">
                      {s.command} {(s.args ?? []).join(" ")}
                      {envCount > 0
                        ? ` · ${envCount} env var${envCount === 1 ? "" : "s"}`
                        : ""}
                    </code>
                  </div>
                  <div className="mcp-server-actions">
                    <Toggle
                      checked={enabled}
                      disabled={busy === s.name}
                      label={`${enabled ? "Disable" : "Enable"} ${s.name}`}
                      onChange={() => void toggleEnabled(s)}
                    />
                    {item ? null : (
                      <button
                        type="button"
                        className="btn-ghost"
                        disabled={busy === s.name}
                        onClick={() => openEdit(s)}
                      >
                        Edit
                      </button>
                    )}
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
              );
            })}
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
