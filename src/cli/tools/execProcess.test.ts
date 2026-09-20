/**
 * exec_process (P0.C2 / t17) — real structured execution WITHOUT a shell,
 * workspace cwd sandbox, timeout kill, policy denial through the SAME
 * permission choke-point as every other registered tool, and the evidence
 * trail (audit entry carrying program + argv + exitCode).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import type { ToolContext } from '@zelari/core/harness/tools/toolTypes';
import {
  SESSION_SCHEMA_VERSION,
  buildProjection,
  decisionPayloadError,
  type SessionEventEnvelope,
  type SessionEventInput,
} from '@zelari/core/session';
import { AuditLogger } from '../safety/auditLogger.js';
import { setJailBackendForTests } from '../safety/osJail.js';
import { clearSessionPermissionGrants, type PermissionPolicy } from '../safety/toolPermissions.js';
import { resourceClaimsFor } from '../safety/resourceClaims.js';
import { createExecProcessTool } from './execProcess.js';
import { createBuiltinToolRegistry } from '../toolRegistry.js';

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(tmpdir(), 'zelari-execproc-'));
}
function tmpHome(): string {
  return fs.mkdtempSync(path.join(tmpdir(), 'zelari-execproc-home-'));
}
function writePolicyFile(root: string, content: unknown): void {
  fs.mkdirSync(path.join(root, '.zelari'), { recursive: true });
  fs.writeFileSync(path.join(root, '.zelari', 'policy.json'), JSON.stringify(content, null, 2));
}
function allowAll(): PermissionPolicy {
  return { read: 'allow', write: 'allow', execute: 'allow', network: 'allow', ui: 'allow', auto: true };
}
function makeCtx(cwd: string): ToolContext {
  return {
    signal: new AbortController().signal,
    cwd,
    audit: () => undefined,
    sessionId: 'exec-process-test',
  };
}

describe('exec_process execution', () => {
  const root = tmpRoot();

  it('executes a real program and returns the structured result contract', async () => {
    const tool = createExecProcessTool(root);
    const res = await tool.execute(
      { program: process.execPath, args: ['-e', 'console.log("HELLO")'] },
      makeCtx(root),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.exitCode).toBe(0);
    expect(res.value.stdout).toContain('HELLO');
    expect(res.value.stderr).toBe('');
    expect(typeof res.value.durationMs).toBe('number');
    expect(res.value.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('captures stderr and nonzero exit codes without throwing', async () => {
    const tool = createExecProcessTool(root);
    const res = await tool.execute(
      { program: process.execPath, args: ['-e', 'console.error("BOOM");process.exit(3)'] },
      makeCtx(root),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.exitCode).toBe(3);
    expect(res.value.stderr).toContain('BOOM');
  });

  it('sandbox: cwd arguments resolve inside and may not escape the workspace root', async () => {
    const tool = createExecProcessTool(root);
    fs.mkdirSync(path.join(root, 'sub', 'dir'), { recursive: true });
    const inside = await tool.execute(
      { program: process.execPath, args: ['-e', 'console.log(process.cwd())'], cwd: 'sub/dir' },
      makeCtx(root),
    );
    expect(inside.ok).toBe(true);
    if (inside.ok) {
      const normalized = inside.value.stdout.trim().toLowerCase().replace(/\\/g, '/');
      expect(normalized.startsWith(root.toLowerCase().replace(/\\/g, '/'))).toBe(true);
    }
    const outside = await tool.execute(
      { program: process.execPath, args: ['-e', ''], cwd: '..' },
      makeCtx(root),
    );
    expect(outside.ok).toBe(false);
    if (outside.ok) return;
    expect(outside.error).toContain('[sandbox]');
  });

  it('times out a hung child and reports the timeout error', async () => {
    const tool = createExecProcessTool(root);
    const res = await tool.execute(
      { program: process.execPath, args: ['-e', 'setInterval(()=>{},10000)'], timeoutMs: 250 },
      makeCtx(root),
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain('timed out after 250ms');
  }, 15_000);

  it('anti-self-kill: refuses a node-image kill BEFORE spawn, teaching the per-port alternative', async () => {
    const tool = createExecProcessTool(root);
    const res = await tool.execute(
      { program: 'taskkill', args: ['//IM', 'node.exe', '//F'] },
      makeCtx(root),
    );
    expect(res.ok).toBe(false);
    if (res.ok) return; // typed tool error — never an uncaught throw
    expect(res.error).toContain('[self-kill]');
    // The denial must teach the safe alternative: kill by PORT, never by image.
    expect(res.error).toContain('netstat');
    expect(res.error).toContain('taskkill //PID');
  });

  it('anti-self-kill: allows ordinary programs through untouched', async () => {
    const tool = createExecProcessTool(root);
    const res = await tool.execute(
      { program: 'taskkill', args: ['/?'] },
      makeCtx(root),
    );
    // Not blocked as self-kill (help text) — it fails to launch or exits,
    // but the error must NOT be a self-kill denial.
    if (!res.ok) expect(res.error).not.toContain('[self-kill]');
  });

  it('reports launch failures (missing binary) as errors, not hangs', async () => {
    const tool = createExecProcessTool(root);
    const res = await tool.execute(
      { program: 'zelari-no-such-binary-xyz-t17', timeoutMs: 5000 },
      makeCtx(root),
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.toLowerCase()).toMatch(/launch|enoent/);
  });

  it('argv array reaches the OS verbatim (quotes are NOT parsed)', async () => {
    const tool = createExecProcessTool(root);
    // A single argv element containing spaces + $ must survive intact —
    // through a shell this would explode or expand.
    const res = await tool.execute(
      { program: process.execPath, args: ['-e', 'console.log(JSON.stringify(process.argv.slice(1)))', 'a b && rm -rf $HOME | cat'] },
      makeCtx(root),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.stdout.trim()).toBe('["a b && rm -rf $HOME | cat"]');
  });
});

// ── Registry integration: exposure, policy deny, evidence ──────────────────

function makeRegistry(root: string, audit: AuditLogger, policyAgent?: string) {
  return createBuiltinToolRegistry({
    root,
    audit,
    sessionId: 'exec-process-test',
    profile: 'general',
    enableTask: false,
    enableSkill: false,
    diagnostics: false,
    lspProvider: null,
    permissionPolicy: allowAll(),
    ...(policyAgent ? { policyAgent } : {}),
  });
}

describe('exec_process through the registry', () => {
  beforeEach(() => {
    clearSessionPermissionGrants();
  });

  it('claim table sees the invocation the same way the OS will', () => {
    expect(resourceClaimsFor('exec_process', { program: 'node', args: ['-e', 'x'] })).toEqual([
      { kind: 'process', executable: 'node', argv: ['-e', 'x'] },
    ]);
  });

  it('policy denies the call BEFORE any process starts (v2 process-claim rule)', async () => {
    const dir = tmpRoot();
    writePolicyFile(dir, {
      version: 2,
      agents: {
        general: { claims: [{ kind: 'process', pattern: 'node -e*', effect: 'deny', reason: 'no inline eval' }] },
      },
    });
    const { registry } = makeRegistry(dir, new AuditLogger(path.join(tmpdir(), `ex-${Date.now()}.log`)), 'general');
    const tool = registry.get('exec_process');
    if (!tool) throw new Error('exec_process not registered');
    const res = (await tool.execute(
      { program: 'node', args: ['-e', 'console.log("should never run")'] } as never,
      makeCtx(dir),
    )) as { ok: boolean; error?: string };
    expect(res.ok).toBe(false);
    expect(res.error).toContain('[permission]');
    expect(res.error).toContain('node -e*');
  });

  it('positive control: allowed config really executes via the registry', async () => {
    const dir = tmpRoot();
    writePolicyFile(dir, {
      version: 2,
      agents: { general: { claims: [{ kind: 'process', pattern: 'node*', effect: 'allow' }] } },
    });
    const { registry } = makeRegistry(dir, new AuditLogger(path.join(tmpdir(), `ex-${Date.now()}.log`)), 'general');
    const tool = registry.get('exec_process');
    if (!tool) throw new Error('exec_process not registered');
    const res = (await tool.execute(
      { program: process.execPath, args: ['-e', 'process.stdout.write("ran")'] } as never,
      makeCtx(dir),
    )) as { ok: boolean; value?: { stdout?: string } };
    expect(res.ok).toBe(true);
    expect(res.value?.stdout).toBe('ran');
  });

  it('[PW §4] every execution lands in the audit seam with program+argv+exitCode', async () => {
    const dir = tmpRoot();
    const audit = new AuditLogger(path.join(tmpdir(), `ex-ev-${Date.now()}-${Math.random().toString(36).slice(2)}.log`));
    const { registry } = makeRegistry(dir, audit, 'general');
    const tool = registry.get('exec_process');
    if (!tool) throw new Error('exec_process not registered');
    await tool.execute(
      { program: process.execPath, args: ['-e', 'console.log(42)'] } as never,
      makeCtx(dir),
    );
    // Fire-and-forget queue: poll briefly for the JSONL line.
    let line: Record<string, unknown> | undefined;
    for (let i = 0; i < 40 && !line; i++) {
      try {
        const text = fs.readFileSync((audit as unknown as { path: string }).path, 'utf8');
        const l = text.split('\n').filter((x) => x.includes('"exec_process"')).pop();
        if (l) line = JSON.parse(l) as Record<string, unknown>;
      } catch {
        /* not flushed yet */
      }
      if (!line) await new Promise((r) => setTimeout(r, 100));
    }
    expect(line).toBeDefined();
    expect(line?.['ok']).toBe(true);
    const args = line?.['args'] as Record<string, unknown> | undefined;
    expect(typeof args?.['program']).toBe('string');
    expect(Array.isArray(args?.['args'])).toBe(true);
    const summary = String(line?.['resultSummary']);
    expect(summary).toContain(path.basename(process.execPath));
    expect(summary).toContain('exitCode=0');
  }, 20_000);
});

