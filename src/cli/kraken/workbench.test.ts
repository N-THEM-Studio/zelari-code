/**
 * Kraken workbench writer — tests.
 *
 * Covers:
 *   - `flush()` writes a Markdown file to `.zelari/radio/workbench-<id>.md`
 *   - The file is rewritten atomically (no partial state on tail)
 *   - `setNodes` + `markStart` + `markEnd` produce the expected table
 *   - Events are capped at MAX_EVENTS (30)
 *   - `ZELARI_KRAKEN_WORKBENCH=0` disables the writer
 *   - Disabled writer is a no-op (no file, no error)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkbenchWriter, isWorkbenchEnabled, type WorkbenchNode } from './workbench.js';

let tmp = '';
let counter = 0;

async function freshTmp(): Promise<string> {
  const t = await fs.mkdtemp(path.join(os.tmpdir(), 'kraken-workbench-'));
  counter += 1;
  return t;
}

describe('isWorkbenchEnabled', () => {
  it('defaults to true', () => {
    expect(isWorkbenchEnabled({})).toBe(true);
  });
  it('respects ZELARI_KRAKEN_WORKBENCH=0', () => {
    expect(isWorkbenchEnabled({ ZELARI_KRAKEN_WORKBENCH: '0' })).toBe(false);
  });
  it('treats "no", "false", "off" as disabled', () => {
    expect(isWorkbenchEnabled({ ZELARI_KRAKEN_WORKBENCH: 'no' })).toBe(false);
    expect(isWorkbenchEnabled({ ZELARI_KRAKEN_WORKBENCH: 'false' })).toBe(false);
    expect(isWorkbenchEnabled({ ZELARI_KRAKEN_WORKBENCH: 'off' })).toBe(false);
  });
});

describe('WorkbenchWriter', () => {
  beforeEach(async () => {
    tmp = await freshTmp();
  });

  it('writes a Markdown file with the expected header', async () => {
    const w = new WorkbenchWriter({ cwd: tmp, graphId: 'g-1', goal: 'refactor auth' });
    w.setNodes([{ id: 't0001', kind: 'explore', label: 'map', status: 'pending' }]);
    const out = await w.flush();
    expect(out).toBe(path.join(tmp, '.zelari', 'radio', 'workbench-g-1.md'));
    const body = await fs.readFile(out!, 'utf8');
    expect(body).toContain('# Kraken workbench');
    expect(body).toContain('**Goal:** refactor auth');
    expect(body).toContain('**Graph id:** `g-1`');
    expect(body).toContain('| t0001 | map | explore |');
  });

  it('updates the table on markStart / markEnd', async () => {
    const w = new WorkbenchWriter({ cwd: tmp, graphId: 'g-2', goal: 'x' });
    w.setNodes([{ id: 't0001', kind: 'general', label: 'do it', status: 'pending', scope: ['src/auth'] }]);
    w.markStart('t0001', { model: 'grok-3-mini' });
    w.markEnd('t0001', { status: 'done', durationMs: 1234 });
    const out = await w.flush();
    const body = await fs.readFile(out!, 'utf8');
    expect(body).toContain('✓'); // done emoji
    expect(body).toContain('1.2s'); // formatted duration
    expect(body).toContain('grok-3-mini');
    expect(body).toContain('src/auth');
  });

  it('captures events in the latest-30 list', async () => {
    const w = new WorkbenchWriter({ cwd: tmp, graphId: 'g-3', goal: 'x' });
    for (let i = 0; i < 50; i++) w.logEvent(`event ${i}`);
    const out = await w.flush();
    const body = await fs.readFile(out!, 'utf8');
    // The first 20 events are dropped; the last 30 survive.
    expect(body).not.toContain('event 0 ');
    expect(body).not.toContain('event 19 ');
    expect(body).toContain('event 20');
    expect(body).toContain('event 49');
  });

  it('marks a node as error and surfaces the message', async () => {
    const w = new WorkbenchWriter({ cwd: tmp, graphId: 'g-4', goal: 'x' });
    w.setNodes([{ id: 't0001', kind: 'general', label: 'do', status: 'pending' }]);
    w.markStart('t0001');
    w.markEnd('t0001', { status: 'error', error: 'kaboom', durationMs: 100 });
    const out = await w.flush();
    const body = await fs.readFile(out!, 'utf8');
    expect(body).toContain('✗');
    expect(body).toContain('kaboom');
  });

  it('parses the persona verdict and Bennett weakness score from findings', async () => {
    // Simulate a verify/spec/conformance node whose findings include the
    // standard trailer. The workbench must surface the verdict + weakness
    // in the Wave table so a `tail -f` reader sees whether a PASS was
    // earned by a tightly-asserted or loosely-claimed reviewer.
    const w = new WorkbenchWriter({ cwd: tmp, graphId: 'g-err', goal: 'x' });
    w.setNodes([{ id: 'v-001', kind: 'verify', label: 'review', status: 'pending' }]);
    w.markStart('v-001');
    w.markEnd('v-001', {
      status: 'done',
      durationMs: 100,
      findings: 'All requirements are met. The function returns the right shape.\n\nVERDICT: PASS',
    });
    const out = await w.flush();
    const body = await fs.readFile(out!, 'utf8');
    expect(body).toContain('| v-001 |');
    // Header columns for verdict + weakness are present.
    expect(body).toMatch(/\|\s*id\s*\|\s*label\s*\|\s*kind\s*\|\s*scope\s*\|\s*status\s*\|\s*verdict\s*\|\s*weakness\s*\|/);
    // Verdict cell shows pass.
    expect(body).toMatch(/\|\s*v-001\s*\|[^|]+\|\s*verify\s*\|[^|]+\|[^|]+\|\s*pass\s*\|/);
    // Weakness is a 2-decimal number in [0, 1].
    expect(body).toMatch(/\|\s*pass\s*\|\s*(0\.\d{2}|1\.00)\s*\|/);
  });

  it('records a high weakness (loosely claimed) PASS when findings are vague', async () => {
    // Loosely-claimed reviewer: "looks good" → high weakness (close to 1).
    const writer = new WorkbenchWriter({ cwd: tmp, graphId: 'g-loose', goal: 'x' });
    writer.setNodes([{ id: 'v-002', kind: 'verify', label: 'r', status: 'pending' }]);
    writer.markStart('v-002');
    writer.markEnd('v-002', {
      status: 'done',
      durationMs: 50,
      findings: 'Looks good.\n\nVERDICT: PASS',
    });
    const out = await writer.flush();
    const body = await fs.readFile(out!, 'utf8');
    const weaknessCell = body.match(/\|\s*pass\s*\|\s*(\d\.\d{2})\s*\|/);
    expect(weaknessCell).not.toBeNull();
    const weaknessValue = parseFloat(weaknessCell![1]);
    expect(weaknessValue).toBeGreaterThan(0.6);
  });

  it('records a low weakness (tightly asserted) PASS when findings pin specifics', async () => {
    // Tightly-asserted reviewer: pins paths + line + version → low weakness.
    const findings = [
      'The function MUST always return EXACTLY the value at line 42, version 1.2.3.',
      'I GUARANTEED the file is at /src/util.ts.',
      '',
      'VERDICT: PASS',
    ].join('\n');
    const writer = new WorkbenchWriter({ cwd: tmp, graphId: 'g-tight', goal: 'x' });
    writer.setNodes([{ id: 'v-003', kind: 'spec', label: 'r', status: 'pending' }]);
    writer.markStart('v-003');
    writer.markEnd('v-003', { status: 'done', durationMs: 50, findings });
    const out = await writer.flush();
    const body = await fs.readFile(out!, 'utf8');
    const weaknessCell = body.match(/\|\s*pass\s*\|\s*(\d\.\d{2})\s*\|/);
    expect(weaknessCell).not.toBeNull();
    const weaknessValue = parseFloat(weaknessCell![1]);
    expect(weaknessValue).toBeLessThan(0.5);
  });

  it('marks a parallel wave', async () => {
    const w = new WorkbenchWriter({ cwd: tmp, graphId: 'g-5', goal: 'x' });
    w.markWave(['t0001', 't0002', 't0003']);
    const out = await w.flush();
    const body = await fs.readFile(out!, 'utf8');
    expect(body).toMatch(/wave: t0001, t0002, t0003/);
  });

  it('preserves running status across setNodes (does NOT reset to pending)', async () => {
    const w = new WorkbenchWriter({ cwd: tmp, graphId: 'g-6', goal: 'x' });
    w.setNodes([{ id: 't0001', kind: 'general', label: 'do', status: 'pending' }]);
    w.markStart('t0001');
    // A second setNodes call shouldn't reset the running state.
    w.setNodes([{ id: 't0001', kind: 'general', label: 'do', status: 'pending' }]);
    const out = await w.flush();
    const body = await fs.readFile(out!, 'utf8');
    expect(body).toContain('↑'); // running emoji
  });

  it('is a no-op when disabled', async () => {
    const w = new WorkbenchWriter({ cwd: tmp, graphId: 'g-7', goal: 'x', enabled: false });
    w.setNodes([{ id: 't0001', kind: 'explore', label: 'x', status: 'pending' }]);
    w.markStart('t0001');
    const out = await w.flush();
    expect(out).toBeNull();
    // No file was written.
    const file = path.join(tmp, '.zelari', 'radio', 'workbench-g-7.md');
    await expect(fs.access(file)).rejects.toThrow();
  });

  it('rewrites atomically (no partial state observable on tail)', async () => {
    const w = new WorkbenchWriter({ cwd: tmp, graphId: 'g-8', goal: 'x', debounceMs: 0 });
    w.setNodes([{ id: 't0001', kind: 'explore', label: 'a', status: 'pending' }]);
    await w.flush();
    w.markStart('t0001');
    w.markEnd('t0001', { status: 'done', durationMs: 50 });
    // Two flushes in quick succession: each must produce a complete file.
    await w.flush();
    const body = await fs.readFile(path.join(tmp, '.zelari', 'radio', 'workbench-g-8.md'), 'utf8');
    expect(body).toMatch(/✓/); // last write's status
    // No .tmp files left over.
    const dir = path.join(tmp, '.zelari', 'radio');
    const files = await fs.readdir(dir);
    const tmps = files.filter((f) => f.endsWith('.tmp'));
    expect(tmps).toEqual([]);
  });

  it('close() cancels the pending debounced write', async () => {
    const w = new WorkbenchWriter({ cwd: tmp, graphId: 'g-9', goal: 'x', debounceMs: 1000 });
    w.logEvent('will never land');
    w.close();
    await new Promise((r) => setTimeout(r, 1100));
    const file = path.join(tmp, '.zelari', 'radio', 'workbench-g-9.md');
    await expect(fs.access(file)).rejects.toThrow();
  });

  it('handles a graph with many nodes by truncating the table', async () => {
    const w = new WorkbenchWriter({ cwd: tmp, graphId: 'g-10', goal: 'x' });
    const nodes: WorkbenchNode[] = [];
    for (let i = 0; i < 250; i++) {
      nodes.push({ id: `t${String(i).padStart(4, '0')}`, kind: 'explore', label: `n${i}`, status: 'pending' });
    }
    w.setNodes(nodes);
    const out = await w.flush();
    const body = await fs.readFile(out!, 'utf8');
    // The table caps at 200 rows. (We don't assert exact count, just that
    // it's not 250 — the truncated set is present and the rest is gone.)
    const tableRows = body.split('\n').filter((l) => l.startsWith('| t')).length;
    expect(tableRows).toBeLessThanOrEqual(200);
    expect(tableRows).toBeGreaterThan(0);
  });
});
