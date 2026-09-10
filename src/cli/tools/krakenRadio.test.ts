import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { appendKrakenRadio, readKrakenRadio } from './krakenRadio.js';

const radioFile = (cwd: string, sessionId: string): string =>
  path.join(cwd, '.zelari', 'radio', `${sessionId}.jsonl`);

const lines = (file: string): string[] =>
  (readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean));

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
});
