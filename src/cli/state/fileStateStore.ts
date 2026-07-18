/**
 * File-backed DurableStateStore — verified layer accumulation under
 * `<projectRoot>/.zelari/state/`.
 *
 * Layout:
 *   .zelari/state/HEAD.json
 *   .zelari/state/commits/<id>.json
 *   .zelari/state/artifacts/<id>/{summary.md,discoveries.json,verification.json}
 *   .zelari/state/index.jsonl
 *
 * Kill switch: ZELARI_STATE=0 → factory returns NoopDurableStateStore.
 * Fail-open: getStateStore never throws; returns noop on init failure.
 */

import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type {
  Discovery,
  DurableStateStore,
  StateCommitId,
  StateCommitInput,
  StateCommitMeta,
} from '@zelari/core';

const DEFAULT_MATERIALIZE_CHARS = 4_000;

interface StoredCommit extends StateCommitMeta {
  /** Relative artifact dir under .zelari/state/artifacts/ */
  artifactDir: string;
}

function shortId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 12);
}

async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  await fs.rename(tmp, filePath);
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function defaultSummary(input: StateCommitInput, discoveries: Discovery[]): string {
  if (input.summary?.trim()) return input.summary.trim();
  const lines = [
    `# ${input.label}`,
    '',
    `- mode: ${input.mode}`,
    input.layer ? `- layer: ${input.layer}` : null,
    `- verification: ran=${input.verification.ran} ok=${input.verification.ok}`,
    '',
    '## Discoveries',
    ...discoveries.map((d) => `- [${d.kind}] ${d.summary}`),
  ].filter((x): x is string => x !== null);
  return lines.join('\n');
}

export class FileDurableStateStore implements DurableStateStore {
  private root = '';
  private stateDir = '';
  private commitsDir = '';
  private artifactsDir = '';
  private headPath = '';
  private indexPath = '';

  async init(projectRoot: string): Promise<void> {
    this.root = projectRoot;
    this.stateDir = path.join(projectRoot, '.zelari', 'state');
    this.commitsDir = path.join(this.stateDir, 'commits');
    this.artifactsDir = path.join(this.stateDir, 'artifacts');
    this.headPath = path.join(this.stateDir, 'HEAD.json');
    this.indexPath = path.join(this.stateDir, 'index.jsonl');
    await fs.mkdir(this.commitsDir, { recursive: true });
    await fs.mkdir(this.artifactsDir, { recursive: true });
  }

  async commit(input: StateCommitInput): Promise<StateCommitMeta> {
    if (!input.force && input.verification.ran && !input.verification.ok) {
      throw new Error(
        'DurableStateStore.commit refused: verification ran and failed (pass force:true for soft commit)',
      );
    }

    const discoveries = input.discoveries ?? [];
    const parent = await this.head();
    const id = shortId();
    const artifactRel = path.join('artifacts', id);
    const artifactAbs = path.join(this.artifactsDir, id);
    await fs.mkdir(artifactAbs, { recursive: true });

    const summary = defaultSummary(input, discoveries);
    await fs.writeFile(path.join(artifactAbs, 'summary.md'), summary + '\n', 'utf8');
    await writeJsonAtomic(path.join(artifactAbs, 'discoveries.json'), discoveries);
    await writeJsonAtomic(path.join(artifactAbs, 'verification.json'), input.verification);

    const meta: StoredCommit = {
      id,
      parentId: parent?.id ?? null,
      createdAt: Date.now(),
      sessionId: input.sessionId,
      mode: input.mode,
      layer: input.layer,
      label: input.label,
      workspaceCheckpointId: input.workspaceCheckpointId,
      verification: {
        ...input.verification,
        reportPath:
          input.verification.reportPath ??
          path.join('.zelari', 'state', artifactRel, 'verification.json').replace(/\\/g, '/'),
      },
      changedPaths: input.changedPaths ?? [],
      stablePromptHash: input.stablePromptHash,
      discoveryCount: discoveries.length,
      artifactDir: artifactRel.replace(/\\/g, '/'),
    };

    await writeJsonAtomic(path.join(this.commitsDir, `${id}.json`), meta);
    await writeJsonAtomic(this.headPath, { id, updatedAt: meta.createdAt });
    await fs.appendFile(this.indexPath, JSON.stringify({ id, createdAt: meta.createdAt, label: meta.label }) + '\n', 'utf8');

    return stripStored(meta);
  }

  async head(): Promise<StateCommitMeta | null> {
    const head = await readJsonFile<{ id: string }>(this.headPath);
    if (!head?.id) return null;
    return this.get(head.id);
  }

  async get(id: StateCommitId): Promise<StateCommitMeta | null> {
    const stored = await readJsonFile<StoredCommit>(path.join(this.commitsDir, `${id}.json`));
    return stored ? stripStored(stored) : null;
  }

