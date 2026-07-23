/**
 * zelari-code serve — opt-in companion host for remote clients (Android / web)
 * over Tailscale or LAN.
 *
 * Security defaults:
 *   - bind 127.0.0.1 (override with --bind 100.x for Tailscale only)
 *   - Bearer token (~/.zelari-code/companion.token)
 *   - project cwd allowlist only
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { getCurrentVersion } from '../updater.js';
import { buildDesktopConfigSnapshot } from '../desktopConfig.js';
import {
  DEFAULT_COMPANION_BIND,
  DEFAULT_COMPANION_PORT,
  loadCompanionConfig,
  loadOrCreateToken,
  mergeProjects,
  resolveProjectPath,
  saveCompanionConfig,
  tokenMatches,
  type CompanionProject,
} from './config.js';
import { RunManager } from './runManager.js';

export interface ServeOptions {
  bind?: string;
  port?: number;
  token?: string;
  /** Extra project roots from --project flags */
  projects?: string[];
  /** Persist CLI projects into companion.json */
  persistProjects?: boolean;
}

function readBody(req: IncomingMessage, max = 2_000_000): Promise<string> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > max) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders?: Record<string, string>,
): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(data),
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    ...extraHeaders,
  });
  res.end(data);
}

function getBearer(req: IncomingMessage): string | null {
  const h = req.headers.authorization;
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m?.[1]?.trim() || null;
}

function parseUrl(req: IncomingMessage): URL {
  return new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
}

