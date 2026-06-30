/**
 * oauthCallbackServer — minimal HTTP server for OAuth browser-flow callbacks.
 *
 * The CLI uses this to receive the redirect from the OAuth provider after
 * the user authenticates in their browser. The server:
 *   - listens on a local port (default 14523) on 127.0.0.1
 *   - captures `?code=XXX` from the first request to `expectedPath`
 *   - returns a friendly 200 HTML response so the user can close the tab
 *   - resolves a single `waitForCode()` Promise with the code, or rejects on timeout
 *   - shuts itself down after capture (or via explicit close())
 *
 * No deps — pure node:http. Browser-importable for jsdom tests.
 *
 * @see docs/plans/2026-06-29-anathema-coder-v2.md (Task 16.1)
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface OAuthCallbackServerOptions {
  /** Preferred port. If 0, the OS picks a free port. Default: 14523. */
  port?: number;
  /** Host to bind to. Default: '127.0.0.1'. */
  host?: string;
  /** Maximum time to wait for a callback. Default: 60000ms. */
  timeoutMs?: number;
  /** Path that the OAuth provider will redirect to. Default: '/oauth/callback'. */
  expectedPath?: string;
  /** HTML page returned to the user's browser after capture. */
  successHtml?: string;
}

export interface OAuthCallbackServerHandle {
  /** Port the server is listening on (useful when port=0). */
  port: number;
  /** Resolves with the captured code, or rejects on timeout / close. */
  waitForCode: () => Promise<string>;
  /** Close the server immediately (rejects any pending waitForCode). */
  close: () => void;
}

const DEFAULT_SUCCESS_HTML = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>anathema-coder OAuth</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; padding: 40px; text-align: center; color: #1a1a1a;">
  <h1 style="color: #00aa33;">✓ Authentication complete</h1>
  <p>You can close this tab and return to anathema-coder.</p>
</body>
</html>
`.trim();

export class OAuthCallbackTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`OAuth callback not received within ${timeoutMs}ms`);
    this.name = 'OAuthCallbackTimeoutError';
  }
}

export class OAuthCallbackClosedError extends Error {
  constructor() {
    super('OAuth callback server closed before receiving a callback');
    this.name = 'OAuthCallbackClosedError';
  }
}

export class OAuthCallbackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OAuthCallbackError';
  }
}

/**
 * Start the OAuth callback server. Returns a handle with port + waitForCode + close.
 *
 * The first request to `expectedPath` resolves waitForCode with the `code`
 * query parameter. Any other path returns a 404.
 */
export function startOAuthCallbackServer(
  options: OAuthCallbackServerOptions = {},
): Promise<OAuthCallbackServerHandle> {
  const host = options.host ?? '127.0.0.1';
  const preferredPort = options.port ?? 14523;
  const timeoutMs = options.timeoutMs ?? 60_000;
  const expectedPath = options.expectedPath ?? '/oauth/callback';
  const successHtml = options.successHtml ?? DEFAULT_SUCCESS_HTML;

  return new Promise((resolveStart, rejectStart) => {
    let resolved = false;
    let resolveCode: ((code: string) => void) | null = null;
    let rejectCode: ((err: Error) => void) | null = null;
    let timeoutHandle: NodeJS.Timeout | null = null;

    const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
      try {
        if (!req.url) {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('Bad request');
          return;
        }
        // Parse path + query.
        const url = new URL(req.url, `http://${host}:${preferredPort}`);
        if (url.pathname !== expectedPath) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not found');
          return;
        }
        const code = url.searchParams.get('code');
        const errorParam = url.searchParams.get('error');
        if (errorParam) {
          // OAuth provider returned an error (e.g. user denied).
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`<h1>OAuth error: ${errorParam}</h1>`);
          if (rejectCode && !resolved) {
            resolved = true;
            if (timeoutHandle) clearTimeout(timeoutHandle);
            rejectCode(new OAuthCallbackError(`OAuth provider returned error: ${errorParam}`));
          }
          return;
        }
        if (!code) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<h1>Missing <code>code</code> query parameter</h1>');
          return;
        }
        // Success.
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(successHtml);
        if (resolveCode && !resolved) {
          resolved = true;
          if (timeoutHandle) clearTimeout(timeoutHandle);
          resolveCode(code);
        }
        // Give the response a moment to flush before closing.
        setTimeout(() => {
          try {
            server.close();
          } catch {
            // already closed
          }
        }, 100);
      } catch (err) {
        // Defensive: never crash the server on a single bad request.
        try {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('Internal error');
        } catch {
          // ignore
        }
        if (!resolved && rejectCode) {
          resolved = true;
          if (timeoutHandle) clearTimeout(timeoutHandle);
          rejectCode(err instanceof Error ? err : new Error(String(err)));
        }
      }
    });

    const onError = (err: Error) => {
      if (!resolved) {
        resolved = true;
        if (timeoutHandle) clearTimeout(timeoutHandle);
        rejectStart(err);
      }
    };
    server.once('error', onError);

    server.listen(preferredPort, host, () => {
      // Resolve with the actual bound port (important when port=0).
      const addr = server.address() as AddressInfo | null;
      const actualPort = addr ? addr.port : preferredPort;

      const waitForCode = (): Promise<string> => {
        return new Promise((res, rej) => {
          if (resolved) {
            // Server already resolved (timeout fired, etc.) — reject.
            rej(new OAuthCallbackClosedError());
            return;
          }
          resolveCode = res;
          rejectCode = rej;
          timeoutHandle = setTimeout(() => {
            if (!resolved) {
              resolved = true;
              try {
                server.close();
              } catch {
                // ignore
              }
              rej(new OAuthCallbackTimeoutError(timeoutMs));
            }
          }, timeoutMs);
          // Don't keep the process alive just for this timer.
          if (typeof timeoutHandle?.unref === 'function') timeoutHandle.unref();
        });
      };

      const close = (): void => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        try {
          server.close();
        } catch {
          // ignore
        }
        if (!resolved && rejectCode) {
          resolved = true;
          rejectCode(new OAuthCallbackClosedError());
        }
      };

      resolveStart({ port: actualPort, waitForCode, close });
    });
  });
}