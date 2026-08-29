/**
 * Small pure helpers shared by the settings sections.
 */

/** Effective model id: a non-empty custom id wins over the preset model. */
export function resolveModelId(customModel: string, model: string): string {
  return customModel.trim() || model;
}

/**
 * Human expiry for OAuth tokens: minutes under 90m, then hours, then days.
 * Returns null when there is nothing to show.
 */
export function formatExpiry(ms?: number | null): string | null {
  if (!ms) return null;
  const delta = ms - Date.now();
  if (delta <= 0) return "expired";
  const min = Math.round(delta / 60_000);
  if (min < 90) return `expires in ${min}m`;
  const hr = Math.round(min / 60);
  if (hr < 48) return `expires in ${hr}h`;
  const days = Math.round(hr / 24);
  return `expires in ${days}d`;
}

/** Short single-line model label for provider cards. */
export function modelLabel(model?: string | null): string {
  const m = (model ?? "").trim();
  return m || "no model set";
}
