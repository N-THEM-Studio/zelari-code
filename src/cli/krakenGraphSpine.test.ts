/**
 * W1 — the `--kraken-graph` headless path opens the ADR-0016 session spine.
 *
 * End-to-end IN-PROCESS via dispatchHeadlessTurn (same seam policyGate.test.ts
 * uses): planner/executor are the LLM seams and are stubbed; the spine is
 * REAL. Asserts the on-disk contract under `<workspace>/.zelari/sessions`:
 *   (a) a JSONL session log exists after the run;
 *   (b) session.started envelope + user.message carrying the graph goal;
 *   (c) session.ended with the right close reason (completed / cancelled);
 *   (d) ZELARI_KRAKEN_GRAPH=0 disables BEFORE the spine opens — no log left;
 *   (e) ADR-0024 v1.1 (amended 2026-08-30): with a REAL node turn executed by
 *       the stubbed executor, the spine gains exactly the HOST-written
 *       per-node ENVELOPE pair (graph.node_started / graph.node_ended,
 *       metadata-only) and NOTHING else — the node's turn internals (tool
 *       call, assistant text) live on the kraken radio JSONL, never on the
 *       spine log; the stub executor/tentacle never touch the spine.
 *
 * Env discipline + stdout capture cribbed from runOneTurn.strictExit.test.ts;
 * spineLogs helper from policyGate.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ProviderStreamFn } from '@zelari/core/harness';
import type { TaskNode } from '@zelari/core';
import type { TentacleResult } from './kraken/tentacle.js';
import { readSessionLog } from '@zelari/core/session';
import { dispatchHeadlessTurn } from './runHeadless.js';
import { readKrakenRadio } from './tools/krakenRadio.js';

const GOAL = 'w1 spine probe: add one function to src/util.ts';

// Mutable stub state readable from the vi.mock factories (vitest hoisting).
// `turnNodeIds: null` keeps the legacy EMPTY graph (envelope tests below); a
// non-null id list makes the planner emit a 1-node graph whose node the stub
// executor runs a real (mini) turn for — see the W1b describe at the bottom.
const probe = vi.hoisted(() => {
  // Minimal real-shape graph node (packages/core TaskNode); hoisted scope can
  // only close over plain values, so the node is built inline.
  const makeNode = (id: string): TaskNode => ({
    id,
    kind: 'general',
    label: `tentacle ${id}`,
    prompt: 'add one function to src/util.ts',
    deps: [],
    status: 'pending',
    retryCount: 0,
    maxRetries: 1,
  });
  return {
    turnNodeIds: null as string[] | null,
    executed: null as null | { nodeIds: string[]; radioSessionId?: string; radioCwd?: string },
    makeNode,
  };
});

// The planner is an LLM seam — a fixed graph keeps the run deterministic.
vi.mock('./kraken/planner.js', () => ({
  planTaskGraph: async () => ({
    id: 'graph-w1',
    nodes: new Map((probe.turnNodeIds ?? []).map((id) => [id, probe.makeNode(id)])),
  }),
}));

// Topology rendering is not under test — fixed strings decouple the run from
// the executor summary shape.
vi.mock('./kraken/graphStatus.js', () => ({
  formatKrakenGraphAscii: () => 'ascii',
  formatKrakenGraphDigest: () => 'digest',
}));

// Fake executor. `fireSigint` lets the cancelled-path test trigger the SAME
// process signal the real handler (process.once('SIGINT')) listens for, so
// the abort → close('cancelled') branch runs exactly as on a real Ctrl-C.
//
// W1b (ADR-0024 v1.1): when the planner emitted a non-empty graph, execute()
// drives each node's mini-turn through the HOST-owned tentacle seam —
// `opts.runTentacleFn({ nodeId, agent, graphId })`, exactly the per-node call
// shape the real executor makes. The spine envelope pair is written by the
// HOST wrapper AROUND that seam; this stub and the tentacle stub below
// deliberately NEVER touch the spine — single-writer is the contract under
// test. Turn internals (assistant text + tool call detail) go to the
// executor's real per-node channel, the kraken radio JSONL (appendKrakenRadio
// with the parentCwd/sessionId the host handed it).
let fireSigint = false;
vi.mock('./kraken/executor.js', async () => {
  const { appendKrakenRadio } = await import('./tools/krakenRadio.js');
  return {
    // Mirror the real kill-switch contract: only the literal '0' disables.
    isKrakenGraphEnabled: (env: NodeJS.ProcessEnv = process.env) => env.ZELARI_KRAKEN_GRAPH !== '0',
    KrakenGraphExecutor: class {
      private readonly parentCwd?: string;
      private readonly sessionId?: string;
      private readonly runTentacleFn?:
        | ((opts: { nodeId: string; agent: string; graphId?: string }) => Promise<unknown>)
        | undefined;
      constructor(opts: {
        signal?: AbortSignal;
        parentCwd?: string;
        sessionId?: string;
        runTentacleFn?: (opts: { nodeId: string; agent: string; graphId?: string }) => Promise<unknown>;
      }) {
        this.parentCwd = opts.parentCwd;
        this.sessionId = opts.sessionId;
        this.runTentacleFn = opts.runTentacleFn;
      }
      async execute(graph: { id: string; nodes: Map<string, TaskNode> }) {
        if (fireSigint) process.emit('SIGINT');
        if (probe.turnNodeIds !== null) {
          const nodeIds: string[] = [];
          for (const node of graph.nodes.values()) {
            const cwd = this.parentCwd ?? tmp;
            const sessionId = this.sessionId ?? '';
            appendKrakenRadio(cwd, sessionId, {
              kind: 'node_start',
              agent: 'general',
              description: `node ${node.id}: ${node.label}`,
              nodeId: node.id,
            });
            // Drive the host-owned seam (real executor call shape): the host
            // wrapper notes graph.node_started / graph.node_ended around it.
            await this.runTentacleFn?.({ nodeId: node.id, agent: 'general', graphId: graph.id });
            appendKrakenRadio(cwd, sessionId, {
              kind: 'node_end',
              agent: 'general',
              ok: true,
              nodeId: node.id,
              description: `node ${node.id} turn complete`,
              detail: 'assistant: added the function to src/util.ts; tool(write_file src/util.ts) -> ok',
              durationMs: 5,
            });
            node.status = 'done';
            node.result = 'mini-turn: assistant reply + successful write_file tool call';
            nodeIds.push(node.id);
          }
          probe.executed = {
            nodeIds,
            radioSessionId: this.sessionId,
            radioCwd: this.parentCwd,
          };
        }
        return {
          converged: !fireSigint,
          cancelled: fireSigint,
          graph,
          durationsMs: {},
          unresolvedFindings: [],
        };
      }
    },
  };
});

// W1b: the innermost LLM seam — the real `runTentacle` the host wrapper
// delegates to. Stubbed like the planner/executor above: it completes
// instantly with a distinctive conclusion that must NEVER appear on the spine.
vi.mock('./kraken/tentacle.js', () => ({
  runTentacle: async (): Promise<TentacleResult> =>
    ({
      ok: true,
      agent: 'general',
      thoroughness: 'medium',
      model: 'stub-model',
      result: 'STUB TURN CONCLUSION — must never reach the spine',
      footer: '',
      worktreePath: null,
      worktreeHandle: null,
    }) satisfies TentacleResult,
}));

const ENV_KEYS = ['ZELARI_KRAKEN_GRAPH', 'ZELARI_SESSIONS_DIR', 'ZELARI_MEMORY'] as const;

let tmp: string;
let savedEnv: Record<string, string | undefined>;

beforeEach(async () => {
  tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'zelari-w1-spine-'));
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  delete process.env.ZELARI_KRAKEN_GRAPH; // engine enabled (default)
  // No env override: sessions must land under <workspace>/.zelari/sessions.
  delete process.env.ZELARI_SESSIONS_DIR;
  process.env.ZELARI_MEMORY = '0'; // memory v2 off (serviceFactory short-circuit)
});

afterEach(async () => {
  for (const k of ENV_KEYS) {
    const v = savedEnv[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fireSigint = false;
  probe.turnNodeIds = null;
  probe.executed = null;
  await fs.promises.rm(tmp, { recursive: true, force: true });
});

/** Session spine logs under the tmp workspace (paths, per policyGate.test.ts). */
function spineLogs(root: string): string[] {
  const sessions = path.join(root, '.zelari', 'sessions');
  if (!fs.existsSync(sessions)) return [];
  return fs
    .readdirSync(sessions)
    .map((id) => path.join(sessions, id, 'events.jsonl'))
    .filter((p) => fs.existsSync(p));
}

