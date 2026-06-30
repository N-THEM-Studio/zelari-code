import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { MetricsLogger, readMetrics, METRICS_ROTATE_BYTES } from '../../src/cli/metrics.js';

describe('MetricsLogger (Task B.5.3)', () => {
  let testFile: string;

  beforeEach(() => {
    testFile = path.join(
      os.tmpdir(),
      `anathema-metrics-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jsonl`,
    );
  });

  afterEach(async () => {
    await fs.rm(testFile, { force: true });
    await fs.rm(testFile.replace(/\.jsonl$/, '.1.jsonl'), { force: true });
  });

  it('writes a single record as one JSONL line', async () => {
    const log = new MetricsLogger(testFile);
    log.record({ kind: 'run', sessionId: 's1', provider: 'grok', model: 'grok-4', latencyMs: 1234, ok: true });
    await log.flush();
    const records = await readMetrics(testFile);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      kind: 'run',
      sessionId: 's1',
      provider: 'grok',
      model: 'grok-4',
      latencyMs: 1234,
      ok: true,
    });
    expect(typeof records[0].ts).toBe('number');
  });

  it('appends multiple records (one per line, NDJSON)', async () => {
    const log = new MetricsLogger(testFile);
    log.record({ kind: 'run', sessionId: 's1' });
    log.record({ kind: 'message', sessionId: 's1', tokens: 100, costUsd: 0.001 });
    log.record({ kind: 'error', sessionId: 's1', error: 'boom' });
    await log.flush();
    const records = await readMetrics(testFile);
    expect(records).toHaveLength(3);
    expect(records.map((r) => r.kind)).toEqual(['run', 'message', 'error']);
  });

  it('uses injected ts when provided', async () => {
    const log = new MetricsLogger(testFile);
    log.record({ kind: 'run', sessionId: 's1', ts: 1234567890 });
    await log.flush();
    const records = await readMetrics(testFile);
    expect(records[0].ts).toBe(1234567890);
  });

  it('flush() returns the underlying write queue (already-resolved)', async () => {
    const log = new MetricsLogger(testFile);
    log.record({ kind: 'run', sessionId: 's1' });
    log.record({ kind: 'run', sessionId: 's2' });
    log.record({ kind: 'run', sessionId: 's3' });
    await log.flush();
    // Subsequent flush should be a no-op.
    await log.flush();
    const records = await readMetrics(testFile);
    expect(records).toHaveLength(3);
  });

  it('fire-and-forget: caller does not await record()', () => {
    const log = new MetricsLogger(testFile);
    expect(() => {
      log.record({ kind: 'run', sessionId: 's1' });
      log.record({ kind: 'run', sessionId: 's2' });
      log.record({ kind: 'error', sessionId: 's1', error: 'boom' });
    }).not.toThrow();
  });

  it('readMetrics() returns [] when file is missing', async () => {
    const records = await readMetrics(testFile);
    expect(records).toEqual([]);
  });

  it('readMetrics() skips malformed lines', async () => {
    await fs.writeFile(
      testFile,
      JSON.stringify({ ts: 1, kind: 'run' }) + '\n' +
      '{ broken json\n' +
      JSON.stringify({ ts: 2, kind: 'error' }) + '\n',
      'utf-8',
    );
    const records = await readMetrics(testFile);
    expect(records).toHaveLength(2);
    expect(records.map((r) => r.ts)).toEqual([1, 2]);
  });

  it('exports the rotation threshold constant', () => {
    expect(METRICS_ROTATE_BYTES).toBe(10 * 1024 * 1024);
  });

  it('respects custom file path from constructor', async () => {
    const customPath = path.join(
      os.tmpdir(),
      `anathema-metrics-custom-${Date.now()}.jsonl`,
    );
    try {
      const log = new MetricsLogger(customPath);
      log.record({ kind: 'run', sessionId: 's1' });
      await log.flush();
      const records = await readMetrics(customPath);
      expect(records).toHaveLength(1);
      // Default path was NOT written.
      const defaultRecords = await readMetrics(testFile);
      expect(defaultRecords).toEqual([]);
    } finally {
      await fs.rm(customPath, { force: true });
    }
  });

  it('uses ANATHEMA_METRICS_FILE env var when no path provided', async () => {
    const saved = process.env.ANATHEMA_METRICS_FILE;
    process.env.ANATHEMA_METRICS_FILE = testFile;
    try {
      const log = new MetricsLogger();
      log.record({ kind: 'run', sessionId: 's1' });
      await log.flush();
      const records = await readMetrics(testFile);
      expect(records).toHaveLength(1);
    } finally {
      if (saved === undefined) delete process.env.ANATHEMA_METRICS_FILE;
      else process.env.ANATHEMA_METRICS_FILE = saved;
    }
  });
});