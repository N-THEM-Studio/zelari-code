/**
 * dryRun.test.ts — the F2 channel seam (adapter + registry). Hermetic.
 */
import { describe, expect, it } from 'vitest';
import { createDryRunAdapter } from './dryRun.js';
import { DRY_RUN_CHANNELS, resolveChannelAdapter } from './registry.js';

describe('createDryRunAdapter', () => {
  it('returns a deterministic DRY-RUN result and never touches the network', async () => {
    const adapter = createDryRunAdapter('x', 'RUN1');
    const res = await adapter.publish({ text: 'hi' });
    expect(res.dryRun).toBe(true);
    expect(res.url).toContain('dry-run');
    expect(res.url).toContain('/x/RUN1');
    expect(res.postId).toBe('dry-x-RUN1');

    const again = await adapter.publish({ text: 'anything else' });
    expect(again).toEqual(res);
  });
});

describe('resolveChannelAdapter', () => {
  it('maps every supported channel to a dry-run adapter carrying its id', () => {
    for (const id of DRY_RUN_CHANNELS) {
      const adapter = resolveChannelAdapter(id, 'RUN2');
      expect(adapter.id).toBe(id);
    }
  });

  it('throws a clear error for an unknown channel id', () => {
    expect(() => resolveChannelAdapter('mastodon', 'RUN3')).toThrow(/unknown channel: mastodon/);
  });
});
