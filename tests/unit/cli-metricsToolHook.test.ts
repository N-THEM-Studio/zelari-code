/**
 * cli-metricsToolHook.test.ts — Task G.3.4
 *
 * Verifies the new `kind: 'tool'` metric record type and the
 * process-wide singleton (Task G.3.3). The shutdown-flush wiring in
 * `main.ts` is covered indirectly by exercising the singleton's flush()
 * behavior — the SIGINT handler calls `getMetricsLogger().flush()`
 * before `process.exit(0)`, and we assert that the singleton flush
 * drains pending records (which is what makes the wiring work).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  MetricsLogger,
  getMetricsLogger,
  resetMetricsLogger,
  readMetrics,
  type MetricsRecord,
} from '../../src/cli/metrics.js';

describe('MetricsKind extension to include "tool" (Task G.3.1)', () => {
  it('writes a tool record with toolName + toolCallId + durationMs + ok', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'metrics-tool-'));
    const file = path.join(dir, 'metrics.jsonl');
    try {
      const logger = new MetricsLogger(file);
      logger.record({
        kind: 'tool',
        sessionId: 'sess-1',
        provider: 'minimax',
        model: 'test-model',
        toolName: 'read_file',
        toolCallId: 'tc-42',
        durationMs: 123,
        ok: true,
      });
      logger.record({
        kind: 'tool',
        sessionId: 'sess-1',
        provider: 'minimax',
        model: 'test-model',
        toolName: 'shell',
        toolCallId: 'tc-43',
        durationMs: 5,
        ok: false,
      });
      await logger.flush();

      const records = await readMetrics(file);
      expect(records.length).toBe(2);
      const ok = records[0] as MetricsRecord;
      const err = records[1] as MetricsRecord;
      expect(ok.kind).toBe('tool');
      expect(ok.toolName).toBe('read_file');
      expect(ok.toolCallId).toBe('tc-42');
      expect(ok.durationMs).toBe(123);
      expect(ok.ok).toBe(true);
      expect(err.kind).toBe('tool');
      expect(err.toolName).toBe('shell');
      expect(err.ok).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Process-wide singleton MetricsLogger (Task G.3.3)', () => {
  beforeEach(() => {
    resetMetricsLogger();
  });
  afterEach(() => {
    resetMetricsLogger();
  });

  it('getMetricsLogger returns the same instance on repeated calls', () => {
    const a = getMetricsLogger();
    const b = getMetricsLogger();
    expect(a).toBe(b);
  });

  it('resetMetricsLogger clears the singleton', () => {
    const a = getMetricsLogger();
    resetMetricsLogger();
    const b = getMetricsLogger();
    expect(a).not.toBe(b);
  });

  it('singleton flush drains pending fire-and-forget records', async () => {
    // Point the singleton at a temp file via env override BEFORE first access.
    const dir = mkdtempSync(path.join(tmpdir(), 'metrics-singleton-'));
    const file = path.join(dir, 'singleton.jsonl');
    const saved = process.env.ANATHEMA_METRICS_FILE;
    process.env.ANATHEMA_METRICS_FILE = file;
    resetMetricsLogger();
    try {
      const logger = getMetricsLogger();
      logger.record({ kind: 'run', sessionId: 'sess-2', ok: true });
      logger.record({ kind: 'error', sessionId: 'sess-2', error: 'boom' });
      // Fire-and-forget: file should NOT exist yet (or be empty).
      // The metric buffer is in the promise chain.
      await logger.flush();
      // After flush, the file must exist and contain both records.
      expect(existsSync(file)).toBe(true);
      const raw = readFileSync(file, 'utf-8').trim().split('\n').filter(Boolean);
      expect(raw.length).toBe(2);
      const r1 = JSON.parse(raw[0] as string) as MetricsRecord;
      const r2 = JSON.parse(raw[1] as string) as MetricsRecord;
      expect(r1.kind).toBe('run');
      expect(r2.kind).toBe('error');
    } finally {
      if (saved === undefined) delete process.env.ANATHEMA_METRICS_FILE;
      else process.env.ANATHEMA_METRICS_FILE = saved;
      resetMetricsLogger();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Shutdown flush semantic — pending records survive process.exit (Task G.3.3)', () => {
  it('a record + flush guarantees the file is fully written before the next instruction', async () => {
    // Simulates the SIGINT handler behavior: record() is fire-and-forget,
    // but flush() awaits the write queue. Without the flush, the file
    // would be empty (or missing) when `process.exit(0)` runs.
    const dir = mkdtempSync(path.join(tmpdir(), 'metrics-shutdown-'));
    const file = path.join(dir, 'shutdown.jsonl');
    const saved = process.env.ANATHEMA_METRICS_FILE;
    process.env.ANATHEMA_METRICS_FILE = file;
    resetMetricsLogger();
    try {
      const logger = getMetricsLogger();
      // Record 5 tool calls rapidly (the kind that would otherwise be
      // lost on shutdown because they're written async)
      for (let i = 0; i < 5; i++) {
        logger.record({
          kind: 'tool',
          sessionId: 'sess-3',
          toolName: `tool_${i}`,
          durationMs: i * 10,
          ok: true,
        });
      }
      // No flush yet — file should not contain all 5 records.
      const partialContent = existsSync(file) ? readFileSync(file, 'utf-8') : '';
      // The fire-and-forget queue MAY have written some, but not all.
      // (We don't assert "exactly 0" because the queue is fast; we just
      // assert that flush() completes the write.)
      await logger.flush();
      const finalContent = readFileSync(file, 'utf-8');
      const lines = finalContent.trim().split('\n').filter(Boolean);
      expect(lines.length).toBe(5);
      // Sanity: at least one record was added between the partial check
      // and the post-flush check, OR the queue was already done. Both
      // outcomes are valid — the test guards against "flush() is a no-op".
      const records = lines.map((l) => JSON.parse(l) as MetricsRecord);
      for (let i = 0; i < 5; i++) {
        expect(records[i]?.toolName).toBe(`tool_${i}`);
      }
      // Suppress unused-var warning for partialContent (kept for
      // documentary purposes in case future debugging is needed).
      void partialContent;
    } finally {
      if (saved === undefined) delete process.env.ANATHEMA_METRICS_FILE;
      else process.env.ANATHEMA_METRICS_FILE = saved;
      resetMetricsLogger();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
