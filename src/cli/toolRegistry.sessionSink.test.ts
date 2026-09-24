/**
 * WS7 slice 4b (t139) — `ToolContext.emitSessionEvent` is LIVE on the real host
 * path, proved end to end.
 *
 * COVERED: the production dispatch shape itself. The tests below build the REAL
 * CLI registry (`createBuiltinToolRegistry` + `sessionEventSink`), hand it to a
 * REAL `AgentHarness`, and drive an actual turn with a fake provider stream
 * emitting one native `tool_call`. That is precisely the hop the seam died on —
 * host → `AgentHarness` → `registry.invoke(name, args, { cwd, sessionId, signal })`
 * (AgentHarness.ts:839/1848) → `ToolContext` → tool body (or permission gate) —
 * and it is where the events must land: ADR-0033 `file.read` and WS1
 * `permission.denied`, on a REAL `SessionLogWriter`, visible through
 * `readSessionLog` + `buildProjection`.
 *
 * ASSUMED (stated, not hidden): the two hosts obtain that sink from
 * `spineSessionSink(spine)` (TUI `useChatTurn` dispatchPrompt) or
 * `lateSessionSink(holder)` + `spineSessionSink` (headless `runOneTurn`) — the
 * same helpers used here. Driving a whole TUI turn (React/Ink) or a whole
 * headless run (keys, network) is out of scope for a unit suite; what is
 * asserted here is that the object those hosts hand over really does make the
 * seam live.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { AgentHarness, type ProviderDelta, type ProviderStreamFn } from '@zelari/core/harness';
import { ToolRegistry } from '@zelari/core/harness/tools/registry';
import { SessionLogWriter, buildProjection, readSessionLog } from '@zelari/core/session';
import type { SessionEventInput } from '@zelari/core/session';
import { AuditLogger } from './safety/auditLogger.js';
import { PERMISSION_DENIED_KIND } from './safety/permissionGate.js';
import {
  clearSessionPermissionGrants,
  type PermissionPolicy,
} from './safety/toolPermissions.js';
import { lateSessionSink, spineSessionSink, withSessionEventSink } from './safety/sessionSink.js';
import { createBuiltinToolRegistry } from './toolRegistry.js';

let root: string;
let writer: SessionLogWriter;

/** Provider fake: each call emits the deltas of script[callIndex]. */
function fakeStream(script: ProviderDelta[][]): ProviderStreamFn {
  let call = 0;
  return async function* (): AsyncIterable<ProviderDelta> {
    const seq = script[Math.min(call, script.length - 1)]!;
    call++;
    for (const d of seq) yield d;
  };
}

/** One turn, one native tool call, then a clean stop. */
function oneToolCall(name: string, args: Record<string, unknown>): ProviderStreamFn {
  return fakeStream([
    [
      { kind: 'tool_call', toolCallId: 't1', toolName: name, args },
      { kind: 'finish', reason: 'tool_calls' },
    ],
    [{ kind: 'finish', reason: 'stop' }],
  ]);
}

async function runTurn(
  registry: ToolRegistry,
  name: string,
  args: Record<string, unknown>,
): Promise<Array<{ type: string; [k: string]: unknown }>> {
  const harness = new AgentHarness({
    model: 'test-model',
    provider: 'test',
    sessionId: 'ws7-slice4b-sink',
    messages: [{ role: 'user', content: 'go' }],
    tools: [],
    toolRegistry: registry,
    providerStream: oneToolCall(name, args),
    cwd: root,
  });
  const events: Array<{ type: string; [k: string]: unknown }> = [];
  for await (const ev of harness.run()) events.push(ev as unknown as { type: string });
  return events;
}

function toolEnds(events: Array<{ type: string; [k: string]: unknown }>) {
  return events.filter((e) => e.type === 'tool_execution_end');
}

function allowAll(): PermissionPolicy {
  return { read: 'allow', write: 'allow', execute: 'allow', network: 'allow', ui: 'allow', auto: true };
}

