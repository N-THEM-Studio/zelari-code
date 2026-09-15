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
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getCurrentVersion } from '../updater.js';
import { buildDesktopConfigSnapshot } from '../desktopConfig.js';
import {
  DEFAULT_COMPANION_BIND,
  DEFAULT_COMPANION_PORT,
  isUnderRoots,
  loadCompanionConfig,
  loadOrCreateToken,
  mergeProjects,
  resolveProjectPath,
  saveCompanionConfig,
  tokenMatches,
  type CompanionProject,
} from './config.js';
import { RunManager } from './runManager.js';
import {
  COMPANION_ALLOWED_ORIGINS_ENV,
  allowedOriginFor,
  loopbackOrigins,
  parseAllowedOrigins,
} from './cors.js';

export interface ServeOptions {
  bind?: string;
  port?: number;
  token?: string;
  /** Extra project roots from --project flags */
  projects?: string[];
  /** Persist CLI projects into companion.json */
  persistProjects?: boolean;
  /**
   * t66: filesystem scope for /v1/fs browsing and run-start cwd validation.
   * 'full' (default) — browse every drive/folder on the host; a run whose
   * cwd is outside the allowlist parks as awaiting_trust until the desktop
   * trust modal approves (POST /v1/trust). 'allowlist' — t63 sandbox
   * behavior (roots = allowlist only, unlisted cwd → 400).
   */
  fsMode?: 'full' | 'allowlist';
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
    // t25: the allow-origin header is set per-request from the allowlist
    // (see the createServer handler) — never a wildcard.
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

  // t66: filesystem scope — 'full' by default (browse every drive; a run
  // whose cwd is outside the allowlist parks as awaiting_trust until the
  // desktop modal approves), 'allowlist' restores the t63 sandbox.
  const fsFull = (opts.fsMode ?? 'full') === 'full';

  // v2.16 (t25): CORS allowlist — this server's own loopback origins plus any
  // extra browser origins configured via ZELARI_COMPANION_ALLOWED_ORIGINS
  // (comma-separated). Requests WITHOUT an Origin header (curl / native
  // loopback tooling) are unaffected; foreign browser origins get no
  // access-control-allow-origin header, so the browser blocks the response.
  const allowedOrigins = [
    ...loopbackOrigins(port),
    ...parseAllowedOrigins(process.env[COMPANION_ALLOWED_ORIGINS_ENV]),
  ];

