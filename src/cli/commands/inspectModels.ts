/**
 * inspectModels.ts — MODELS section data for `zelari-code inspect` (t161).
 *
 * Answers "which model runs where?" in one place:
 *   - lead: active provider + model (providerConfig, with env-override source)
 *   - perKind: the model each tentacle kind would resolve to RIGHT NOW, with
 *     the reason (env:kind / env:sub / cross-family / auto-pick / parent) —
 *     delegated to `explainKrakenSubModelAsync` so it can never drift from
 *     the actual routing.
 *   - usage: historical model counts from the session spine (ADR-0016):
 *     `note` agent_start → lead bucket, `subagent.metrics` → tentacle bucket.
 *     `verification.run` carries no model by contract and is deliberately
 *     not attributed.
 *
 * Read-only and defensive by contract: never throws, never mutates. The spine
 * scan is bounded (most recent N sessions by mtime) so inspect stays fast on
 * old workspaces; dot-directories (e.g. the broken `.zelari/` junction some
 * workspaces accumulated) and non-UUID entries are skipped.
 *
 * @since v2.60.0
 */
import path from 'node:path';
import { readdirSync, statSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { readSessionLog, resolveSessionsDir } from '@zelari/core/session';
import { getActiveModel, getActiveProvider } from '../providerConfig.js';
import { explainKrakenSubModelAsync } from '../tools/krakenModel.js';

export type InspectTentacleKind = 'explore' | 'general' | 'verify';

/** How many recent sessions the usage scan reads (bounded for speed). */
const USAGE_SCAN_LIMIT = 50;

/** Session dirs are UUIDs; anything else (including dot-dirs) is skipped. */
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ModelUsageEntry {
  model: string;
  /** Times this model appeared as the lead/parent (note agent_start). */
  lead: number;
  /** Times this model appeared as a tentacle model (subagent.metrics). */
  tentacle: number;
}

export interface ModelUsageReport {
  sessionsDir: string;
  totalSessions: number;
  scannedSessions: number;
  unreadableSessions: number;
  counts: ModelUsageEntry[];
}

export interface ModelsSection {
  lead: { provider: string; model: string; source: string };
  perKind: Array<{ kind: InspectTentacleKind; model: string; source: string }>;
  usage: ModelUsageReport;
}

function leadModelSource(): string {
  if (process.env.ANATHEMA_ACTIVE_PROVIDER?.trim()) return 'env ANATHEMA_ACTIVE_PROVIDER';
  if (process.env.OPENAI_MODEL?.trim()) return 'env OPENAI_MODEL';
  return 'provider.json (persisted)';
}

function emptyUsage(sessionsDir: string): ModelUsageReport {
  return {
    sessionsDir,
    totalSessions: 0,
    scannedSessions: 0,
    unreadableSessions: 0,
    counts: [],
  };
}

/**
 * Count model usage across the most recent sessions. Defensive: unreadable
 * sessions are counted and skipped, malformed lines are left to the tolerant
 * replay parser, and a missing/empty dir yields an empty report.
 */
export async function collectModelUsage(sessionsDir: string): Promise<ModelUsageReport> {
  let entries: Dirent[] = [];
  try {
    entries = readdirSync(sessionsDir, { withFileTypes: true });
  } catch {
    return emptyUsage(sessionsDir);
  }
  const sessionDirs = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && SESSION_ID_RE.test(e.name))
    .map((e) => {
      const dir = path.join(sessionsDir, e.name);
      let mtimeMs = 0;
      try {
        mtimeMs = statSync(dir).mtimeMs;
      } catch {
        mtimeMs = 0;
      }
      return { dir, mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  const counts = new Map<string, ModelUsageEntry>();
  const bump = (model: string, bucket: 'lead' | 'tentacle'): void => {
    const entry = counts.get(model) ?? { model, lead: 0, tentacle: 0 };
    entry[bucket] += 1;
    counts.set(model, entry);
  };

  let unreadable = 0;
  const scanned = sessionDirs.slice(0, USAGE_SCAN_LIMIT);
  for (const { dir } of scanned) {
    try {
      const report = await readSessionLog(path.join(dir, 'events.jsonl'));
      for (const raw of report.events) {
        const ev = raw as { kind?: unknown; data?: unknown };
        const data = (ev.data ?? {}) as { note?: unknown; model?: unknown };
        if (typeof data.model !== 'string' || !data.model.trim()) continue;
        if (ev.kind === 'note' && data.note === 'agent_start') bump(data.model, 'lead');
        else if (ev.kind === 'subagent.metrics') bump(data.model, 'tentacle');
      }
    } catch {
      unreadable += 1;
    }
  }

  return {
    sessionsDir,
    totalSessions: sessionDirs.length,
    scannedSessions: scanned.length,
    unreadableSessions: unreadable,
    counts: [...counts.values()].sort(
      (a, b) => b.lead + b.tentacle - (a.lead + a.tentacle) || a.model.localeCompare(b.model),
    ),
  };
}

/**
 * Build the MODELS section. Never throws: each part degrades on its own so a
 * broken spine or a missing provider config cannot take inspect down.
 */
export async function buildModelsSection(opts: { cwd?: string } = {}): Promise<ModelsSection> {
  let lead: ModelsSection['lead'] = {
    provider: '(unknown)',
    model: '(unknown)',
    source: '(unknown)',
  };
  try {
    const spec = getActiveProvider();
    lead = { provider: spec.id, model: getActiveModel(), source: leadModelSource() };
  } catch {
    // degraded lead stays
  }

  const kinds: InspectTentacleKind[] = ['explore', 'general', 'verify'];
  const perKind: ModelsSection['perKind'] = [];
  for (const kind of kinds) {
    try {
      const ex = await explainKrakenSubModelAsync(kind, lead.model, process.env, {
        provider: lead.provider === '(unknown)' ? undefined : lead.provider,
        silent: true,
      });
      perKind.push({ kind, model: ex.model, source: ex.source });
    } catch {
      perKind.push({ kind, model: lead.model, source: 'parent (resolver unavailable)' });
    }
  }

  let usage: ModelUsageReport;
  try {
    usage = await collectModelUsage(
      resolveSessionsDir({ workspaceRoot: opts.cwd ?? process.cwd() }),
    );
  } catch {
    usage = emptyUsage('(unavailable)');
  }

  return { lead, perKind, usage };
}
