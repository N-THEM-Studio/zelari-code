import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { appendKrakenRadio, listKrakenRadioSessions, readKrakenRadio } from './krakenRadio.js';

const radioFile = (cwd: string, sessionId: string): string =>
  path.join(cwd, '.zelari', 'radio', `${sessionId}.jsonl`);

const lines = (file: string): string[] =>
  (readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean));

/** Raw-file reader: what a Desktop / workspace test sees without the module. */
const rawDescriptions = (file: string): string[] =>
  lines(file).map((line) => (JSON.parse(line) as { description: string }).description);

describe('krakenRadio progress events', () => {
  it('append + read roundtrip keeps kind/agent/detail (tmp dir)', () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'zelari-radio-'));
    try {
      appendKrakenRadio(cwd, 'radio-test', {
        kind: 'progress',
        agent: 'general',
        thoroughness: 'medium',
        description: 'impl slice',
        detail: 'phase: general',
      });
      appendKrakenRadio(cwd, 'radio-test', {
        kind: 'progress',
        agent: 'verify',
        description: 'verify: impl slice',
        detail: 'verifying…',
      });

      const events = readKrakenRadio(cwd, 'radio-test', 10);
      expect(events).toHaveLength(2);
      const [first, second] = events;
      expect(first.kind).toBe('progress');
      expect(first.agent).toBe('general');
      expect(first.description).toBe('impl slice');
      expect(first.detail).toBe('phase: general');
      expect(typeof first.ts).toBe('string');
      expect(second.kind).toBe('progress');
      expect(second.agent).toBe('verify');
      expect(second.detail).toBe('verifying…');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('the line is on disk when appendKrakenRadio returns (raw-file readers)', () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'zelari-radio-durable-'));
    try {
      appendKrakenRadio(cwd, 'durable', { kind: 'progress', agent: 'general', description: 'd0' });
      // Int 3a keeps the synchronous contract: workspace tests and the Desktop
      // read `.zelari/radio/<session>.jsonl` directly, so a deferred write is
      // observable. No await here on purpose.
      expect(lines(radioFile(cwd, 'durable'))).toHaveLength(1);
      appendKrakenRadio(cwd, 'durable', { kind: 'progress', agent: 'general', description: 'd1' });
      const raw = lines(radioFile(cwd, 'durable')).map((line) => JSON.parse(line) as { description: string });
      expect(raw.map((event) => event.description)).toEqual(['d0', 'd1']);
      expect(readKrakenRadio(cwd, 'durable', 10)).toHaveLength(2);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('N=100 bursts land as 100 complete JSONL lines in emission order', () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'zelari-radio-burst-'));
    const total = 100;
    try {
      for (let i = 0; i < total; i += 1) {
        appendKrakenRadio(cwd, 'burst', {
          kind: 'progress',
          agent: 'general',
          description: `burst-${i}`,
          detail: `phase: ${i}`,
        });
      }

      const parsed = lines(radioFile(cwd, 'burst')).map(
        (line) => JSON.parse(line) as { description: string; detail: string },
      );
      expect(parsed).toHaveLength(total);
      expect(parsed.map((event) => event.description)).toEqual(
        Array.from({ length: total }, (_, i) => `burst-${i}`),
      );
      // The write path must not corrupt, drop or duplicate rows.
      expect(new Set(parsed.map((event) => event.detail)).size).toBe(total);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('keeps every event readable in the same tick and across sinks', () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'zelari-radio-sinks-'));
    try {
      for (let i = 0; i < 3; i += 1) {
        appendKrakenRadio(cwd, 'sess-a', { kind: 'progress', agent: 'general', description: `a${i}` });
        appendKrakenRadio(cwd, 'sess-b', { kind: 'progress', agent: 'general', description: `b${i}` });
      }
      expect(readKrakenRadio(cwd, 'sess-a', 10).map((event) => event.description)).toEqual(['a0', 'a1', 'a2']);
      expect(readKrakenRadio(cwd, 'sess-b', 10).map((event) => event.description)).toEqual(['b0', 'b1', 'b2']);
      expect(lines(radioFile(cwd, 'sess-a'))).toHaveLength(3);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('a sessionId-less writer never collapses onto a shared default.jsonl (Desktop cross-talk)', () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'zelari-radio-nosession-'));
    try {
      // Two appends with no session id: one process, so one file (a per-call
      // timestamp would scatter the trail across several).
      appendKrakenRadio(cwd, '', { kind: 'progress', agent: 'general', description: 'n0' });
      appendKrakenRadio(cwd, '', { kind: 'progress', agent: 'general', description: 'n1' });

      const dir = path.join(cwd, '.zelari', 'radio');
      const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
      expect(files).toHaveLength(1);
      // The old fallback was the literal 'default', which made EVERY
      // sessionId-less process append to the same file: two runs interleaved
      // their events and a reader could not tell them apart.
      expect(files[0]).not.toBe('default.jsonl');
      expect(files[0]).toMatch(/^default-\d+-[0-9a-z]+\.jsonl$/);

      // Writer and reader of the same process agree on that one file.
      expect(readKrakenRadio(cwd, '', 10).map((event) => event.description)).toEqual(['n0', 'n1']);
      expect(listKrakenRadioSessions(cwd)).toEqual([files[0].replace(/\.jsonl$/, '')]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  // F18 (K3.5): the fd cache keeps an append-mode descriptor per file. An
  // unlink/rotation leaves that descriptor pointing at the ORPHAN inode, and
  // because `writeSync` on it keeps succeeding the old catch-with-fallback
  // never fired: the event was written, reported OK, and was invisible to
  // every reader of the live `.jsonl`. Revalidate the fd against the path on
  // EVERY cached append.
  it('after-unlink: a cached fd on a deleted inode is reopened so the new line lands on the live path', () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'zelari-radio-unlink-'));
    try {
      appendKrakenRadio(cwd, 'unlink', { kind: 'progress', agent: 'general', description: 'before-unlink' });
      const file = radioFile(cwd, 'unlink');
      // The append above cached an fd on this inode (same process, same path).
      expect(rawDescriptions(file)).toEqual(['before-unlink']);

      rmSync(file, { force: true });
      expect(existsSync(file)).toBe(false);

      appendKrakenRadio(cwd, 'unlink', { kind: 'progress', agent: 'general', description: 'after-unlink' });

      // The pre-unlink line died with its inode — that is expected and not
      // what this test asserts. The NEW line must be on the live path.
      expect(existsSync(file)).toBe(true);
      expect(rawDescriptions(file)).toEqual(['after-unlink']);
      expect(readKrakenRadio(cwd, 'unlink', 10).map((event) => event.description)).toEqual(['after-unlink']);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('after-rotate: a renamed jsonl keeps its old line while new appends go to the live path', () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'zelari-radio-rotate-'));
    try {
      appendKrakenRadio(cwd, 'rotate', { kind: 'progress', agent: 'general', description: 'before-rotate' });
      const file = radioFile(cwd, 'rotate');
      const rotated = `${file}.1`;
      renameSync(file, rotated); // logrotate-style rotation, cached fd still open
      expect(existsSync(file)).toBe(false);

      appendKrakenRadio(cwd, 'rotate', { kind: 'progress', agent: 'general', description: 'after-rotate' });

      expect(existsSync(file)).toBe(true);
      expect(readKrakenRadio(cwd, 'rotate', 10).map((event) => event.description)).toEqual(['after-rotate']);
      // The rotated file keeps exactly the pre-rotation line: a write into the
      // orphan inode would append 'after-rotate' into the archive instead.
      expect(rawDescriptions(rotated)).toEqual(['before-rotate']);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('after-replace: a new file at the same path (fresh inode) is not shadowed by the cached fd', () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'zelari-radio-replace-'));
    try {
      appendKrakenRadio(cwd, 'replace', { kind: 'progress', agent: 'general', description: 'before-replace' });
      const file = radioFile(cwd, 'replace');

      // The path exists throughout, but the INODE behind it changed:
      // comparing dev+ino (not just an existsSync check) is what catches this.
      // Honest limit: on a filesystem reporting dev/ino as 0 the comparison
      // cannot discriminate and this test would not hold.
      rmSync(file, { force: true });
      writeFileSync(
        file,
        `${JSON.stringify({ ts: new Date().toISOString(), kind: 'progress', agent: 'other', description: 'handwritten' })}\n`,
        'utf8',
      );
      expect(existsSync(file)).toBe(true);

      appendKrakenRadio(cwd, 'replace', { kind: 'progress', agent: 'general', description: 'after-replace' });

      expect(rawDescriptions(file)).toEqual(['handwritten', 'after-replace']);
      expect(readKrakenRadio(cwd, 'replace', 10).map((event) => event.description)).toEqual([
        'handwritten',
        'after-replace',
      ]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
