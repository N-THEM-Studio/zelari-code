/**
 * SemVer helpers for the Desktop CLI updater UI.
 *
 * Numeric "split on `.` then parseInt" comparison treats `2.0.0-alpha.4` as
 * equal to `2.0.0` (`parseInt("0-alpha") === 0`). That made Settings claim
 * the CLI was up to date on npm latest and disabled "Update CLI".
 */

export function normalizeSemver(raw: string): string {
  const s = raw.trim();
  const token = s.split(/\s+/).pop() ?? s;
  return token.trim().replace(/^v/i, "");
}

export type ParsedSemver = {
  core: [number, number, number];
  pre: string | null;
};

export function parseSemver(raw: string): ParsedSemver | null {
  const s = normalizeSemver(raw);
  if (!s) return null;
  const dash = s.indexOf("-");
  const core = dash >= 0 ? s.slice(0, dash) : s;
  const pre = dash >= 0 ? s.slice(dash + 1) : null;
  const parts = core.split(".");
  const major = Number.parseInt(parts[0] ?? "", 10);
  const minor = Number.parseInt(parts[1] ?? "0", 10);
  const patch = Number.parseInt(parts[2] ?? "0", 10);
  if (![major, minor, patch].every((n) => Number.isFinite(n))) return null;
  return { core: [major, minor, patch], pre };
}

function cmpPrerelease(a: string, b: string): number {
  const pa = a.split(".");
  const pb = b.split(".");
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const x = pa[i];
    const y = pb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x) ? Number(x) : null;
    const yn = /^\d+$/.test(y) ? Number(y) : null;
    if (xn !== null && yn !== null) {
      if (xn !== yn) return xn < yn ? -1 : 1;
      continue;
    }
    if (xn !== null && yn === null) return -1;
    if (xn === null && yn !== null) return 1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** -1 if a < b, 0 equal, 1 if a > b. A release outranks a matching prerelease. */
export function cmpSemver(a: string, b: string): number {
  const x = parseSemver(a);
  const y = parseSemver(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) {
    if (x.core[i]! < y.core[i]!) return -1;
    if (x.core[i]! > y.core[i]!) return 1;
  }
  if (x.pre === null && y.pre === null) return 0;
  if (x.pre !== null && y.pre === null) return -1;
  if (x.pre === null && y.pre !== null) return 1;
  return cmpPrerelease(x.pre!, y.pre!);
}

export type CliUpdateCheckLike = {
  installed?: string | null;
  npmLatest?: string | null;
  channel?: string;
  updateAvailable?: boolean;
  message?: string;
};

export type CliUpdatePresentation = {
  updateAvailable: boolean;
  upToDate: boolean;
  message: string;
};

function claimsUpToDate(message: string | undefined): boolean {
  return Boolean(message && /up to date/i.test(message));
}

/**
 * Resolve what Settings should show / enable, even if an older Desktop
 * backend compared prereleases as equal to the matching release.
 */
export function resolveCliUpdateStatus(
  info: CliUpdateCheckLike | null,
  installedFallback: string | null = null,
): CliUpdatePresentation {
  const installed = info?.installed ?? installedFallback;
  const npmLatest = info?.npmLatest ?? null;
  const channel = info?.channel ?? "latest";

  if (!installed) {
    return {
      updateAvailable: true,
      upToDate: false,
      message: npmLatest
        ? `CLI not found. Install with: npm i -g zelari-code@${npmLatest}`
        : (info?.message ?? "CLI not found."),
    };
  }

  const behindRegistry =
    Boolean(npmLatest) && cmpSemver(installed, npmLatest as string) < 0;
  const updateAvailable = Boolean(info?.updateAvailable) || behindRegistry;

  if (updateAvailable) {
    const backendMsg = info?.message?.trim() ?? "";
    const message =
      backendMsg && !claimsUpToDate(backendMsg)
        ? backendMsg
        : npmLatest
          ? `CLI is v${installed}; npm ${channel} is v${npmLatest}. Use Update CLI to upgrade.`
          : backendMsg;
    return { updateAvailable: true, upToDate: false, message };
  }

  if (npmLatest && cmpSemver(installed, npmLatest) === 0) {
    return {
      updateAvailable: false,
      upToDate: true,
      message: `CLI is up to date (v${installed}) on npm ${channel}.`,
    };
  }

  if (npmLatest) {
    return {
      updateAvailable: false,
      upToDate: false,
      message: `CLI is v${installed}; npm ${channel} is v${npmLatest}.`,
    };
  }

  return {
    updateAvailable: false,
    upToDate: false,
    message: info?.message ?? "",
  };
}