/**
 * WS7 slice 4 (t139) — `jail.blocked`: the OS-jail deny of a spawn is a
 * DECISION (required + no honest backend ⇒ deny, never a silent unjailed run),
 * so it lands on the session spine at the exec tool that owned the spawn.
 */
describe('WS7 slice 4 — jail.blocked on the exec_process spawn deny', () => {
  /** Honest-unavailable backend double (the win32 reality, injected). */
  const unavailable = {
    id: 'stub-jail',
    probe: () => ({ backend: 'stub-jail', available: false, reason: 'no backend in this test' }),
    wrap: () => {
      throw new Error('an unavailable backend must never wrap');
    },
  };
  const savedMode = process.env.ZELARI_OS_JAIL;

  afterEach(() => {
    setJailBackendForTests(null);
    if (savedMode === undefined) delete process.env.ZELARI_OS_JAIL;
    else process.env.ZELARI_OS_JAIL = savedMode;
  });

  function collectingCtx(
    dir: string,
    events: SessionEventInput[],
    emit?: (input: SessionEventInput) => Promise<unknown>,
  ): ToolContext {
    return {
      ...makeCtx(dir),
      emitSessionEvent:
        emit ?? (async (input) => { events.push(input); return { seq: events.length }; }),
    };
  }

  /** The emission is fire-and-forget: poll briefly, like the audit test above. */
  async function settle(events: SessionEventInput[]): Promise<void> {
    for (let i = 0; i < 20 && events.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
  }

  function envelopes(inputs: readonly SessionEventInput[]): SessionEventEnvelope[] {
    return inputs.map((input, i) => ({
      schemaVersion: SESSION_SCHEMA_VERSION,
      sessionId: 'exec-process-test',
      seq: i + 1,
      ts: 1_700_000_000_000 + i,
      kind: input.kind,
      actor: input.actor,
      data: input.data ?? {},
    }));
  }

  it('required + no backend ⇒ typed [jail] deny AND a jail.blocked decision event', async () => {
    process.env.ZELARI_OS_JAIL = 'required';
    setJailBackendForTests(unavailable);
    const dir = tmpRoot();
    const events: SessionEventInput[] = [];
    const tool = createExecProcessTool(dir);
    const res = await tool.execute(
      { program: process.execPath, args: ['-e', ''] } as never,
      collectingCtx(dir, events),
    );

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('[jail]');

    await settle(events);
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe('jail.blocked');
    expect(events[0]!.data).toMatchObject({
      tool: 'exec_process',
      backend: 'stub-jail',
      mode: 'required',
    });
    expect(String(events[0]!.data.reason)).toContain('[jail]');
    expect(decisionPayloadError('jail.blocked', events[0]!.data)).toBeNull();

    const projection = buildProjection(envelopes(events));
    expect(projection.decisionEvents.map((d) => d.kind)).toEqual(['jail.blocked']);
    expect(projection.decisionEvents[0]!.detail).toContain('stub-jail required');
  });

  it('BEST-EFFORT: a THROWING sink cannot soften the deny', async () => {
    process.env.ZELARI_OS_JAIL = 'required';
    setJailBackendForTests(unavailable);
    const dir = tmpRoot();
    const events: SessionEventInput[] = [];
    const tool = createExecProcessTool(dir);
    const res = await tool.execute(
      { program: process.execPath, args: ['-e', ''] } as never,
      collectingCtx(dir, events, () => Promise.reject(new Error('SESSION_LOG_LOCKED'))),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('[jail]');
  });

  it('advisory + no backend fails OPEN: the command runs, no jail.blocked is recorded', async () => {
    process.env.ZELARI_OS_JAIL = 'advisory';
    setJailBackendForTests(unavailable);
    const dir = tmpRoot();
    const events: SessionEventInput[] = [];
    const tool = createExecProcessTool(dir);
    const res = await tool.execute(
      { program: process.execPath, args: ['-e', 'process.stdout.write("ran")'] } as never,
      collectingCtx(dir, events),
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.stdout).toBe('ran');
    await new Promise((r) => setTimeout(r, 20));
    expect(events).toEqual([]);
  }, 20_000);
});
