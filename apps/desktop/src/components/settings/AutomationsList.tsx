/**
 * AutomationsList — Settings → Automations: one row per registry automation
 * (non-gardener). The registry itself is owned by the CLI
 * (`zelari-code automation upsert --file`); this view only lists, schedules and
 * deletes. Failures are surfaced inline — never swallowed.
 */
import { useCallback, useEffect, useState } from "react";
import {
  deleteAutomation,
  formatAutomationError,
  getAppConfig,
  listAutomations,
  manageAutomationSchedule,
  runAutomationHeadless,
  runAutomationOnce,
  setAutomationEnabled,
  upsertAutomation,
  type AutomationScheduleStatus,
  type AutomationSpecInput,
  type AutomationSummary,
} from "../../agentClient";
import { SettingsCard, StatusPill } from "./primitives";
import type { DesktopProviderInfo } from "../../types";

export interface AutomationsListProps {
  /** Repo whose `.zelari/automations` registry is shown. */
  workdir: string | null;
  /** Bumped by the parent to force a refresh (e.g. after a sibling mutation). */
  refreshToken: number;
  /** Told to the parent after a row action so it can refresh siblings. */
  onChanged: () => void;
  /** Select this automation in the run-history card. */
  onShowHistory: (id: string) => void;
}

/** Visible poll while the section is mounted — no background daemon. */
const POLL_MS = 30_000;

/** Map a run status to the shared pill tone + label (P1: status only, no fake ok). */
export function lastRunChip(
  run: AutomationSummary["lastRun"],
): { tone: "ok" | "warn" | "neutral"; label: string } {
  if (!run) return { tone: "neutral", label: "no runs yet" };
  switch (run.status) {
    case "completed":
      return { tone: "ok", label: "ok" };
    case "awaiting_approval":
      return { tone: "warn", label: "awaiting" };
    case "failed":
      return { tone: "warn", label: "failed" };
    default:
      // relogin_required / skipped / drafting / publishing → not proven.
      return { tone: "neutral", label: "unproven" };
  }
}

function scheduleSummary(schedule: AutomationSummary["schedule"]): string {
  if (typeof schedule.intervalMin === "number") return `every ${schedule.intervalMin} min`;
  if (schedule.cron) return `cron ${schedule.cron}`;
  if (schedule.atLogon) return "at logon";
  return "manual";
}

