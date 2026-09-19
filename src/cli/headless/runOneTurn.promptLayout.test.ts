/**
 * M2.1 (cache-hit-rate plan) — request layout on the WIRE + ephemeral invariant.
 *
 * Three contracts are pinned here, in-process (injected provider stream, no
 * spawn, no live keys — same seam discipline as runOneTurn.harnessState.test.ts):
 *
 *  1. LAYOUT: the default (`ZELARI_PROMPT_LAYOUT` unset) request body is
 *     `[stable system][history][<context-update>…volatile…][task]`. The stable
 *     prefix carries no workspace data, so a workspace/RAG change busts only the
 *     request tail instead of the cacheable system prefix.
 *  2. EPHEMERAL: the trailing context exists ONLY in the provider request. It
 *     must never be written to the session spine (`events.jsonl`) nor to the
 *     seeded history — otherwise the volatile context would re-enter the next
 *     turn's transcript and duplicate on every turn.
 *  3. ROLLBACK: `ZELARI_PROMPT_LAYOUT=legacy` restores the pre-M2 body
 *     `[stable, volatile system][history][task]`.
 *
 * Env discipline cribbed from runOneTurn.strictExit.test.ts: sessions isolated
 * under a temp dir, extensions / memory / verifier review off, `process.exit`
 * mocked (runOneTurn terminates the process on the way out).
 */
import { describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ProviderStreamFn } from '@zelari/core/harness';
import { resetPromptLayoutCache } from '@zelari/core/skills';
import { runOneTurn } from './runOneTurn.js';

// Task wording avoids EVERY expectsDiskImplementation cue: the stub makes no
// tool calls, so build liveness must not demand disk mutations.
const TASK = 'layout probe: reply with exactly ok and nothing else';

const ENV_KEYS = [
  'ZELARI_HOME',
  'ANATHEMA_METRICS_FILE',
  'ZELARI_SESSIONS_DIR',
  'ZELARI_EXTENSIONS',
  'ZELARI_VERIFIER_REVIEW',
  'ZELARI_MEMORY',
  'ZELARI_STRICT_DONE',
  'ZELARI_MISSION_STRICT',
  'ZELARI_PROMPT_LAYOUT',
] as const;

interface WireMessage {
  role: string;
  content: string;
}

interface Probe {
  wire: WireMessage[];
  events: string;
  trailing: WireMessage[];
}

/**
 * Run one headless turn in an isolated temp workspace and report both what the
 * provider received (the HTTP body seed) and what the session spine persisted.
 */
async function runProbe(options: {
  sessionId: string;
  /** Omitted ⇒ default layout (trailing); 'legacy' ⇒ pre-M2 rollback shape. */
  layout?: 'legacy';
}): Promise<Probe> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'm21-layout-'));
  const cwd = path.join(home, 'work');
  await fs.mkdir(cwd, { recursive: true });
  const sessionsDir = path.join(home, 'sessions');
  const saved = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.ZELARI_HOME = home;
  process.env.ANATHEMA_METRICS_FILE = path.join(home, 'metrics.jsonl');
  process.env.ZELARI_SESSIONS_DIR = sessionsDir;
  process.env.ZELARI_EXTENSIONS = '0';
  process.env.ZELARI_VERIFIER_REVIEW = '0';
  process.env.ZELARI_MEMORY = '0';
  delete process.env.ZELARI_STRICT_DONE;
  delete process.env.ZELARI_MISSION_STRICT;
  if (options.layout) process.env.ZELARI_PROMPT_LAYOUT = options.layout;
  else delete process.env.ZELARI_PROMPT_LAYOUT;
  // The layout is resolved once per process: forget the memo so this scenario
  // re-reads the env it just set.
  resetPromptLayoutCache();
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

  const wire: WireMessage[] = [];
  const stubStream: ProviderStreamFn = async function* layoutProbeStub(params) {
    for (const m of params.messages) {
      wire.push({ role: m.role, content: typeof m.content === 'string' ? m.content : '' });
    }
    yield { kind: 'text', delta: 'ok' };
    yield { kind: 'finish', reason: 'stop' };
  };

  try {
    await runOneTurn(
      {
        task: TASK,
        mode: 'kraken',
        phase: 'build',
        output: 'json',
        useCouncil: false,
        cwd,
        strictDone: false,
        resumeSessionId: options.sessionId,
      },
      'openai-compatible',
      'layout-fake',
      stubStream,
    );
    const eventsPath = path.join(sessionsDir, options.sessionId, 'events.jsonl');
    const events = await fs.readFile(eventsPath, 'utf8');
    return { wire, events, trailing: wire.filter((m) => m.content.includes('<context-update>')) };
  } finally {
    exitSpy.mockRestore();
    for (const key of ENV_KEYS) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetPromptLayoutCache();
    await fs.rm(home, { recursive: true, force: true }).catch(() => undefined);
  }
}

describe('runOneTurn — M2.1 cache-first request layout (ephemeral trailing context)', () => {
  it('default: [stable system][trailing context][task], trailing never on the spine', async () => {
    const { wire, events, trailing } = await runProbe({ sessionId: 'm21-layout-probe' });

    // ── Layout on the wire ──────────────────────────────────────────────
    expect(wire.length).toBeGreaterThanOrEqual(2);
    expect(wire[0]!.role).toBe('system');
    // The stable prefix is workspace-free: no volatile data, no trailing tag.
    expect(wire[0]!.content).not.toContain('<context-update>');
    expect(wire[0]!.content).not.toContain('# Project:');

    // Exactly ONE ephemeral trailing message, carrying the volatile payload
    // (the workspace summary names the temp cwd)…
    expect(trailing).toHaveLength(1);
    expect(trailing[0]!.content.startsWith('<context-update>')).toBe(true);
    expect(trailing[0]!.content.endsWith('</context-update>')).toBe(true);
    expect(trailing[0]!.content).toContain('# Project:');
    // …immediately before the new turn (i.e. AFTER the history).
    const trailingIdx = wire.indexOf(trailing[0]!);
    expect(trailingIdx).toBeGreaterThan(0);
    expect(wire[trailingIdx + 1]!.role).toBe('user');

    // ── Ephemeral invariant: nothing on the spine ───────────────────────
    expect(events.length).toBeGreaterThan(0);
    // The trailing is a request-build artifact only: the event log holds
    // neither the tag nor the payload it carried.
    expect(events).not.toContain('<context-update>');
    expect(events).not.toContain('</context-update>');
    expect(events).not.toContain(trailing[0]!.content);
    // The volatile PAYLOAD is ephemeral too — not just the tag that wraps it:
    // the budget/measurement pipeline fingerprints the system surface but must
    // not dump the workspace summary into the event log.
    expect(events).not.toContain('# Project:');
    // Sanity: the turn itself WAS persisted (so the absence above is real).
    expect(events).toContain(TASK);
  }, 30_000);

  it('ZELARI_PROMPT_LAYOUT=legacy restores [stable, volatile] pre-history', async () => {
    const { wire, trailing } = await runProbe({
      sessionId: 'm21-layout-legacy',
      layout: 'legacy',
    });

    // Pre-M2 shape: two system messages, volatile SECOND, before the history.
    expect(wire[0]!.role).toBe('system');
    expect(wire[1]!.role).toBe('system');
    expect(wire[0]!.content).not.toContain('# Project:');
    expect(wire[1]!.content).toContain('# Project:');
    // No ephemeral trailing message exists in the rollback layout.
    expect(trailing).toHaveLength(0);
  }, 30_000);
});
