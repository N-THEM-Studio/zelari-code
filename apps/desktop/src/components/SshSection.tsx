/**
 * Settings → Connections: SSH targets for deploy/monitor (OpenSSH).
 */
import { useCallback, useEffect, useState } from "react";
import {
  printSshPubkey,
  printSshTargets,
  removeSshTarget,
  setSshTarget,
  testSshTarget,
  type SshTargetDto,
} from "../agentClient";

interface Props {
  onStatus?: (msg: string) => void;
}

type AuthMode = SshTargetDto["auth"];

function parseAuth(v: string): AuthMode {
  if (v === "keyPath" || v === "password") return v;
  return "agent";
}

const emptyForm = (): SshTargetDto => ({
  id: "",
  name: "",
  host: "",
  port: 22,
  user: "",
  auth: "password",
  keyPath: "",
  publicKeyPath: "",
  password: "",
  defaultRemotePath: "",
  allowedCommands: ["systemctl status *", "journalctl *", "docker ps*", "df -h*", "uptime"],
  enabled: true,
});

export function SshSection({ onStatus }: Props) {
  const [targets, setTargets] = useState<SshTargetDto[]>([]);
  const [path, setPath] = useState("");
  const [form, setForm] = useState<SshTargetDto>(emptyForm);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [pubPreview, setPubPreview] = useState("");
  const [pubPathResolved, setPubPathResolved] = useState("");
  /** True while editing a target that already has a stored password */
  const [hadPassword, setHadPassword] = useState(false);

  const refresh = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      const s = await printSshTargets();
      setTargets(Array.isArray(s?.targets) ? s.targets : []);
      setPath(typeof s?.path === "string" ? s.path : "");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setTargets([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const loadPubkey = async (fromPath?: string) => {
    const src =
      fromPath?.trim() ||
      form.publicKeyPath?.trim() ||
      form.keyPath?.trim() ||
      "";
    if (!src) {
      setError("Set private key path or public key (.pub) path first");
      return;
    }
    setBusy("pubkey");
    setError(null);
    try {
      const r = await printSshPubkey(src);
      if (!r.ok) {
        setPubPreview("");
        setPubPathResolved("");
        setError(r.error);
        return;
      }
      setPubPreview(r.content);
      setPubPathResolved(r.path);
      setForm((f) => ({
        ...f,
        publicKeyPath: r.path,
        // If user only set private path, keep it; .pub is derived
        keyPath: f.keyPath?.trim() || src.replace(/\.pub$/i, ""),
      }));
      onStatus?.(`Public key loaded from ${r.path}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const copyPubkey = async () => {
    if (!pubPreview) return;
    try {
      await navigator.clipboard.writeText(pubPreview);
      onStatus?.("Public key copied — add it to ~/.ssh/authorized_keys on the server");
    } catch {
      setError("Could not copy to clipboard");
    }
  };

  const save = async () => {
    setBusy("save");
    setError(null);
    try {
      if (form.auth === "password") {
        const pwd = form.password?.trim() ?? "";
        if (!pwd && !hadPassword) {
          setError("Password is required (IP + user + password)");
          setBusy(null);
          return;
        }
      }
      const payload: SshTargetDto = {
        ...form,
        id: form.id.trim(),
        name: form.name.trim() || form.id.trim(),
        host: form.host.trim(),
        user: form.user.trim(),
        port: form.port || 22,
        keyPath: form.auth === "keyPath" ? form.keyPath?.trim() : undefined,
        publicKeyPath:
          form.auth === "password"
            ? undefined
            : form.publicKeyPath?.trim() ||
              (form.auth === "keyPath" && form.keyPath?.trim()
                ? `${form.keyPath.trim()}.pub`
                : undefined),
        // Send password only if user typed one (keep existing secret if blank)
        password:
          form.auth === "password" && form.password?.trim()
            ? form.password
            : undefined,
        allowedCommands: (form.allowedCommands ?? [])
          .map((c) => c.trim())
          .filter(Boolean),
      };
      // Never leave password on the DTO for accidental logging
      delete (payload as { hasPassword?: boolean }).hasPassword;
      await setSshTarget(payload);
      onStatus?.(`SSH target "${payload.id}" saved`);
      setEditing(false);
      setForm(emptyForm());
      setHadPassword(false);
      setPubPreview("");
      setPubPathResolved("");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const test = async (id: string) => {
    setBusy(id);
    setError(null);
    try {
      const r = await testSshTarget(id);
      onStatus?.(r.message);
      if (!r.ok) setError(r.message);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (id: string) => {
    if (!window.confirm(`Remove SSH target "${id}"?`)) return;
    setBusy(id);
    try {
      await removeSshTarget(id);
      onStatus?.(`Removed ${id}`);
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
        <h2>SSH targets</h2>
        <p className="muted">
          Hosts for deploy / monitoring via OpenSSH (<code>ssh</code> on PATH).
          Auth: <strong>password</strong> (IP + user + password), ssh-agent, or
          key file. Agent tools: <code>ssh_status</code>, <code>ssh_run</code>{" "}
          (allowlist only). Config:{" "}
          <code>{path || "~/.zelari-code/ssh-targets.json"}</code>. Kill switch:{" "}
          <code>ZELARI_SSH=0</code>.
        </p>
        {error && <p className="error-banner">{error}</p>}

        <h3 className="settings-subhead">Configured</h3>
        {loading ? (
          <p className="muted">Loading SSH targets…</p>
        ) : targets.length === 0 ? (
          <p className="muted">
            No targets yet. Click <strong>Add target</strong> to register a host
            (OpenSSH required on this machine).
          </p>
        ) : (
          <ul className="mcp-list">
            {targets.map((t) => (
              <li key={t.id} className="mcp-item">
                <div className="mcp-item-main">
                  <strong>
                    {t.name} <span className="mcp-meta">({t.id})</span>
                  </strong>
                  <span className="mcp-meta">
                    {t.user}@{t.host}:{t.port ?? 22}
                    {t.auth === "password"
                      ? " · password"
                      : t.auth === "keyPath"
                        ? " · key file"
                        : " · agent"}
                    {t.enabled === false ? " · disabled" : ""}
                    {t.tags?.length ? ` · ${t.tags.join(", ")}` : ""}
                  </span>
                  <code className="mcp-cmd">
                    allow: {(t.allowedCommands ?? []).join(" | ") || "(status only)"}
                  </code>
                </div>
                <div className="mcp-item-actions">
                  <button
                    type="button"
                    className="btn-ghost"
                    disabled={busy === t.id}
                    onClick={() => void test(t.id)}
                  >
                    Test
                  </button>
                  <button
                    type="button"
                    className="btn-ghost"
                    onClick={() => {
                      setForm({
                        ...t,
                        keyPath: t.keyPath ?? "",
                        publicKeyPath:
                          t.publicKeyPath ??
                          (t.keyPath?.trim() ? `${t.keyPath.trim()}.pub` : ""),
                        password: "",
                        allowedCommands: t.allowedCommands ?? [],
                      });
                      setHadPassword(Boolean(t.hasPassword));
                      setPubPreview("");
                      setPubPathResolved("");
                      setEditing(true);
                    }}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    className="btn-ghost"
                    disabled={busy === t.id}
                    onClick={() => void remove(t.id)}
                  >
                    Remove
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}

        <div className="settings-actions inline" style={{ marginTop: 12 }}>
          <button
            type="button"
            className="btn-send"
            onClick={() => {
              setForm(emptyForm());
              setHadPassword(false);
              setPubPreview("");
              setPubPathResolved("");
              setEditing(true);
            }}
          >
            Add target
          </button>
          <button type="button" className="btn-ghost" onClick={() => void refresh()}>
            Refresh
          </button>
        </div>
      </section>

      {editing && (
        <section className="settings-card">
          <h2>{form.id ? "Edit target" : "New target"}</h2>
          <label className="field">
            <span>Id</span>
            <input
              value={form.id}
              onChange={(e) => setForm({ ...form, id: e.target.value })}
              placeholder="prod-vps"
            />
          </label>
          <label className="field">
            <span>Display name</span>
            <input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="Production"
            />
          </label>
          <label className="field">
            <span>Host / IP</span>
            <input
              value={form.host}
              onChange={(e) => setForm({ ...form, host: e.target.value })}
              placeholder="192.168.1.10 or deploy.example.com"
              autoComplete="off"
            />
          </label>
          <label className="field">
            <span>Username</span>
            <input
              value={form.user}
              onChange={(e) => setForm({ ...form, user: e.target.value })}
              placeholder="root"
              autoComplete="username"
            />
          </label>
          <label className="field">
            <span>Port</span>
            <input
              type="number"
              value={form.port ?? 22}
              onChange={(e) =>
                setForm({ ...form, port: Number(e.target.value) || 22 })
              }
            />
          </label>
          <label className="field">
            <span>Auth</span>
            <select
              value={form.auth}
              onChange={(e) =>
                setForm({
                  ...form,
                  auth: parseAuth(e.target.value),
                  password: "",
                })
              }
            >
              <option value="password">Password (IP + user + password)</option>
              <option value="agent">ssh-agent (loaded keys)</option>
              <option value="keyPath">File key pair (private + .pub)</option>
            </select>
          </label>

          {form.auth === "password" && (
            <>
              <label className="field">
                <span>Password</span>
                <input
                  type="password"
                  value={form.password ?? ""}
                  onChange={(e) =>
                    setForm({ ...form, password: e.target.value })
                  }
                  placeholder={
                    hadPassword
                      ? "Leave blank to keep saved password"
                      : "Server password"
                  }
                  autoComplete="new-password"
                />
              </label>
              <p className="muted" style={{ marginTop: -6 }}>
                Stored only on this machine in{" "}
                <code>~/.zelari-code/ssh-secrets.json</code> (not in chat, not
                in the target list). Prefer SSH keys when you can.
              </p>
            </>
          )}

          {form.auth !== "password" && (
            <>
              <p className="muted" style={{ marginTop: -6 }}>
                OpenSSH connects with the <strong>private</strong> key. The{" "}
                <strong>public</strong> key must be on the server in{" "}
                <code>~/.ssh/authorized_keys</code> — use the fields below to
                load and copy it.
              </p>
              {form.auth === "keyPath" && (
                <label className="field">
                  <span>Private key path</span>
                  <input
                    value={form.keyPath ?? ""}
                    onChange={(e) => {
                      const v = e.target.value;
                      setForm({
                        ...form,
                        keyPath: v,
                        publicKeyPath:
                          form.publicKeyPath?.trim() ||
                          (v.trim() ? `${v.trim()}.pub` : ""),
                      });
                      setPubPreview("");
                    }}
                    placeholder="C:\\Users\\…\\.ssh\\id_ed25519"
                  />
                </label>
              )}
              <label className="field">
                <span>Public key path (.pub)</span>
                <input
                  value={form.publicKeyPath ?? ""}
                  onChange={(e) => {
                    setForm({ ...form, publicKeyPath: e.target.value });
                    setPubPreview("");
                  }}
                  placeholder="C:\\Users\\…\\.ssh\\id_ed25519.pub"
                />
              </label>
              <div className="settings-actions inline">
                <button
                  type="button"
                  className="btn-ghost"
                  disabled={busy === "pubkey"}
                  onClick={() => void loadPubkey()}
                >
                  {busy === "pubkey" ? "Loading…" : "Load public key"}
                </button>
                <button
                  type="button"
                  className="btn-ghost"
                  disabled={!pubPreview}
                  onClick={() => void copyPubkey()}
                >
                  Copy public key
                </button>
              </div>
              {pubPathResolved ? (
                <p className="muted">
                  Loaded from <code>{pubPathResolved}</code>
                </p>
              ) : null}
              {pubPreview ? (
                <label className="field">
                  <span>Public key (copy to server authorized_keys)</span>
                  <textarea
                    rows={3}
                    readOnly
                    value={pubPreview}
                    className="ssh-pubkey-preview"
                  />
                </label>
              ) : (
                <p className="muted">
                  Tip: set the <code>.pub</code> path, then Load → Copy → paste
                  into the server&apos;s <code>authorized_keys</code>.
                </p>
              )}
            </>
          )}

          <label className="field">
            <span>Default remote path</span>
            <input
              value={form.defaultRemotePath ?? ""}
              onChange={(e) =>
                setForm({ ...form, defaultRemotePath: e.target.value })
              }
              placeholder="/var/www/app"
            />
          </label>
          <label className="field">
            <span>Allowed commands (one per line; suffix * = prefix)</span>
            <textarea
              rows={4}
              value={(form.allowedCommands ?? []).join("\n")}
              onChange={(e) =>
                setForm({
                  ...form,
                  allowedCommands: e.target.value.split("\n"),
                })
              }
              placeholder={"systemctl status *\njournalctl *\ndocker ps*"}
            />
          </label>
          <div className="settings-actions inline">
            <button
              type="button"
              className="btn-ghost"
              onClick={() => {
                setEditing(false);
                setHadPassword(false);
                setForm(emptyForm());
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn-send"
              disabled={busy === "save"}
              onClick={() => void save()}
            >
              {busy === "save" ? "Saving…" : "Save target"}
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