  async list(limit = 20): Promise<StateCommitMeta[]> {
    let raw: string;
    try {
      raw = await fs.readFile(this.indexPath, 'utf8');
    } catch {
      return [];
    }
    const ids: string[] = [];
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        const row = JSON.parse(t) as { id?: string };
        if (row.id) ids.push(row.id);
      } catch {
        // skip corrupt
      }
    }
    const slice = ids.slice(-Math.max(1, limit)).reverse();
    const out: StateCommitMeta[] = [];
    for (const id of slice) {
      const m = await this.get(id);
      if (m) out.push(m);
    }
    return out;
  }

  async setHead(id: StateCommitId): Promise<StateCommitMeta> {
    const meta = await this.get(id);
    if (!meta) {
      throw new Error(`DurableStateStore.setHead: unknown commit ${id}`);
    }
    await writeJsonAtomic(this.headPath, { id, updatedAt: Date.now() });
    return meta;
  }

  async loadDiscoveries(id?: StateCommitId): Promise<Discovery[]> {
    const meta = id ? await this.get(id) : await this.head();
    if (!meta) return [];
    const stored = await readJsonFile<StoredCommit>(path.join(this.commitsDir, `${meta.id}.json`));
    if (!stored?.artifactDir) return [];
    const discPath = path.join(this.stateDir, stored.artifactDir, 'discoveries.json');
    return (await readJsonFile<Discovery[]>(discPath)) ?? [];
  }

  async materializeContext(id?: StateCommitId, maxChars = DEFAULT_MATERIALIZE_CHARS): Promise<string> {
    const meta = id ? await this.get(id) : await this.head();
    if (!meta) return '';
    const discoveries = await this.loadDiscoveries(meta.id);
    const reusable = discoveries.filter((d) => d.reusable);
    const lines: string[] = [
      `# Durable State (commit ${meta.id}${meta.layer ? `, layer ${meta.layer}` : ''})`,
      `label: ${meta.label}`,
      `verification: ran=${meta.verification.ran} ok=${meta.verification.ok}`,
    ];
    if (meta.workspaceCheckpointId) {
      lines.push(`workspaceCheckpoint: ${meta.workspaceCheckpointId}`);
    }
    if (reusable.length === 0 && discoveries.length === 0) {
      lines.push('(no discoveries)');
    } else {
      const list = reusable.length > 0 ? reusable : discoveries;
      for (const d of list) {
        const pathHint = d.paths?.length ? ` — ${d.paths.join(', ')}` : '';
        lines.push(`- [${d.kind}] ${d.summary}${pathHint}`);
      }
    }
    let text = lines.join('\n');
    if (text.length > maxChars) {
      text = text.slice(0, maxChars - 1) + '…';
    }
    return text;
  }

  async close(): Promise<void> {
    // nothing held open
  }
}

function stripStored(s: StoredCommit): StateCommitMeta {
  const { artifactDir: _a, ...meta } = s;
  return meta;
}

/** No-op store used when ZELARI_STATE=0 or init fails. */
export class NoopDurableStateStore implements DurableStateStore {
  async init(): Promise<void> {}
  async commit(input: StateCommitInput): Promise<StateCommitMeta> {
    return {
      id: '',
      parentId: null,
      createdAt: Date.now(),
      mode: input.mode,
      label: input.label,
      verification: input.verification,
      changedPaths: input.changedPaths ?? [],
      discoveryCount: input.discoveries?.length ?? 0,
    };
  }
  async head(): Promise<StateCommitMeta | null> {
    return null;
  }
  async get(): Promise<StateCommitMeta | null> {
    return null;
  }
  async list(): Promise<StateCommitMeta[]> {
    return [];
  }
  async setHead(id: StateCommitId): Promise<StateCommitMeta> {
    throw new Error(`NoopDurableStateStore.setHead: state disabled (id=${id})`);
  }
  async loadDiscoveries(): Promise<Discovery[]> {
    return [];
  }
  async materializeContext(): Promise<string> {
    return '';
  }
  async close(): Promise<void> {}
}

/** True unless durable state has been explicitly disabled. */
export function isStateEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ZELARI_STATE !== '0';
}

/**
 * Resolve and initialise the durable state store. Never throws — returns
 * NoopDurableStateStore when disabled or when init fails.
 */
export async function getStateStore(
  projectRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<DurableStateStore> {
  if (!isStateEnabled(env)) return new NoopDurableStateStore();
  const store = new FileDurableStateStore();
  try {
    await store.init(projectRoot);
    return store;
  } catch {
    return new NoopDurableStateStore();
  }
}

/** Stable SHA-256 hex of a prompt pack (for stablePromptHash / cache bust count). */
export function hashStablePrompt(stable: string): string {
  return createHash('sha256').update(stable, 'utf8').digest('hex').slice(0, 16);
}
