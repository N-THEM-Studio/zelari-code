/**
 * budgetRuntime wiring tests (2.6 Track B, Phase 2/3 rollout):
 *  - SessionSpineMirror + BudgetRuntime count every tool.call and emit
 *    resource.snapshot at §10.4 frequency (first sight + usage delta);
 *  - deriveMessages projects the LATEST snapshot only (model surface);
 *  - protected enforcement denies non-essential tools inside the reserve
 *    zone while advisory mode lets everything through with a notice.
 */
import { describe, expect, it, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { readSessionLog, deriveMessages, resolveSessionsDir } from '@zelari/core/session';
import { SessionSpineMirror } from '../sessionSpine.js';
import { BudgetRuntime, resolveResourceEnforcement } from './budgetRuntime.js';

let tmp: string;

async function tmpDir(): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'zelari-budget-rt-'));
  return d;
}

afterEach(async () => {
  if (tmp) await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  tmp = undefined as unknown as string;
});

function brainToolStart(callId: string, tool = 'bash') {
  return { type: 'tool_execution_start', toolCallId: callId, toolName: tool, args: {} };
}

describe('BudgetRuntime (pure)', () => {
  it('emits on first sight and after every usage delta, not in between', () => {
    const rt = new BudgetRuntime('kraken/v1');
    expect(rt.noteToolCall()).not.toBeNull(); // first sight
    // No usage delta between two current() reads — but each tool call IS a delta.
    const second = rt.noteToolCall();
    expect(second).not.toBeNull();
    expect(second!.toolCallsUsed).toBe(2);
    expect(rt.latestEmitted()?.toolCallsUsed).toBe(2);
  });

  it('stage change triggers emission (§10.4 phase change)', () => {
    const rt = new BudgetRuntime('kraken/v1');
    rt.noteToolCall();
    const onVerify = rt.noteVerificationStart();
    expect(onVerify?.stage).toBe('verify');
    expect(rt.noteRepairStart()?.stage).toBe('repair');
  });

  it('advisory mode never blocks inside the protected zone', () => {
    const rt = new BudgetRuntime('kraken/v1', { enforcement: 'advisory', policy: undefined });
    // kraken/v1 default: 40 calls, verificationReserve 6 → burn 35 to enter the zone.
    for (let i = 0; i < 35; i++) rt.noteToolCall();
    const gate = rt.gateToolCall('task');
    expect(gate.allowed).toBe(true);
    expect(gate.advisory).toBe(true);
    expect(gate.reason).toMatch(/verification reserve/i);
  });

  it('protected mode denies non-essential tools, allows verify essentials', () => {
    const rt = new BudgetRuntime('kraken/v1', { enforcement: 'protected' });
    for (let i = 0; i < 35; i++) rt.noteToolCall();
    expect(rt.gateToolCall('task').allowed).toBe(false);
    expect(rt.gateToolCall({ toolName: 'bash', args: { command: 'npm test' } }).allowed).toBe(true);
    expect(rt.gateToolCall('read_file').allowed).toBe(true);
  });

  it('outside the zone everything is allowed in both modes', () => {
    const rt = new BudgetRuntime('kraken/v1', { enforcement: 'protected' });
    rt.noteToolCall();
    expect(rt.gateToolCall('task').allowed).toBe(true);
    expect(rt.gateToolCall('task').advisory).toBe(false);
  });

  it('resolveResourceEnforcement reads the env phase selector', () => {
    expect(resolveResourceEnforcement({} as NodeJS.ProcessEnv)).toBe('advisory');
    expect(resolveResourceEnforcement({ ZELARI_RESOURCE_ENFORCEMENT: 'protected' } as unknown as NodeJS.ProcessEnv)).toBe('protected');
  });
});