/** Capture (and swallow) stdout+stderr while the run emits NDJSON. */
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

function runGraph(): Promise<{ result: number; lines: string[] }> {
  const unreachableStream = (() => {
    throw new Error('provider stream must not be reached by the kraken-graph path');
  }) as unknown as ProviderStreamFn;
  return captureOutput(() =>
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
      'w1-provider',
      'w1-fake-model',
      unreachableStream,
      { policyGateDone: true }, // gate coverage is policyGate.test.ts's job
    ),
  );
}

describe('W1 — kraken-graph opens the ADR-0016 session spine', () => {
  it('success: session log under <workspace>/.zelari/sessions with envelope + goal, closed completed', async () => {
    const { result: code } = await runGraph();
    expect(code).toBe(0);

    // (a) exactly ONE session log, at the documented workspace location.
    const logs = spineLogs(tmp);
    expect(logs).toHaveLength(1);
    const events = (await readSessionLog(logs[0]!)).events;

    // (b) session envelope first + user message carrying the graph goal.
    expect(events[0]!.kind).toBe('session.started');
    const userMsg = events.find((e) => e.kind === 'user.message');
    expect(userMsg).toBeDefined();
    expect((userMsg!.data as { text?: string } | undefined)?.text).toBe(GOAL);

    // (c) clean close.
    const ended = events.at(-1)!;
    expect(ended.kind).toBe('session.ended');
    expect((ended.data as { reason?: string }).reason).toBe('completed');
  }, 30_000);

  it('SIGINT mid-graph closes the spine as cancelled (exit 3, ended log present)', async () => {
    fireSigint = true;
    const { result: code } = await runGraph();
    expect(code).toBe(3); // non-converged graph exit, spine stays out of it

    const logs = spineLogs(tmp);
    expect(logs).toHaveLength(1);
    const events = (await readSessionLog(logs[0]!)).events;
    const ended = events.at(-1)!;
    expect(ended.kind).toBe('session.ended');
    expect((ended.data as { reason?: string }).reason).toBe('cancelled');
  }, 30_000);

  it('ZELARI_KRAKEN_GRAPH=0: exit 1 and NO session file left behind', async () => {
    process.env.ZELARI_KRAKEN_GRAPH = '0';
    const { result: code } = await runGraph();
    expect(code).toBe(1);
    // (d) the kill-switch fires BEFORE the spine opens — nothing on disk.
    expect(spineLogs(tmp)).toHaveLength(0);
    expect(existsSync(path.join(tmp, '.zelari', 'sessions'))).toBe(false);
  }, 30_000);
});

