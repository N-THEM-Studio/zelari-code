/**
 * WS7 slice 4c (t139) — the GRAPH host and the COUNCIL host bind the
 * session-spine tool sink, proved end to end on a REAL `SessionLogWriter`.
 *
 * COVERED (same discipline as krakenGraphSpine.test.ts + the 4b live-seam
 * suite): only the LLM/topology seams are stubbed. The graph test drives the
 * REAL `runHeadlessKrakenGraph` (via `dispatchHeadlessTurn`) with a stubbed
 * planner/executor/tentacle; the stub executor then makes the SAME call the
 * real executor makes for a node — the host-owned
 * `runTentacleFn` envelope wrapper and `taskToolDeps.createSubAgentContext`
 * (built by the real `createKrakenSubAgentContextFactory`, carrying the sink
 * the host bound) — and runs a REAL tool turn through that registry. The
 * council test drives the REAL `dispatchCouncil` against a real CLI tool
 * registry. No test hand-builds a `ToolContext`: the events must land through
 * the production hops host → AgentHarness → `registry.invoke({ cwd, sessionId,
 * signal })` → tool → `ctx.emitSessionEvent`.
 *
 * ASSERTED: `permission.asked` (a decision) and `file.applied` (a real write)
 * land on the spine and `buildProjection()` surfaces them; `file.read` is
 * FILTERED OUT (the graph/council binding is BOUNDED — ADR-0024 amendment
 * v1.3); `ZELARI_GRAPH_SPINE_SINK=0` binds NOTHING while the host's own
 * per-node envelope pair still lands.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentHarness, type ProviderDelta, type ProviderStreamFn } from '@zelari/core/harness';
import type { ToolRegistry } from '@zelari/core/harness/tools/registry';
import { SessionLogWriter, buildProjection, readSessionLog } from '@zelari/core/session';
import type { SessionEventInput } from '@zelari/core/session';
import type { TaskNode } from '@zelari/core';
import type { TentacleResult } from './kraken/tentacle.js';
import { dispatchHeadlessTurn } from './runHeadless.js';
import { dispatchCouncil } from './councilDispatcher.js';
import { createBuiltinToolRegistry } from './toolRegistry.js';
import { AuditLogger } from './safety/auditLogger.js';
import { clearSessionPermissionGrants, type PermissionPolicy } from './safety/toolPermissions.js';
import {
  BOUNDED_SESSION_SINK_KINDS,
  bindSessionSinkToRegistry,
  boundedSessionSink,
  hostSessionSink,
  sessionSinkEnabled,
  type SessionToolSink,
} from './safety/sessionSink.js';

const GOAL = 'ws7c spine probe: one node, one anchored edit';
const SESSION = 'ws7-slice4c-hosts';
const OLD_LINE = 'const value = 1;';
const NEW_LINE = 'const value = 2;';

/**
 * Mutable stub state the hoisted mock factories read at CALL time: the anchor a
 * real read_file would have handed the model, and which probe file to edit (the
 * kill-switch run needs a fresh file, since the first run already applied).
 */
const probe = vi.hoisted(() => ({
  snapshotId: '',
  sourceFile: 'probe.ts',
  sawRegistry: null as unknown,
  makeNode: (id: string): TaskNode => ({
    id,
    kind: 'general',
    label: `tentacle ${id}`,
    prompt: 'edit src/probe.ts',
    deps: [],
    status: 'pending',
    retryCount: 0,
    maxRetries: 1,
  }),
}));

/** The planner is an LLM seam: a fixed 1-node graph keeps the run deterministic. */
vi.mock('./kraken/planner.js', () => ({
  planTaskGraph: async () => ({
    id: 'graph-ws7c',
    nodes: new Map([['n1', probe.makeNode('n1')]]),
  }),
}));

/** Topology rendering is not under test — fixed strings decouple the run. */
vi.mock('./kraken/graphStatus.js', () => ({
  formatKrakenGraphAscii: () => 'ascii',
  formatKrakenGraphDigest: () => 'digest',
}));

/** The tentacle TURN is an LLM seam: the host still wraps it (envelope pair). */
vi.mock('./kraken/tentacle.js', () => ({
  runTentacle: async (): Promise<TentacleResult> =>
    ({
      ok: true,
      agent: 'general',
      thoroughness: 'medium',
      model: 'stub-model',
      result: 'STUB TURN — its content must never reach the spine',
      footer: '',
      worktreePath: null,
      worktreeHandle: null,
    }) satisfies TentacleResult,
}));

