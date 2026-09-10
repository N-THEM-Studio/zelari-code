/**
 * Int4a — incremental replay cache.
 *
 * Coverage (kill switch default OFF):
 *   1. growing file: only the NEW bytes are parsed (fs.readFile spy) and the
 *      running seq state survives the incremental read;
 *   2. truncation / size < byteSize ⇒ full re-read of the shorter log;
 *   3. torn last line: not an event, and exactly once after it completes;
 *   4. bit-equivalence with `readSessionLog` (happy / gap / duplicate / corrupt
 *      / non-ASCII, cold AND warm-cache reads);
 *   5. kill switch: unset and '0' ⇒ verbatim `readSessionLog`, nothing cached;
 *   6. the returned report arrays are detached from the cache.
 *
 * Wiring test note: the production call-sites live in the CLI package
 * (src/cli/sessionSpine.ts, headlessSpine.ts, budget/restoreRuntime.ts,
 * harnessState.ts) which @zelari/core must not import — the wiring is therefore
 * verified by the CLI suites (sessionSpine/headlessSpine/…) running with the
 * flag OFF (bit-identical path) plus the `// PERF-4a: session log cache`
 * markers at each call-site, and here by the module-level contract above.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readSessionLog } from './replay.js';
import { SessionLogCache, isReplayCacheEnabled, readSessionLogCached } from './replayCache.js';
import type { SessionEventEnvelope } from './types.js';

const ENV = 'ZELARI_SPINE_REPLAY_CACHE';

let tmpDir: string | null = null;

async function tmpFile(content: string | Buffer): Promise<string> {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zelari-replaycache-test-'));
  const file = path.join(tmpDir, 'events.jsonl');
  await fs.writeFile(file, content);
  return file;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  delete process.env[ENV];
  if (tmpDir) {
    await fs.rm(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  }
});

/** Writer-shaped line (the JSONL writer always appends `line + '\n'`). */
function line(seq: number, kind = 'note', data: Record<string, unknown> = {}): string {
  const e: SessionEventEnvelope = {
    schemaVersion: 1,
    sessionId: 's',
    seq,
    ts: 1755000000000 + seq,
    kind: kind as SessionEventEnvelope['kind'],
    actor: { type: 'system' },
    data,
  };
  return JSON.stringify(e);
}

const seqs = (report: { events: readonly SessionEventEnvelope[] }) => report.events.map((e) => e.seq);

/** Read through the cache with the flag ON (tests opt in explicitly). */
async function cached(filePath: string, cache: SessionLogCache) {
  vi.stubEnv(ENV, '1');
  return readSessionLogCached(filePath, cache);
}

