/**
 * krakenLive — in-process live tentacle tracker for StatusBar / Desktop (K10).
 *
 * Complements file radio (.zelari/radio): this is ephemeral, per process,
 * ideal for "tentacles 1 running · 2 done" chips during a parent turn.
 */

export type LiveTentacleStatus = 'running' | 'done' | 'error';

export interface LiveTentacle {
  id: string;
  agent: string;
  description: string;
  status: LiveTentacleStatus;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  model?: string;
  worktree?: string | null;
  ok?: boolean;
  detail?: string;
}

type G = {
  __zelariKrakenLive?: LiveTentacle[];
  __zelariKrakenLiveSeq?: number;
};

function store(): LiveTentacle[] {
  const g = globalThis as unknown as G;
  if (!g.__zelariKrakenLive) g.__zelariKrakenLive = [];
  return g.__zelariKrakenLive;
}

function nextId(): string {
  const g = globalThis as unknown as G;
  g.__zelariKrakenLiveSeq = (g.__zelariKrakenLiveSeq ?? 0) + 1;
  return `t${g.__zelariKrakenLiveSeq}`;
}

/** Clear finished tentacles (keep running). Call on new parent turn if desired. */
export function resetKrakenLive(opts: { keepRunning?: boolean } = {}): void {
  const g = globalThis as unknown as G;
  if (opts.keepRunning) {
    g.__zelariKrakenLive = store().filter((t) => t.status === 'running');
  } else {
    g.__zelariKrakenLive = [];
  }
}

export function krakenTentacleStart(info: {
  agent: string;
  description: string;
  model?: string;
  worktree?: string | null;
}): string {
  const id = nextId();
  const row: LiveTentacle = {
    id,
    agent: info.agent,
    description: info.description.slice(0, 80),
    status: 'running',
    startedAt: Date.now(),
    model: info.model,
    worktree: info.worktree ?? null,
  };
  const list = store();
  list.push(row);
  if (list.length > 40) {
    list.splice(0, list.length - 40);
  }
  return id;
}

export function krakenTentacleEnd(
  id: string,
  info: {
    ok: boolean;
    model?: string;
    detail?: string;
    durationMs?: number;
  },
): void {
  const row = store().find((t) => t.id === id);
  if (!row) return;
  row.status = info.ok ? 'done' : 'error';
  row.endedAt = Date.now();
  row.durationMs = info.durationMs ?? row.endedAt - row.startedAt;
  row.ok = info.ok;
  if (info.model) row.model = info.model;
  if (info.detail) row.detail = info.detail.slice(0, 160);
}

export function listKrakenLive(): LiveTentacle[] {
  return [...store()];
}

/** One-line chip for StatusBar: "tentacles 1↑ 2✓" or null if empty. */
export function formatKrakenLiveSummary(
  list: readonly LiveTentacle[] = store(),
): string | null {
  if (list.length === 0) return null;
  const running = list.filter((t) => t.status === 'running').length;
  const done = list.filter((t) => t.status === 'done').length;
  const err = list.filter((t) => t.status === 'error').length;
  const parts: string[] = [];
  if (running) parts.push(`${running}↑`);
  if (done) parts.push(`${done}✓`);
  if (err) parts.push(`${err}✗`);
  if (parts.length === 0) return null;
  return `tentacles ${parts.join(' ')}`;
}

/** Multi-line block for slash / desktop panel. */
export function formatKrakenLiveStatus(
  list: readonly LiveTentacle[] = store(),
  limit = 12,
): string {
  if (list.length === 0) {
    return 'Kraken live: no tentacles in this process yet.';
  }
  const slice = list.slice(-limit);
  const lines = slice.map((t) => {
    const flag = t.status === 'running' ? '…' : t.status === 'done' ? '✓' : '✗';
    const ms = t.durationMs != null ? ` ${t.durationMs}ms` : '';
    const model = t.model ? ` [${t.model}]` : '';
    return `${flag} ${t.agent} "${t.description}"${model}${ms}`;
  });
  const summary = formatKrakenLiveSummary(list);
  return [`Kraken live (${summary ?? list.length}):`, ...lines].join('\n');
}

/** Desktop-friendly rows (JSON-serializable). */
export function krakenLiveForUi(list: readonly LiveTentacle[] = store()): Array<{
  id: string;
  agent: string;
  description: string;
  status: LiveTentacleStatus;
  model?: string;
  durationMs?: number;
  ok?: boolean;
}> {
  return list.map((t) => ({
    id: t.id,
    agent: t.agent,
    description: t.description,
    status: t.status,
    ...(t.model ? { model: t.model } : {}),
    ...(t.durationMs != null ? { durationMs: t.durationMs } : {}),
    ...(t.ok != null ? { ok: t.ok } : {}),
  }));
}
