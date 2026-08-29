/**
 * cors.ts — companion host CORS allowlist (v2.16 HARNESS-10 t25).
 *
 * The companion host used to answer every request with
 * `access-control-allow-origin: *`. On a Bearer-token API that token-gates
 * /v1/*, a wildcard origin lets any web page the browser runs read responses
 * from a hostile origin. Now:
 *
 *  - Non-browser loopback clients (curl, native apps) send no `Origin`
 *    header: they need no CORS header and keep working unchanged.
 *  - Browser origins must be on the allowlist: `ZELARI_COMPANION_ALLOWED_
 *    ORIGINS` (comma-separated, e.g. the companion PWA origin), plus the
 *    server's own loopback origins (`http://127.0.0.1:<port>`,
 *    `http://localhost:<port>`) so same-origin browser use keeps working.
 *  - Any other origin receives NO `access-control-allow-origin` header — the
 *    browser blocks the response; the request itself is unaffected.
 *
 * Pure functions: the host injects env values (tests never mutate the
 * environment).
 *
 * @since 2.16.0
 */

/** Env var holding the comma-separated list of allowed browser origins. */
export const COMPANION_ALLOWED_ORIGINS_ENV = 'ZELARI_COMPANION_ALLOWED_ORIGINS';

/** Parse a raw env value into the allowlist (trim, drop empties). */
export function parseAllowedOrigins(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
}

/** The server's own loopback browser origins (same-origin browsing). */
export function loopbackOrigins(port: number): string[] {
  return [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
}

/**
 * Value for the `access-control-allow-origin` header for a request, or
 * `undefined` when the header must be OMITTED (foreign origin — the browser
 * then blocks the response; non-browser requests never needed it).
 * Host comparison is case-insensitive; the exact allowlist entry is echoed
 * so the header value is deterministic.
 */
export function allowedOriginFor(
  requestOrigin: string | string[] | undefined,
  allowed: readonly string[],
): string | undefined {
  const raw = Array.isArray(requestOrigin) ? requestOrigin[0] : requestOrigin;
  const origin = raw?.trim();
  if (!origin) return undefined;
  return allowed.find((o) => o.toLowerCase() === origin.toLowerCase());
}
