/**
 * v3-T updated tests for oauthCallbackServer — returns OAuthCallbackParams (object).
 *
 * Now waitForCode() resolves with { code, state, error, errorDescription, extras }
 * instead of just a code string.
 */
import { describe, it, expect } from 'vitest';
import {
  startOAuthCallbackServer,
  OAuthCallbackTimeoutError,
  OAuthCallbackClosedError,
  OAuthCallbackError,
} from '../../src/cli/oauthCallbackServer.js';

async function sendCallback(port: number, pathWithQuery: string): Promise<{ status: number; body: string }> {
  const res = await fetch(`http://127.0.0.1:${port}${pathWithQuery}`);
  const body = await res.text();
  return { status: res.status, body };
}

describe('oauthCallbackServer (v3-T)', () => {
  it('startOAuthCallbackServer() listens on a port and waitForCode() rejects on timeout', async () => {
    const handle = await startOAuthCallbackServer({
      port: 0,
      timeoutMs: 200,
      expectedPath: '/callback',
    });
    expect(handle.port).toBeGreaterThan(0);
    await expect(handle.waitForCode()).rejects.toBeInstanceOf(OAuthCallbackTimeoutError);
    handle.close();
  });

  it('waitForCode() resolves with OAuthCallbackParams from successful callback', async () => {
    const handle = await startOAuthCallbackServer({
      port: 0,
      timeoutMs: 5_000,
      expectedPath: '/callback',
    });
    const paramsPromise = handle.waitForCode();
    await new Promise((r) => setTimeout(r, 50));
    const response = await sendCallback(handle.port, '/callback?code=ABC123&state=xyz-state');
    expect(response.status).toBe(200);
    expect(response.body).toMatch(/Authentication complete/i);
    const params = await paramsPromise;
    expect(params.code).toBe('ABC123');
    expect(params.state).toBe('xyz-state');
    expect(params.error).toBeUndefined();
  });

  it('waitForCode() rejects with OAuthCallbackError when provider returns error', async () => {
    const handle = await startOAuthCallbackServer({
      port: 0,
      timeoutMs: 5_000,
      expectedPath: '/callback',
    });
    const paramsPromise = handle.waitForCode();
    // Attach a catch handler BEFORE triggering the callback, so the
    // handler is in place when the server rejects — avoids an unhandled
    // promise rejection on Node.js. The catch transforms the rejection
    // into a resolved promise carrying the error.
    const errorPromise = paramsPromise.catch((e) => e);
    await new Promise((r) => setTimeout(r, 50));
    const response = await sendCallback(handle.port, '/callback?error=access_denied&error_description=user+denied');
    expect(response.status).toBe(400);
    const error = await errorPromise;
    expect(error).toBeInstanceOf(OAuthCallbackError);
    expect(error.message).toMatch(/access_denied/);
    handle.close();
  });

  it('404 returned for unknown paths (does not resolve waitForCode)', async () => {
    const handle = await startOAuthCallbackServer({
      port: 0,
      timeoutMs: 1_500,
      expectedPath: '/callback',
    });
    await new Promise((r) => setTimeout(r, 50));
    const response = await sendCallback(handle.port, '/some/other/path');
    expect(response.status).toBe(404);
    await expect(handle.waitForCode()).rejects.toBeInstanceOf(OAuthCallbackTimeoutError);
    handle.close();
  });

  it('extras field captures non-standard params', async () => {
    const handle = await startOAuthCallbackServer({
      port: 0,
      timeoutMs: 5_000,
      expectedPath: '/callback',
    });
    const paramsPromise = handle.waitForCode();
    await new Promise((r) => setTimeout(r, 50));
    await sendCallback(handle.port, '/callback?code=OK&state=s1&iss=https%3A%2F%2Fauth.x.ai&session_state=abc');
    const params = await paramsPromise;
    expect(params.code).toBe('OK');
    expect(params.state).toBe('s1');
    expect(params.extras.iss).toBe('https://auth.x.ai');
    expect(params.extras.session_state).toBe('abc');
  });
});