/**
 * Stub executor: it makes the two calls the real executor makes per node — the
 * host-owned `runTentacleFn` (whose wrapper writes the graph.node_* envelope)
 * and `taskToolDeps.createSubAgentContext`, on which this stub then runs a REAL
 * tool turn. That second hop is the whole point: the sink can only be live
 * because `runHeadlessKrakenGraph` put it on the factory.
 */
vi.mock('./kraken/executor.js', () => ({
  // Mirror the real kill-switch contract: only the literal '0' disables.
  isKrakenGraphEnabled: (env: NodeJS.ProcessEnv = process.env) => env.ZELARI_KRAKEN_GRAPH !== '0',
  KrakenGraphExecutor: class {
    private readonly opts: {
      parentCwd?: string;
      runTentacleFn?: (opts: { nodeId: string; agent: string; graphId?: string }) => Promise<unknown>;
      taskToolDeps?: {
        createSubAgentContext: (input: {
          agent: string;
          cwd?: string;
        }) => Promise<{ registry: ToolRegistry } | null>;
      };
    };
    constructor(opts: typeof this.opts) {
      this.opts = opts;
    }
    async execute(graph: { id: string; nodes: Map<string, TaskNode> }) {
      for (const node of graph.nodes.values()) {
        await this.opts.runTentacleFn?.({ nodeId: node.id, agent: 'general', graphId: graph.id });
        const ctx = await this.opts.taskToolDeps?.createSubAgentContext({
          agent: 'general',
          cwd: this.opts.parentCwd,
        });
        probe.sawRegistry = ctx?.registry ?? null;
        if (ctx) await driveNodeTurn(ctx.registry, this.opts.parentCwd ?? '');
        node.status = 'done';
      }
      return { converged: true, cancelled: false, graph, durationsMs: {}, unresolvedFindings: [] };
    }
  },
}));

let tmp: string;
let root: string;

/** Per-call scripted provider stream (last entry repeats) — 4b live-seam style. */
function fakeStream(script: ProviderDelta[][]): ProviderStreamFn {
  let call = 0;
  return async function* (): AsyncIterable<ProviderDelta> {
    const seq = script[Math.min(call, script.length - 1)]!;
    call++;
    for (const d of seq) yield d;
  };
}

/** read → edit: the real ADR-0033 anchor flow (sha256 of the full content). */
function editTurn(cwd: string, file: string): ProviderDelta[][] {
  return [
    [
      { kind: 'tool_call', toolCallId: 't1', toolName: 'read_file', args: { path: file, maxBytes: 100_000 } },
      { kind: 'finish', reason: 'tool_calls' },
    ],
    [
      {
        kind: 'tool_call',
        toolCallId: 't2',
        toolName: 'edit',
        args: { path: file, oldString: OLD_LINE, newString: NEW_LINE, snapshotId: probe.snapshotId },
      },
      { kind: 'finish', reason: 'tool_calls' },
    ],
    [{ kind: 'finish', reason: 'stop' }],
  ];
}

/** One REAL node turn through the registry the HOST built (relative path). */
async function driveNodeTurn(registry: ToolRegistry, cwd: string): Promise<void> {
  const harness = new AgentHarness({
    model: 'test-model',
    provider: 'test',
    sessionId: SESSION,
    messages: [{ role: 'user', content: 'work the node' }],
    tools: [],
    toolRegistry: registry,
    cwd,
    providerStream: fakeStream(editTurn(cwd, path.join('src', probe.sourceFile))),
  });
  for await (const _ of harness.run()) {
    /* drain */
  }
}

/** Swallow stdout/stderr (NDJSON) while the host run completes. */
async function captureQuiet<T>(fn: () => Promise<T>): Promise<T> {
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  process.stdout.write = (() => true) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    return await fn();
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
  }
}

/** Run the real graph host once: provider/model anchor the real factory. */
async function runGraphOnce(): Promise<number> {
  const unreachable = (() => {
    throw new Error('provider stream must not be reached by the kraken-graph path');
  }) as unknown as ProviderStreamFn;
  return captureQuiet(() =>
    dispatchHeadlessTurn(
      {
        task: GOAL,
        krakenGraph: GOAL,
        mode: 'kraken',
        phase: 'build',
        output: 'json',
        useCouncil: false,
        cwd: tmp,
        onPermissionAsk: async () => true,
      },
      'openai-compatible',
      'ws7c-model',
      unreachable,
      { policyGateDone: true },
    ),
  );
}

