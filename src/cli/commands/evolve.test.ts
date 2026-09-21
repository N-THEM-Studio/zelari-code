/**
 * commands/evolve.test.ts — detector v0 + flag parsing for `evolve shadow`.
 *
 * Red-if-reopens:
 *   - write → turn boundary → by-name verify yields ONE proposal with the
 *     calls AND the boundary as evidence (what the controller requires);
 *   - no boundary between the calls (same decision batch) is NOT a candidate;
 *   - a FAILED write (tool.result ok:false folded by callId) is not a candidate;
 *   - `task` with agent=verify counts as a verify;
 *   - the limit caps detection;
 *   - the parser strips the command token, rejects unknown subcommands and
 *     parses --limit/--json without ever throwing.
 */
import { describe, expect, it } from 'vitest';
import type { SessionEventEnvelope } from '@zelari/core/session';
import { detectFuseProposals, parseEvolveFlags } from './evolve.js';

let seq = 0;
const ev = (kind: SessionEventEnvelope['kind'], data: Record<string, unknown>): SessionEventEnvelope => {
  seq += 1;
  return { schemaVersion: 1, sessionId: 's-test', seq, ts: 1755000000 + seq, kind, actor: { type: 'agent' }, data };
};
const writeCall = (callId: string, path: string) => ev('tool.call', { callId, tool: 'write_file', args: { path } });
const verifyCall = (callId: string) => ev('tool.call', { callId, tool: 'verify', args: {} });

describe('detectFuseProposals', () => {
  it('pairs write → boundary → verify into one evidenced proposal', () => {
    seq = 0;
    const { proposals, calls, turnBoundaries } = detectFuseProposals(
      [writeCall('w1', 'src/a.ts'), ev('assistant.message', { text: 'done' }), verifyCall('v1')],
      50,
    );
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      kind: 'fuse_edit_verify',
      callIds: ['w1', 'v1'],
      estSavedCalls: 1,
      decisiveSeq: 3,
      path: 'src/a.ts',
    });
    expect(proposals[0]!.evidence.map((e) => e.ref)).toEqual(['call:w1', 'seq:2', 'call:v1']);
    expect(calls).toBe(2);
    expect(turnBoundaries).toBe(1);
  });

  it('does not pair calls sitting in the same decision batch (no boundary)', () => {
    seq = 0;
    const { proposals } = detectFuseProposals([writeCall('w1', 'src/a.ts'), verifyCall('v1')], 50);
    expect(proposals).toHaveLength(0);
  });

  it('does not pair a write that failed (tool.result ok:false)', () => {
    seq = 0;
    const { proposals } = detectFuseProposals(
      [writeCall('w1', 'src/a.ts'), ev('tool.result', { callId: 'w1', ok: false }), ev('assistant.message', {}), verifyCall('v1')],
      50,
    );
    expect(proposals).toHaveLength(0);
  });

  it('counts task agent=verify as a verify', () => {
    seq = 0;
    const { proposals } = detectFuseProposals(
      [writeCall('w1', 'src/a.ts'), ev('assistant.message', {}), ev('tool.call', { callId: 'v1', tool: 'task', args: { agent: 'verify' } })],
      50,
    );
    expect(proposals).toHaveLength(1);
  });

  it('caps detection at the limit', () => {
    seq = 0;
    const events: SessionEventEnvelope[] = [];
    for (let i = 0; i < 5; i++) {
      events.push(writeCall(`w${i}`, `src/${i}.ts`), ev('assistant.message', {}), verifyCall(`v${i}`));
    }
    expect(detectFuseProposals(events, 2).proposals).toHaveLength(2);
  });
});

describe('parseEvolveFlags', () => {
  it('strips the command token and reads the subcommand + session id', () => {
    const f = parseEvolveFlags(['evolve', 'shadow', 'abc-123', '--json']);
    expect(f).toMatchObject({ subcommand: 'shadow', sessionId: 'abc-123', json: true });
    expect(f.error).toBeUndefined();
  });

  it('rejects unknown subcommands (v0 ships only shadow)', () => {
    expect(parseEvolveFlags(['evolve', 'apply']).error).toContain("unknown evolve subcommand 'apply'");
  });

  it('parses --limit and ignores junk values', () => {
    expect(parseEvolveFlags(['evolve', 'shadow', '--limit', '7']).limit).toBe(7);
    expect(parseEvolveFlags(['evolve', 'shadow', '--limit', 'x']).limit).toBeUndefined();
  });

  it('help suppresses the subcommand error', () => {
    const f = parseEvolveFlags(['evolve', 'bogus', '--help']);
    expect(f.help).toBe(true);
    expect(f.error).toBeUndefined();
  });
});
