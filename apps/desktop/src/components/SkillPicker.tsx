/**
 * Skill list + select for Desktop composer (parity with CLI /skills picker).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  printSkills,
  type SkillEntryDto,
  type SkillsSnapshot,
} from "../agentClient";

interface Props {
  open: boolean;
  workdir: string | null;
  onClose: () => void;
  /** Called with expanded prompt fragment + skill meta when user picks a skill. */
  onSelect: (skill: SkillEntryDto) => void;
}

export function expandDesktopSkill(
  skill: SkillEntryDto,
  userInput: string = "",
): string {
  const body =
    (skill.body && skill.body.trim()) ||
    `(Skill "${skill.id}" — use the skill tool to load full instructions if needed.)\n\n${skill.description}`;
  const input = userInput.trim();
  return input
    ? `${body}\n\n## User input\n${input}`
    : `${body}\n\n## User input\n(Please provide the task description or input for this skill.)`;
}

export function SkillPicker({ open, workdir, onClose, onSelect }: Props) {
  const [snap, setSnap] = useState<SkillsSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const s = await printSkills({ cwd: workdir });
      setSnap(s);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSnap(null);
    } finally {
      setBusy(false);
    }
  }, [workdir]);

  useEffect(() => {
    if (!open) return;
    setFilter("");
    void refresh();
  }, [open, refresh]);

  const skills = useMemo(() => {
    const all = snap?.skills ?? [];
    const q = filter.trim().toLowerCase();
    if (!q) return all;
    return all.filter(
      (s) =>
        s.id.toLowerCase().includes(q) ||
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        (s.category ?? "").toLowerCase().includes(q),
    );
  }, [snap, filter]);

  if (!open) return null;

  return (
    <div className="skill-picker-overlay" role="dialog" aria-label="Select skill">
      <div className="skill-picker">
        <div className="skill-picker-head">
          <h3>Skills</h3>
          <button type="button" className="btn-ghost" onClick={onClose}>
            Close
          </button>
        </div>
        <p className="muted skill-picker-hint">
          Pick a skill to expand into the next message (same as{" "}
          <code>/skill &lt;id&gt;</code> in the CLI).
        </p>
        <input
          className="skill-picker-filter"
          type="search"
          placeholder="Filter by id, name, category…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          autoFocus
        />
        {error && <p className="error-banner">{error}</p>}
        {busy && !snap && <p className="muted">Loading skills…</p>}
        <ul className="skill-picker-list">
          {skills.map((s) => (
            <li key={`${s.scope}:${s.id}`}>
              <button
                type="button"
                className="skill-picker-item"
                onClick={() => {
                  onSelect(s);
                  onClose();
                }}
              >
                <span className="skill-picker-title">
                  <strong>{s.name}</strong>
                  <span className="mcp-meta">
                    {s.scope}
                    {s.category ? ` · ${s.category}` : ""}
                    {s.estimatedCost ? ` · ${s.estimatedCost}` : ""}
                  </span>
                </span>
                <span className="muted skill-picker-desc">{s.description}</span>
                <code className="skill-picker-id">/skill {s.id}</code>
              </button>
            </li>
          ))}
        </ul>
        {!busy && skills.length === 0 && (
          <p className="muted">No skills match.</p>
        )}
      </div>
    </div>
  );
}
