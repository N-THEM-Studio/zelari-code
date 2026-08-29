/**
 * cors.test.ts — v2.16 (HARNESS-10 t25): the companion host must answer with
 * an allowlist-driven `access-control-allow-origin` (env
 * ZELARI_COMPANION_ALLOWED_ORIGINS + loopback same-origin), NEVER a wildcard.
 * Red-if-reopens: the foreign-origin and serve.ts tripwire tests fail the
 * moment the '*' behaviour is reintroduced.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  COMPANION_ALLOWED_ORIGINS_ENV,
  allowedOriginFor,
  loopbackOrigins,
  parseAllowedOrigins,
} from './cors.js';

/** The effective serve-time allowlist for port 4510 with an env override. */
function allowlistWith(env: string | undefined): string[] {
  return [...loopbackOrigins(4510), ...parseAllowedOrigins(env)];
}

describe('companion CORS allowlist (v2.16 t25)', () => {
  it('exposes the documented env var name', () => {
    expect(COMPANION_ALLOWED_ORIGINS_ENV).toBe('ZELARI_COMPANION_ALLOWED_ORIGINS');
  });

  it('parses the env allowlist: comma-separated, trimmed, empties dropped', () => {
    expect(parseAllowedOrigins(undefined)).toEqual([]);
    expect(parseAllowedOrigins('')).toEqual([]);
    expect(parseAllowedOrigins('  ')).toEqual([]);
    expect(parseAllowedOrigins(' https://companion.example , https://a.example,,')).toEqual([
      'https://companion.example',
      'https://a.example',
    ]);
  });

  it('loopback origins cover 127.0.0.1 and localhost on the bound port', () => {
    expect(loopbackOrigins(4510)).toEqual(['http://127.0.0.1:4510', 'http://localhost:4510']);
  });

  it('an allowlisted origin gets the EXACT header value (env + loopback)', () => {
    const allowed = allowlistWith('https://companion.example');
    expect(allowedOriginFor('https://companion.example', allowed)).toBe('https://companion.example');
    expect(allowedOriginFor('http://localhost:4510', allowed)).toBe('http://localhost:4510');
    expect(allowedOriginFor('http://127.0.0.1:4510', allowed)).toBe('http://127.0.0.1:4510');
  });

  it('RED-IF-REOPENS: a foreign browser origin gets NO allow-origin header', () => {
    const allowed = allowlistWith('https://companion.example');
    expect(allowedOriginFor('https://evil.example', allowed)).toBeUndefined();
    expect(allowedOriginFor('https://companion.example.evil.test', allowed)).toBeUndefined();
    // The string-literal "null" origin (sandboxed iframe) is not allowlisted.
    expect(allowedOriginFor('null', allowed)).toBeUndefined();
  });

  it('default (no env) allows only loopback same-origin browsing', () => {
    const allowed = allowlistWith(undefined);
    expect(allowedOriginFor('http://127.0.0.1:4510', allowed)).toBeDefined();
    expect(allowedOriginFor('http://localhost:4510', allowed)).toBeDefined();
    expect(allowedOriginFor('https://companion.example', allowed)).toBeUndefined();
  });

  it('non-browser requests (no Origin header) need no CORS header and stay allowed', () => {
    expect(allowedOriginFor(undefined, allowlistWith(undefined))).toBeUndefined();
    expect(allowedOriginFor('', allowlistWith(undefined))).toBeUndefined();
    expect(allowedOriginFor(['http://localhost:4510'], allowlistWith(undefined))).toBe(
      'http://localhost:4510',
    );
  });

  it('RED-IF-REOPENS: serve.ts must not answer with a wildcard CORS origin', () => {
    const src = readFileSync(new URL('./serve.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/access-control-allow-origin['"]\s*:\s*['"]\*['"]/i);
    // …and the allowlist must actually be wired into the request path.
    expect(src).toContain('allowedOriginFor(req.headers.origin, allowedOrigins)');
  });
});