describe('SessionSpineMirror × BudgetRuntime wiring', () => {
  it('counts tool.calls and appends resource.snapshot events; latest-only projects', async () => {
    tmp = await tmpDir();
    const mirror = await SessionSpineMirror.adopt('budget-rt-1', { baseDir: tmp, quiet: true });
    mirror.attachBudgetRuntime(new BudgetRuntime('kraken/v1'));
    expect(mirror.latestResourceSnapshot()).toBeNull(); // nothing emitted yet

    mirror.mirrorBrainEvent(brainToolStart('c1') as never);
    mirror.mirrorBrainEvent(brainToolStart('c2') as never);
    await mirror.flush();

    const log = path.join(resolveSessionsDir({ baseDir: tmp }), 'budget-rt-1', 'events.jsonl');
    const report = await readSessionLog(log);
    const kinds = report.events.map((e) => e.kind);
    // session.started, tool.call c1, resource.snapshot, tool.call c2, resource.snapshot, session.ended
    expect(kinds.filter((k) => k === 'tool.call')).toHaveLength(2);
    expect(kinds.filter((k) => k === 'resource.snapshot')).toHaveLength(2);

    const latest = mirror.latestResourceSnapshot();
    expect(latest?.toolCallsUsed).toBe(2);

    // Model surface: deriveMessages projects ONLY the latest snapshot.
    const derived = deriveMessages(report.events);
    const surface = derived.filter((m) => m.content.includes('RESOURCE STATUS'));
    expect(surface).toHaveLength(1);
    expect(surface[0].content).toContain('Tool calls: 2 / 40');

    await mirror.close('test-end');
  });

  it('exposes the pre-dispatch gate passthrough (null without runtime)', async () => {
    tmp = await tmpDir();
    const mirror = await SessionSpineMirror.adopt('budget-rt-2', { baseDir: tmp, quiet: true });
    expect(mirror.gateResourceToolCall('bash')).toBeNull();
    const rt = new BudgetRuntime('kraken/v1', { enforcement: 'protected' });
    for (let i = 0; i < 35; i++) rt.noteToolCall();
    mirror.attachBudgetRuntime(rt);
    const denied = mirror.gateResourceToolCall('task');
    expect(denied?.allowed).toBe(false);
    expect(denied?.reason).toMatch(/Resource protected/i);
    await mirror.close('test-end');
  });

  it('hard limit: overrun is kept real, never clamped (2.6.1 plan §9)', () => {
    const rt = new BudgetRuntime('kraken/v1');
    for (let i = 0; i < 50; i++) rt.noteToolCall();
    const snap = rt.current();
    expect(snap.toolCallsUsed).toBe(50); // real spend, NO clamp
    expect(snap.toolCallsRemaining).toBe(0);
    expect(snap.overrun).toBe(10); // 50 - 40
    // Gate denies every new billable call at the hard limit, both modes.
    const denied = rt.gateToolCall({ toolName: 'bash', args: { command: 'npm test' } });
    expect(denied.allowed).toBe(false);
    expect(denied.hardLimit).toBe(true);
    expect(denied.reason).toMatch(/budget \(maxToolCalls\) is spent|Resource exhausted/i);
  });

  it('hard-limit events: limit_reached once, then overrun (2.6.1 plan §9)', () => {
    const rt = new BudgetRuntime('kraken/v1'); // limit 40
    let limitReached = 0;
    let overrun = 0;
    for (let i = 0; i < 43; i++) {
      const effect = rt.consumeToolCall();
      if (effect.hardEvent?.kind === 'resource.limit_reached') limitReached += 1;
      if (effect.hardEvent?.kind === 'resource.overrun') overrun += 1;
    }
    expect(limitReached).toBe(1); // exactly at the crossing (call #40)
    expect(overrun).toBe(3); // calls #41, #42, #43
  });

  it('2.6.1 plan §13: bash is essential only for verification commands (argument-aware)', () => {
    const rt = new BudgetRuntime('kraken/v1', { enforcement: 'protected' });
    for (let i = 0; i < 35; i++) rt.noteToolCall(); // enter reserve zone
    expect(rt.gateToolCall({ toolName: 'bash', args: { command: 'npm test' } }).allowed).toBe(true);
    expect(rt.gateToolCall({ toolName: 'bash', args: { command: 'git diff --stat' } }).allowed).toBe(true);
    expect(rt.gateToolCall({ toolName: 'bash', args: { command: 'npm install lodash' } }).allowed).toBe(false);
    expect(rt.gateToolCall({ toolName: 'bash', args: { command: 'rm -rf node_modules && find . -name "*.tmp"' } }).allowed).toBe(false);
    expect(rt.gateToolCall('task').allowed).toBe(false);
  });

  it('2.6.1 plan §8: ZELARI_MAX_TOOL_CALLS is a policy alias, not a second limit', () => {
    vi.stubEnv('ZELARI_MAX_TOOL_CALLS', '10');
    const rt = new BudgetRuntime('kraken/v1');
    expect(rt.policy.maxToolCalls).toBe(10); // session budget rewritten
    expect(rt.current().toolCallsLimit).toBe(10); // one number everywhere
    vi.unstubAllEnvs();
    const rtDefault = new BudgetRuntime('kraken/v1');
    expect(rtDefault.policy.maxToolCalls).toBe(40); // untouched without the env
  });
});
