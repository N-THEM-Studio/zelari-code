/**
 * session/replayEquivalence.test.ts — property test "log ≡ execution" (A1).
 *
 * Seeded, dependency-free fuzz over the session spine (ADR-0016/0021),
 * inspired by unreallabsai/unreal-agent `cmd/internal/agentrunner/*_fuzz_test.go`.
 * For N pseudo-random VALID event sequences, the JSONL log written by the
 * SessionLogWriter must round-trip exactly — replay(serialize(execution))
 * ≡ execution — and a damaged log (lost line / torn line / corrupted payload)
 * must never diverge silently: tolerant replay either recovers the coherent
 * remainder or reports ReplayIssue(s); every replayed event is byte-identical
 * to a live one (values are never invented).
 *
 * Determinism contract: in-test mulberry32 PRNG + injected writer clock —
 * no Math.random/Date.now in any assertion, no new dependencies (AGENTS.MD).
 * Design intent: .zelari/docs/2026-09-21-piano-roi-steal-unreal-agent.md §A1.
 */

import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionLogWriter } from './writer.js';
import { readSessionLog } from './replay.js';
import { deriveMessages } from './modelSurface.js';
import { validateSessionTrace } from './invariants.js';
import {
  ACTOR_AGENT,
  ACTOR_SYSTEM,
  ACTOR_USER,
  SESSION_SCHEMA_VERSION,
  SessionEventEnvelopeSchema,
  type SessionEventEnvelope,
  type SessionEventInput,
  type SessionEventKind,
} from './types.js';

/** Number of pseudo-random sequences per property (acceptance: N >= 100). */
const SEQUENCES = 100;
const BASE_SEED = 0x5eed165;
const TOOLS = ['bash', 'read_file', 'write_file'] as const;

/** mulberry32 — deterministic in-test PRNG (no Math.random, no deps). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rand: () => number, xs: readonly T[]): T {
  return xs[Math.floor(rand() * xs.length)]!;
}

/**
 * Generate a VALID session sequence: `session.started` … `session.ended`,
 * mixing surface kinds (user/assistant/tool) with state-only kinds. Every
 * `tool.call` is immediately paired with its `tool.result` (unique callId), so
 * `validateSessionTrace(events, 'strict')` holds. seq/ts/schemaVersion are
 * assigned by the writer — never faked here.
 */
function genInputs(rand: () => number, target: number): SessionEventInput[] {
  const inputs: SessionEventInput[] = [
    { kind: 'session.started', actor: ACTOR_SYSTEM, data: { reason: 'fuzz' } },
  ];
  let calls = 0;
  while (inputs.length < target - 1) {
    const r = rand();
    if (r < 0.3) {
      inputs.push({ kind: 'user.message', actor: ACTOR_USER, data: { text: `user-${inputs.length}` } });
    } else if (r < 0.55) {
      inputs.push({ kind: 'assistant.message', actor: ACTOR_AGENT, data: { text: `assistant-${inputs.length}` } });
    } else if (r < 0.75) {
      const callId = `call-${++calls}`;
      inputs.push({
        kind: 'tool.call',
        actor: ACTOR_AGENT,
        data: { callId, tool: pick(rand, TOOLS), args: { i: inputs.length } },
      });
      inputs.push({
        kind: 'tool.result',
        actor: { type: 'tool' },
        data: { callId, ok: rand() < 0.8, output: `out-${callId}` },
      });
    } else if (r < 0.85) {
      inputs.push({ kind: 'note', actor: ACTOR_SYSTEM, data: { note: `n-${inputs.length}` } });
    } else if (r < 0.94) {
      inputs.push({ kind: 'file.read', actor: ACTOR_AGENT, data: { path: `f-${inputs.length}.ts` } });
    } else {
      inputs.push({ kind: 'mission.phase', actor: ACTOR_SYSTEM, data: { phase: 'plan' } });
    }
  }
  inputs.push({ kind: 'session.ended', actor: ACTOR_SYSTEM, data: { reason: 'completed' } });
  return inputs;
}

/** Execution: write `inputs` through the real writer with a SEEDED clock. */
async function writeSeq(
  dir: string,
  sessionId: string,
  seed: number,
  inputs: SessionEventInput[],
): Promise<{ file: string; raw: string; live: SessionEventEnvelope[] }> {
  let ts = 1_755_000_000_000 + seed;
  const writer = await SessionLogWriter.open(dir, sessionId, 1, { now: () => (ts += 1000) });
  const live: SessionEventEnvelope[] = [];
  for (const input of inputs) live.push(await writer.append(input));
  await writer.close();
  const raw = await fs.readFile(writer.path, 'utf-8');
  return { file: writer.path, raw, live };
}

