import { describe, expect, it } from 'vitest';
import { NoProgressGuard } from './NoProgressGuard.js';

const identity = { runId: 'r1', agentId: 'a1', role: 'lead', mode: 'kraken' } as const;

let seq = 0;
function toolCall(toolName: string, args: unknown, turn: number) {
  seq += 1;
  return {
    id: `e${seq}`,
    ts: 1,
    identity,
    turn,
    toolCallId: `tc${seq}`,
    toolName,
    args,
  };
}

function turnEnd(turn: number) {
  seq += 1;
  return { id: `e${seq}`, ts: 1, identity, turn };
}

/** Drive one full turn: tool calls then its onTurnEnd. */
async function turn(
  guard: NoProgressGuard,
  calls: Array<{ tool: string; args?: unknown }>,
  turnNumber: number,
) {
  for (const c of calls) {
    await guard.onToolCall(toolCall(c.tool, c.args ?? {}, turnNumber));
  }
  return guard.onTurnEnd(turnEnd(turnNumber));
}

describe('NoProgressGuard', () => {
  it('never intervenes while each turn does something new', async () => {
    const guard = new NoProgressGuard();
    expect(
      (await turn(guard, [{ tool: 'read_file', args: { path: 'a.ts' } }], 1)).action,
    ).toBe('continue');
    expect(
      (await turn(guard, [{ tool: 'grep_content', args: { pattern: 'x' } }], 2)).action,
    ).toBe('continue');
    expect(
      (await turn(guard, [{ tool: 'bash', args: { command: 'npm test' } }], 3)).action,
    ).toBe('continue');
  });

  it('treats zero-tool turns as neutral (they do not advance the stall counter)', async () => {
    const guard = new NoProgressGuard({ softStallTurns: 2 });
    const read = { path: 'a.ts' };
    // Turn 1: productive (first-time fingerprint).
    expect((await turn(guard, [{ tool: 'read_file', args: read }], 1)).action).toBe('continue');
    // Turns 2–4: no tool calls at all → neutral, stall stays 0.
    for (const t of [2, 3, 4]) {
      expect((await guard.onTurnEnd(turnEnd(t))).action).toBe('continue');
    }
    // Turn 5: one unproductive repeat → stall=1 < soft=2 → continue.
    // (If zero-tool turns counted as stalls, this would already be an inject.)
    expect((await turn(guard, [{ tool: 'read_file', args: read }], 5)).action).toBe('continue');
    // Turn 6: second consecutive unproductive turn → stall=2 → inject.
    expect((await turn(guard, [{ tool: 'read_file', args: read }], 6)).action).toBe('inject');
  });

  it('injects after softStallTurns consecutive unproductive turns', async () => {
    const guard = new NoProgressGuard(); // soft=2, hard=5
    const args = { path: 'a.ts' };
    expect((await turn(guard, [{ tool: 'read_file', args }], 1)).action).toBe('continue'); // productive
    expect((await turn(guard, [{ tool: 'read_file', args }], 2)).action).toBe('continue'); // stall=1
    expect((await turn(guard, [{ tool: 'read_file', args }], 3)).action).toBe('inject'); // stall=2
  });

  it('stops at hardStallTurns with code no_progress', async () => {
    const guard = new NoProgressGuard(); // hard=5
    const args = { path: 'a.ts' };
    await turn(guard, [{ tool: 'read_file', args }], 1); // productive
    for (let t = 2; t <= 5; t++) {
      const r = await turn(guard, [{ tool: 'read_file', args }], t); // stall 1..4
      if (t === 5) expect(r.action).toBe('inject'); // stall=4: still soft
    }
    const last = await turn(guard, [{ tool: 'read_file', args }], 6); // stall=5
    expect(last.action).toBe('stop');
    expect(last.code).toBe('no_progress');
  });

  it('file writes count as progress and reset the stall counter', async () => {
    const guard = new NoProgressGuard({ softStallTurns: 2 });
    const read = { path: 'a.ts' };
    await turn(guard, [{ tool: 'read_file', args: read }], 1); // productive
    expect((await turn(guard, [{ tool: 'read_file', args: read }], 2)).action).toBe('continue'); // stall=1
    // A writing turn resets the counter…
    await turn(guard, [{ tool: 'edit_file', args: { path: 'a.ts' } }], 3);
    // …so one repeated read afterwards is only stall=1 again → continue.
    expect((await turn(guard, [{ tool: 'read_file', args: read }], 4)).action).toBe('continue');
    // …and it takes a second consecutive unproductive turn to warn again.
    expect((await turn(guard, [{ tool: 'read_file', args: read }], 5)).action).toBe('inject');
  });

  it('same tool with different args is new progress', async () => {
    const guard = new NoProgressGuard({ softStallTurns: 1 });
    await turn(guard, [{ tool: 'bash', args: { command: 'npm test' } }], 1);
    const second = await turn(guard, [{ tool: 'bash', args: { command: 'npm test -- auth' } }], 2);
    expect(second.action).toBe('continue');
  });

  it('honours custom soft/hard thresholds', async () => {
    const strict = new NoProgressGuard({ softStallTurns: 1, hardStallTurns: 2 });
    const args = { pattern: 'x' };
    expect((await turn(strict, [{ tool: 'grep_content', args }], 1)).action).toBe('continue');
    expect((await turn(strict, [{ tool: 'grep_content', args }], 2)).action).toBe('inject');
    expect((await turn(strict, [{ tool: 'grep_content', args }], 3)).action).toBe('stop');
  });

  it('reset clears fingerprints and stall state', async () => {
    const guard = new NoProgressGuard({ softStallTurns: 1, hardStallTurns: 2 });
    const args = { path: 'a.ts' };
    await turn(guard, [{ tool: 'read_file', args }], 1);
    expect((await turn(guard, [{ tool: 'read_file', args }], 2)).action).toBe('inject');
    guard.reset();
    // After reset the same call is a first-time fingerprint again.
    expect((await turn(guard, [{ tool: 'read_file', args }], 3)).action).toBe('continue');
  });
});