export function AutomationsList({
  workdir,
  refreshToken,
  onChanged,
  onShowHistory,
}: AutomationsListProps) {
  const [items, setItems] = useState<AutomationSummary[] | null>(null);
  const [registered, setRegistered] = useState<Record<string, boolean | "unknown">>({});
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  // Optimistic `enabled` overrides per id; dropped on every successful reload.
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  // Transient confirmation after a detached run is spawned.
  const [notice, setNotice] = useState<string | null>(null);

  // Integrated provider list for the per-row model picker (same source as the
  // chat bar via get_app_config — never council/kraken mode prefs).
  const [providers, setProviders] = useState<DesktopProviderInfo[]>([]);
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const cfg = await getAppConfig();
        if (alive) setProviders(cfg?.providers ?? []);
      } catch {
        /* picker falls back to the default-only option */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const repoPath = workdir ?? "";

  const load = useCallback(async () => {
    if (!repoPath) {
      setItems([]);
      setError(null);
      return;
    }
    try {
      const { automations } = await listAutomations(repoPath);
      const rows = automations.filter((a) => a.id !== "gardener" && a.kind !== "gardener");
      setItems(rows);
      setOverrides({}); // server truth wins over any optimistic toggle
      setError(null);
      // Per-row OS registration state (bounded: one cheap probe per row).
      const entries = await Promise.all(
        rows.map(async (r): Promise<readonly [string, boolean | "unknown"]> => {
          try {
            const st = (await manageAutomationSchedule(
              r.id,
              "status",
              repoPath,
            )) as AutomationScheduleStatus;
            return [r.id, !!st.registered] as const;
          } catch {
            // Probe failed: surface "unknown" rather than a false "not registered".
            return [r.id, "unknown"] as const;
          }
        }),
      );
      setRegistered(Object.fromEntries(entries));
    } catch (e) {
      setItems(null);
      setError(formatAutomationError(e));
    }
  }, [repoPath]);

  useEffect(() => {
    void load();
  }, [load, refreshToken]);

  useEffect(() => {
    if (!repoPath) return;
    const id = window.setInterval(() => void load(), POLL_MS);
    return () => window.clearInterval(id);
  }, [load, repoPath]);

  const act = async (id: string, fn: () => Promise<unknown>) => {
    if (busyId) return;
    setBusyId(id);
    setError(null);
    try {
      await fn();
      onChanged(); // parent bumps refreshToken → this + siblings reload
    } catch (e) {
      setError(formatAutomationError(e));
    } finally {
      setBusyId(null);
    }
  };

  // Optimistic enable/disable: flip immediately, revert on failure.
  const toggleEnabled = async (id: string, next: boolean) => {
    if (busyId) return;
    setOverrides((o) => ({ ...o, [id]: next }));
    setBusyId(id);
    setError(null);
    try {
      await setAutomationEnabled(id, next, repoPath);
      onChanged(); // parent bumps refreshToken → reload drops the override
    } catch (e) {
      setOverrides((o) => {
        const copy = { ...o };
        delete copy[id];
        return copy;
      });
      setError(formatAutomationError(e));
    } finally {
      setBusyId(null);
    }
  };

  // Detached run: resolves as soon as the child is spawned (never blocks on the
  // run itself), then refresh shortly after so the new run shows up.
  const runHeadless = async (id: string) => {
    if (busyId) return;
    setBusyId(id);
    setError(null);
    try {
      await runAutomationHeadless(id, repoPath);
      setNotice("Avviato in background — vedi Cronologia");
      window.setTimeout(() => void load(), 1500);
      window.setTimeout(() => setNotice(null), 6000);
    } catch (e) {
      setError(formatAutomationError(e));
    } finally {
      setBusyId(null);
    }
  };

  // Assign the drafting model straight from the integrated provider picker
  // (same list as the chat bar). "" = active provider/model default.
  const changeModel = async (a: AutomationSummary, value: string) => {
    if (!a.spec) {
      setError("Spec non disponibile — premi Refresh e riprova");
      return;
    }
    if (busyId) return;
    setBusyId(a.id);
    setError(null);
    try {
      const next: AutomationSpecInput = { ...a.spec };
      if (value === "") delete next.model;
      else {
        const sep = value.indexOf("::");
        const provider = value.slice(0, sep);
        const id = value.slice(sep + 2);
        next.model = provider ? { provider, id } : { id };
      }
      await upsertAutomation(next, repoPath);
      onChanged(); // parent bumps refreshToken → row reloads with the saved spec
    } catch (e) {
      setError(formatAutomationError(e));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <SettingsCard
      title="Automations"
      description={
        <>
          Registry jobs are created and edited by the{" "}
          <strong>social-automations</strong> skill in chat — here you assign the model, toggle,
          register the OS scheduler entry and run. The CLI stays the source of truth.
        </>
      }
      actions={
        <>
          <button
            type="button"
            className="btn-ghost"
            disabled={!repoPath}
            onClick={() => void load()}
          >
            Refresh
          </button>
        </>
      }
    >
      {error ? <StatusPill tone="warn">{error}</StatusPill> : null}
      {notice ? <StatusPill tone="ok">{notice}</StatusPill> : null}
      {items === null && !error ? <StatusPill tone="neutral">Loading…</StatusPill> : null}
      {items !== null && items.length === 0 ? (
        <p className="s-card-desc" style={{ marginBottom: 0 }}>
          Nessuna automazione. Creala in chat con la skill{" "}
          <strong>social-automations</strong> (es. "programma 2 post al giorno su facebook…") o
          via <code>zelari-code automation upsert --file spec.json</code>.
        </p>
      ) : null}

      {items?.map((a) => {
        const chip = lastRunChip(a.lastRun);
        const osState = registered[a.id] ?? "unknown";
        const osLabel =
          osState === true ? "registered" : osState === false ? "not registered" : "unknown";
        const busy = busyId === a.id;
        const enabled = overrides[a.id] ?? a.enabled;
        return (
          <div className="s-row" key={a.id}>
            <div>
              <div className="s-row-label">
                {a.name} <StatusPill tone="neutral">{a.kind}</StatusPill>{" "}
                <StatusPill tone={chip.tone}>{chip.label}</StatusPill>
              </div>
              <div className="s-row-hint">
                <code>{a.id}</code> · {enabled ? "enabled" : "disabled"} ·{" "}
                {scheduleSummary(a.schedule)} · OS: {osLabel} · model: {a.spec?.model?.id ?? "attivo"}
              </div>
              {osState === true ? (
                <div className="s-row-hint">
                  Registrato nel sistema operativo: gira anche a Desktop chiuso
                </div>
              ) : null}
            </div>
            <div className="s-row-control">
              <label className="automation-toggle" title={enabled ? "Disattiva" : "Attiva"}>
                <input
                  type="checkbox"
                  aria-label={`Enable ${a.name}`}
                  checked={enabled}
                  disabled={busy || !repoPath}
                  onChange={(e) => void toggleEnabled(a.id, e.target.checked)}
                />
              </label>
              <button
                type="button"
                className="btn-ghost"
                disabled={busy || !repoPath}
                onClick={() => onShowHistory(a.id)}
              >
                Cronologia
              </button>
              <select
                aria-label={`Modello per ${a.name}`}
                className="automation-model-select"
                style={{ maxWidth: 190 }}
                value={a.spec?.model ? `${a.spec.model.provider ?? ""}::${a.spec.model.id}` : ""}
                disabled={busy || !repoPath}
                onChange={(e) => void changeModel(a, e.target.value)}
              >
                <option value="">Modello attivo</option>
                {providers.map((p) => (
                  <optgroup key={p.id} label={p.displayName ?? p.id}>
                    {(p.models ?? []).map((m) => (
                      <option key={`${p.id}::${m}`} value={`${p.id}::${m}`}>
                        {m}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
              <button
                type="button"
                className="btn-ghost"
                disabled={busy || !repoPath}
                onClick={() =>
                  void act(a.id, () =>
                    manageAutomationSchedule(a.id, osState === true ? "remove" : "register", repoPath),
                  )
                }
              >
                {osState === true ? "Remove OS" : "Register OS"}
              </button>
              <button
                type="button"
                className="btn-ghost"
                disabled={busy || !repoPath}
                onClick={() => void act(a.id, () => runAutomationOnce(a.id, repoPath))}
              >
                Run once
              </button>
              <button
                type="button"
                className="btn-ghost"
                disabled={busy || !repoPath}
                title="Avvia in background, sopravvive alla chiusura del Desktop"
                onClick={() => void runHeadless(a.id)}
              >
                Run headless
              </button>
              <button
                type="button"
                className="btn-ghost"
                disabled={busy || !repoPath}
                onClick={() => void act(a.id, () => deleteAutomation(a.id, repoPath))}
              >
                Delete
              </button>
            </div>
          </div>
        );
      })}
    </SettingsCard>
  );
}