// ADR-0024 v1.1 (amended 2026-08-30): graph runs carry per-node ENVELOPE
// events on the spine — written by the HOST (the sole spine writer) around
// the executor's tentacle-run seam, metadata-only (id/stato/tempi). Turn
// internals and model content NEVER reach the spine (they live on the kraken
// radio JSONL). This suite pins the contract with a graph whose node actually
// runs a turn, DIFFERENTIALLY: a 1-node run must add exactly ONE node
// envelope pair (graph.node_started + graph.node_ended) to the empty-graph
// spine sequence — nothing else. (The spine also carries host/session
// scaffolding — session.harness_manifest, resource.*, task.contract, notes —
// written by the spine mirror itself on every run, node or not; that is not
// per-node output and the differential pin is agnostic to its exact shape.)
describe('W1b — per-node envelope contract with a real node turn', () => {
  it('node completes a mini-turn: the spine gains exactly the host-written graph.node pair vs the empty-graph run', async () => {
    // Run A — the legacy EMPTY graph (same shape the envelope tests above use).
    const first = await runGraph();
    expect(first.result).toBe(0);
    const logsA = spineLogs(tmp);
    expect(logsA).toHaveLength(1);
    const eventsA = (await readSessionLog(logsA[0]!)).events;
    const kindsA = eventsA.map((e) => e.kind);
    // Empty graph: zero per-node events — session envelope + scaffolding only.
    expect(kindsA.filter((k) => k.startsWith('graph.node'))).toEqual([]);

    // Run B — a 1-node graph; the stub executor records the node call, drives
    // the HOST-owned runTentacle seam (real executor call shape) and emits
    // the mini-turn on the executor's real per-node channel (radio).
    probe.turnNodeIds = ['g1'];
    const second = await runGraph();
    expect(second.result).toBe(0);

    // The turn really ran, under run B's session.
    expect(probe.executed?.nodeIds).toEqual(['g1']);
    expect(probe.executed?.radioSessionId).toBeTruthy();

    // Run B's spine log (disambiguated by the session id the executor saw).
    const logsB = spineLogs(tmp);
    expect(logsB).toHaveLength(2);
    const logB = logsB.find((p) => path.basename(path.dirname(p)) === probe.executed?.radioSessionId);
    expect(logB).toBeDefined();
    const eventsB = (await readSessionLog(logB!)).events;
    const kindsB = eventsB.map((e) => e.kind);

    // THE PIN (ADR-0024 v1.1, inverted vs v1): exactly ONE node envelope pair
    // — and removing it restores the empty-graph sequence kind-for-kind.
    expect(kindsB.filter((k) => !k.startsWith('graph.node'))).toEqual(kindsA);
    expect(kindsB.filter((k) => k.startsWith('graph.node'))).toEqual([
      'graph.node_started',
      'graph.node_ended',
    ]);

    // Envelope events are present, in the documented positions.
    expect(eventsB[0]!.kind).toBe('session.started');
    const userMsg = eventsB.find((e) => e.kind === 'user.message');
    expect((userMsg!.data as { text?: string } | undefined)?.text).toBe(GOAL);
    const ended = eventsB.at(-1)!;
    expect(ended.kind).toBe('session.ended');
    expect((ended.data as { reason?: string }).reason).toBe('completed');

    // The pair is HOST-written (actor system), metadata-only, and keyed to the
    // run: nodeId/agent/graphId on start; ok + measured durationMs on end.
    const started = eventsB.find((e) => e.kind === 'graph.node_started')!;
    const nodeEnded = eventsB.find((e) => e.kind === 'graph.node_ended')!;
    expect(started.actor.type).toBe('system');
    expect(started.data).toEqual({ nodeId: 'g1', agent: 'general', graphId: 'graph-w1' });
    expect(nodeEnded.actor.type).toBe('system');
    const endData = nodeEnded.data as { ok?: boolean; cancelled?: boolean; durationMs?: number };
    expect(endData.ok).toBe(true);
    expect(endData.cancelled).toBeUndefined();
    expect(typeof endData.durationMs).toBe('number');
    // …ordered started → ended → session.ended, inside the run.
    expect(eventsB.indexOf(started)).toBeLessThan(eventsB.indexOf(nodeEnded));
    expect(eventsB.indexOf(nodeEnded)).toBeLessThan(eventsB.indexOf(ended));

    // Explicit negative pin (unchanged from v1): no turn-internal spine kind —
    // assistant text, tool calls/results and verification stay OFF the spine.
    const spineKinds = new Set(kindsB);
    for (const perNodeKind of ['tool.call', 'tool.result', 'tool.interrupted', 'assistant.message', 'verification.run', 'verification.evidence']) {
      expect(spineKinds.has(perNodeKind)).toBe(false);
    }
    // …and no spine payload carries the turn's MODEL content (the stub
    // conclusion and the node prompt exist only outside the spine).
    expect(JSON.stringify(eventsB)).not.toContain('STUB TURN CONCLUSION');
    expect(JSON.stringify([started, nodeEnded])).not.toContain('util.ts');

    // Cross-check: the node's events went to the executor's REAL per-node
    // channel — the kraken radio JSONL — keyed by the SAME session id the
    // spine used (correlated streams, disjoint contents).
    expect(probe.executed?.radioSessionId).toBe(path.basename(path.dirname(logB!)));
    const radio = readKrakenRadio(tmp, probe.executed!.radioSessionId!);
    expect(radio.map((e) => e.kind)).toEqual(expect.arrayContaining(['node_start', 'node_end']));
    const nodeEnd = radio.find((e) => e.kind === 'node_end');
    expect(nodeEnd?.nodeId).toBe('g1');
    expect(nodeEnd?.ok).toBe(true);
    expect(nodeEnd?.detail).toContain('assistant');
  }, 30_000);
});