export async function runCompanionServe(opts: ServeOptions = {}): Promise<void> {
  const fileCfg = loadCompanionConfig();
  const bind = (opts.bind || fileCfg.bind || DEFAULT_COMPANION_BIND).trim();
  const port = opts.port ?? fileCfg.port ?? DEFAULT_COMPANION_PORT;
  const { token, created } = loadOrCreateToken(opts.token);

  let projects = mergeProjects(fileCfg, opts.projects ?? []);
  // Drop missing paths with warning
  projects = projects.filter((p) => {
    const abs = resolve(p.path);
    if (!existsSync(abs)) {
      process.stderr.write(
        `[zelari-code serve] skip missing project path: ${p.path}\n`,
      );
      return false;
    }
    p.path = abs;
    return true;
  });

  if (opts.persistProjects && projects.length > 0) {
    saveCompanionConfig({
      ...fileCfg,
      bind,
      port,
      projects,
    });
  }

  if (projects.length === 0) {
    // Default: cwd if it looks like a project
    const cwd = resolve(process.cwd());
    projects = [
      {
        id: 'default',
        name: 'default',
        path: cwd,
      },
    ];
    process.stderr.write(
      `[zelari-code serve] no projects configured — using cwd as default: ${cwd}\n` +
        `  Add more: zelari-code serve --project <path>\n` +
        `  Or edit ~/.zelari-code/companion.json\n`,
    );
  }

  const runs = new RunManager();

  const server = createServer(async (req, res) => {
    // CORS preflight (browser companion / PWA)
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': 'authorization, content-type',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
      });
      res.end();
      return;
    }

    const url = parseUrl(req);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    try {
      if (req.method === 'GET' && (path === '/health' || path === '/v1/health')) {
        sendJson(res, 200, {
          ok: true,
          service: 'zelari-companion',
          version: getCurrentVersion(),
          bind,
          port,
          projects: projects.length,
          activeRun: runs.getActive()?.id ?? null,
        });
        return;
      }

      // All other /v1/* require auth
      if (path.startsWith('/v1')) {
        if (!tokenMatches(token, getBearer(req))) {
          sendJson(res, 401, { ok: false, error: 'unauthorized' });
          return;
        }
      }

      if (req.method === 'GET' && path === '/v1/config') {
        const snap = buildDesktopConfigSnapshot();
        sendJson(res, 200, { ok: true, ...snap });
        return;
      }

      if (req.method === 'GET' && path === '/v1/projects') {
        sendJson(res, 200, {
          ok: true,
          projects: projects.map((p: CompanionProject) => ({
            id: p.id,
            name: p.name,
            path: p.path,
          })),
        });
        return;
      }

      if (req.method === 'GET' && path === '/v1/runs') {
        sendJson(res, 200, {
          ok: true,
          active: runs.getActive(),
          recent: runs.listRecent().map((r) => ({
            id: r.id,
            status: r.status,
            mode: r.mode,
            phase: r.phase,
            cwd: r.cwd,
            createdAt: r.createdAt,
            finishedAt: r.finishedAt,
            exitCode: r.exitCode,
            promptPreview: r.prompt.slice(0, 120),
          })),
        });
        return;
      }

      if (req.method === 'POST' && path === '/v1/runs') {
        const raw = await readBody(req);
        let body: Record<string, unknown> = {};
        try {
          body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
        } catch {
          sendJson(res, 400, { ok: false, error: 'invalid JSON body' });
          return;
        }
        const prompt = String(body.prompt ?? body.task ?? '').trim();
        const mode = String(body.mode ?? 'agent');
        const phase = String(body.phase ?? 'build');
        const cwdArg = body.cwd != null ? String(body.cwd) : body.projectId != null ? String(body.projectId) : null;
        const resolved = resolveProjectPath(projects, cwdArg);
        if (!resolved.ok) {
          sendJson(res, 400, { ok: false, error: resolved.error });
          return;
        }
        const history = Array.isArray(body.history) ? body.history : undefined;
        const result = runs.start({
          prompt,
          mode,
          phase,
          cwd: resolved.project.path,
          provider: body.provider != null ? String(body.provider) : undefined,
          model: body.model != null ? String(body.model) : undefined,
          history,
        });
        if (!result.ok) {
          sendJson(res, 409, { ok: false, error: result.error });
          return;
        }
        sendJson(res, 201, {
          ok: true,
          run: {
            id: result.run.id,
            status: result.run.status,
            mode: result.run.mode,
            phase: result.run.phase,
            cwd: result.run.cwd,
            createdAt: result.run.createdAt,
          },
          eventsUrl: `/v1/runs/${result.run.id}/events`,
          cancelUrl: `/v1/runs/${result.run.id}/cancel`,
        });
        return;
      }

      const eventsMatch = /^\/v1\/runs\/([^/]+)\/events$/.exec(path);
      if (req.method === 'GET' && eventsMatch) {
        const runId = eventsMatch[1]!;
        const run = runs.getRun(runId);
        if (!run) {
          sendJson(res, 404, { ok: false, error: 'run not found' });
          return;
        }

        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'access-control-allow-origin': '*',
          'access-control-allow-headers': 'authorization, content-type',
        });
        res.write(`: connected run=${runId}\n\n`);

        const writeEv = (ev: unknown) => {
          try {
            res.write(`data: ${JSON.stringify(ev)}\n\n`);
          } catch {
            /* client gone */
          }
        };

        const unsub = runs.subscribe(runId, writeEv);

        // If already finished, close after replay
        if (run.status !== 'running' && run.status !== 'queued') {
          writeEv({
            type: 'run_finished',
            runId,
            status: run.status,
            exitCode: run.exitCode ?? null,
          });
          unsub();
          res.end();
          return;
        }

        const heartbeat = setInterval(() => {
          try {
            res.write(`: ping\n\n`);
          } catch {
            /* ignore */
          }
        }, 15_000);

        const onClose = () => {
          clearInterval(heartbeat);
          unsub();
        };
        req.on('close', onClose);

        // Poll finish for SSE close when run ends after subscribe
        const check = setInterval(() => {
          const r = runs.getRun(runId);
          if (!r || (r.status !== 'running' && r.status !== 'queued')) {
            clearInterval(check);
            clearInterval(heartbeat);
            unsub();
            try {
              res.end();
            } catch {
              /* ignore */
            }
          }
        }, 500);
        return;
      }

      const cancelMatch = /^\/v1\/runs\/([^/]+)\/cancel$/.exec(path);
      if (req.method === 'POST' && cancelMatch) {
        const runId = cancelMatch[1]!;
        const result = runs.cancel(runId);
        if (!result.ok) {
          sendJson(res, 404, { ok: false, error: result.error });
          return;
        }
        sendJson(res, 200, { ok: true, cancelled: runId });
        return;
      }

      sendJson(res, 404, { ok: false, error: 'not found' });
    } catch (err) {
      sendJson(res, 500, {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(port, bind, () => resolveListen());
  });
  // Keep the process alive even if stdin is a closed pipe (Windows Start-Process).
  server.ref();
  try {
    process.stdin?.resume?.();
  } catch {
    /* ignore */
  }

  const tokenHint = created
    ? `NEW token saved to ~/.zelari-code/companion.token`
    : `token: ~/.zelari-code/companion.token`;

  const displayHost =
    bind === '0.0.0.0' || bind === '::'
      ? '127.0.0.1 (and LAN/Tailscale interfaces)'
      : bind;

  process.stderr.write(
    `\n[zelari-code serve] companion host listening\n` +
      `  URL     http://${displayHost === '127.0.0.1 (and LAN/Tailscale interfaces)' ? '127.0.0.1' : bind}:${port}\n` +
      `  Bind    ${bind}\n` +
      `  Health  GET /health\n` +
      `  Auth    Authorization: Bearer <token>\n` +
      `  ${tokenHint}\n` +
      `  Projects (${projects.length}): ${projects.map((p) => p.id).join(', ')}\n` +
      `  Phone   use http://<PC-LAN-or-Tailscale-IP>:${port}  (not 127.0.0.1 on the phone)\n` +
      `  Stop    Ctrl+C  (keep this window open)\n\n`,
  );

  if (created) {
    process.stderr.write(`  Token (copy now): ${token}\n\n`);
  }

  // Stay up until signal. Do not resolve on stdin EOF.
  await new Promise<void>((resolveStop) => {
    let stopped = false;
    const stop = (sig: string) => {
      if (stopped) return;
      stopped = true;
      process.stderr.write(`[zelari-code serve] shutting down (${sig})…\n`);
      try {
        runs.cancel();
      } catch {
        /* ignore */
      }
      server.close(() => resolveStop());
      // Force exit if close hangs
      setTimeout(() => resolveStop(), 3000).unref();
    };
    process.once('SIGINT', () => stop('SIGINT'));
    process.once('SIGTERM', () => stop('SIGTERM'));
    process.once('SIGHUP', () => stop('SIGHUP'));
  });
}

/** Parse serve flags from argv. */
export function parseServeFlags(argv: readonly string[]): ServeOptions | null {
  if (!argv.includes('serve') && !argv.includes('--serve')) {
    return null;
  }
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : undefined;
  };
  const projects: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--project' && argv[i + 1]) {
      projects.push(argv[i + 1]!);
      i++;
    }
  }
  const portRaw = get('--port');
  const port = portRaw ? Number.parseInt(portRaw, 10) : undefined;
  return {
    bind: get('--bind'),
    port: Number.isFinite(port) ? port : undefined,
    token: get('--token'),
    projects,
    persistProjects: argv.includes('--save-projects'),
  };
}
