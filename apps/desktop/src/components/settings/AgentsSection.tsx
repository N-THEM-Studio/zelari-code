/**
 * Agents — Kraken delegation, model routing and the verification card.
 * Gates persist to localStorage prefs (same flow as the old onSave);
 * the advisory verifier writes to CLI provider.json.
 */
import { useEffect, useState } from "react";
import { setAppConfig } from "../../agentClient";
import {
  type DelegationPolicy,
  type DesktopPrefs,
} from "../../desktopPrefs";
import type { DesktopConfig } from "../../types";
import { KrakenModelSelect } from "../KrakenModelSelect";
import { PermissionsSection } from "../PermissionsSection";
import { SettingHelp } from "../SettingHelp";
import {
  BusyDot,
  SelectInput,
  SettingsCard,
  SettingsRow,
  Toggle,
} from "./primitives";
import { useSettingAction } from "./useSettingAction";

export interface AgentsSectionProps {
  config: DesktopConfig | null;
  prefs: DesktopPrefs;
  onPrefsChange: (partial: Partial<DesktopPrefs>) => void;
  onRefresh: () => Promise<void>;
}

export function AgentsSection({
  config,
  prefs,
  onPrefsChange,
  onRefresh,
}: AgentsSectionProps) {
  const { busy, run } = useSettingAction();
  const providers = config?.providers ?? [];
  const activeProvider = config?.activeProviderId ?? "";
  const active = providers.find((p) => p.id === activeProvider) ?? null;
  const models = active?.models ?? [];
  const crossProviderGroups = providers
    .filter((p) => p.id !== activeProvider)
    .map((p) => ({ id: p.id, label: p.displayName, models: p.models ?? [] }));

  const override = config?.krakenVerifier ?? null;
  const verifierMode = override ? "custom" : "inherit";
  const [verifierProvider, setVerifierProvider] = useState(
    override?.provider ?? providers[0]?.id ?? "",
  );
  const [verifierModel, setVerifierModel] = useState(
    override?.model ?? providers[0]?.defaultModel ?? providers[0]?.models[0] ?? "",
  );

  useEffect(() => {
    if (override) {
      setVerifierProvider(override.provider);
      setVerifierModel(override.model);
    }
  }, [override]);

  const saveVerifier = () =>
    void run(async () => {
      await setAppConfig({ verifierProvider, verifierModel });
      await onRefresh();
      return "Advisory verifier saved to provider.json";
    });

  const clearVerifier = () =>
    void run(async () => {
      await setAppConfig({ verifierClear: true });
      await onRefresh();
      return "Verifier inherits the current model";
    });

  return (
    <>
      <div className="settings-section-head">
        <h2>Agents</h2>
        <p>How Kraken delegates work, which models each role uses, and how results are verified.</p>
      </div>

      <SettingsCard
        title="Delegation"
        description="Controls when the Kraken lead spawns tentacles instead of doing the work itself."
      >
        <SettingsRow label="Delegation policy">
          <SelectInput
            value={prefs.krakenDelegation}
            ariaLabel="Delegation policy"
            onChange={(v) => onPrefsChange({ krakenDelegation: v as DelegationPolicy })}
          >
            <option value="automatic">Automatic (CLI default)</option>
            <option value="prefer">Prefer tentacles</option>
            <option value="aggressive">Aggressive</option>
            <option value="lead-only">Lead only</option>
          </SelectInput>
        </SettingsRow>
      </SettingsCard>

      <SettingsCard
        title="Kraken — model routing"
        description="Per-role model overrides. Cross-provider picks are stored qualified (e.g. grok/grok-4) and split by the CLI at spawn time."
      >
        <SettingsRow label="Lead model" hint="Read-only — set it in Models & Providers.">
          <span className="muted">
            {active ? `${active.displayName} / ${config?.modelByProvider[active.id] || "—"}` : "—"}
          </span>
        </SettingsRow>
        <KrakenModelSelect
          label="Explore tentacles"
          tooltipId="tooltip-kraken-explore"
          tooltip="Read-oriented research tentacles. A fast, cheap model is usually enough."
          value={prefs.krakenExploreModel}
          models={models}
          groups={crossProviderGroups}
          activeProviderLabel={active?.displayName ?? activeProvider}
          inheritLabel="Inherit / Kraken default"
          onChange={(v) => onPrefsChange({ krakenExploreModel: v })}
        />
        <KrakenModelSelect
          label="General tentacles"
          tooltipId="tooltip-kraken-general"
          tooltip="Code-writing tentacles for implementation tasks. Prefer a strong coding model for complex or high-impact changes."
          value={prefs.krakenGeneralModel}
          models={models}
          groups={crossProviderGroups}
          activeProviderLabel={active?.displayName ?? activeProvider}
          inheritLabel="Inherit / Kraken lead"
          onChange={(v) => onPrefsChange({ krakenGeneralModel: v })}
        />
        <KrakenModelSelect
          label="Verify tentacles"
          tooltipId="tooltip-kraken-verify"
          tooltip="Sub-agents that check completed work before the lead considers the task done. Different from the advisory verifier below."
          value={prefs.krakenVerifyModel}
          models={models}
          groups={crossProviderGroups}
          activeProviderLabel={active?.displayName ?? activeProvider}
          inheritLabel="Inherit / Kraken default"
          onChange={(v) => onPrefsChange({ krakenVerifyModel: v })}
        />
        <KrakenModelSelect
          label="Graph planner"
          tooltipId="tooltip-kraken-planner"
          tooltip="Plans Kraken Graph tasks as a dependency DAG. A fast non-reasoning model is often sufficient."
          value={prefs.krakenPlannerModel}
          models={models}
          groups={crossProviderGroups}
          activeProviderLabel={active?.displayName ?? activeProvider}
          inheritLabel="Inherit / Kraken lead"
          onChange={(v) => onPrefsChange({ krakenPlannerModel: v })}
        />
        <p className="s-card-desc" style={{ marginBottom: 0 }}>
          Typical setup: Explore → fast/cheap · General → strongest coding · Verify → reliable
          reviewer · Planner → low-latency.
        </p>
      </SettingsCard>

      <SettingsCard
        title="Verification"
        description="Deterministic gates run on every run; the advisory verifier adds an optional LLM review on top."
      >
        <SettingsRow
          label="Strict done — Kraken"
          help={
            <SettingHelp id="tooltip-strict-done" label="Strict done">
              Requires positive deterministic evidence before a Kraken run may report completion.
            </SettingHelp>
          }
        >
          <Toggle
            checked={prefs.strictDone}
            label="Strict done Kraken"
            onChange={(v) => onPrefsChange({ strictDone: v })}
          />
        </SettingsRow>
        <SettingsRow label="Strict done — Missions" hint="On by default for Zelari missions.">
          <Toggle
            checked={prefs.missionStrict}
            label="Strict done missions"
            onChange={(v) => onPrefsChange({ missionStrict: v })}
          />
        </SettingsRow>
        <SettingsRow
          label="Native criteria pack"
          help={
            <SettingHelp id="tooltip-native-pack" label="Native criteria pack">
              Runs deterministic project checks such as typecheck, tests and build when the project
              exposes the corresponding commands.
            </SettingHelp>
          }
        >
          <Toggle
            checked={prefs.verifyPack}
            label="Native criteria pack"
            onChange={(v) => onPrefsChange({ verifyPack: v })}
          />
        </SettingsRow>
        <SettingsRow
          label="Advisory verifier review"
          help={
            <SettingHelp id="tooltip-advisory-review" label="Advisory verifier review">
              Controls whether Zelari asks the configured advisory verification model for an
              additional LLM review. This review does not replace deterministic gates.
            </SettingHelp>
          }
        >
          <SelectInput
            value={prefs.verifierReview === null ? "auto" : prefs.verifierReview ? "on" : "off"}
            ariaLabel="Advisory verifier review"
            onChange={(v) =>
              onPrefsChange({ verifierReview: v === "auto" ? null : v === "on" })
            }
          >
            <option value="auto">Automatic — enabled by a dedicated verifier model</option>
            <option value="on">Always on</option>
            <option value="off">Always off</option>
          </SelectInput>
        </SettingsRow>

        <h4 className="settings-subhead">Advisory verification model</h4>
        <SettingsRow label="Mode" hint="Inherit uses the current chat model (recommended).">
          <SelectInput
            value={verifierMode}
            ariaLabel="Advisory verifier mode"
            onChange={(v) => {
              if (v === "custom" && !verifierProvider && providers.length > 0) {
                const first = providers[0];
                setVerifierProvider(first.id);
                setVerifierModel(first.defaultModel || first.models[0] || "");
              }
            }}
          >
            <option value="inherit">Same as current model (recommended)</option>
            <option value="custom">Custom provider + model…</option>
          </SelectInput>
        </SettingsRow>
        {verifierMode === "custom" && (
          <>
            <SettingsRow label="Verifier provider">
              <SelectInput
                value={verifierProvider}
                ariaLabel="Verifier provider"
                onChange={(v) => {
                  setVerifierProvider(v);
                  const p = providers.find((x) => x.id === v);
                  setVerifierModel(p?.defaultModel || p?.models[0] || "");
                }}
              >
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.displayName}
                    {p.hasKey ? "" : " — no API key"}
                  </option>
                ))}
              </SelectInput>
            </SettingsRow>
            <SettingsRow label="Verifier model">
              <SelectInput
                value={verifierModel}
                ariaLabel="Verifier model"
                onChange={setVerifierModel}
              >
                {(providers.find((x) => x.id === verifierProvider)?.models ?? []).map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </SelectInput>
            </SettingsRow>
            <div className="settings-actions inline">
              <button
                type="button"
                className="btn-send"
                disabled={busy || !verifierProvider || !verifierModel}
                onClick={saveVerifier}
              >
                Save verifier
              </button>
              {busy ? <BusyDot /> : null}
            </div>
          </>
        )}
        {verifierMode === "inherit" && override && (
          <div className="settings-actions inline">
            <button
              type="button"
              className="btn-ghost"
              disabled={busy}
              onClick={clearVerifier}
            >
              Reset to inherit
            </button>
          </div>
        )}
        {override ? (
          <p className="s-card-desc" style={{ marginBottom: 0 }}>
            Current override: {override.provider} / {override.model}
          </p>
        ) : null}
      </SettingsCard>

      <SettingsCard title="Experiments" description="Optional compute-heavy modes.">
        <SettingsRow
          label="Best-of-N alpha (N=3)"
          help={
            <SettingHelp id="tooltip-bon-alpha" label="Best-of-N alpha">
              Experimental test-time compute mode that generates and evaluates multiple candidates.
              Increases latency and model usage; never flips the deterministic gate.
            </SettingHelp>
          }
        >
          <Toggle
            checked={prefs.bonAlpha}
            label="Best of N"
            onChange={(v) => onPrefsChange({ bonAlpha: v })}
          />
        </SettingsRow>
        <SettingsRow
          label="Gauntlet Loop"
          hint="Builder/critic rounds — exclusive with Graph. Same as the top-bar toggle."
          help={
            <SettingHelp id="tooltip-gauntlet-loop" label="Gauntlet Loop">
              Runs iterative builder-versus-critic rounds so the implementation can be challenged
              and revised multiple times. Intended for difficult tasks.
            </SettingHelp>
          }
        >
          <Toggle
            checked={prefs.gauntletLoop}
            label="Gauntlet loop"
            onChange={(v) => onPrefsChange({ gauntletLoop: v })}
          />
        </SettingsRow>
      </SettingsCard>

      <PermissionsSection prefs={prefs} onPrefsChange={onPrefsChange} />
    </>
  );
}