/** The single session log the host left under the tmp workspace. */
async function spineReport(): Promise<{
  kinds: string[];
  events: Array<{ kind: string; data: Record<string, unknown> }>;
}> {
  const dir = path.join(tmp, '.zelari', 'sessions');
  const ids = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  const logs = ids.map((id) => path.join(dir, id, 'events.jsonl')).filter((p) => fs.existsSync(p));
  expect(logs).toHaveLength(1);
  const report = await readSessionLog(logs[0]!);
  expect(report.ok).toBe(true);
  expect(report.issues).toEqual([]);
  const events = report.events as unknown as Array<{ kind: string; data: Record<string, unknown> }>;
  return { kinds: events.map((e) => e.kind), events };
}

const ENV_KEYS = [
  'ZELARI_MEMORY',
  'ZELARI_SESSIONS_DIR',
  'ZELARI_KRAKEN_GRAPH',
  'ZELARI_PERMISSION_WRITE',
  'ZELARI_PERMISSION_READ',
  'ZELARI_PERMISSION_EXECUTE',
  'ZELARI_PERMISSION_NETWORK',
  'ZELARI_PERMISSION_PRESET',
  'ZELARI_AUTO',
  'ZELARI_GRAPH_SPINE_SINK',
  'OPENAI_API_KEY',
] as const;

let savedEnv: Record<string, string | undefined>;

beforeEach(async () => {
  tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'zelari-ws7c-'));
  root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'zelari-ws7c-council-'));
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.ZELARI_MEMORY = '0'; // memory v2 off (serviceFactory short-circuit)
  delete process.env.ZELARI_SESSIONS_DIR; // sessions under <workspace>/.zelari
  delete process.env.ZELARI_KRAKEN_GRAPH; // graph engine enabled (default)
  delete process.env.ZELARI_GRAPH_SPINE_SINK; // binding ON (default)
  delete process.env.ZELARI_AUTO;
  // Deterministic policy: the WRITE category asks (a decision event to record),
  // the read category is silent, and nothing promotes the ask behind the gate.
  process.env.ZELARI_PERMISSION_PRESET = 'standard';
  process.env.ZELARI_PERMISSION_WRITE = 'ask';
  delete process.env.ZELARI_PERMISSION_READ;
  delete process.env.ZELARI_PERMISSION_EXECUTE;
  delete process.env.ZELARI_PERMISSION_NETWORK;
  process.env.OPENAI_API_KEY = 'sk-ws7c'; // the REAL factory resolves its config
  probe.sourceFile = 'probe.ts';
  await fs.promises.mkdir(path.join(tmp, 'src'), { recursive: true });
  const source = `${OLD_LINE}\n`;
  await fs.promises.writeFile(path.join(tmp, 'src', 'probe.ts'), source, 'utf-8');
  await fs.promises.writeFile(path.join(tmp, 'src', 'probe-kill.ts'), source, 'utf-8');
  probe.snapshotId = createHash('sha256').update(source).digest('hex').slice(0, 16);
  clearSessionPermissionGrants();
});

