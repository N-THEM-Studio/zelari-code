import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readMetrics, resetMetricsLogger } from '../metrics.js';
import { calculateCost } from '../modelPricing.js';
import { flushMessageUsage, recordMessageUsage } from './messageUsage.js';

/**
 * M1.1 (cache-hit-rate plan): the `kind: 'message'` writer.
 *
 * The row is the ONLY place the provider-verified cache split is persisted —
 * `/cache stats` is in-memory and `events.jsonl` drops usage on message_end —
 * so these tests pin the durable contract `--doctor` aggregates from.
 */

const dirs: string[] = [];

function tempMetricsFile(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'metrics-messageUsage-'));
  dirs.push(dir);
  const file = path.join(dir, 'metrics.jsonl');
  const saved = process.env.ANATHEMA_METRICS_FILE;
  process.env.ANATHEMA_METRICS_FILE = file;
  resetMetricsLogger();
  return file;
}

afterEach(() => {
  delete process.env.ANATHEMA_METRICS_FILE;
  resetMetricsLogger();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('recordMessageUsage', () => {
  it('persists kind:message with the provider-verified cache split and cache-aware cost', async () => {
    const file = tempMetricsFile();
    recordMessageUsage({
      sessionId: 'sess-1',
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
      promptTokens: 1_000_000,
      completionTokens: 0,
      cachedPromptTokens: 1_000_000,
      ts: 1_700_000_000_000,
    });
    await flushMessageUsage();

    const [record] = await readMetrics(file);
    expect(record).toMatchObject({
      kind: 'message',
      ts: 1_700_000_000_000,
      sessionId: 'sess-1',
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
      promptTokens: 1_000_000,
      completionTokens: 0,
      cachedPromptTokens: 1_000_000,
      // 1M cached prompt tokens at the cache-read rate — NOT the miss rate.
      costUsd: 0.003625,
    });
    expect(record.costUsd).toBeLessThan(
      calculateCost('deepseek-v4-pro', 1_000_000, 0, 0),
    );
  });

  it('clamps cachedPromptTokens to promptTokens so hit% can never exceed 100', async () => {
    const file = tempMetricsFile();
    recordMessageUsage({
      provider: 'grok',
      model: 'grok-4.5',
      promptTokens: 100,
      completionTokens: 5,
      cachedPromptTokens: 9_999,
    });
    await flushMessageUsage();

    const [record] = await readMetrics(file);
    expect(record).toMatchObject({ promptTokens: 100, cachedPromptTokens: 100 });
  });

  it('coerces absent / NaN / negative counters to 0 and omits unknown identity keys', async () => {
    const file = tempMetricsFile();
    recordMessageUsage({ promptTokens: Number.NaN, completionTokens: -3 });
    recordMessageUsage({ promptTokens: 10, cachedPromptTokens: undefined });
    await flushMessageUsage();

    const records = await readMetrics(file);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      kind: 'message',
      promptTokens: 0,
      completionTokens: 0,
      cachedPromptTokens: 0,
      costUsd: 0,
    });
    // Absent identity is omitted rather than persisted as an empty string —
    // an empty provider would invent a phantom row in the doctor report.
    expect(records[0]).not.toHaveProperty('provider');
    expect(records[0]).not.toHaveProperty('model');
    expect(records[0]).not.toHaveProperty('sessionId');
    expect(records[1]).toMatchObject({ promptTokens: 10, cachedPromptTokens: 0 });
  });

  it('stamps ts with the current time when no override is given', async () => {
    const file = tempMetricsFile();
    const before = Date.now();
    recordMessageUsage({ promptTokens: 5 });
    await flushMessageUsage();

    const [record] = await readMetrics(file);
    expect(typeof record.ts).toBe('number');
    expect(record.ts).toBeGreaterThanOrEqual(before);
  });

  it('never throws when the metrics sink is unwritable', () => {
    // A *file* where the metrics directory should be makes MetricsLogger's
    // mkdirSync throw synchronously — the writer must swallow it (telemetry
    // never breaks a turn).
    const dir = mkdtempSync(path.join(tmpdir(), 'metrics-messageUsage-blocked-'));
    dirs.push(dir);
    const blocker = path.join(dir, 'not-a-dir');
    writeFileSync(blocker, 'x');
    process.env.ANATHEMA_METRICS_FILE = path.join(blocker, 'metrics.jsonl');
    resetMetricsLogger();
    expect(() => recordMessageUsage({ promptTokens: 1, model: 'grok-4.5' })).not.toThrow();
  });
});
