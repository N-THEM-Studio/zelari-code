/**
 * oauthPkce — PKCE helpers + loopback callback server for native OAuth.
 *
 * Shared by ChatGPT (optional browser flow) and Anthropic magic-link.
 * No provider-specific endpoints here.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

export function generatePkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function generateOAuthState(): string {
  return randomBytes(32).toString('base64url');
}

export interface LoopbackCallbackResult {
  code?: string;
  state?: string;
  error?: string;
  errorDescription?: string;
}

export interface WaitForLoopbackOptions {
  host?: string;
  port: number;
  path: string;
  timeoutMs?: number;
}

/**
 * Bind 127.0.0.1:<port> and wait for a single OAuth redirect.
 * Rejects on timeout or bind failure.
 */
export async function waitForLoopbackCallback(
  options: WaitForLoopbackOptions,
): Promise<LoopbackCallbackResult> {
  const host = options.host ?? '127.0.0.1';
  const timeoutMs = options.timeoutMs ?? 300_000;
  const expectedPath = options.path.startsWith('/') ? options.path : `/${options.path}`;

  return new Promise<LoopbackCallbackResult>((resolve, reject) => {
    let settled = false;
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? '/', `http://${host}`);
      if (url.pathname !== expectedPath) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
        return;
      }
      const result: LoopbackCallbackResult = {
        code: url.searchParams.get('code') ?? undefined,
        state: url.searchParams.get('state') ?? undefined,
        error: url.searchParams.get('error') ?? undefined,
        errorDescription: url.searchParams.get('error_description') ?? undefined,
      };
      const ok = Boolean(result.code) && !result.error;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(oauthResultHtml(ok, result.errorDescription ?? result.error));
      finish(result);
    });

    const timer = setTimeout(() => {
      finish(undefined, new Error(`Timed out waiting for OAuth callback on http://${host}:${options.port}`));
    }, timeoutMs);

    const finish = (value?: LoopbackCallbackResult, err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close(() => {
        if (err) reject(err);
        else resolve(value ?? {});
      });
    };

    server.on('error', (err) => finish(undefined, err));
    server.listen(options.port, host);
  });
}

function oauthResultHtml(ok: boolean, detail?: string): string {
  const title = ok ? 'Signed in' : 'Sign-in failed';
  const body = ok
    ? 'You can close this tab and return to Zelari.'
    : detail ?? 'Authorization was denied or incomplete.';
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#111;color:#eee}
main{max-width:28rem;padding:2rem;border:1px solid #333;border-radius:12px}</style></head>
<body><main><h1>${title}</h1><p>${body}</p></main></body></html>`;
}
