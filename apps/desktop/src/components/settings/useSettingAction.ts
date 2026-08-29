/**
 * Wraps a settings async action with per-control busy state and toasts.
 *
 * Replaces the ~9 hand-rolled `setSaving/setError/setMessage/finally`
 * blocks of the old SettingsView. The wrapped action may return a custom
 * success message; returning nothing falls back to `opts.success`.
 */
import { useCallback, useRef, useState } from "react";
import { useSettingsToast } from "./primitives";

export interface SettingActionOptions {
  /** Toast shown when the action resolves; defaults to "Saved". */
  success?: string;
  /** When true, failures are silent (no error toast) — for passive refreshes. */
  silentError?: boolean;
}

export function useSettingAction(): {
  busy: boolean;
  run: (action: () => Promise<string | void>, opts?: SettingActionOptions) => Promise<boolean>;
} {
  const toast = useSettingsToast();
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);

  const run = useCallback(
    async (action: () => Promise<string | void>, opts?: SettingActionOptions) => {
      if (inFlight.current) return false;
      inFlight.current = true;
      setBusy(true);
      try {
        const msg = await action();
        toast.push("ok", opts?.success ?? (typeof msg === "string" ? msg : "Saved"));
        return true;
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        if (!opts?.silentError) toast.push("error", "Action failed", detail);
        return false;
      } finally {
        inFlight.current = false;
        setBusy(false);
      }
    },
    [toast],
  );

  return { busy, run };
}
