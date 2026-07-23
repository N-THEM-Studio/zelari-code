/**
 * Settings → Extensions: runtime skills (builtin + user SKILL.md).
 * Create / remove user & project skills; import from URL via selected model.
 */
import { useCallback, useEffect, useState } from "react";
import {
  generateSkillFromUrl,
  printSkills,
  removeSkill,
  setSkill,
  type SkillEntryDto,
  type SkillsSnapshot,
} from "../agentClient";

interface Props {
  /** Open Folder path — used for project-scoped .zelari/skills */
  workdir: string | null;
  /** Active provider (Settings) — used for URL → skill generation. */
  provider?: string | null;
  /** Active model (Settings) — used for URL → skill generation. */
  model?: string | null;
  onStatus?: (msg: string) => void;
}

const CATEGORY_OPTIONS = [
  "plan",
  "refactor",
  "debug",
  "review",
  "test",
  "docs",
  "ops",
  "git",
  "db",
  "maint",
];

export function SkillsSection({
  workdir,
  provider = null,
  model = null,
  onStatus,
}: Props) {
  const [snap, setSnap] = useState<SkillsSnapshot | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scope, setScope] = useState<"user" | "project">("user");

  // New skill form state
  const [showForm, setShowForm] = useState(false);
  const [sName, setSName] = useState("");
  const [sDesc, setSDesc] = useState("");
  const [sBody, setSBody] = useState("");
  const [sCategory, setSCategory] = useState("");
  const [sTools, setSTools] = useState("");
  const [sCost, setSCost] = useState("medium");
  const [sUrl, setSUrl] = useState("");

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const s = await printSkills({ cwd: workdir });
      setSnap(s);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSnap(null);
    }
  }, [workdir]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const resetForm = () => {
    setSName("");
    setSDesc("");
    setSBody("");
    setSCategory("");
    setSTools("");
    setSCost("medium");
    setSUrl("");
    setShowForm(false);
  };

  const createSkill = async () => {
    const name = sName.trim().toLowerCase();
    const description = sDesc.trim();
    const body = sBody.trim();
    if (!name) {
      setError("Skill id (name) is required.");
      return;
    }
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) {
      setError("Skill id must be lowercase kebab-case (a-z, 0-9, hyphens).");
      return;
    }
    if (!description) {
      setError("Description is required.");
      return;
    }
    if (!body) {
      setError("Instructions body is required (markdown).");
      return;
    }
    if (scope === "project" && !workdir) {
      setError("Open a project folder first for project-scoped skills.");
      return;
    }
    setBusy(`new:${name}`);
    setError(null);
    try {
      const tools = sTools.trim()
        ? sTools
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean)
        : undefined;
      await setSkill({
        name,
        description,
        body,
        category: sCategory || undefined,
        tools,
        cost: sCost || undefined,
        scope,
        cwd: workdir,
      });
      onStatus?.(`Skill "${name}" saved (${scope})`);
      resetForm();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const importFromUrl = async () => {
    const url = sUrl.trim();
    if (!url) {
      setError("Paste a URL to convert into a skill.");
      return;
    }
    if (!/^https?:\/\//i.test(url)) {
      setError("URL must start with http:// or https://");
      return;
    }
    setBusy("url-import");
    setError(null);
    try {
      const draft = await generateSkillFromUrl({
        url,
        provider: provider || undefined,
        model: model || undefined,
      });
      setSName(draft.name || "");
      setSDesc(draft.description || "");
      setSBody(draft.body || "");
      if (draft.category && CATEGORY_OPTIONS.includes(draft.category)) {
        setSCategory(draft.category);
      }
      if (draft.cost === "low" || draft.cost === "medium" || draft.cost === "high") {
        setSCost(draft.cost);
      }
      if (draft.tools && draft.tools.length > 0) {
        setSTools(draft.tools.join(", "));
      }
      onStatus?.(
        `Draft from URL via ${draft.provider}/${draft.model} — review and Create skill`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const removeOne = async (s: SkillEntryDto) => {
    if (!window.confirm(`Remove skill "${s.name}" (${s.scope})?`)) return;
    setBusy(s.id);
    setError(null);
    try {
      await removeSkill({
        name: s.name,
        scope: s.scope === "project" ? "project" : "user",
        cwd: workdir,
      });
      onStatus?.(`Removed skill "${s.name}"`);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const builtinSkills = (snap?.skills ?? []).filter((s) => s.builtin);
  const userSkills = (snap?.skills ?? []).filter(
    (s) => !s.builtin && (s.scope === "user" || s.scope === "project"),
  );
  const compatSkills = (snap?.skills ?? []).filter((s) => s.scope === "compat");

  const modelLabel =
    provider || model
      ? [provider, model].filter(Boolean).join(" / ")
      : "active provider model";

  return (
    <div className="settings-stack">
      {/* ── Installed skills (user + project) ───────────────────────────── */}
      <section className="settings-card">
        <div className="settings-card-head">
          <h2>Skills</h2>
          <div className="settings-scope-select">
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
        </div>
        <p className="muted">
          Skills are loaded from <code>SKILL.md</code> files. User skills live
          in <code>~/.zelari-code/skills/</code>, project skills in{" "}
          <code>.zelari/skills/</code>. In chat, open the Skills ★ picker or use
          CLI <code>/skills</code> / <code>/skill &lt;id&gt;</code>. Tag paths
          with <code>@file</code>.
        </p>

        {error && <p className="error-banner">{error}</p>}

        <h3 className="settings-subhead">
          Installed ({userSkills.length})
        </h3>
        {!snap ? (
          <p className="muted">Loading…</p>
        ) : userSkills.length === 0 ? (
          <p className="muted">No user/project skills yet. Create one below.</p>
        ) : (
          <ul className="mcp-list">
            {userSkills.map((s) => (
              <li key={`${s.scope}:${s.id}:${s.path ?? "nop"}`} className="mcp-item">
                <div className="mcp-item-main">
                  <strong>{s.name}</strong>
                  <span className="mcp-meta">
                    {s.scope}
                    {s.category ? ` · ${s.category}` : ""}
                    {s.estimatedCost ? ` · ${s.estimatedCost}` : ""}
                  </span>
                  <span className="muted" style={{ fontSize: 13 }}>
                    {s.description}
                  </span>
                  {s.requiredTools && s.requiredTools.length > 0 && (
                    <code className="mcp-cmd">
                      tools: {s.requiredTools.join(", ")}
                    </code>
                  )}
                </div>
                <div className="mcp-item-actions">
                  <button
                    type="button"
                    className="btn-ghost"
                    disabled={busy === s.id}
                    onClick={() => void removeOne(s)}
                  >
                    Remove
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}

        {/* ── Create skill form ─────────────────────────────────────────── */}
        {showForm ? (
          <div className="settings-card-inner">
            <h3 className="settings-subhead">New skill ({scope})</h3>

            <label className="field">
              <span>Import from URL (optional)</span>
              <div className="settings-row skill-url-row">
                <input
                  type="url"
                  placeholder="https://… (docs, prompt, or skill page)"
                  value={sUrl}
                  onChange={(e) => setSUrl(e.target.value)}
                  disabled={busy === "url-import"}
                />
                <button
                  type="button"
                  className="btn-send"
                  disabled={!!busy || !sUrl.trim()}
                  onClick={() => void importFromUrl()}
                  title={`Uses ${modelLabel}`}
                >
                  {busy === "url-import"
                    ? "Generating…"
                    : "Convert with model"}
                </button>
              </div>
              <span className="muted" style={{ fontSize: 12 }}>
                Fetches the page and drafts id, description, and body with{" "}
                <strong>{modelLabel}</strong> (Settings → Provider). Review
                fields below, then Create skill.
              </span>
            </label>

            <label className="field">
              <span>Skill id (kebab-case)</span>
              <input
                type="text"
                placeholder="my-deploy-skill"
                value={sName}
                onChange={(e) => setSName(e.target.value)}
              />
            </label>
            <label className="field">
              <span>One-line description</span>
              <input
                type="text"
                placeholder="Deploy to staging and run smoke tests"
                value={sDesc}
                onChange={(e) => setSDesc(e.target.value)}
              />
            </label>
            <label className="field">
              <span>Instructions (markdown body)</span>
              <textarea
                rows={6}
                placeholder={
                  "# My Skill\n\n## Steps\n1. Run npm run build\n2. Deploy with rsync\n3. Verify health endpoint"
                }
                value={sBody}
                onChange={(e) => setSBody(e.target.value)}
                style={{ fontFamily: "monospace", fontSize: 13 }}
              />
            </label>
            <div className="settings-row">
              <label className="field">
                <span>Category (optional)</span>
                <select
                  value={sCategory}
                  onChange={(e) => setSCategory(e.target.value)}
                >
                  <option value="">— none —</option>
                  {CATEGORY_OPTIONS.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Cost</span>
                <select
                  value={sCost}
                  onChange={(e) => setSCost(e.target.value)}
                >
                  <option value="low">low</option>
                  <option value="medium">medium</option>
                  <option value="high">high</option>
                </select>
              </label>
            </div>
            <label className="field">
              <span>Required tools (comma-separated, optional)</span>
              <input
                type="text"
                placeholder="bash, read_file, write_file"
                value={sTools}
                onChange={(e) => setSTools(e.target.value)}
              />
            </label>
            <div className="settings-actions inline">
              <button
                type="button"
                className="btn-ghost"
                onClick={resetForm}
                disabled={!!busy}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn-send"
                disabled={!!busy}
                onClick={() => void createSkill()}
              >
                {busy?.startsWith("new:") ? "Saving…" : "Create skill"}
              </button>
            </div>
          </div>
        ) : (
          <div className="settings-actions inline">
            <button
              type="button"
              className="btn-send"
              onClick={() => setShowForm(true)}
            >
              + New skill
            </button>
          </div>
        )}
      </section>

      {/* ── Builtin skills (read-only) ──────────────────────────────────── */}
      <section className="settings-card">
        <h2>Builtin skills ({builtinSkills.length})</h2>
        <p className="muted">
          Ship with <code>@zelari/core</code>. Read-only — cannot be edited or
          removed.
        </p>
        {!snap ? (
          <p className="muted">Loading…</p>
        ) : (
          <ul className="mcp-list">
            {builtinSkills.map((s) => (
              <li key={`builtin:${s.id}`} className="mcp-item">
                <div className="mcp-item-main">
                  <strong>{s.name}</strong>
                  <span className="mcp-meta">
                    {s.category ? ` · ${s.category}` : ""}
                    {s.estimatedCost ? ` · ${s.estimatedCost}` : ""}
                  </span>
                  <span className="muted" style={{ fontSize: 13 }}>
                    {s.description}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ── Compat skills (.claude / .opencode) ────────────────────────── */}
      {compatSkills.length > 0 && (
        <section className="settings-card">
          <h2>Compat skills ({compatSkills.length})</h2>
          <p className="muted">
            Discovered in <code>.claude/skills/</code> or{" "}
            <code>.opencode/skills/</code>. Read-only — edit the files directly.
          </p>
          <ul className="mcp-list">
            {compatSkills.map((s) => (
              <li key={`compat:${s.id}:${s.path ?? s.name}`} className="mcp-item">
                <div className="mcp-item-main">
                  <strong>{s.name}</strong>
                  <span className="mcp-meta">compat · {s.path}</span>
                  <span className="muted" style={{ fontSize: 13 }}>
                    {s.description}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