afterEach(async () => {
  for (const k of ENV_KEYS) {
    const v = savedEnv[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await fs.promises.rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe('WS7 slice 4c — the GRAPH host binds its spine to node tool invocations', () => {
  it('a real node turn lands permission.asked + file.applied; file.read is filtered out', async () => {
    const code = await runGraphOnce();
    expect(code).toBe(0);
    // The host really handed the stub executor a sub-agent registry.
    expect(probe.sawRegistry).not.toBeNull();

    const { kinds, events } = await spineReport();
    // The host's own per-node envelope is untouched by the new binding.
    expect(kinds).toContain('graph.node_started');
    expect(kinds).toContain('graph.node_ended');

    const asked = events.filter((e) => e.kind === 'permission.asked');
    expect(asked).toHaveLength(1);
    expect(asked[0]!.data).toMatchObject({ tool: 'edit', categories: ['write'] });

    const applied = events.filter((e) => e.kind === 'file.applied');
    expect(applied.map((e) => e.data.path)).toEqual([path.join(tmp, 'src', probe.sourceFile)]);
    // The write really happened on disk — the ask was answered, not bypassed.
    expect(await fs.promises.readFile(path.join(tmp, 'src', probe.sourceFile), 'utf-8')).toBe(
      `${NEW_LINE}\n`,
    );

    // BOUNDED: the same turn READ the file (read_file ran first) and still left
    // no `file.read`; no per-tool-call dump landed either.
    expect(kinds).not.toContain('file.read');
    expect(kinds).not.toContain('tool.call');
    expect(kinds).not.toContain('tool.result');

    // Replay surface: the decision is aggregated where a reader looks for it.
    const dir = path.join(tmp, '.zelari', 'sessions');
    const log = path.join(dir, fs.readdirSync(dir)[0]!, 'events.jsonl');
    const report = await readSessionLog(log);
    const projection = buildProjection(report.events, report.issues);
    expect(projection.decisionEvents.map((d) => d.kind)).toEqual(['permission.asked']);
    expect(projection.decisionEvents[0]!.tool).toBe('edit');
  }, 60_000);

  it('KILL SWITCH: ZELARI_GRAPH_SPINE_SINK=0 binds nothing — envelope unchanged, zero tool events', async () => {
    process.env.ZELARI_GRAPH_SPINE_SINK = '0';
    probe.sourceFile = 'probe-kill.ts';

    const code = await runGraphOnce();
    expect(code).toBe(0);
    // The turn still ran end to end: the switch disables the BINDING, not work.
    expect(await fs.promises.readFile(path.join(tmp, 'src', probe.sourceFile), 'utf-8')).toBe(
      `${NEW_LINE}\n`,
    );

    const { kinds } = await spineReport();
    expect(kinds).toContain('graph.node_started');
    expect(kinds).toContain('graph.node_ended');
    expect(kinds).not.toContain('permission.asked');
    expect(kinds).not.toContain('file.applied');
    expect(kinds).not.toContain('file.read');
  }, 60_000);
});

describe('WS7 slice 4c — COUNCIL members emit on the parent session spine', () => {
  /** A real CLI registry with the write category ASKED (deterministic decision). */
  function councilRegistry(): ToolRegistry {
    const policy: PermissionPolicy = {
      read: 'allow',
      write: 'ask',
      execute: 'allow',
      network: 'allow',
      ui: 'allow',
      auto: false,
    };
    const { registry } = createBuiltinToolRegistry({
      root,
      audit: new AuditLogger(path.join(root, 'audit.jsonl')),
      sessionId: SESSION,
      profile: 'full',
      enableTask: false,
      enableSkill: false,
      diagnostics: false,
      lspProvider: null,
      permissionPolicy: policy,
      onPermissionAsk: async () => true,
    });
    return registry;
  }

  /** The member's turn: absolute paths — a member harness has no cwd of its own. */
  function memberStream(target: string): ProviderStreamFn {
    return fakeStream([
      [
        { kind: 'tool_call', toolCallId: 'c1', toolName: 'read_file', args: { path: target, maxBytes: 100_000 } },
        { kind: 'finish', reason: 'tool_calls' },
      ],
      [
        {
          kind: 'tool_call',
          toolCallId: 'c2',
          toolName: 'edit',
          args: { path: target, oldString: OLD_LINE, newString: NEW_LINE, snapshotId: probe.snapshotId },
        },
        { kind: 'finish', reason: 'tool_calls' },
      ],
      [{ kind: 'finish', reason: 'stop' }],
    ]);
  }

  async function runCouncil(target: string, sessionEventSink?: SessionToolSink): Promise<void> {
    const registry = councilRegistry();
    for await (const _event of dispatchCouncil('council spine probe', {
      apiKey: 'sk-test',
      model: 'ws7c-model',
      provider: 'openai-compatible',
      providerStream: memberStream(target),
      sessionId: SESSION,
      workspaceRoot: root,
      disableWorkspaceTools: true,
      tools: registry,
      councilSize: 3,
      debateMode: false,
      runMode: 'design-phase',
      ...(sessionEventSink ? { sessionEventSink } : {}),
    })) {
      /* drain */
    }
  }

  it('a real dispatchCouncil member tool invocation lands permission.asked + file.applied', async () => {
    await fs.promises.mkdir(path.join(root, 'src'), { recursive: true });
    const target = path.join(root, 'src', 'probe.ts');
    await fs.promises.writeFile(target, `${OLD_LINE}\n`, 'utf-8');
    const writer = await SessionLogWriter.open(path.join(root, 'council-session'), SESSION, 1);
    try {
      // The host binding — exactly `hostSessionSink(spine)` as runHeadless does.
      const sink = hostSessionSink({ appendEvent: (input: SessionEventInput) => writer.append(input) });
      expect(sink).toBeDefined();

      await runCouncil(target, sink);

      const report = await readSessionLog(writer.path);
      expect(report.ok).toBe(true);
      expect(report.events.filter((e) => e.kind === 'permission.asked').map((e) => e.data.tool)).toEqual([
        'edit',
      ]);
      expect(report.events.filter((e) => e.kind === 'file.applied').map((e) => e.data.path)).toEqual([
        target,
      ]);
      expect(report.events.map((e) => e.kind)).not.toContain('file.read');
      expect(await fs.promises.readFile(target, 'utf-8')).toBe(`${NEW_LINE}\n`);

      const projection = buildProjection(report.events, report.issues);
      expect(projection.decisionEvents.map((d) => d.kind)).toEqual(['permission.asked']);
    } finally {
      await writer.close();
    }
  }, 60_000);

  it('without a sink the SAME member registry stays dormant (additive-optional)', async () => {
    await fs.promises.mkdir(path.join(root, 'src'), { recursive: true });
    const target = path.join(root, 'src', 'probe.ts');
    await fs.promises.writeFile(target, `${OLD_LINE}\n`, 'utf-8');
    const writer = await SessionLogWriter.open(path.join(root, 'dormant-session'), SESSION, 1);
    try {
      await runCouncil(target);
      expect(await fs.promises.readFile(target, 'utf-8')).toBe(`${NEW_LINE}\n`);
      expect((await readSessionLog(writer.path)).events).toEqual([]);
    } finally {
      await writer.close();
    }
  }, 60_000);
});

describe('WS7 slice 4c — the binding itself: bounded, order-preserving, kill-switchable', () => {
  it('drops every kind outside the bounded set and forwards the ones inside it', async () => {
    const seen: string[] = [];
    const sink = boundedSessionSink(async (input) => {
      seen.push(input.kind);
    });
    for (const kind of [
      'file.read',
      'note',
      'tool.call',
      'tool.result',
      'assistant.message',
      'graph.node_started',
    ]) {
      await sink({ kind, actor: { type: 'system' }, data: {} });
    }
    expect(seen).toEqual([]);
    for (const kind of [...BOUNDED_SESSION_SINK_KINDS]) {
      await sink({ kind, actor: { type: 'system' }, data: {} });
    }
    expect(seen).toEqual([...BOUNDED_SESSION_SINK_KINDS]);
    // The write path is in, the read path is out — the whole point of the bound.
    expect(BOUNDED_SESSION_SINK_KINDS.has('file.applied')).toBe(true);
    expect(BOUNDED_SESSION_SINK_KINDS.has('file.read')).toBe(false);
  });

  it('binds an existing registry WITHOUT reordering its tools (prompt-cache prefix)', () => {
    const { registry } = createBuiltinToolRegistry({
      root: tmp,
      audit: new AuditLogger(path.join(tmp, 'audit.jsonl')),
      sessionId: SESSION,
      profile: 'full',
      enableTask: false,
      enableSkill: false,
      diagnostics: false,
      lspProvider: null,
      permissionPolicy: {
        read: 'allow',
        write: 'allow',
        execute: 'allow',
        network: 'allow',
        ui: 'allow',
        auto: true,
      },
    });
    const before = registry.list();
    const bound = bindSessionSinkToRegistry(registry, async () => undefined);
    expect(bound).toBe(before.length);
    expect(registry.list()).toEqual(before);
  });

  it('kill switch: only the literal 0 disables, absence and anything else fail OPEN', () => {
    expect(sessionSinkEnabled({})).toBe(true);
    expect(sessionSinkEnabled({ ZELARI_GRAPH_SPINE_SINK: '' })).toBe(true);
    expect(sessionSinkEnabled({ ZELARI_GRAPH_SPINE_SINK: '1' })).toBe(true);
    expect(sessionSinkEnabled({ ZELARI_GRAPH_SPINE_SINK: 'false' })).toBe(true);
    expect(sessionSinkEnabled({ ZELARI_GRAPH_SPINE_SINK: ' 0 ' })).toBe(false);
    const spine = { appendEvent: async () => ({ seq: 1 }) };
    expect(hostSessionSink(spine)).toBeDefined();
    expect(hostSessionSink(spine, { ZELARI_GRAPH_SPINE_SINK: '0' })).toBeUndefined();
  });
});
