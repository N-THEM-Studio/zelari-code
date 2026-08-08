/**
 * Kraken workbench view — tests.
 *
 * Covers:
 *   - `parseWorkbench` round-trips a workbench file produced by the writer
 *   - Tolerant: partial / truncated input does not throw
 *   - `formatWorkbenchForTerminal` produces a readable text block
 */

import { describe, it, expect } from 'vitest';
import { parseWorkbench, formatWorkbenchForTerminal } from './workbenchView.js';
import { WorkbenchWriter } from './workbench.js';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SAMPLE = `# Kraken workbench

**Goal:** refactor auth
**Graph id:** \`g-abc\`
**Started:** 2026-08-08T11:00:00.000Z · **Elapsed:** 00:01:23

## Progress: 2/5 · 1↑ · 0✗

## Wave

| id | label | kind | scope | status | model | duration |
|----|-------|------|-------|--------|-------|----------|
| t0001 | map auth | explore | src/auth | ✓ | grok-3-mini | 4.0s |
| t0002 | refactor | general | src/auth | ✓ | grok-4.5 | 12.3s |
| t0003 | test | general | tests/auth | ↑ | grok-4.5 |  |
| t0004 | judge | verify |  | pending |  |  |
| t0005 | merge | merge |  | pending |  |  |

## Events (latest 30)

- 11:00:01 node_start t0001 map auth
- 11:00:05 node_end t0001 done (4000ms)
- 11:00:06 node_start t0002 refactor
- 11:00:18 node_end t0002 done (12300ms)
- 11:00:18 node_start t0003 test
`;

describe('parseWorkbench', () => {
  it('parses a full workbench file', () => {
    const p = parseWorkbench(SAMPLE);
    expect(p.goal).toBe('refactor auth');
    expect(p.graphId).toBe('g-abc');
    expect(p.started).toContain('2026-08-08');
    expect(p.progress).toContain('2/5');
    expect(p.nodes).toHaveLength(5);
    expect(p.nodes[0]).toMatchObject({
      id: 't0001',
      label: 'map auth',
      kind: 'explore',
      scope: 'src/auth',
      status: '✓',
      model: 'grok-3-mini',
      duration: '4.0s',
    });
    expect(p.events).toHaveLength(5);
    expect(p.events[0]).toEqual({ ts: '11:00:01', text: 'node_start t0001 map auth' });
  });

  it('returns empty for empty / null input', () => {
    expect(parseWorkbench('')).toEqual({
      goal: '', graphId: '', started: '', elapsed: '', progress: '',
      nodes: [], events: [],
    });
    expect(parseWorkbench(undefined)).toEqual({
      goal: '', graphId: '', started: '', elapsed: '', progress: '',
      nodes: [], events: [],
    });
    expect(parseWorkbench(null)).toEqual({
      goal: '', graphId: '', started: '', elapsed: '', progress: '',
      nodes: [], events: [],
    });
  });

  it('tolerates a truncated file (only header, no sections)', () => {
    const p = parseWorkbench('# Kraken workbench\n\n**Goal:** x\n');
    expect(p.goal).toBe('x');
    expect(p.nodes).toEqual([]);
    expect(p.events).toEqual([]);
  });

  it('tolerates a partial events section', () => {
    const p = parseWorkbench('# Kraken workbench\n\n## Events (latest 30)\n\n- 11:00:01 hello\n');
    expect(p.events).toHaveLength(1);
    expect(p.events[0].text).toBe('hello');
  });

  it('ignores rows that do not have enough cells', () => {
    const content = `
## Wave

| id | label | kind | scope | status | model | duration |
|----|-------|------|-------|--------|-------|----------|
| t0001 ok
`;
    const p = parseWorkbench(content);
    expect(p.nodes).toEqual([]); // row has only 1 cell, dropped
  });

  it('round-trips with the writer', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'kraken-wb-view-'));
    const w = new WorkbenchWriter({ cwd: tmp, graphId: 'g-rt', goal: 'rt test', debounceMs: 0 });
    w.setNodes([
      { id: 't0001', kind: 'explore', label: 'a', status: 'done', model: 'm1', durationMs: 100 },
      { id: 't0002', kind: 'general', label: 'b', status: 'running', scope: ['src/x'] },
    ]);
    w.logEvent('event 1');
    w.logEvent('event 2');
    const out = await w.flush();
    const content = await fs.readFile(out!, 'utf8');
    const parsed = parseWorkbench(content);
    expect(parsed.goal).toBe('rt test');
    expect(parsed.graphId).toBe('g-rt');
    expect(parsed.nodes).toHaveLength(2);
    expect(parsed.events.length).toBeGreaterThanOrEqual(2);
  });
});

describe('formatWorkbenchForTerminal', () => {
  it('includes the goal, progress, and recent events', () => {
    const out = formatWorkbenchForTerminal(parseWorkbench(SAMPLE));
    expect(out).toContain('[kraken] refactor auth');
    expect(out).toContain('[kraken] progress: 2/5');
    expect(out).toContain('[kraken] wave:');
    expect(out).toContain('t0001  map auth');
    expect(out).toContain('11:00:01  node_start t0001');
  });

  it('produces a readable block for an empty workbench', () => {
    const out = formatWorkbenchForTerminal(parseWorkbench(''));
    // Empty workbench → empty render (nothing to show).
    expect(out.trim()).toBe('');
  });
});
