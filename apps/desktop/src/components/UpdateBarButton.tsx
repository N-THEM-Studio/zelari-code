/**
 * Topbar control: check for updates / install when available.
 */
import { useRef, useState } from "react";
import type { Update } from "@tauri-apps/plugin-updater";
import { installDesktopUpdate } from "../updater";

export type PendingDesktopUpdate = {
  version: string;
  current: string;
  update: Update;
};

interface Props {
  pending: PendingDesktopUpdate | null;
  busy?: boolean;
  onCheck: () => void;
  onInstalled?: () => void;
  onError?: (msg: string) => void;
  onProgress?: (msg: string) => void;
}

export function UpdateBarButton({
  pending,
  busy,
  onCheck,
  onInstalled,
  onError,
  onProgress,
}: Props) {
  const [installing, setInstalling] = useState(false);
  const lock = useRef(false);

  const onInstall = async () => {
    if (!pending || lock.current) return;
    lock.current = true;
    setInstalling(true);
    onProgress?.(`Downloading v${pending.version}…`);
    try {
      await installDesktopUpdate(pending.update, (pct) => {
        if (pct != null) {
          onProgress?.(`Downloading v${pending.version} — ${pct}%`);
        }
      });
      onInstalled?.();
    } catch (e) {
      onError?.(e instanceof Error ? e.message : String(e));
    } finally {
      lock.current = false;
      setInstalling(false);
    }
  };

  if (pending) {
    return (
      <button
        type="button"
        className="btn-update"
        disabled={busy || installing}
        title={`Install desktop update v${pending.version}`}
        onClick={() => void onInstall()}
      >
        {installing ? "Updating…" : `Update v${pending.version}`}
      </button>
    );
  }

  return (
    <button
      type="button"
      className="btn-ghost topbar-update-check"
      disabled={busy || installing}
      title="Check for desktop app updates"
      onClick={onCheck}
    >
      ↻
    </button>
  );
}
