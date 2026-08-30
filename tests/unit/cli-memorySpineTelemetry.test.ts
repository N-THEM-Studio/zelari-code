/**
 * W2 — memory telemetry projected onto the ADR-0016 session spine.
 *
 * Three layers:
 *   (a) UNIT: `spineMemoryEventNote` maps MemoryEvents to spine `note`s —
 *       `context.projection` for per-turn context projection, `memory_*`
 *       otherwise — and never throws on a degraded spine;
 *   (b) UNIT: `memorySinkFor` is the late-binding seam (pre-bind events are
 *       BUFFERED up to PRE_BIND_BUFFER_CAP and drained by
 *       flushMemorySpineNotes; overflow counts in droppedEvents);
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
import { LegacyMemoryBackendAdapter, type MemoryEvent, type MemoryService } from '@zelari/core/memory';
import { readSessionLog } from '@zelari/core/session';
import {
  flushMemorySpineNotes,
  memorySinkFor,
  PRE_BIND_BUFFER_CAP,
  spineMemoryEventNote,
  type LateBindingSpineHolder,
  type SpineNoteHandle,
} from '../../src/cli/memory/spineTelemetry.js';
import { getMemoryBackend } from '../../src/cli/memory/fileBackend.js';
import { dispatchHeadlessTurn } from '../../src/cli/runHeadless.js';
import { handleKrakenGraph } from '../../src/cli/slashHandlers/krakenGraph.js';
import type { SpineMirroringWriter } from '../../src/cli/sessionSpine.js';
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

  it('buffers events while the holder is empty and drains them on flush (late binding)', () => {
    const notes: Array<{ text: string; data?: Record<string, unknown> }> = [];
    const handle: SpineNoteHandle = { note: (text, data) => void notes.push({ text, data }) };
    const holder: LateBindingSpineHolder = {};
    const sink = memorySinkFor(holder);
    sink(recallEnd); // pre-bind → buffered, not noted
    expect(notes).toHaveLength(0);
    holder.current = handle;
    sink(recallEnd); // post-bind → direct note
    expect(notes).toHaveLength(1);
    expect(notes[0]!.text).toBe('context.projection');
    flushMemorySpineNotes(holder); // T4-S3 drain → the buffered event lands
    expect(notes).toHaveLength(2);
    expect(notes[1]!.text).toBe('context.projection');
    expect(holder.droppedEvents).toBeUndefined();
  });

  it('accepts a getter-backed holder (the TUI writerRef seam shape) and drains it on flush', () => {
    const notes: Array<{ text: string; data?: Record<string, unknown> }> = [];
    let attached = false; // mirrors writerRef.current?.spine attaching mid-session
    const holder = {
      get current(): SpineNoteHandle | undefined {
        return attached ? { note: (text, data) => void notes.push({ text, data }) } : undefined;
      },
    };
    const sink = memorySinkFor(holder);
    sink(recallEnd); // getter resolves undefined → buffered
    attached = true;
    sink(recallEnd); // getter now resolves a handle → note flows
    expect(notes).toHaveLength(1);
    expect(notes[0]!.text).toBe('context.projection');
    flushMemorySpineNotes(holder); // drain the buffered pre-attach event
    expect(notes).toHaveLength(2);
    expect(notes.map((n) => n.text)).toEqual(['context.projection', 'context.projection']);
  });

  it(`caps the pre-bind buffer at PRE_BIND_BUFFER_CAP and counts overflow in droppedEvents`, () => {
    const notes: Array<{ text: string; data?: Record<string, unknown> }> = [];
    const holder: LateBindingSpineHolder = {};
    const sink = memorySinkFor(holder);
    for (let i = 0; i < PRE_BIND_BUFFER_CAP + 3; i += 1) sink(recallEnd);
    expect(notes).toHaveLength(0);
    expect(holder.droppedEvents).toBe(3);
    holder.current = { note: (text, data) => void notes.push({ text, data }) };
    flushMemorySpineNotes(holder);
    expect(notes).toHaveLength(PRE_BIND_BUFFER_CAP); // capped survivors only
    flushMemorySpineNotes(holder); // second drain is a no-op (buffer empty)
    expect(notes).toHaveLength(PRE_BIND_BUFFER_CAP);
  });

  it('flush is a no-op when the handle is unset; later it drains the kept buffer', () => {
    const notes: Array<{ text: string; data?: Record<string, unknown> }> = [];
    const holder: LateBindingSpineHolder = {};
    const sink = memorySinkFor(holder);
    sink(recallEnd);
    flushMemorySpineNotes(holder); // handle unset → no-op, buffer kept
    expect(notes).toHaveLength(0);
    holder.current = { note: (text, data) => void notes.push({ text, data }) };
    flushMemorySpineNotes(holder); // now drains
    expect(notes).toHaveLength(1);
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

// ---------------------------------------------------------------------------
// (d) W2 follow-up: the two remaining unwired memory call sites.
//     - getMemoryBackend (mission adapter) threads onEvent to the V2 service;
//     - the TUI /kraken graph handler projects events through the writerRef
//       holder (late binding; missing ref → buffered/no-op, never a crash).
// ---------------------------------------------------------------------------

/** setMessages fake with the same updater idiom as cli-kraken-graphSlash.test.ts. */
function fakeSetMessages() {
  const messages: string[] = [];
  const setMessages = (updater: unknown) => {
    if (typeof updater === 'function') {
      const next = (updater as (prev: unknown[]) => Array<{ content: string }>)([]);
      messages.push(...next.map((m) => m.content));
    }
  };
  return { setMessages, messages };
}

