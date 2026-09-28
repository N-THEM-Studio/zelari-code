/**
 * Silent Grok session renew for the chat picker and Settings.
 *
 * Uses the existing `refreshOAuth` IPC (`--refresh-oauth`). Never starts a
 * device-code login and never opens a browser — if there is no refresh token
 * the caller must not invoke this. One in-flight promise is shared so two
 * clicks cannot spawn two CLI refresh processes.
 */
import { refreshOAuth, type OAuthActionResult } from "./agentClient";

export const GROK_PROVIDER_ID = "grok";

/** Same fallback AuthCard uses when the CLI omits a message (`${name} session renewed.`). */
export const GROK_SESSION_RENEWED = "Grok session renewed.";

export interface GrokRenewResult {
  ok: boolean;
  message: string;
}

let inFlight: Promise<GrokRenewResult> | null = null;

function errorText(e: unknown): string {
  if (typeof e === "string" && e.trim()) return e.trim();
  if (e instanceof Error && e.message.trim()) return e.message.trim();
  if (e && typeof e === "object" && "message" in e) {
    const m = (e as { message?: unknown }).message;
    if (typeof m === "string" && m.trim()) return m.trim();
  }
  return "Could not renew the Grok session.";
}

function resultFrom(r: OAuthActionResult): GrokRenewResult {
  if (r.ok === false) {
    return {
      ok: false,
      message: r.error?.trim() || "Could not renew the Grok session.",
    };
  }
  return { ok: true, message: r.message?.trim() || GROK_SESSION_RENEWED };
}

async function runRenew(refreshConfig: () => Promise<void>): Promise<GrokRenewResult> {
  let r: OAuthActionResult;
  try {
    r = await refreshOAuth({ provider: GROK_PROVIDER_ID });
  } catch (e) {
    return { ok: false, message: errorText(e) };
  }
  const result = resultFrom(r);
  if (!result.ok) return result;
  try {
    await refreshConfig();
  } catch (e) {
    return { ok: false, message: errorText(e) };
  }
  return result;
}

/**
 * Refresh the stored Grok session once, then reload config so the UI sees the
 * new token metadata. A second call while the first is still running returns
 * the same promise and does not start another refresh.
 */
export function renewGrokSession(
  refreshConfig: () => Promise<void>,
): Promise<GrokRenewResult> {
  if (inFlight) return inFlight;
  const job = runRenew(refreshConfig).finally(() => {
    if (inFlight === job) inFlight = null;
  });
  inFlight = job;
  return job;
}

/** Test hook: drop a leaked lock without letting a late finally clear a newer one. */
export function resetGrokRenewForTests(): void {
  inFlight = null;
}

/**
 * Chat provider pick, after `persistChatModel` has succeeded. Only provider id
 * `grok` with a stored refresh token renews; every other pick just reloads
 * config, matching the previous `onProviderChange` tail.
 */
export async function renewGrokAfterChatPersist(args: {
  providerId: string;
  hasRefreshToken: boolean | undefined;
  refreshConfig: () => Promise<void>;
  setStatus: (message: string) => void;
}): Promise<void> {
  if (args.providerId !== GROK_PROVIDER_ID || args.hasRefreshToken !== true) {
    await args.refreshConfig();
    return;
  }
  const result = await renewGrokSession(args.refreshConfig);
  args.setStatus(result.message);
  if (!result.ok) await args.refreshConfig();
}
