import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readSessionLog, buildProjection } from './replay.js';
import type { SessionEventEnvelope } from './types.js';

async function tmpFile(content: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zelari-replay-test-'));
  const file = path.join(dir, 'events.jsonl');
  await fs.writeFile(file, content, 'utf-8');
  return file;
}

function env(seq: number, kind = 'note'): string {
  const e: SessionEventEnvelope = {
    schemaVersion: 1,
    sessionId: 's',
    seq,
    ts: 1755000000000 + seq,
    kind: kind as SessionEventEnvelope['kind'],
    actor: { type: 'system' },
    data: {},
  };
  return JSON.stringify(e);
}

describe('readSessionLog', () => {
  it('returns an empty ok report for a missing file', async () => {
    const report = await readSessionLog(path.join(os.tmpdir(), 'no-such-events.jsonl'));
    expect(report.events).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('reports corrupt lines without throwing', async () => {
    const file = await tmpFile(`${env(1)}\nNOT JSON {{\n${env(2)}\n`);
    const report = await readSessionLog(file);
    expect(report.events).toHaveLength(2);
    expect(report.issues).toEqual([{ type: 'corrupt-line', line: 2 }]);
    expect(report.ok).toBe(false);
  });

  it('detects seq gaps and duplicates', async () => {
    const file = await tmpFile(`${env(1)}\n${env(3)}\n${env(3)}\n`);
    const report = await readSessionLog(file);
    expect(report.issues.map((i) => i.type)).toEqual(['seq-gap', 'seq-duplicate']);
    expect(report.events.map((e) => e.seq)).toEqual([1, 3]);
  });

  it('reports schema mismatches (wrong schemaVersion)', async () => {
    const raw = { ...JSON.parse(env(1)), schemaVersion: 99 };
    const file = await tmpFile(`${JSON.stringify(raw)}\n`);
    const report = await readSessionLog(file);
    expect(report.events).toHaveLength(0);
    expect(report.issues[0]?.type).toBe('schema-mismatch');
  });
});

describe('buildProjection', () => {
  it('counts surface and state events, verification summaries and fork', () => {
    const events: SessionEventEnvelope[] = [
      JSON.parse(env(1, 'session.started')),
      JSON.parse(env(2, 'user.message')),
      {
        schemaVersion: 1,
        sessionId: 's',
        seq: 3,
        ts: 1,
        kind: 'tool.call',
        actor: { type: 'agent' },
        data: { callId: 'c1', tool: 'bash', args: { command: 'ls' } },
      },
      {
        schemaVersion: 1,
        sessionId: 's',
        seq: 4,
        ts: 2,
        kind: 'tool.result',
        actor: { type: 'tool' },
        data: { callId: 'c1', tool: 'bash', ok: true, output: 'file-a\nfile-b' },
      },
      {
        schemaVersion: 1,
        sessionId: 's',
        seq: 5,
        ts: 3,
        kind: 'verification.run',
        actor: { type: 'system' },
        data: {
          results: [
            { criterionId: 'tests', status: 'pass', evidence: [{ tier: 'command-output' }] },
            { criterionId: 'lint', status: 'unknown', evidence: [] },
          ],
          complete: false,
        },
      },
    ];
    const projection = buildProjection(events);
    expect(projection.lastSeq).toBe(5);
    expect(projection.messages).toHaveLength(2); // user.message + tool.result (tool.call skipped by default)
    expect(projection.messages[1]).toMatchObject({ role: 'tool', toolCallId: 'c1', isError: false });
    expect(projection.toolCalls).toBe(1);
    expect(projection.toolResults).toBe(1);
    expect(projection.verifications).toHaveLength(1);
    expect(projection.verifications[0]?.results[0]).toEqual({
      criterionId: 'tests',
      status: 'pass',
      evidenceCount: 1,
    });
    expect(projection.verifications[0]?.complete).toBe(false);
  });
});
