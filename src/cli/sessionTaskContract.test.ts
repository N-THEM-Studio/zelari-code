/**
 * sessionTaskContract.test.ts — 2.6 Track A wiring (doc §14): the spine
 * mirror seeds the first-class task contract from the FIRST user message,
 * env-gated (ZELARI_TASK_CONTRACT=1), state-only + version-monotone; a
 * resumed session that already carries a user.message/contract never
 * re-seeds (authority §14.3).
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readSessionLog } from '@zelari/core/session';
import { SessionSpineMirror } from './sessionSpine.js';

let baseDir: string;
const FLAG = 'ZELARI_TASK_CONTRACT';

beforeAll(async () => {
  baseDir = await mkdtemp(path.join(tmpdir(), 'task-contract-'));
});

afterAll(async () => {
  await rm(baseDir, { recursive: true, force: true });
  delete process.env[FLAG];
});

async function log(sessionId: string) {
  return readSessionLog(path.join(baseDir, sessionId, 'events.jsonl'));
}

describe('task.contract seeding (2.6 Track A)', () => {
  it('seeds a v1 contract after the first user.message when the flag is on', async () => {
    process.env[FLAG] = '1';
    try {
      const mirror = await SessionSpineMirror.adopt('tc-seed', { baseDir });
      mirror.userMessage('Fix the parser bug\n- do not add dependencies\n- verify: npm test');
      await mirror.flush();
      const { events } = await log('tc-seed');
      const contractEv = events.find((e) => e.kind === 'task.contract');
      expect(contractEv).toBeDefined();
      const contract = contractEv!.data.contract as {
        version: number;
        goal: string;
        constraints: Array<{ source: string }>;
        acceptanceCriteria: Array<{ source: string }>;
        source: { userSeq: number };
      };
      expect(contract.version).toBe(1);
      expect(contract.goal).toContain('Fix the parser bug');
      expect(contract.constraints.length).toBeGreaterThan(0);
      expect(contract.acceptanceCriteria.length).toBeGreaterThan(0);
      // source.userSeq points at the user.message event.
      const userEv = events.find((e) => e.kind === 'user.message');
      expect(contract.source.userSeq).toBe(userEv!.seq);
      // Ordering: user.message precedes task.contract in the log.
      expect(contractEv!.seq).toBeGreaterThan(userEv!.seq);
      // Only one contract even after a second user message.
      mirror.userMessage('procedi');
      await mirror.flush();
      const again = (await log('tc-seed')).events.filter((e) => e.kind === 'task.contract');
      expect(again).toHaveLength(1);
    } finally {
      delete process.env[FLAG];
    }
  });

  it('does NOT seed when the flag is off (default rollout Phase 1)', async () => {
    delete process.env[FLAG];
    const mirror = await SessionSpineMirror.adopt('tc-off', { baseDir });
    mirror.userMessage('plain prompt');
    await mirror.flush();
    const { events } = await log('tc-off');
    expect(events.some((e) => e.kind === 'task.contract')).toBe(false);
  });

  it('does NOT re-seed a resumed session that already had a user.message', async () => {
    process.env[FLAG] = '1';
    try {
      const first = await SessionSpineMirror.adopt('tc-resume', { baseDir });
      first.userMessage('original task');
      await first.close('test-done');
      const second = await SessionSpineMirror.adopt('tc-resume', { baseDir });
      expect(second.status).toBe('active');
      second.userMessage('later steer');
      await second.flush();
      const { events } = await log('tc-resume');
      const contracts = events.filter((e) => e.kind === 'task.contract');
      // Exactly ONE contract: seeded by the FIRST user message before close;
      // the resumed mirror must NOT add a second (authority §14.3).
      expect(contracts).toHaveLength(1);
      const goal = (contracts[0]!.data.contract as { goal: string }).goal;
      expect(goal).toContain('original task');
      expect(goal).not.toContain('later steer');
    } finally {
      delete process.env[FLAG];
    }
  });
});
