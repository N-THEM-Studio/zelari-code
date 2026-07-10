/**
 * Desktop auto-update via @tauri-apps/plugin-updater.
 * Checks GitHub Releases `latest.json` (signed artifacts).
 */
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { getVersion } from "@tauri-apps/api/app";

export type UpdateStatus =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "up-to-date"; current: string }
  | { kind: "available"; current: string; latest: string; notes?: string }
  | { kind: "downloading"; current: string; latest: string; percent?: number }
  | { kind: "ready"; current: string; latest: string }
  | { kind: "error"; message: string };

export async function getAppVersion(): Promise<string> {
  try {
    return await getVersion();
  } catch {
    return "dev";
  }
}

export async function checkForDesktopUpdate(): Promise<{
  update: Update | null;
  current: string;
}> {
  const current = await getAppVersion();
  // In browser-only vite (no Tauri), check() throws — treat as no update.
  try {
    const update = await check();
    return { update, current };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Dev / missing plugin: not an error for the shell
    if (/not available|webview|plugin/i.test(msg)) {
      return { update: null, current };
    }
    throw e;
  }
}

/**
 * Download + install the pending update, then relaunch.
 * Calls onProgress(0..100) when content length is known.
 */
export async function installDesktopUpdate(
  update: Update,
  onProgress?: (percent: number | undefined) => void,
): Promise<void> {
  let downloaded = 0;
  let contentLength: number | undefined;

  await update.downloadAndInstall((event) => {
    if (event.event === "Started") {
      contentLength = event.data.contentLength;
      onProgress?.(0);
    } else if (event.event === "Progress") {
      downloaded += event.data.chunkLength;
      if (contentLength && contentLength > 0) {
        onProgress?.(Math.min(100, Math.round((downloaded / contentLength) * 100)));
      } else {
        onProgress?.(undefined);
      }
    } else if (event.event === "Finished") {
      onProgress?.(100);
    }
  });

  await relaunch();
}
