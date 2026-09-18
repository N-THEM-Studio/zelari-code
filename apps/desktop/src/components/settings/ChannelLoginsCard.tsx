/**
 * ChannelLoginsCard — Settings → Automations: manual browser login + health for
 * the social channels (x, facebook). The CLI owns the persistent profiles
 * (~/.zelari-code/browser-profiles/<channel>); this card only orchestrates.
 *
 * Health on mount; "Login" opens a HEADED window (the wait lasts as long as the
 * user's login). Exit 4 (relogin_required) is a VALID state, never an error.
 */
import { useCallback, useEffect, useState } from "react";
import {
  automationChannelHealth,
  automationChannelLogin,
  formatAutomationError,
} from "../../agentClient";
import { ChannelProbePanel } from "./ChannelProbePanel";
import { WebsiteCredentialForm } from "./WebsiteCredentialForm";
import { SettingsCard, StatusPill } from "./primitives";

export interface ChannelLoginsCardProps {
  workdir: string | null;
}

const LOGIN_CHANNELS = ["x", "facebook"] as const;
type Channel = (typeof LOGIN_CHANNELS)[number];
type HealthStatus = "unknown" | "checking" | "logged" | "relogin" | "error";

interface ChannelState {
  status: HealthStatus;
  message?: string;
}

const CHIP: Record<HealthStatus, { tone: "ok" | "warn" | "neutral"; label: string }> = {
  unknown: { tone: "neutral", label: "sconosciuto" },
  checking: { tone: "neutral", label: "verifica…" },
  logged: { tone: "ok", label: "loggato" },
  relogin: { tone: "warn", label: "ri-login richiesto" },
  error: { tone: "warn", label: "errore" },
};

export function ChannelLoginsCard({ workdir }: ChannelLoginsCardProps) {
  const repoPath = workdir ?? "";
  const [state, setState] = useState<Record<Channel, ChannelState>>({
    x: { status: "unknown" },
    facebook: { status: "unknown" },
  });
  const [busy, setBusy] = useState<Channel | null>(null);

  const check = useCallback(
    async (channel: Channel) => {
      if (!repoPath) return;
      setState((s) => ({ ...s, [channel]: { status: "checking" } }));
      try {
        const report = await automationChannelHealth(channel, repoPath);
        setState((s) => ({
          ...s,
          [channel]: {
            status: report.loggedIn ? "logged" : "relogin",
            message: report.message,
          },
        }));
      } catch (e) {
        setState((s) => ({
          ...s,
          [channel]: { status: "error", message: formatAutomationError(e) },
        }));
      }
    },
    [repoPath],
  );

  useEffect(() => {
    if (!repoPath) return;
    // Probe ONCE on mount (and after Login / Verifica). A 30s Chromium health
    // poll raced the persistent profile (false relogin_required, locked cookies,
    // publishes that never submitted). Cookie-disk health is now instant anyway.
    void check("x");
    void check("facebook");
  }, [repoPath, check]);

  const login = async (channel: Channel) => {
    if (busy) return;
    setBusy(channel);
    try {
      const res = await automationChannelLogin(channel, repoPath);
      setState((s) => ({
        ...s,
        [channel]: { status: res.ok ? "logged" : "relogin", message: res.message },
      }));
    } catch (e) {
      setState((s) => ({
        ...s,
        [channel]: { status: "error", message: formatAutomationError(e) },
      }));
    } finally {
      setBusy(null);
    }
  };

  return (
    <SettingsCard
      title="Login canali"
      description="Apre una finestra browser (headed) sul profilo persistente per accedere a X / Facebook. La sessione resta salvata localmente e viene riusata dalle automation."
    >
      {LOGIN_CHANNELS.map((channel) => {
        const st = state[channel];
        const chip = CHIP[st.status];
        const isBusy = busy === channel;
        return (
          <div className="s-row" key={channel}>
            <div>
              <div className="s-row-label">
                {channel} <StatusPill tone={chip.tone}>{chip.label}</StatusPill>
              </div>
              {st.message ? <div className="s-row-hint">{st.message}</div> : null}
              {isBusy ? (
                <div className="s-row-hint">
                  Finestra browser in apertura — se non la vedi, cerca Chromium nella barra delle
                  applicazioni. Accedi dentro la finestra: si chiuderà da sola appena il login
                  riesce, e la sessione resta salvata nel profilo.
                </div>
              ) : null}
            </div>
            <div className="s-row-control">
              <button
                type="button"
                className="btn-ghost"
                disabled={isBusy || !repoPath}
                onClick={() => void login(channel)}
              >
                {isBusy ? "Login…" : "Login"}
              </button>
              <button
                type="button"
                className="btn-ghost"
                disabled={isBusy || !repoPath}
                onClick={() => void check(channel)}
              >
                Verifica sessione
              </button>
            </div>
          </div>
        );
      })}
      {LOGIN_CHANNELS.map((channel) => (
        <ChannelProbePanel key={`probe-${channel}`} workdir={workdir} channel={channel} />
      ))}
      <WebsiteCredentialForm workdir={workdir} />
    </SettingsCard>
  );
}
