/**
 * QR pairing payload between Zelari Desktop and the Android companion.
 *
 * One scan fills both host URL and bearer token:
 *   zelari://pair?v=1&url=http%3A%2F%2F100.x.y.z%3A7421&token=…
 */

export const PAIRING_SCHEME = "zelari://pair";

export interface CompanionPairing {
  url: string;
  token: string;
}

export function normalizeCompanionUrl(raw: string): string {
  let s = raw.trim();
  if (!s) return s;
  // Strip wrapping quotes the user may paste from a terminal.
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    s = s.slice(1, -1).trim();
  }
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s)) {
    s = `http://${s}`;
  }
  return s.replace(/\/+$/, "");
}

export function isLoopbackHost(url: string): boolean {
  try {
    const host = new URL(normalizeCompanionUrl(url)).hostname.toLowerCase();
    return host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "::1";
  } catch {
    return false;
  }
}

export function formatCompanionPairing(url: string, token: string): string {
  const params = new URLSearchParams();
  params.set("v", "1");
  params.set("url", normalizeCompanionUrl(url));
  params.set("token", token.trim());
  return `${PAIRING_SCHEME}?${params.toString()}`;
}

export function parseCompanionPairing(raw: string): CompanionPairing | null {
  const s = raw.trim();
  if (!s) return null;

  if (s.startsWith("zelari://pair") || s.startsWith("zelari-code://pair")) {
    try {
      const u = new URL(s);
      const url = u.searchParams.get("url");
      if (!url) return null;
      return {
        url: normalizeCompanionUrl(url),
        token: (u.searchParams.get("token") ?? "").trim(),
      };
    } catch {
      return null;
    }
  }

  if (s.startsWith("{")) {
    try {
      const obj = JSON.parse(s) as { url?: unknown; token?: unknown };
      if (typeof obj.url !== "string" || !obj.url.trim()) return null;
      return {
        url: normalizeCompanionUrl(obj.url),
        token: typeof obj.token === "string" ? obj.token.trim() : "",
      };
    } catch {
      return null;
    }
  }

  if (/^https?:\/\//i.test(s) || /^\d{1,3}(\.\d{1,3}){3}/.test(s)) {
    try {
      const normalized = normalizeCompanionUrl(s.split(/\s+/)[0]!);
      const u = new URL(normalized);
      const token = u.searchParams.get("token") ?? "";
      u.search = "";
      u.hash = "";
      return { url: u.toString().replace(/\/+$/, ""), token };
    } catch {
      return null;
    }
  }

  return null;
}