describe('replayCache (Int4a)', () => {
  it('kill switch is OFF by default and only 1/true/yes/on enable it', () => {
    expect(isReplayCacheEnabled({})).toBe(false);
    expect(isReplayCacheEnabled({ [ENV]: '' })).toBe(false);
    expect(isReplayCacheEnabled({ [ENV]: '0' })).toBe(false);
    expect(isReplayCacheEnabled({ [ENV]: 'false' })).toBe(false);
    expect(isReplayCacheEnabled({ [ENV]: 'off' })).toBe(false);
    expect(isReplayCacheEnabled({ [ENV]: '1' })).toBe(true);
    expect(isReplayCacheEnabled({ [ENV]: ' true ' })).toBe(true);
    expect(isReplayCacheEnabled({ [ENV]: 'yes' })).toBe(true);
    expect(isReplayCacheEnabled({ [ENV]: 'ON' })).toBe(true);
  });

  it('growth: parses only the appended bytes and keeps the seq/line state', async () => {
    const head = `${line(1, 'session.started')}\n${line(2, 'user.message')}\n`;
    const file = await tmpFile(head);
    const cache = new SessionLogCache();
    const readFileSpy = vi.spyOn(fs, 'readFile');

    const cold = await cached(file, cache);
    expect(seqs(cold)).toEqual([1, 2]);
    expect(readFileSpy).toHaveBeenCalledTimes(1); // one full read, once
    expect(cache.peek(file)?.byteSize).toBe(Buffer.byteLength(head, 'utf8'));

    // Append three complete lines — and one seq-duplicate, to prove the running
    // `expected` seq (not just the events) survived the incremental read.
    const appended = `${line(3, 'assistant.message')}\n${line(4, 'tool.call')}\n${line(2)}\n`;
    await fs.appendFile(file, appended);
    const warm = await cached(file, cache);

    expect(readFileSpy).toHaveBeenCalledTimes(1); // NO full read on the append path
    expect(seqs(warm)).toEqual([1, 2, 3, 4]);
    expect(warm.issues).toEqual([{ type: 'seq-duplicate', line: 5, seq: 2 }]);
    expect(warm.ok).toBe(false);
    // Issue line numbers stay absolute: line 5 is the duplicate in the WHOLE file.
    expect(cache.peek(file)?.expectedSeq).toBe(5);
    expect(cache.peek(file)?.linesConsumed).toBe(5);
    expect(cache.peek(file)?.byteSize).toBe(Buffer.byteLength(head + appended, 'utf8'));
  });

  it('a repeated read with no new bytes does no I/O at all', async () => {
    const file = await tmpFile(`${line(1)}\n`);
    const cache = new SessionLogCache();
    await cached(file, cache);
    const readFileSpy = vi.spyOn(fs, 'readFile');
    const again = await cached(file, cache);
    expect(readFileSpy).not.toHaveBeenCalled();
    expect(seqs(again)).toEqual([1]);
  });

  it('truncation (size < byteSize) falls back to a full re-read', async () => {
    const file = await tmpFile(`${line(1)}\n${line(2)}\n${line(3)}\n`);
    const cache = new SessionLogCache();
    expect(seqs(await cached(file, cache))).toEqual([1, 2, 3]);

    // Rotation: the log is replaced by a SHORTER one (new session on the path).
    await fs.writeFile(file, `${line(1, 'session.started')}\n`);
    const after = await cached(file, cache);
    expect(after).toEqual(await readSessionLog(file));
    expect(seqs(after)).toEqual([1]);
    expect(cache.peek(file)?.byteSize).toBe(Buffer.byteLength(await fs.readFile(file, 'utf8'), 'utf8'));
  });

  it('a torn last line is never an event and appears exactly once when completed', async () => {
    const file = await tmpFile(`${line(1, 'session.started')}\n`);
    const cache = new SessionLogCache();
    expect(seqs(await cached(file, cache))).toEqual([1]);

    // Writer crash mid-line: no trailing '\n'. Not parseable yet.
    await fs.appendFile(file, `${line(2, 'user.message').slice(0, -3)}`);
    const torn = await cached(file, cache);
    expect(seqs(torn)).toEqual([1]);
    expect(torn.issues).toEqual([]);
    expect(torn.ok).toBe(true);
    expect(cache.peek(file)?.partial).not.toBe('');
    expect(cache.peek(file)?.partial).not.toContain('�'); // never U+FFFD

    // The writer retries/completes the line: it lands ONCE (never duplicated).
    await fs.appendFile(file, `${line(2, 'user.message').slice(-3)}\n`);
    const completed = await cached(file, cache);
    expect(seqs(completed)).toEqual([1, 2]);
    expect(completed.issues).toEqual([]);
    expect(cache.peek(file)?.partial).toBe('');
    // …and a refreshed read of the same log agrees.
    expect(completed).toEqual(await readSessionLog(file));
  });

  it('a torn MULTI-BYTE character is re-read from a boundary (no mangling)', async () => {
    const text = 'città — 完了 ✓';
    const file = await tmpFile(`${line(1, 'session.started')}\n`);
    const cache = new SessionLogCache();
    await cached(file, cache);

    const full = Buffer.from(`${line(2, 'user.message', { text })}\n`, 'utf8');
    await fs.appendFile(file, full.subarray(0, full.length - 2)); // split inside the final char
    const torn = await cached(file, cache);
    expect(seqs(torn)).toEqual([1]); // incomplete sequence ⇒ not consumed

    await fs.appendFile(file, full.subarray(full.length - 2));
    const completed = await cached(file, cache);
    expect(seqs(completed)).toEqual([1, 2]);
    expect((completed.events[1]!.data as { text: string }).text).toBe(text);
    expect(completed).toEqual(await readSessionLog(file));
  });

  it('is bit-equivalent to readSessionLog (cold and warm) for every log shape', async () => {
    const good = (n: number) => `${line(n, 'session.started')}\n`;
    const logs: Array<[string, string]> = [
      ['happy', [1, 2, 3].map(good).join('')],
      ['seq-gap', `${good(1)}${good(3)}${good(4)}`],
      ['duplicate', `${good(1)}${good(2)}${good(2)}${good(3)}`],
      ['corrupt', `${good(1)}NOT JSON {{\n${good(2)}\n`],
      ['schema-mismatch', `${JSON.stringify({ ...JSON.parse(line(1)), schemaVersion: 99 })}\n${good(2)}`],
      ['non-ascii', `${line(1, 'user.message', { text: 'perché — tèst ✓' })}\n${line(2, 'assistant.message', { text: '日本語' })}\n`],
      ['blank-lines', `\n${good(1)}\n\n${good(2)}\n`],
      ['torn-tail', `${good(1)}${good(2).slice(0, -2)}`],
      ['empty', ''],
    ];
    for (const [name, content] of logs) {
      const file = await tmpFile(content);
      const plain = await readSessionLog(file);
      const cache = new SessionLogCache();
      expect(await cached(file, cache), `${name}: cold`).toEqual(plain);
      expect(await cached(file, cache), `${name}: warm (no-op)`).toEqual(plain);
    }
  });

  it('is bit-equivalent for a log appended between two reads (warm growth)', async () => {
    const head = `${line(1, 'session.started')}\n${line(2, 'user.message')}\n`;
    const tail = `${line(3, 'assistant.message')}\nNOT JSON\n${line(4, 'tool.call')}\n`;
    const file = await tmpFile(head);
    const cache = new SessionLogCache();
    await cached(file, cache); // warm the cache at `head`
    await fs.appendFile(file, tail);
    expect(await cached(file, cache)).toEqual(await readSessionLog(file));
    expect(cache.peek(file)?.linesConsumed).toBe(5);
  });

  it('kill switch off (unset or 0) calls readSessionLog verbatim and caches nothing', async () => {
    const file = await tmpFile(`${line(1)}\n`);
    const cache = new SessionLogCache();
    const plain = await readSessionLog(file);
    const readFileSpy = vi.spyOn(fs, 'readFile');

    for (const value of [undefined, '0', 'false', 'off']) {
      if (value === undefined) vi.stubEnv(ENV, undefined as unknown as string);
      else vi.stubEnv(ENV, value);
      expect(await readSessionLogCached(file, cache)).toEqual(plain);
    }
    expect(readFileSpy).toHaveBeenCalledTimes(4); // full read every time
    expect(cache.size).toBe(0); // no entry, no state
    // A missing cache behaves identically even with the flag ON.
    vi.stubEnv(ENV, '1');
    expect(await readSessionLogCached(file)).toEqual(plain);
  });

  it('returns a report detached from the cache', async () => {
    const file = await tmpFile(`${line(1)}\n`);
    const cache = new SessionLogCache();
    const first = await cached(file, cache);
    first.events.push({ ...first.events[0]!, seq: 99 } as SessionEventEnvelope);
    first.issues.push({ type: 'corrupt-line', line: 99 });

    const second = await cached(file, cache);
    expect(seqs(second)).toEqual([1]);
    expect(second.issues).toEqual([]);
    expect(second.ok).toBe(true);
  });

  it('reports a missing file as an empty ok report (tolerant, like readSessionLog)', async () => {
    const cache = new SessionLogCache();
    const missing = path.join(os.tmpdir(), 'zelari-no-such-events.jsonl');
    expect(await cached(missing, cache)).toEqual(await readSessionLog(missing));
    // Delete-after-cache also degrades to the same empty report and drops the entry.
    const file = await tmpFile(`${line(1)}\n`);
    await cached(file, cache);
    await fs.rm(file);
    expect(await cached(file, cache)).toEqual({ path: file, events: [], issues: [], ok: true });
    expect(cache.peek(file)).toBeUndefined();
  });
});
