import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { appendKrakenRadio, readKrakenRadio } from './krakenRadio.js';

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
});
