/**
 * Automations — one card per scheduled job, backed by the OS scheduler.
 *
 * The gardener is propose-only: it checks out the repo's plan, and only when
 * there is something to do does it run the plan phase under a hard budget cap.
 * A quiet repo exits 0 without spending anything.
 */
import { useCallback, useEffect, useState } from "react";
import { manageAutomation, type AutomationStatus } from "../../agentClient";
import { DEFAULT_DESKTOP_PREFS, type DesktopPrefs } from "../../desktopPrefs";
import {
  BusyDot,
  SelectInput,
  SettingsCard,
  SettingsRow,
  StatusPill,
  TextInput,
  Toggle,
} from "./primitives";
import { useSettingAction } from "./useSettingAction";

export interface AutomationsSectionProps {
  prefs: DesktopPrefs;
  onPrefsChange: (partial: Partial<DesktopPrefs>) => void;
  /** Repo whose scripts/zelari-gardener.sh the scheduled task runs. */
  workdir: string | null;
}

/** Interval choices offered in the select (minutes). */
const INTERVAL_OPTIONS = [10, 15, 30, 60, 120];

export function AutomationsSection({
  prefs,
  onPrefsChange,
  workdir,
}: AutomationsSectionProps) {
  const { busy, run } = useSettingAction();
  const [status, setStatus] = useState<AutomationStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);

  const repoPath = workdir ?? "";
  const { gardenerEnabled, gardenerIntervalMin, gardenerMaxCostUsd } = prefs;
  // A stored value outside the offered list would render an empty select.
  const intervalChoices = INTERVAL_OPTIONS.includes(gardenerIntervalMin)
    ? INTERVAL_OPTIONS
    : [...INTERVAL_OPTIONS, gardenerIntervalMin].sort((a, b) => a - b);

  const refreshStatus = useCallback(async () => {
    try {
      const next = await manageAutomation({
        action: "status",
        intervalMin: gardenerIntervalMin,
        maxCostUsd: gardenerMaxCostUsd,
        repoPath,
      });
      setStatus(next);
      setStatusError(null);
    } catch (e) {
      setStatus(null);
      setStatusError(e instanceof Error ? e.message : String(e));
    }
  }, [gardenerIntervalMin, gardenerMaxCostUsd, repoPath]);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  const runAction = (action: "register" | "remove", success: string) =>
    void run(async () => {
      const next = await manageAutomation({
        action,
        intervalMin: gardenerIntervalMin,
        maxCostUsd: gardenerMaxCostUsd,
        repoPath,
      });
      setStatus(next);
      setStatusError(null);
      return success;
    });

  return (
    <>
      <div className="settings-section-head">
        <h2>Automations</h2>
        <p>Jobs the app hands to the operating system so they keep running while it is closed.</p>
      </div>

      <div className="settings-stack">
        <SettingsCard
          title="Gardener"
          description="Runs scripts/zelari-gardener.sh on a schedule. Plan phase only — it proposes work and never commits; every run is capped by the budget below, and a quiet repo (no failing tests, no new commits, no pending plan tasks) exits immediately at $0."
        >
          <SettingsRow
            label="Enable gardener"
            hint="Your intent flag; the task itself is registered or removed below."
          >
            <Toggle
              checked={gardenerEnabled}
              label="Enable gardener automation"
              onChange={(v) => onPrefsChange({ gardenerEnabled: v })}
            />
          </SettingsRow>

          <SettingsRow label="Run every" hint="Windows Task Scheduler triggers the task at this interval.">
            <SelectInput
              value={String(gardenerIntervalMin)}
              ariaLabel="Gardener interval"
              onChange={(v) => onPrefsChange({ gardenerIntervalMin: Number(v) })}
            >
              {intervalChoices.map((min) => (
                <option key={min} value={min}>
                  {min} minutes
                </option>
              ))}
            </SelectInput>
          </SettingsRow>

          <SettingsRow
            label="Max cost per run (USD)"
            hint="ZELARI_MISSION_MAX_COST for each run — 0.5 to 20."
          >
            <TextInput
              value={String(gardenerMaxCostUsd)}
              type="number"
              ariaLabel="Gardener max cost"
              style={{ maxWidth: 120 }}
              onCommit={(next) => {
                const n = Number(next);
                onPrefsChange({
                  gardenerMaxCostUsd:
                    next.trim() === "" || !Number.isFinite(n)
                      ? DEFAULT_DESKTOP_PREFS.gardenerMaxCostUsd
                      : n,
                });
              }}
            />
          </SettingsRow>

          <SettingsRow label="Scheduled task" hint={workdir ?? undefined}>
            {statusError ? (
              <StatusPill tone="warn">{statusError}</StatusPill>
            ) : status === null ? (
              <StatusPill tone="neutral">Checking…</StatusPill>
            ) : (
              <StatusPill tone={status.registered ? "ok" : "neutral"}>
                {status.registered ? "Registered" : "Not registered"}
                {status.registered && status.nextRun ? ` · next ${status.nextRun}` : ""}
              </StatusPill>
            )}
          </SettingsRow>

          <div className="settings-actions inline">
            <button
              type="button"
              className="btn-send"
              disabled={busy || !repoPath}
              title={repoPath ? undefined : "Open a workspace folder first"}
              onClick={() => runAction("register", "Gardener task registered")}
            >
              Register task
            </button>
            <button
              type="button"
              className="btn-ghost"
              disabled={busy || !repoPath}
              onClick={() => runAction("remove", "Gardener task removed")}
            >
              Remove task
            </button>
            {busy ? <BusyDot /> : null}
          </div>

          {status?.detail ? (
            <p className="s-card-desc" style={{ marginBottom: 0 }}>
              {status.detail}
            </p>
          ) : null}
        </SettingsCard>
      </div>
    </>
  );
}
