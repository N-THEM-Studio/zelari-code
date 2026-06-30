import { describe, it, expect } from 'vitest';
import {
  startOAuthCallbackServer,
  OAuthCallbackTimeoutError,
  OAuthCallbackClosedError,
  OAuthCallbackError,
} from '../../src/cli/oauthCallbackServer.js';

/** Send a GET request to the callback server. */
async function sendCallback(port: number, pathWithQuery: string): Promise<{ status: number; body: string }> {
  const res = await fetch(`http://127.0.0.1:${port}${pathWithQuery}`);
  const body = await res.text();
  return { status: res.status, body };
}

describe('oauthCallbackServer (Task 16.1)', () => {
  it('startOAuthCallbackServer() listens on a port and waitForCode() rejects on timeout', async () => {
    const handle = await startOAuthCallbackServer({
      port: 0,             // OS picks a free port
      timeoutMs: 200,      // short timeout for test
      expectedPath: '/oauth/callback',
    });
    expect(handle.port).toBeGreaterThan(0);
    await expect(handle.waitForCode()).rejects.toBeInstanceOf(OAuthCallbackTimeoutError);
    handle.close();
  });

  it('waitForCode() resolves with code from successful callback', async () => {
    const handle = await startOAuthCallbackServer({
      port: 0,
      timeoutMs: 5_000,
      expectedPath: '/oauth/callback',
    });
    // Fire the callback in the background.
    const codePromise = handle.waitForCode();
    // Slight delay to ensure server is ready.
    await new Promise((r) => setTimeout(r, 50));
    const response = await sendCallback(handle.port, '/oauth/callback?code=ABC123');
    expect(response.status).toBe(200);
    expect(response.body).toMatch(/Authentication complete/i);
    const code = await codePromise;
    expect(code).toBe('ABC123');
    // Server should close itself after capture; no need to call close().
  });

  it('waitForCode() rejects with OAuthCallbackError when provider returns error', async () => {
    const handle = await startOAuthCallbackServer({
      port: 0,
      timeoutMs: 5_000,
      expectedPath: '/oauth/callback',
    });
    const codePromise = handle.waitForCode();
    await new Promise((r) => setTimeout(r, 50));
    const response = await sendCallback(handle.port, '/oauth/callback?error=access_denied');
    expect(response.status).toBe(400);
    await expect(codePromise).rejects.toBeInstanceOf(OAuthCallbackError);
    expect(await Promise.race([
      codePromise.catch((e) => e.message),
      new Promise((r) => setTimeout(() => r('timeout'), 1000)),
    ])).toMatch(/access_denied/);
    handle.close();
  });

  it('404 returned for unknown paths (does not resolve waitForCode)', async () => {
    const handle = await startOAuthCallbackServer({
      port: 0,
      timeoutMs: 1_500,
      expectedPath: '/oauth/callback',
    });
    await new Promise((r) => setTimeout(r, 50));
    const response = await sendCallback(handle.port, '/some/other/path');
    expect(response.status).toBe(404);
    // waitForCode should still be pending → reject on timeout.
    await expect(handle.waitForCode()).rejects.toBeInstanceOf(OAuthCallbackTimeoutError);
    handle.close();
  });

  it('close() before callback rejects with OAuthCallbackClosedError', async () => {
    const handle = await startOAuthCallbackServer({
      port: 0,
      timeoutMs: 30_000,
      expectedPath: '/oauth/callback',
    });
    const codePromise = handle.waitForCode();
    handle.close();
    await expect(codePromise).rejects.toBeInstanceOf(OAuthCallbackClosedError);
  });

  it('bind error on already-used port rejects the start', async () => {
    const first = await startOAuthCallbackServer({ port: 0, timeoutMs: 5_000 });
    try {
      // Try to bind a second server on the same explicit port.
      await expect(
        startOAuthCallbackServer({ port: first.port, timeoutMs: 5_000 }),
      ).rejects.toThrow();
    } finally {
      first.close();
    }
  });

  it('server uses default path /oauth/callback when not specified', async () => {
    const handle = await startOAuthCallbackServer({
      port: 0,
      timeoutMs: 5_000,
      // no expectedPath — should default
    });
    const codePromise = handle.waitForCode();
    await new Promise((r) => setTimeout(r, 50));
    const response = await sendCallback(handle.port, '/oauth/callback?code=default-path');
    expect(response.status).toBe(200);
    expect(await codePromise).toBe('default-path');
  });
});