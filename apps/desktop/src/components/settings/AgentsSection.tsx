/**
 * Agents — how the Kraken lead proves the work is done.
 *
 * Laid out for someone who has never heard of "tentacles": the main model,
 * quality checks as plain toggles, tool permissions as described choices, and
 * the execution profile under Advanced. Prefs autosave to localStorage; the
 * second-opinion model writes to the CLI config.
 *
 * Every control here reaches the run: prefs ride run.turn per turn (the CLI
 * applies them to that turn only). Removed on purpose: the separate missions
 * strict toggle (the proof requirement covers missions too), Best-of-N (the
 * CLI verifier never enables it), the Gauntlet toggle, and delegation plus the
 * per-role tentacle models — those live on the composer (Run mode and
 * Tentacles pills), next to the prompt they shape.
 */
import { useEffect, useState } from "react";
import { setAppConfig } from "../../agentClient";
import { EXECUTION_PROFILES, type DesktopPrefs, type ExecutionProfile } from "../../desktopPrefs";
import type { DesktopConfig } from "../../types";
import { PermissionsSection } from "../PermissionsSection";
import { SettingHelp } from "../SettingHelp";
import {
  BusyDot,
  ChoiceList,
  Collapsible,
  SelectInput,
  SettingsCard,
  SettingsRow,
  Toggle,
} from "./primitives";
import { useSettingAction } from "./useSettingAction";

export interface AgentsSectionProps {
  config: DesktopConfig | null;
  prefs: DesktopPrefs;
  /** SLICE4(model-sync): the model the ACTIVE chat will run with (App state,
   *  kept in sync with provider.json by App's `persistChatModel`). */
  activeChatModel?: string;
  onPrefsChange: (partial: Partial<DesktopPrefs>) => void;
  onRefresh: () => Promise<void>;
}

type SecondOpinion = "off" | "same" | "custom";

const PROFILE_LABELS: Record<ExecutionProfile, { label: string; description: string }> = {
  "kraken/v1": { label: "Standard", description: "Kraken with sub-agents (default)." },
  "minimal/v1": { label: "Minimal", description: "Tools only — no sub-agents, no hooks." },
  "council/v1": { label: "Council", description: "Multi-role council pipeline." },
  "mission/v1": { label: "Mission", description: "Long-running plan → build → verify loop." },
};