/** The host binding: the spine writer the turn already owns → tool sink. */
function spine() {
  return { appendEvent: (input: SessionEventInput) => writer.append(input) };
}

function makeRegistry(
  sessionEventSink?: ReturnType<typeof spineSessionSink>,
  policy: ReturnType<typeof allowAll> = allowAll(),
) {
  const { registry } = createBuiltinToolRegistry({
    root,
    audit: new AuditLogger(path.join(root, 'audit.jsonl')),
    sessionId: 'ws7-slice4b-sink',
    profile: 'full',
    enableTask: false,
    enableSkill: false,
    diagnostics: false,
    lspProvider: null,
    permissionPolicy: policy,
    ...(sessionEventSink ? { sessionEventSink } : {}),
  });
  return registry;
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'zelari-ws7-slice4b-'));
  await fs.mkdir(path.join(root, 'secrets'), { recursive: true });
  await fs.writeFile(path.join(root, 'f.ts'), 'const hello = 1;\n', 'utf-8');
  await fs.writeFile(path.join(root, 'secrets', 'key.pem'), 'old', 'utf-8');
  writer = await SessionLogWriter.open(path.join(root, 'session'), 'ws7-slice4b-sink', 1);
  clearSessionPermissionGrants();
});

afterEach(async () => {
  await writer.close();
  await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe('WS7 slice 4b — the tool-side session sink is live under the real harness', () => {
  it('a real turn: read_file lands file.read on the spine and buildProjection exposes it', async () => {
    const registry = makeRegistry(spineSessionSink(spine()));

    const events = await runTurn(registry, 'read_file', { path: 'f.ts', maxBytes: 1_000_000 });
    // The tool really ran through the harness (not a synthesized denial).
    const end = toolEnds(events).find((e) => String(e.result).includes('const hello = 1;'));
    expect(end, JSON.stringify(toolEnds(events))).toBeDefined();
    expect(end!.isError).toBe(false);

    const report = await readSessionLog(writer.path);
    expect(report.ok).toBe(true);
    const reads = report.events.filter((e) => e.kind === 'file.read');
    expect(reads).toHaveLength(1);
    expect(reads[0]?.data.path).toBe(path.join(root, 'f.ts'));
    expect(reads[0]?.data.snapshotId).toBeTypeOf('string');
    // Writer-assigned seq: the sink returned the writer's own anchor.
    expect(reads[0]?.seq).toBeGreaterThan(0);

    const projection = buildProjection(report.events, report.issues);
    expect(projection.eventCount).toBe(1);
    expect(projection.issues).toEqual([]);
  });

  it('a real turn: a category DENY lands permission.denied (before the tool body)', async () => {
    // ADR-0039 P3b: engine A (permissions.json rules) is gone — the deny now
    // comes from the category policy itself, and the spine event names THAT
    // deciding layer (`default`), with no matched rule id.
    const registry = makeRegistry(spineSessionSink(spine()), { ...allowAll(), write: 'deny' });

    const events = await runTurn(registry, 'write_file', { path: 'secrets/key.pem', content: 'x' });
    const end = toolEnds(events)[0];
    // Model-visible denial from the category policy…
    expect(end?.isError).toBe(true);
    expect(String(end?.result)).toContain('[permission]');
    // …and the file was never touched.
    expect(await fs.readFile(path.join(root, 'secrets', 'key.pem'), 'utf-8')).toBe('old');

    const report = await readSessionLog(writer.path);
    const denials = report.events.filter((e) => e.kind === PERMISSION_DENIED_KIND);
    expect(denials).toHaveLength(1);
    expect(denials[0]?.data).toMatchObject({
      tool: 'write_file',
      matchedRuleId: '',
      source: 'default',
    });
    const projection = buildProjection(report.events, report.issues);
    expect(projection.permissionDenials?.map((d) => d.matchedRuleId)).toEqual(['']);
  });

  it('ADDITIVE-OPTIONAL: the same turn without a sink emits nothing and is otherwise identical', async () => {
    const registry = makeRegistry();

    const events = await runTurn(registry, 'read_file', { path: 'f.ts', maxBytes: 1_000_000 });
    const end = toolEnds(events).find((e) => String(e.result).includes('const hello = 1;'));
    expect(end, JSON.stringify(toolEnds(events))).toBeDefined();
    expect(end!.isError).toBe(false);

    const report = await readSessionLog(writer.path);
    expect(report.events).toEqual([]);
  });

  it('the late-bound variant resolves to silence until the spine opens, then emits', async () => {
    const holder = { current: undefined as ReturnType<typeof spineSessionSink> | undefined };
    const sink = lateSessionSink(holder);
    const registry = makeRegistry(sink);

    // Before binding: the tool runs, nothing is recorded, nothing throws.
    await runTurn(registry, 'read_file', { path: 'f.ts', maxBytes: 1_000_000 });
    expect((await readSessionLog(writer.path)).events).toEqual([]);

    holder.current = spineSessionSink(spine());
    // A DIFFERENT file on purpose: read_file is wrapped with the stat-keyed
    // result cache, so re-reading f.ts would be served from cache and never
    // re-enter the tool body (no body ⇒ no telemetry, by design).
    await fs.writeFile(path.join(root, 'g.ts'), 'const later = 2;\n', 'utf-8');
    await runTurn(registry, 'read_file', { path: 'g.ts', maxBytes: 1_000_000 });
    const kinds = (await readSessionLog(writer.path)).events.map((e) => e.kind);
    expect(kinds).toEqual(['file.read']);
  });

  it('the decorator never overwrites a sink the ctx already carries', async () => {
    const seen: SessionEventInput[] = [];
    const own: SessionEventInput[] = [];
    const decorated = withSessionEventSink(
      {
        name: 'probe',
        description: 'probe',
        permissions: [],
        inputSchema: z.object({}),
        execute: async (_input: Record<string, never>, ctx) => {
          await ctx.emitSessionEvent?.({ kind: 'note', actor: { type: 'system' }, data: {} });
          return { ok: true, value: 'probe' } as const;
        },
      },
      async (input) => {
        seen.push(input);
      },
    );
    const res = await decorated.execute(
      {},
      {
        signal: new AbortController().signal,
        cwd: root,
        audit: () => undefined,
        sessionId: 'ws7-slice4b-sink',
        emitSessionEvent: async (input) => {
          own.push(input);
        },
      },
    );
    expect(res.ok).toBe(true);
    expect(own).toHaveLength(1);
    expect(seen).toEqual([]);
  });
});

describe('WS7 slice 4b — the core InvokeOptions seam (additive, optional)', () => {
  function probeRegistry(seen: string[]): ToolRegistry {
    const registry = new ToolRegistry();
    registry.register({
      name: 'probe',
      description: 'probe',
      permissions: [],
      inputSchema: z.object({}),
      execute: async (_input: Record<string, never>, ctx) => {
        seen.push(ctx.emitSessionEvent ? 'sink' : 'no-sink');
        return { ok: true, value: ctx.emitSessionEvent ? 'sink' : 'no-sink' };
      },
    });
    return registry;
  }

  it('invoke({ emitSessionEvent }) populates ToolContext; without it the ctx is unchanged', async () => {
    const seen: string[] = [];
    const registry = probeRegistry(seen);

    const withSink = await registry.invoke<string>('probe', {}, {
      cwd: root,
      sessionId: 'ws7-slice4b-sink',
      emitSessionEvent: async () => ({ seq: 1 }),
    });
    expect(withSink.ok).toBe(true);
    if (withSink.ok) expect(withSink.value).toBe('sink');

    const without = await registry.invoke<string>('probe', {}, {
      cwd: root,
      sessionId: 'ws7-slice4b-sink',
    });
    expect(without.ok).toBe(true);
    if (without.ok) expect(without.value).toBe('no-sink');

    expect(seen).toEqual(['sink', 'no-sink']);
  });
});