describe('W2 follow-up — getMemoryBackend threads onEvent (mission adapter)', () => {
  it('propagates V2 service events to the caller-provided sink', async () => {
    const events: MemoryEvent[] = [];
    const backend = await getMemoryBackend(tmp, process.env, (event) => void events.push(event));
    expect(backend).toBeInstanceOf(LegacyMemoryBackendAdapter);
    await backend.add('w2 backend telemetry probe content', { source: 'w2-followup' });
    await vi.waitFor(() => {
      expect(events.some((e) => e.type === 'memory_write')).toBe(true);
    });
    await backend.close();
  });

  it('stays silent on the sink when memory is disabled', async () => {
    process.env.ZELARI_MEMORY = '0';
    const events: MemoryEvent[] = [];
    const backend = await getMemoryBackend(tmp, process.env, (event) => void events.push(event));
    await backend.add('disabled sink probe', {});
    expect(events).toEqual([]);
    await backend.close();
  });
});

describe('W2 follow-up — TUI /kraken graph projects memory telemetry onto the spine', () => {
  const rememberProbe = async (memory: MemoryService): Promise<void> => {
    await memory.remember({
      content: SECRET_CONTENT,
      kind: 'fact',
      importance: 0.9,
      confidence: 0.9,
      source: { agent: 'w2-followup' },
    });
  };

  it('notes memory events via the writerRef-backed holder (late binding)', async () => {
    const notes: Array<{ text: string; data?: Record<string, unknown> }> = [];
    const spine: SpineNoteHandle = { note: (text, data) => void notes.push({ text, data }) };
    const writerRef = { current: null as unknown as SpineMirroringWriter | null };
    driveMemory = async (memory) => {
      // Mirror attaches MID-RUN, after the handler already built the memory
      // service — the holder getter must resolve it at emit time.
      writerRef.current = { spine } as unknown as SpineMirroringWriter;
      await rememberProbe(memory);
    };
    const { setMessages } = fakeSetMessages();
    await handleKrakenGraph({ setMessages, cwd: tmp, sessionId: 'w2-followup', writerRef }, GOAL);

    await vi.waitFor(() => {
      expect(
        notes.some(
          (n) =>
            (n.data as { subject?: string; type?: string } | undefined)?.subject === 'memory_event' &&
            (n.data as { type?: string } | undefined)?.type === 'memory_write',
        ),
      ).toBe(true);
    });
    // Identifier-only invariant: the remembered content never reaches the spine.
    expect(JSON.stringify(notes)).not.toContain(SECRET_CONTENT);
  });

  it('buffers memory events (no-op) without crashing when the context has no writerRef', async () => {
    driveMemory = rememberProbe;
    const { setMessages, messages } = fakeSetMessages();
    await expect(
      handleKrakenGraph({ setMessages, cwd: tmp, sessionId: 'w2-noref' }, GOAL),
    ).resolves.toBeUndefined();
    expect(messages.some((m) => m.includes('graph run failed'))).toBe(false);
  });
});
