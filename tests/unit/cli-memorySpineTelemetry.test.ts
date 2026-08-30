/**
 * W2 — memory telemetry projected onto the ADR-0016 session spine.
 *
 * Three layers:
 *   (a) UNIT: `spineMemoryEventNote` maps MemoryEvents to spine `note`s —
 *       `context.projection` for per-turn context projection, `memory_*`
 *       otherwise — and never throws on a degraded spine;
 *   (b) UNIT: `memorySinkFor` is the late-binding seam (events dropped until
 *       the spine handle is assigned; getter-backed holders work);
 *   (c) INTEGRATION: the headless --kraken-graph path (memory wired directly
 *       to the open spine) records remember+recall as spine notes with
 *       `data.subject === 'context.projection'`, and the spine log NEVER
 *       contains the remembered content (identifier-only invariant).
 *
 * Env discipline + stdout capture + spineLogs helpers cribbed from
 * src/cli/krakenGraphSpine.test.ts; collector idiom from
 * tests/unit/cli-memoryMigration.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { MemoryEvent, MemoryService } from '@zelari/core/memory';
import { readSessionLog } from '@zelari/core/session';
import { memorySinkFor, spineMemoryEventNote, type SpineNoteHandle } from '../../src/cli/memory/spineTelemetry.js';
import { dispatchHeadlessTurn } from '../../src/cli/runHeadless.js';
import type { ProviderStreamFn } from '@zelari/core/harness';

const AT = '2026-01-01T00:00:00.000Z';

describe('spineMemoryEventNote (unit)', () => {
  function collector(): { handle: SpineNoteHandle; notes: Array<{ text: string; data?: Record<string, unknown> }> } {
    const notes: Array<{ text: string; data?: Record<string, unknown> }> = [];
    return { handle: { note: (text, data) => void notes.push({ text, data }) }, notes };
  }

  it('maps a context-built recall_end to the context.projection note with counter payload', () => {
    const { handle, notes } = collector();
    spineMemoryEventNote(handle, {
      type: 'memory_recall_end',
      at: AT,
      reason: 'context-built',
      contextChars: 512,
      returnedCount: 3,
      durationMs: 7,
    });
    expect(notes).toHaveLength(1);
    expect(notes[0]!.text).toBe('context.projection');
    expect(notes[0]!.data).toMatchObject({
      subject: 'context.projection',
      contextChars: 512,
      returnedCount: 3,
      durationMs: 7,
    });
  });

  it('maps every other memory event to a memory_* note with the memory_event subject', () => {
    const { handle, notes } = collector();
    spineMemoryEventNote(handle, { type: 'memory_write', at: AT, memoryId: 'mem-1', backend: 'sqlite' });
    spineMemoryEventNote(handle, { type: 'memory_error', at: AT, reason: 'semantic: unavailable' });
    // Note text is `memory_${event.type}` per the W2 design — the core event
    // type already carries the memory_ prefix, so the doubled prefix is the
    // specified spine vocabulary (the payload keeps the raw type).
    expect(notes[0]!.text).toBe('memory_memory_write');
    expect(notes[0]!.data).toEqual({ subject: 'memory_event', type: 'memory_write', backend: 'sqlite', memoryId: 'mem-1' });
    expect(notes[1]!.text).toBe('memory_memory_error');
    expect(notes[1]!.data).toEqual({ subject: 'memory_event', type: 'memory_error', reason: 'semantic: unavailable' });
  });

  it('omits undefined fields instead of passing them through as nulls', () => {
    const { handle, notes } = collector();
    spineMemoryEventNote(handle, { type: 'memory_recall_start', at: AT });
    expect(notes[0]!.data).toEqual({ subject: 'memory_event', type: 'memory_recall_start' });
  });

  it('swallows a throwing spine handle — telemetry never breaks the run', () => {
    const throwing: SpineNoteHandle = {
      note: () => {
        throw new Error('spine down');
      },
    };
    expect(() =>
      spineMemoryEventNote(throwing, { type: 'memory_recall_end', at: AT, reason: 'context-built', contextChars: 10 }),
    ).not.toThrow();
    expect(() => spineMemoryEventNote(throwing, { type: 'memory_write', at: AT })).not.toThrow();
  });
});

describe('memorySinkFor (unit)', () => {
  const recallEnd: MemoryEvent = {
    type: 'memory_recall_end',
    at: AT,
    reason: 'context-built',
    contextChars: 256,
    returnedCount: 2,
  };

  it('drops events while the holder is empty and flows them once assigned (late binding)', () => {
    const notes: Array<{ text: string; data?: Record<string, unknown> }> = [];
    const handle: SpineNoteHandle = { note: (text, data) => void notes.push({ text, data }) };
    const holder: { current?: SpineNoteHandle } = {};
    const sink = memorySinkFor(holder);
    sink(recallEnd);
    expect(notes).toHaveLength(0);
    holder.current = handle;
    sink(recallEnd);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.text).toBe('context.projection');
  });

  it('accepts a getter-backed holder (the TUI writerRef seam shape)', () => {
    const notes: Array<{ text: string; data?: Record<string, unknown> }> = [];
    let attached = false; // mirrors writerRef.current?.spine attaching mid-session
    const holder = {
      get current(): SpineNoteHandle | undefined {
        return attached ? { note: (text, data) => void notes.push({ text, data }) } : undefined;
      },
    };
    const sink = memorySinkFor(holder);
    sink(recallEnd); // getter resolves undefined → dropped
    attached = true;
    sink(recallEnd); // getter now resolves a handle → note flows
    expect(notes).toHaveLength(1);
    expect(notes[0]!.text).toBe('context.projection');
  });
});

// ---------------------------------------------------------------------------
// (c) Integration: real spine + real memory service on the headless graph path.
// ---------------------------------------------------------------------------

const GOAL = 'w2 spine telemetry probe: note one function in src/util.ts';
const SECRET_CONTENT = 'kraken spine telemetry probe alpha bravo';

/** Set by each integration test; runs INSIDE the (mocked) executor with the real service. */
let driveMemory: (memory: MemoryService) => Promise<void> = async () => {};

