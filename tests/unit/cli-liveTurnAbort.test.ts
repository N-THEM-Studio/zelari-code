import { afterEach, describe, expect, it } from 'vitest';
import {
  getLiveTurnControl,
  runWithSession,
} from '../../src/cli/serve/sessionControl.js';
import { attachHeadlessLiveCancel } from '../../src/cli/headless/liveTurnAbort.js';

const SERVE_ENV = 'ZELARI_SERVE_HARNESS';

describe('attachHeadlessLiveCancel', () => {
  afterEach(() => {
    delete process.env[SERVE_ENV];
  });

  it('registers under the serve-harness session so session.cancel is live', () => {
    process.env[SERVE_ENV] = '1';
    runWithSession('sess-council', () => {
      const live = attachHeadlessLiveCancel({ output: 'json' });
      try {
        const control = getLiveTurnControl('sess-council');
        expect(control).toBeDefined();
        expect(live.signal.aborted).toBe(false);
        expect(control!.cancel()).toBe(true);
        expect(live.signal.aborted).toBe(true);
        expect(control!.cancel()).toBe(true);
      } finally {
        live.dispose();
      }
      expect(getLiveTurnControl('sess-council')).toBeUndefined();
    });
  });

  it('does not register outside a session dispatch (plain --headless)', () => {
    process.env[SERVE_ENV] = '1';
    const live = attachHeadlessLiveCancel();
    try {
      expect(getLiveTurnControl('no-session')).toBeUndefined();
      expect(live.cancel()).toBe(true);
      expect(live.signal.aborted).toBe(true);
    } finally {
      live.dispose();
    }
  });
});