export function AgentsSection({
  config,
  prefs,
  activeChatModel = "",
  onPrefsChange,
  onRefresh,
}: AgentsSectionProps) {
  const { busy, run } = useSettingAction();
  const providers = config?.providers ?? [];
  const activeProvider = config?.activeProviderId ?? "";
  const active = providers.find((p) => p.id === activeProvider) ?? null;

  // SLICE4(model-sync): the Lead runs on the CHAT model. Show the live chat
  // value; when it drifts from the saved default, say so and offer to save it
  // through the same `set_app_config` channel the rest of Settings uses.
  const leadChatModel = activeChatModel.trim();
  const leadConfigModel = config?.modelByProvider[activeProvider] || "";
  const leadModel = leadChatModel || leadConfigModel;
  const leadDrift = Boolean(leadChatModel && leadConfigModel && leadChatModel !== leadConfigModel);

  const saveLeadModel = () =>
    void run(async () => {
      await setAppConfig({ provider: activeProvider, model: leadChatModel });
      await onRefresh();
      return `Saved ${leadChatModel} as the default model`;
    });

  // ── Second opinion (advisory verifier) ────────────────────────────────
  const override = config?.krakenVerifier ?? null;
  const savedOpinion: SecondOpinion =
    prefs.verifierReview === false ? "off" : override ? "custom" : prefs.verifierReview === true ? "same" : "off";
  const [opinion, setOpinion] = useState<SecondOpinion>(savedOpinion);
  const [verifierProvider, setVerifierProvider] = useState(override?.provider ?? providers[0]?.id ?? "");
  const [verifierModel, setVerifierModel] = useState(
    override?.model ?? providers[0]?.defaultModel ?? providers[0]?.models[0] ?? "",
  );
  useEffect(() => setOpinion(savedOpinion), [savedOpinion]);
  useEffect(() => {
    if (override) {
      setVerifierProvider(override.provider);
      setVerifierModel(override.model);
    }
  }, [override]);

  const chooseOpinion = (next: SecondOpinion) => {
    setOpinion(next);
    if (next === "off") {
      onPrefsChange({ verifierReview: false });
    } else if (next === "same") {
      onPrefsChange({ verifierReview: true });
      if (override) {
        void run(async () => {
          await setAppConfig({ verifierClear: true });
          await onRefresh();
          return "Second opinion uses the chat model";
        });
      }
    }
    // "custom" waits for Save (provider + model below).
  };

  const saveVerifier = () =>
    void run(async () => {
      await setAppConfig({ verifierProvider, verifierModel });
      onPrefsChange({ verifierReview: true });
      await onRefresh();
      return `Second opinion: ${verifierProvider} / ${verifierModel}`;
    });

  return (
    <>
      <div className="settings-section-head">
        <h2>Agents</h2>
        <p>How Zelari's lead agent (Kraken) proves the work is really done.</p>
      </div>

      <SettingsCard
        title="Main model"
        help={
          <SettingHelp id="tooltip-main-model" label="Main model">
            Kraken, the lead agent, always runs on the chat model. Sub-agents use it too unless you
            give a role its own model from the Tentacles pill under the chat.
          </SettingHelp>
        }
      >
        <SettingsRow label="Chats run on" hint="Change it in Models & Providers or from the model picker above the chat.">
          <span className="muted">{active ? `${active.displayName} / ${leadModel || "—"}` : leadModel || "—"}</span>
        </SettingsRow>
        {leadDrift ? (
          <p className="s-card-desc" style={{ marginBottom: 0 }}>
            This chat uses {leadChatModel}, but the saved default is {leadConfigModel}.{" "}
            <button type="button" className="btn-ghost" disabled={busy || !activeProvider} onClick={saveLeadModel}>
              Make {leadChatModel} the default
            </button>
          </p>
        ) : null}
        <p className="s-card-desc" style={{ marginBottom: 0 }}>
          Delegation and the model of each sub-agent (“tentacle”) are set from the
          Tentacles pill under the message box. These never change the model of the main chat.
        </p>
      </SettingsCard>

      <SettingsCard
        title="Quality checks"
        description="How strictly Kraken has to prove a task is finished. Applied to your next run."
      >
        <SettingsRow
          label="Require proof before “done”"
          hint="Recommended. Covers Kraken runs and Zelari missions."
          help={
            <SettingHelp id="tooltip-strict-done" label="Require proof">
              Kraken may only report a task as finished when there is real evidence (edits made,
              checks run and passed). Without it, the run ends as “blocked” and tells you what is
              missing instead of claiming success.
            </SettingHelp>
          }
        >
          <Toggle
            checked={prefs.strictDone}
            label="Require proof before done"
            onChange={(v) => onPrefsChange({ strictDone: v, missionStrict: v })}
          />
        </SettingsRow>
        <SettingsRow
          label="Run the project's own checks"
          hint="Typecheck, tests and build — when the project defines them."
          help={
            <SettingHelp id="tooltip-native-pack" label="Project checks">
              After changes, Zelari runs the commands your project already has (for example npm
              test or tsc) and counts their result as evidence. Slower, but catches breakage.
            </SettingHelp>
          }
        >
          <Toggle
            checked={prefs.verifyPack}
            label="Run the project's own checks"
            onChange={(v) => onPrefsChange({ verifyPack: v })}
          />
        </SettingsRow>
        <SettingsRow
          label="Verify with a different provider"
          hint="Only providers you are signed in to are used."
          help={
            <SettingHelp id="tooltip-cross-provider" label="Different provider">
              The checker sub-agent runs on a model from another company than the one that wrote
              the code — an independent second pair of eyes. Turn it off to keep every request on
              the provider you selected.
            </SettingHelp>
          }
        >
          <Toggle
            checked={prefs.krakenCrossModel}
            label="Verify with a different provider"
            onChange={(v) => onPrefsChange({ krakenCrossModel: v })}
          />
        </SettingsRow>
        <SettingsRow
          label="Second-opinion review"
          stacked
          help={
            <SettingHelp id="tooltip-advisory-review" label="Second-opinion review">
              An extra AI review of the finished work. It is advisory: it adds notes but never
              overrides the proof requirement above. Costs one more model call per run.
            </SettingHelp>
          }
        >
          <ChoiceList
            name="second-opinion"
            ariaLabel="Second-opinion review"
            value={opinion}
            disabled={busy}
            onChange={chooseOpinion}
            options={[
              { value: "off", label: "Off", badge: "Default", description: "No extra review." },
              { value: "same", label: "On — chat model", description: "The chat model reviews the result." },
              {
                value: "custom",
                label: "On — a specific model",
                description: "Pick a dedicated reviewer, e.g. from another provider.",
              },
            ]}
          />
        </SettingsRow>
        {opinion === "custom" ? (
          <>
            <SettingsRow label="Reviewer provider">
              <SelectInput
                value={verifierProvider}
                ariaLabel="Reviewer provider"
                onChange={(v) => {
                  setVerifierProvider(v);
                  const p = providers.find((x) => x.id === v);
                  setVerifierModel(p?.defaultModel || p?.models[0] || "");
                }}
              >
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.displayName}
                    {p.hasKey ? "" : " — not connected"}
                  </option>
                ))}
              </SelectInput>
            </SettingsRow>
            <SettingsRow label="Reviewer model">
              <SelectInput value={verifierModel} ariaLabel="Reviewer model" onChange={setVerifierModel}>
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
                Save reviewer
              </button>
              {override ? (
                <span className="muted">
                  Saved: {override.provider} / {override.model}
                </span>
              ) : null}
              {busy ? <BusyDot /> : null}
            </div>
          </>
        ) : null}
      </SettingsCard>

      <PermissionsSection prefs={prefs} onPrefsChange={onPrefsChange} />

      <SettingsCard>
        <Collapsible summary="Advanced" hint="Execution profile">
          <SettingsRow
            label="Execution profile"
            hint={PROFILE_LABELS[prefs.profile]?.description}
            help={
              <SettingHelp id="tooltip-profile" label="Execution profile">
                Which capabilities the engine wires up for a run. Keep “Standard” unless you know
                you need another profile; the chat mode picker already covers Missions.
              </SettingHelp>
            }
          >
            <SelectInput
              value={prefs.profile}
              ariaLabel="Execution profile"
              onChange={(v) => onPrefsChange({ profile: v as ExecutionProfile })}
            >
              {EXECUTION_PROFILES.map((p) => (
                <option key={p} value={p}>
                  {PROFILE_LABELS[p]?.label ?? p}
                </option>
              ))}
            </SelectInput>
          </SettingsRow>
        </Collapsible>
      </SettingsCard>
    </>
  );
}