describe('property: log ≡ execution (A1 seeded fuzz over the session spine)', () => {
  it('replay(serialize(execution)) == execution for 100 seeded sequences', async () => {
    for (let i = 0; i < SEQUENCES; i++) {
      const seed = BASE_SEED + i;
      const rand = mulberry32(seed);
      const target = 6 + Math.floor(rand() * 30);
      const inputs = genInputs(rand, target);
      // Same seed ⇒ same sequence (generator determinism).
      const rand2 = mulberry32(seed);
      expect(genInputs(rand2, 6 + Math.floor(rand2() * 30)), `seed=${seed}`).toEqual(inputs);

      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zelari-a1-'));
      const tag = `seed=${seed}`;
      const a = await writeSeq(path.join(root, 'a'), `fuzz-${seed}`, seed, inputs);
      const b = await writeSeq(path.join(root, 'b'), `fuzz-${seed}`, seed, inputs); // riscrittura

      // (a) log ≡ execution: replay reconstructs EXACTLY the live envelopes.
      const rep = await readSessionLog(a.file);
      expect(rep.issues, tag).toEqual([]);
      expect(rep.ok, tag).toBe(true);
      expect(rep.events, tag).toEqual(a.live);
      // Rewrite via writer ⇒ same bytes ⇒ same reconstruction.
      expect(b.raw, tag).toBe(a.raw);
      const repB = await readSessionLog(b.file);
      expect(repB.events, tag).toEqual(rep.events);

      // Envelope contract: real schema, SCHEMA_VERSION, monotonic gap-free seq.
      rep.events.forEach((e, idx) => {
        expect(SessionEventEnvelopeSchema.parse(e).schemaVersion, tag).toBe(SESSION_SCHEMA_VERSION);
        expect(e.seq, tag).toBe(idx + 1);
      });
      expect(validateSessionTrace(rep.events, 'strict'), tag).toEqual([]);

      // (b) deriveMessages(replay) == deriveMessages(live execution), both modes.
      expect(deriveMessages(rep.events), tag).toEqual(deriveMessages(a.live));
      expect(deriveMessages(rep.events, { includeToolCalls: true }), tag).toEqual(
        deriveMessages(a.live, { includeToolCalls: true }),
      );
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 120_000);

  it('damaged log: tolerant replay reports the damage and invents nothing', async () => {
    for (let i = 0; i < SEQUENCES; i++) {
      const seed = BASE_SEED + i;
      const rand = mulberry32(seed);
      const inputs = genInputs(rand, 6 + Math.floor(rand() * 30));
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zelari-a1-'));
      const tag = `seed=${seed}`;
      const a = await writeSeq(path.join(root, 'a'), `fuzz-${seed}`, seed, inputs);
      const lines = a.raw.trimEnd().split('\n');
      const dmg = mulberry32(seed + 977); // independent stream for damage choices
      const liveMsgs = deriveMessages(a.live);

      // (c1) an event line vanishes mid-log (lost append): flagged as seq-gap,
      // survivors byte-identical to execution — never renumbered, never invented.
      const dropIdx = 1 + Math.floor(dmg() * (lines.length - 2)); // 0-based, never first/last
      const dropped = lines.filter((_, j) => j !== dropIdx).join('\n') + '\n';
      const file1 = path.join(root, 'dropped.jsonl');
      await fs.writeFile(file1, dropped, 'utf-8');
      const rep1 = await readSessionLog(file1);
      expect(rep1.ok, tag).toBe(false);
      expect(rep1.issues.map((x) => x.type), tag).toEqual(['seq-gap']);
      expect(rep1.events.length, tag).toBe(lines.length - 1);
      for (const e of rep1.events) expect(e, tag).toEqual(a.live[e.seq - 1]);
      expect(deriveMessages(rep1.events), tag).toEqual(liveMsgs.filter((m) => m.seq !== dropIdx + 1));

      // (c2) crash mid-append tears a line: corrupt-line + exact intact prefix
      // (coherent recovery of what really reached disk — no invented tail).
      const cutIdx = 1 + Math.floor(dmg() * (lines.length - 1)); // 0-based, at least line 1 stays
      let cut = 0;
      for (let j = 0; j < cutIdx; j++) cut += lines[j].length + 1;
      cut += Math.floor(lines[cutIdx].length / 2);
      const file2 = path.join(root, 'torn.jsonl');
      await fs.writeFile(file2, a.raw.slice(0, cut), 'utf-8');
      const rep2 = await readSessionLog(file2);
      expect(rep2.ok, tag).toBe(false);
      expect(rep2.issues, tag).toEqual([{ type: 'corrupt-line', line: cutIdx + 1 }]);
      expect(rep2.events, tag).toEqual(a.live.slice(0, cutIdx));
      expect(deriveMessages(rep2.events), tag).toEqual(liveMsgs.filter((m) => m.seq <= cutIdx));

      // (c3) corrupted payload (schema-invalid kind): skipped AND flagged —
      // schema-mismatch plus the seq hole it leaves, never silently patched.
      const badIdx = 1 + Math.floor(dmg() * (lines.length - 2)); // 0-based, never first/last
      const tampered = JSON.parse(lines[badIdx]) as SessionEventEnvelope;
      tampered.kind = 'retired.kind' as SessionEventKind;
      const file3 = path.join(root, 'schema.jsonl');
      await fs.writeFile(
        file3,
        lines.map((l, j) => (j === badIdx ? JSON.stringify(tampered) : l)).join('\n') + '\n',
        'utf-8',
      );
      const rep3 = await readSessionLog(file3);
      expect(rep3.ok, tag).toBe(false);
      expect(rep3.issues.map((x) => x.type), tag).toEqual(['schema-mismatch', 'seq-gap']);
      expect(rep3.events.length, tag).toBe(lines.length - 1);
      for (const e of rep3.events) expect(e, tag).toEqual(a.live[e.seq - 1]);
      expect(deriveMessages(rep3.events), tag).toEqual(liveMsgs.filter((m) => m.seq !== badIdx + 1));

      await fs.rm(root, { recursive: true, force: true });
    }
  }, 120_000);
});
