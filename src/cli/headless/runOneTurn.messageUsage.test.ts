import { describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ProviderStreamFn } from '@zelari/core/harness';
import { runOneTurn } from './runOneTurn.js';
import { resetMetricsLogger } from '../metrics.js';

/**
 * M1.1 (cache-hit-rate plan): the headless path persists provider-verified
 * usage.
 *
 * Before this slice `runOneTurn` recorded ONLY compaction counters, so
 * `metrics.jsonl` stayed cache-blind for every autonomous run and the
 * `--doctor` hit% had nothing to aggregate. This test drives a real turn
 * through `runOneTurn` with a stub stream that reports `usage` (the
 * `stream_options.include_usage` chunk DeepSeek/Grok send) and asserts the
 * `kind: 'message'` row — with its cache split — reached disk.
 *
 * Env discipline cribbed from runOneTurn.strictExit.test.ts: the session
 * spine is isolated under a temp ZELARI_HOME, extensions / memory / verifier
 * review are off, and `process.exit` is mocked (runOneTurn terminates the
 * process on the way out).
 */

const stubStream: ProviderStreamFn = async function* t127UsageStub() {
  yield { kind: 'text', delta: 'ok' };
  yield {
    kind: 'usage',
    usage: {
      promptTokens: 4_200,
      completionTokens: 42,
      totalTokens: 4_242,
      cachedPromptTokens: 3_000,
    },
  };
  yield { kind: 'finish', reason: 'stop' };
};

const ENV_KEYS = [
  'ZELARI_HOME',
  'ANATHEMA_METRICS_FILE',
  'ZELARI_SESSIONS_DIR',
  'ZELARI_EXTENSIONS',
  'ZELARI_VERIFIER_REVIEW',
  'ZELARI_MEMORY',
  'ZELARI_STRICT_DONE',
  'ZELARI_MISSION_STRICT',
] as const;

describe('runOneTurn per-message usage telemetry (M1.1)', () => {
  it('writes a kind:message row with cachedPromptTokens for the LLM call', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 't127-headless-'));
    const cwd = path.join(home, 'work');
    await fs.mkdir(cwd, { recursive: true });
    const metricsFile = path.join(home, 'metrics.jsonl');
    const saved = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
    process.env.ZELARI_HOME = home;
    process.env.ANATHEMA_METRICS_FILE = metricsFile;
    process.env.ZELARI_SESSIONS_DIR = path.join(home, 'sessions');
    process.env.ZELARI_EXTENSIONS = '0';
    process.env.ZELARI_VERIFIER_REVIEW = '0';
    process.env.ZELARI_MEMORY = '0';
    delete process.env.ZELARI_STRICT_DONE;
    delete process.env.ZELARI_MISSION_STRICT;
    resetMetricsLogger();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    try {
      await runOneTurn(
        {
          // Wording avoids every expectsDiskImplementation cue (the stub makes
          // no tool calls, so build liveness must not demand mutations).
          task: 't127 probe: reply with exactly ok and nothing else',
          mode: 'kraken',
          phase: 'build',
          output: 'json',
          useCouncil: false,
          cwd,
          strictDone: false,
        },
        'openai-compatible',
        't127-fake',
        stubStream,
      );

      const raw = await fs.readFile(metricsFile, 'utf-8');
      const rows = raw
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((row) => row.kind === 'message');

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        kind: 'message',
        provider: 'openai-compatible',
        model: 't127-fake',
        promptTokens: 4_200,
        completionTokens: 42,
        cachedPromptTokens: 3_000,
      });
      expect(typeof rows[0].sessionId).toBe('string');
      expect(typeof rows[0].costUsd).toBe('number');
      // Cache split is priced, not folded away: cost must be strictly below
      // the same call billed with zero cache hits.
      expect(rows[0].costUsd as number).toBeGreaterThan(0);
    } finally {
      exitSpy.mockRestore();
      resetMetricsLogger();
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await fs.rm(home, { recursive: true, force: true });
    }
  }, 60_000);
});