vi.mock('../../src/cli/kraken/planner.js', () => ({
  planTaskGraph: async () => ({ id: 'graph-w2', nodes: new Map() }),
}));
vi.mock('../../src/cli/kraken/graphStatus.js', () => ({
  formatKrakenGraphAscii: () => 'ascii',
  formatKrakenGraphDigest: () => 'digest',
}));
vi.mock('../../src/cli/kraken/executor.js', () => ({
  isKrakenGraphEnabled: (env: NodeJS.ProcessEnv = process.env) => env.ZELARI_KRAKEN_GRAPH !== '0',
  KrakenGraphExecutor: class {
    private memory?: MemoryService;
    constructor(opts: { taskToolDeps?: { memoryService?: MemoryService } }) {
      this.memory = opts.taskToolDeps?.memoryService;
    }
    async execute() {
      if (this.memory) await driveMemory(this.memory);
      return {
        converged: true,
        cancelled: false,
        graph: { id: 'graph-w2', nodes: new Map() },
        durationsMs: {},
        unresolvedFindings: [],
      };
    }
  },
}));

const ENV_KEYS = ['ZELARI_KRAKEN_GRAPH', 'ZELARI_SESSIONS_DIR', 'ZELARI_MEMORY', 'ZELARI_MEMORY_V2', 'ZELARI_MEMORY_BACKEND'] as const;

let tmp: string;
let savedEnv: Record<string, string | undefined>;

beforeEach(async () => {
  tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'zelari-w2-telemetry-'));
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  delete process.env.ZELARI_KRAKEN_GRAPH;
  delete process.env.ZELARI_SESSIONS_DIR;
  // Memory v2 ON so the graph path constructs the real service with the sink.
  delete process.env.ZELARI_MEMORY;
  delete process.env.ZELARI_MEMORY_BACKEND;
  process.env.ZELARI_MEMORY_V2 = '1';
});

afterEach(async () => {
  for (const k of ENV_KEYS) {
    const v = savedEnv[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  driveMemory = async () => {};
  await fs.promises.rm(tmp, { recursive: true, force: true });
});

function spineLogs(root: string): string[] {
  const sessions = path.join(root, '.zelari', 'sessions');
  if (!fs.existsSync(sessions)) return [];
  return fs
    .readdirSync(sessions)
    .map((id) => path.join(sessions, id, 'events.jsonl'))
    .filter((p) => fs.existsSync(p));
}

async function captureOutput<T>(fn: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  const lines: string[] = [];
  const collect = (chunk: unknown): boolean => {
    lines.push(String(chunk));
    return true;
  };
  process.stdout.write = collect as typeof process.stdout.write;
  process.stderr.write = collect as typeof process.stderr.write;
  const restore = (): void => {
    process.stdout.write = out;
    process.stderr.write = err;
  };
  try {
    const result = await fn();
    return { result, lines };
  } finally {
    restore();
  }
}

describe('W2 — headless kraken-graph projects memory telemetry onto the spine', () => {
  it('records context.projection notes (counters only — never the memory content)', async () => {
    driveMemory = async (memory) => {
      await memory.remember({
        content: SECRET_CONTENT,
        kind: 'fact',
        importance: 0.9,
        confidence: 0.9,
        source: { agent: 'w2-test' },
      });
      await memory.buildContext({ text: SECRET_CONTENT, maxChars: 2_000, maxMemories: 8 });
    };
    const unreachableStream = (() => {
      throw new Error('provider stream must not be reached by the kraken-graph path');
    }) as unknown as ProviderStreamFn;
    const { result: code } = await captureOutput(() =>
      dispatchHeadlessTurn(
        {
          task: GOAL,
          krakenGraph: GOAL,
          mode: 'kraken',
          phase: 'build',
          output: 'json',
          useCouncil: false,
          cwd: tmp,
        },
        'w2-provider',
        'w2-fake-model',
        unreachableStream,
        { policyGateDone: true },
      ),
    );
    expect(code).toBe(0);

    const logs = spineLogs(tmp);
    expect(logs).toHaveLength(1);
    const events = (await readSessionLog(logs[0]!)).events;

    // Per-turn context projection landed as the dedicated spine note.
    const projection = events.find(
      (e) => e.kind === 'note' && (e.data as { subject?: string } | undefined)?.subject === 'context.projection',
    );
    expect(projection).toBeDefined();
    expect((projection!.data as { contextChars?: number }).contextChars ?? 0).toBeGreaterThan(0);

    // Non-projection memory events land under the memory_event subject too.
    const writeNote = events.find(
      (e) => e.kind === 'note' && (e.data as { subject?: string; type?: string } | undefined)?.subject === 'memory_event' &&
        (e.data as { type?: string }).type === 'memory_write',
    );
    expect(writeNote).toBeDefined();

    // Identifier-only invariant: the remembered CONTENT never reaches the log.
    const raw = fs.readFileSync(logs[0]!, 'utf8');
    expect(raw).not.toContain(SECRET_CONTENT);
  }, 30_000);
});
