/**
 * Detachable always-on-top HUD window for voice + final-answer only.
 */
import { LogicalSize } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { availableMonitors, currentMonitor } from "@tauri-apps/api/window";

const LABEL = "overlay";

/** Compact bar at rest (mic + input). Grows via OverlayApp auto-resize. */
export const OVERLAY_DEFAULT_WIDTH = 280;
export const OVERLAY_COLLAPSED_HEIGHT = 58;
export const OVERLAY_MIN_WIDTH = 280;
export const OVERLAY_MIN_HEIGHT = 58;
export const OVERLAY_MAX_HEIGHT = 320;

async function placeTopCenter(width: number): Promise<{ x: number; y: number }> {
  let x = 80;
  let y = 40;
  try {
    const mon = (await currentMonitor()) ?? (await availableMonitors())[0];
    if (mon) {
      const scale = mon.scaleFactor || 1;
      const w = mon.size.width / scale;
      x = Math.round(mon.position.x / scale + (w - width) / 2);
      y = Math.round(mon.position.y / scale + 24);
    }
  } catch {
    /* browser / fallback */
  }
  return { x, y };
}

/** Open (or show) the overlay at minimum bar size. */
export async function openOrFocusOverlay(): Promise<void> {
  const min = new LogicalSize(OVERLAY_MIN_WIDTH, OVERLAY_MIN_HEIGHT);
  const existing = await WebviewWindow.getByLabel(LABEL);
  if (existing) {
    try {
      await existing.setSize(min);
    } catch {
      /* ignore */
    }
    await existing.show();
    // Don't steal focus from main chat on auto-open; still focus if user clicked ◉
    return;
  }

  const { x, y } = await placeTopCenter(OVERLAY_MIN_WIDTH);

  const win = new WebviewWindow(LABEL, {
    url: "overlay.html",
    title: "Zelari Overlay",
    width: OVERLAY_MIN_WIDTH,
    height: OVERLAY_MIN_HEIGHT,
    minWidth: OVERLAY_MIN_WIDTH,
    minHeight: OVERLAY_MIN_HEIGHT,
    resizable: true,
    decorations: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    focus: false,
    visible: true,
    shadow: false,
    x,
    y,
  });

  await new Promise<void>((resolve, reject) => {
    win.once("tauri://created", () => resolve());
    win.once("tauri://error", (e) => {
      reject(new Error(String((e as { payload?: unknown }).payload ?? e)));
    });
  });

  try {
    await win.setSize(min);
  } catch {
    /* ignore */
  }
}

/**
 * Open overlay at minimum size without focusing (e.g. programmatic restore).
 * Not used on Desktop launch — user opens via title bar ◉.
 */
export async function ensureOverlayOpenAtMin(): Promise<void> {
  await openOrFocusOverlay();
}

export async function hideOverlay(): Promise<void> {
  const existing = await WebviewWindow.getByLabel(LABEL);
  if (existing) await existing.hide();
}

export async function closeOverlay(): Promise<void> {
  const existing = await WebviewWindow.getByLabel(LABEL);
  if (existing) await existing.close();
}
