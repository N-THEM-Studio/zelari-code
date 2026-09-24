/**
 * Token audit — render the REAL requests a Kraken turn sends, without a model.
 *
 * Opt-in (`ZELARI_TOKEN_AUDIT=1`), so it never runs in CI. It drives one
 * headless turn in-process with a capturing provider stream: the lead reads a
 * file, delegates one explore tentacle, then answers. Every request the
 * provider would have received (lead turns AND the tentacle, which shares the
 * stream when the provider matches) is written as JSON to
 * `ZELARI_TOKEN_AUDIT_OUT` (default: os.tmpdir()/zelari-token-audit) for
 * `tools/token-audit/analyze.mjs`.
 *
 * Isolation: sessions, memory and ZELARI_HOME are redirected to a temp dir;
 * MCP is off (`ZELARI_MCP=0`) — integration schemas are measured separately
 * by `analyze.mjs --mcp`, which lists them from the live servers.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ProviderStreamFn } from '@zelari/core/harness';
import { resetPromptLayoutCache } from '@zelari/core/skills';
import { runOneTurn } from '../../src/cli/headless/runOneTurn.js';

const enabled = process.env.ZELARI_TOKEN_AUDIT === '1';
const TASK =
  process.env.ZELARI_TOKEN_AUDIT_TASK ??
  'spiegami come funziona il merge dei worktree dei tentacoli kraken';

describe.skipIf(!enabled)('token audit — rendered requests', () => {
  it('captures lead + tentacle requests for one realistic turn', async () => {
    const outDir =
      process.env.ZELARI_TOKEN_AUDIT_OUT ?? path.join(os.tmpdir(), 'zelari-token-audit');
    await fs.mkdir(outDir, { recursive: true });
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'zelari-token-audit-home-'));
    const env: Record<string, string> = {
      ZELARI_HOME: home,
      ANATHEMA_METRICS_FILE: path.join(home, 'metrics.jsonl'),
      ZELARI_SESSIONS_DIR: path.join(home, 'sessions'),
      ZELARI_EXTENSIONS: '0',
      ZELARI_VERIFIER_REVIEW: '0',
      ZELARI_MEMORY: '0',
      ZELARI_MEMORY_V2: '0',
      ZELARI_MCP: '0',
      ZELARI_KRAKEN_WORKTREE: '0',
      ZELARI_STRICT_DONE: '0',
    };
    const saved = new Map(Object.keys(env).map((k) => [k, process.env[k]]));
    Object.assign(process.env, env);
    resetPromptLayoutCache();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    const captured: Array<{ index: number; role: 'lead' | 'tentacle'; params: unknown }> = [];
    let leadSystem: string | null = null;
    let leadCalls = 0;
    let finish: () => void = () => {};
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const stub: ProviderStreamFn = async function* auditStub(params) {
      const system = params.messages.find((m) => m.role === 'system');
      const systemText = typeof system?.content === 'string' ? system.content : '';
      if (leadSystem === null) leadSystem = systemText;
      const role = systemText === leadSystem ? 'lead' : 'tentacle';
      const entry = {
        index: captured.length,
        role,
        params: { model: params.model, provider: params.provider, messages: params.messages, tools: params.tools },
      } as const;
      captured.push(entry);
      await fs.writeFile(
        path.join(outDir, `request-${String(entry.index).padStart(2, '0')}-${role}.json`),
        JSON.stringify(entry.params, null, 1),
      );
      if (role === 'tentacle') {
        yield { kind: 'text', delta: 'Findings: worktrees are merged back by the task tool.' };
        yield { kind: 'finish', reason: 'stop' };
        return;
      }
      leadCalls += 1;
      if (leadCalls === 1) {
        yield { kind: 'tool_call', toolCallId: 'probe-read', toolName: 'read_file', args: { path: 'AGENTS.MD' } };
        yield { kind: 'finish', reason: 'tool_calls' };
      } else if (leadCalls === 2) {
        yield {
          kind: 'tool_call',
          toolCallId: 'probe-task',
          toolName: 'task',
          args: {
            agent: 'explore',
            thoroughness: 'quick',
            description: 'find the worktree merge code',
            prompt: 'Find where Kraken merges a tentacle worktree back into the parent tree.',
          },
        };
        yield { kind: 'finish', reason: 'tool_calls' };
      } else {
        // The consumer stops reading after `finish`, so signal first: the
        // captures are complete once this last lead request is recorded.
        setTimeout(finish, 500);
        yield { kind: 'text', delta: 'Il merge avviene nel task tool.' };
        yield { kind: 'finish', reason: 'stop' };
      }
    };

    try {
      const turn = runOneTurn(
        {
          task: TASK,
          mode: 'kraken',
          phase: 'build',
          output: 'json',
          useCouncil: false,
          cwd: process.cwd(),
          strictDone: false,
        },
        'openai-compatible',
        'token-audit-probe',
        stub,
      );
      await Promise.race([turn, done]);
    } finally {
      exitSpy.mockRestore();
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      resetPromptLayoutCache();
      await fs.rm(home, { recursive: true, force: true }).catch(() => undefined);
    }

    expect(captured.some((c) => c.role === 'lead')).toBe(true);
  }, 120_000);
});
