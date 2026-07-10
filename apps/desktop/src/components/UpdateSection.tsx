import { useCallback, useEffect, useRef, useState } from "react";
import type { Update } from "@tauri-apps/plugin-updater";
import {
  checkForDesktopUpdate,
  getAppVersion,
  installDesktopUpdate,
  type UpdateStatus,
} from "../updater";

interface Props {
  /** Auto-check once when Settings opens. */
  autoCheck?: boolean;
}

export function UpdateSection({ autoCheck = true }: Props) {
  const [status, setStatus] = useState<UpdateStatus>({ kind: "idle" });
  const [current, setCurrent] = useState("…");
  const pendingRef = useRef<Update | null>(null);
  const checkedRef = useRef(false);

  useEffect(() => {
    void getAppVersion().then(setCurrent);
  }, []);

  const runCheck = useCallback(async () => {
    setStatus({ kind: "checking" });
    pendingRef.current = null;
    try {
      const { update, current: cur } = await checkForDesktopUpdate();
      setCurrent(cur);
      if (!update) {
        setStatus({ kind: "up-to-date", current: cur });
        return;
      }
      pendingRef.current = update;
      setStatus({
        kind: "available",
        current: cur,
        latest: update.version,
        notes: update.body ?? undefined,
      });
    } catch (e) {
      setStatus({
        kind: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }, []);

  useEffect(() => {
    if (!autoCheck || checkedRef.current) return;
    checkedRef.current = true;
    // Slight delay so Settings paints first
    const t = window.setTimeout(() => void runCheck(), 400);
    return () => window.clearTimeout(t);
  }, [autoCheck, runCheck]);

  const runInstall = async () => {
    const update = pendingRef.current;
    if (!update) return;
    const latest = update.version;
    const cur =
      status.kind === "available" || status.kind === "downloading"
        ? status.current
        : current;
    setStatus({ kind: "downloading", current: cur, latest });
    try {
      await installDesktopUpdate(update, (percent) => {
        setStatus({
          kind: "downloading",
          current: cur,
          latest,
          percent,
        });
      });
      // relaunch() usually ends the process; if it returns:
      setStatus({ kind: "ready", current: cur, latest });
    } catch (e) {
      setStatus({
        kind: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  };

  return (
    <section className="settings-card">
      <h2>App updates</h2>
      <p className="muted">
        Desktop shell version <code>{current}</code>. Updates come from GitHub
        Releases (signed). The coding CLI still updates via{" "}
        <code>npm i -g zelari-code</code> / <code>/update</code>.
      </p>

      {status.kind === "idle" && (
        <p className="muted">Not checked yet.</p>
      )}
      {status.kind === "checking" && (
        <p className="muted">Checking for updates…</p>
      )}
      {status.kind === "up-to-date" && (
        <p className="ok-inline">You&apos;re on the latest desktop build ({status.current}).</p>
      )}
      {status.kind === "available" && (
        <div>
          <p className="warn">
            Update available: <strong>v{status.latest}</strong> (you have v
            {status.current})
          </p>
          {status.notes && (
            <pre className="update-notes">{status.notes.slice(0, 800)}</pre>
          )}
        </div>
      )}
      {status.kind === "downloading" && (
        <p className="muted">
          Downloading v{status.latest}
          {status.percent != null ? ` — ${status.percent}%` : "…"}
        </p>
      )}
      {status.kind === "ready" && (
        <p className="ok-inline">Installed. Restarting…</p>
      )}
      {status.kind === "error" && (
        <p className="error-banner">{status.message}</p>
      )}

      <div className="settings-actions inline">
        <button
          type="button"
          className="btn-ghost"
          disabled={status.kind === "checking" || status.kind === "downloading"}
          onClick={() => void runCheck()}
        >
          Check for updates
        </button>
        {status.kind === "available" && (
          <button
            type="button"
            className="btn-send"
            onClick={() => void runInstall()}
          >
            Download & install
          </button>
        )}
      </div>
    </section>
  );
}