  const server = createServer(async (req, res) => {
    // v2.16 (t25): allowlist-driven CORS — emit the header ONLY for
    // allowlisted browser origins (loopback + env). writeHead below never
    // overrides it, so this covers sendJson, preflight and SSE alike.
    const corsOrigin = allowedOriginFor(req.headers.origin, allowedOrigins);
    if (corsOrigin) res.setHeader('access-control-allow-origin', corsOrigin);

    // CORS preflight (browser companion / PWA) — no wildcard: an origin not
    // on the allowlist gets a headerless 204 and the browser blocks it.
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
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

      // t63/t66: folder browsing for the companion picker — directories
      // only. Full-fs mode (default): roots are the host drives and any
      // absolute path without '..' browses; runs on folders outside the
      // allowlist park as awaiting_trust (desktop modal). Allowlist mode:
      // t63 sandbox behavior unchanged.
      if (req.method === 'GET' && path === '/v1/fs') {
        const listFsRootsInline = (): CompanionProject[] => {
          if (process.platform === 'win32') {
            const roots: CompanionProject[] = [];
            for (let code = 65; code <= 90; code++) {
              const letter = String.fromCharCode(code);
              const drive = `${letter}:\\`;
              if (existsSync(drive)) {
                roots.push({
                  id: `fs-${letter.toLowerCase()}`,
                  name: drive,
                  path: drive,
                });
              }
            }
            return roots;
          }
          return [{ id: 'fs-root', name: '/', path: '/' }];
        };
        const rawParam = url.searchParams.get('path')?.trim() ?? '';
        if (!rawParam) {
          sendJson(res, 200, {
            ok: true,
            roots: fsFull ? listFsRootsInline() : projects,
            entries: [],
          });
          return;
        }
        const norm = rawParam.replace(/\\/g, '/').replace(/\/+$/, '');
        const absolute = /^([a-zA-Z]:\/|\/)/.test(norm);
        const allowed =
          fsFull && absolute && !norm.split('/').includes('..')
            ? true
            : isUnderRoots(rawParam, projects).ok;
        if (!allowed) {
          sendJson(res, 403, { ok: false, error: 'path outside allowed roots' });
          return;
        }
        if (!existsSync(rawParam)) {
          sendJson(res, 404, { ok: false, error: 'path not found' });
          return;
        }
        const dirs = readdirSync(rawParam, { withFileTypes: true })
          .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
          .sort((a, b) => a.name.localeCompare(b.name));
        const slash = norm.lastIndexOf('/');
        let parent = slash > 0 ? norm.slice(0, slash) : null;
        // t63: never offer to climb ABOVE an allowlisted root — parent is
        // null AT the root so the phone's "Up" cannot escape the sandbox
        // (in full mode this only fires for a path that IS a configured root).
        const rootHit = isUnderRoots(rawParam, projects);
        if (rootHit.ok) {
          const rootNorm = rootHit.root.path
            .replace(/\\/g, '/')
            .toLowerCase()
            .replace(/\/+$/, '');
          if (rootHit.normalized === rootNorm) parent = null;
        }
        sendJson(res, 200, {
          ok: true,
          path: rawParam,
          parent,
          entries: dirs.map((d) => ({
            name: d.name,
            path: join(rawParam, d.name),
            dir: true,
          })),
        });
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
        const mode = String(body.mode ?? 'kraken');
        const phase = String(body.phase ?? 'build');
        const cwdArg = body.cwd != null ? String(body.cwd) : body.projectId != null ? String(body.projectId) : null;
        const resolved = resolveProjectPath(projects, cwdArg, { fullFs: fsFull });
        if (!resolved.ok) {
          sendJson(res, 400, { ok: false, error: resolved.error });
          return;
        }
        const history = Array.isArray(body.history) ? body.history : undefined;
        // t63: per-turn knobs (Desktop parity). Unknown preset values are
        // dropped — mirroring applyTurnPermissionPreset's allowlist, never a 400.
        const presetRaw =
          typeof body.permissionPreset === 'string'
            ? body.permissionPreset.trim().toLowerCase()
            : '';
        const permissionPreset = ['standard', 'strict', 'yolo'].includes(presetRaw)
          ? presetRaw
          : undefined;
        const strictDone = typeof body.strictDone === 'boolean' ? body.strictDone : undefined;
        const verifyPack = typeof body.verifyPack === 'boolean' ? body.verifyPack : undefined;
        // t66: full-fs run on a folder outside the allowlist → park the run
        // as awaiting_trust; the desktop modal decides via POST /v1/trust.
        const startArgs = {
          prompt,
          mode,
          phase,
          cwd: resolved.project.path,
          provider: body.provider != null ? String(body.provider) : undefined,
          model: body.model != null ? String(body.model) : undefined,
          history,
          permissionPreset,
          strictDone,
          verifyPack,
        };
        const gate =
          fsFull && !resolved.trusted
            ? { awaitingTrust: true as const }
            : undefined;
        const result = runs.start(startArgs, gate);
        if (!result.ok) {
          sendJson(res, 409, { ok: false, error: result.error });
          return;
        }
        sendJson(res, 201, {
          ok: true,
          awaitingTrust: gate ? true : undefined,
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
          steerUrl: `/v1/runs/${result.run.id}/steer`,
          permissionUrl: `/v1/runs/${result.run.id}/permission`,
          askUrl: `/v1/runs/${result.run.id}/ask`,
        });
        return;
      }

      // t66: desktop trust decisions for full-fs runs parked as
      // awaiting_trust. Approve also persists the folder into the allowlist
      // (companion.json) so future runs there start immediately.
      if (req.method === 'POST' && path === '/v1/trust') {
        const raw = await readBody(req);
        let body: Record<string, unknown> = {};
        try {
          body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
        } catch {
          sendJson(res, 400, { ok: false, error: 'invalid JSON body' });
          return;
        }
        const runId = typeof body.runId === 'string' ? body.runId.trim() : '';
        if (!runId) {
          sendJson(res, 400, { ok: false, error: 'runId is required' });
          return;
        }
        const current = runs.pendingTrust();
        if (!current || current.runId !== runId) {
          sendJson(res, 409, { ok: false, error: 'no such awaiting_trust run' });
          return;
        }
        if (body.approve === true) {
          projects = mergeProjects({ ...fileCfg, projects }, [current.path]);
          try {
            saveCompanionConfig({ ...fileCfg, bind, port, projects });
          } catch {
            /* best-effort persist */
          }
          const released = runs.releaseTrust();
          if (!released.ok) {
            sendJson(res, 409, { ok: false, error: released.error });
            return;
          }
          sendJson(res, 200, { ok: true, approved: runId, path: current.path });
          return;
        }
        const denied = runs.denyTrust('Trust negato sul desktop');
        if (!denied.ok) {
          sendJson(res, 409, { ok: false, error: denied.error });
          return;
        }
        sendJson(res, 200, { ok: true, denied: runId });
        return;
      }

      // t66: current awaiting_trust run (auth'd) for the desktop gate poll.
      if (req.method === 'GET' && path === '/v1/trust/pending') {
        sendJson(res, 200, { ok: true, pending: runs.pendingTrust() });
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
          // t25: allow-origin comes from the per-request allowlist set above.
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

        // If already finished, close after replay. awaiting_trust is NOT
        // finished — keep the phone stream open until the desktop trust modal
        // settles it (trust.settled → running | error), so the Android banner
        // can clear on approval/settlement.
        if (
          run.status !== 'running' &&
          run.status !== 'queued' &&
          run.status !== 'awaiting_trust'
        ) {
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
          if (
            !r ||
            (r.status !== 'running' &&
              r.status !== 'queued' &&
              r.status !== 'awaiting_trust')
          ) {
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

      // t40: live-turn steering over HTTP — same control plane as the NDJSON
      // session.steer command (RunManager.steer → HarnessClient.steer →
      // RuntimeControlQueue). Error mapping mirrors the cancel handler above.
      const steerMatch = /^\/v1\/runs\/([^/]+)\/steer$/.exec(path);
      if (req.method === 'POST' && steerMatch) {
        const runId = steerMatch[1]!;
        const raw = await readBody(req);
        let body: Record<string, unknown> = {};
        try {
          body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
        } catch {
          sendJson(res, 400, { ok: false, error: 'invalid JSON body' });
          return;
        }
        const text = typeof body.text === 'string' ? body.text.trim() : '';
        if (!text) {
          sendJson(res, 400, { ok: false, error: 'text is required' });
          return;
        }
        const result = await runs.steer(runId, text);
        if (!result.ok) {
          sendJson(res, 404, { ok: false, error: result.error });
          return;
        }
        sendJson(res, 200, { ok: true, steered: runId, result: result.result });
        return;
      }

      // t63: mobile approvals — settle permission.request / ask_user.request
      // events raised on the run SSE (verbatim passthrough of the harness
      // bridges). Validation mirrors the steer handler's error mapping.
      const askMatch = /^\/v1\/runs\/([^/]+)\/(permission|ask)$/.exec(path);
      if (req.method === 'POST' && askMatch) {
        const runId = askMatch[1]!;
        const kind = askMatch[2]!;
        const raw = await readBody(req);
        let body: Record<string, unknown> = {};
        try {
          body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
        } catch {
          sendJson(res, 400, { ok: false, error: 'invalid JSON body' });
          return;
        }
        const requestId = typeof body.requestId === 'string' ? body.requestId.trim() : '';
        if (!requestId) {
          sendJson(res, 400, { ok: false, error: 'requestId is required' });
          return;
        }
        if (kind === 'permission') {
          const decision = typeof body.decision === 'string' ? body.decision.trim() : '';
          if (!['allow', 'deny', 'always-tool', 'always-category'].includes(decision)) {
            sendJson(res, 400, {
              ok: false,
              error: 'decision must be allow|deny|always-tool|always-category',
            });
            return;
          }
          const result = await runs.permissionRespond(runId, requestId, decision);
          if (!result.ok) {
            sendJson(res, 404, { ok: false, error: result.error });
            return;
          }
          sendJson(res, 200, { ok: true, runId, requestId, result: result.result });
          return;
        }
        const answer =
          body.answer == null ? null : typeof body.answer === 'string' ? body.answer : undefined;
        if (answer === undefined) {
          sendJson(res, 400, { ok: false, error: 'answer must be a string or null' });
          return;
        }
        const result = await runs.askUserRespond(runId, requestId, answer);
        if (!result.ok) {
          sendJson(res, 404, { ok: false, error: result.error });
          return;
        }
        sendJson(res, 200, { ok: true, runId, requestId, result: result.result });
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
      `  Phone   scan the QR in Zelari Desktop → Connections → Mobile connection\n` +
      `          or open http://<PC-Tailscale-IP>:${port}  (never 127.0.0.1 on the phone)\n` +
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
  const fsRaw = get('--fs');
  return {
    bind: get('--bind'),
    port: Number.isFinite(port) ? port : undefined,
    token: get('--token'),
    projects,
    persistProjects: argv.includes('--save-projects'),
    fsMode: fsRaw === 'allowlist' ? 'allowlist' : fsRaw === 'full' ? 'full' : undefined,
  };
}
