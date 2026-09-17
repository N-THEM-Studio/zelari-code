/**
 * types.test.ts — schema acceptance for per-task prompt + model selection.
 * Pins back-compat: spec/run files without the new fields still parse.
 */
import { describe, expect, it } from 'vitest';
import {
  AutomationRunSchema,
  AutomationSpecSchema,
  ModelRefSchema,
  ScheduleSchema,
  SocialPostSpecSchema,
} from './types.js';

function baseSpec(): Record<string, unknown> {
  return {
    id: 'aa',
    name: 'AA',
    kind: 'social_post',
    social_post: { channels: ['x'], topicOrBrief: 'hi' },
  };
}

describe('ModelRefSchema', () => {
  it('accepts {id} and {provider,id}', () => {
    expect(ModelRefSchema.safeParse({ id: 'glm-4.6' }).success).toBe(true);
    expect(ModelRefSchema.safeParse({ provider: 'glm', id: 'glm-4.6' }).success).toBe(true);
  });

  it('rejects a missing/empty id', () => {
    expect(ModelRefSchema.safeParse({}).success).toBe(false);
    expect(ModelRefSchema.safeParse({ provider: 'glm' }).success).toBe(false);
    expect(ModelRefSchema.safeParse({ id: '' }).success).toBe(false);
  });
});

describe('AutomationSpecSchema — model', () => {
  it('parses a spec without model (back-compat)', () => {
    const parsed = AutomationSpecSchema.parse(baseSpec());
    expect(parsed.model).toBeUndefined();
  });

  it('parses a spec with model {provider,id}', () => {
    const parsed = AutomationSpecSchema.parse({ ...baseSpec(), model: { provider: 'glm', id: 'm1' } });
    expect(parsed.model).toEqual({ provider: 'glm', id: 'm1' });
  });

  it('rejects a model without id', () => {
    expect(AutomationSpecSchema.safeParse({ ...baseSpec(), model: { provider: 'glm' } }).success).toBe(
      false,
    );
  });
});

describe('SocialPostSpecSchema — prompt', () => {
  it('parses with a free-form prompt', () => {
    const parsed = SocialPostSpecSchema.parse({
      channels: ['x'],
      topicOrBrief: 'hi',
      prompt: 'Draft about {{brief}}',
    });
    expect(parsed.prompt).toBe('Draft about {{brief}}');
  });

  it('parses without prompt (back-compat)', () => {
    expect(SocialPostSpecSchema.parse({ channels: ['x'], topicOrBrief: 'hi' }).prompt).toBeUndefined();
  });
});

describe('ScheduleSchema — trigger mutual exclusion', () => {
  it('accepts exactly one trigger', () => {
    expect(ScheduleSchema.safeParse({ intervalMin: 30 }).success).toBe(true);
    expect(ScheduleSchema.safeParse({ cron: '0 9 * * *' }).success).toBe(true);
    expect(ScheduleSchema.safeParse({ atLogon: true }).success).toBe(true);
  });

  it('accepts a schedule with no trigger (back-compat)', () => {
    expect(ScheduleSchema.safeParse({ timezone: 'UTC' }).success).toBe(true);
    expect(ScheduleSchema.safeParse({}).success).toBe(true);
  });

  it('rejects atLogon combined with intervalMin', () => {
    expect(ScheduleSchema.safeParse({ atLogon: true, intervalMin: 30 }).success).toBe(false);
  });

  it('rejects atLogon combined with cron', () => {
    expect(ScheduleSchema.safeParse({ atLogon: true, cron: '0 9 * * *' }).success).toBe(false);
  });

  it('rejects intervalMin combined with cron', () => {
    expect(ScheduleSchema.safeParse({ intervalMin: 30, cron: '0 9 * * *' }).success).toBe(false);
  });

  it('a spec with atLogon keeps the flag and no interval (back-compat + new)', () => {
    const parsed = AutomationSpecSchema.parse({ ...baseSpec(), schedule: { atLogon: true } });
    expect(parsed.schedule.atLogon).toBe(true);
    expect(parsed.schedule.intervalMin).toBeUndefined();
  });
});

describe('AutomationRunSchema — draft.generatedBy', () => {
  const baseRun = {
    runId: 'r1',
    automationId: 'aa',
    startedAt: '2026-01-01T00:00:00.000Z',
    status: 'completed',
    exitCode: 0,
  };

  it('persists draft.generatedBy source/provider/model', () => {
    const parsed = AutomationRunSchema.parse({
      ...baseRun,
      draft: { text: 'x', generatedBy: { source: 'llm', provider: 'glm', model: 'm1' } },
    });
    expect(parsed.draft?.generatedBy).toEqual({ source: 'llm', provider: 'glm', model: 'm1' });
  });

  it('accepts generatedBy:{source:static} and a run without generatedBy', () => {
    expect(
      AutomationRunSchema.parse({ ...baseRun, draft: { text: 'x', generatedBy: { source: 'static' } } })
        .draft?.generatedBy?.source,
    ).toBe('static');
    expect(AutomationRunSchema.parse({ ...baseRun, draft: { text: 'x' } }).draft?.generatedBy).toBeUndefined();
  });

  it('rejects an unknown generatedBy source', () => {
    expect(
      AutomationRunSchema.safeParse({
        ...baseRun,
        draft: { text: 'x', generatedBy: { source: 'robot' } },
      }).success,
    ).toBe(false);
  });
});

describe('SocialPostSpecSchema — researchQuery', () => {
  it('parses researchQuery + researchMaxResults', () => {
    const parsed = SocialPostSpecSchema.parse({
      channels: ['x'],
      topicOrBrief: 'hi',
      researchQuery: 'latest AI news',
      researchMaxResults: 5,
    });
    expect(parsed.researchQuery).toBe('latest AI news');
    expect(parsed.researchMaxResults).toBe(5);
  });

  it('rejects out-of-bounds values and stays back-compat without them', () => {
    expect(
      SocialPostSpecSchema.safeParse({ channels: ['x'], topicOrBrief: 'hi', researchQuery: 'x'.repeat(601) })
        .success,
    ).toBe(false);
    expect(
      SocialPostSpecSchema.safeParse({ channels: ['x'], topicOrBrief: 'hi', researchMaxResults: 11 }).success,
    ).toBe(false);
    expect(
      SocialPostSpecSchema.safeParse({ channels: ['x'], topicOrBrief: 'hi', researchMaxResults: 0 }).success,
    ).toBe(false);
    expect(SocialPostSpecSchema.parse({ channels: ['x'], topicOrBrief: 'hi' }).researchQuery).toBeUndefined();
  });
});

describe('AutomationRunSchema — draft.research', () => {
  const baseRun = {
    runId: 'r1',
    automationId: 'aa',
    startedAt: '2026-01-01T00:00:00.000Z',
    status: 'completed',
    exitCode: 0,
  };

  it('persists draft.research and stays back-compat without it', () => {
    const parsed = AutomationRunSchema.parse({
      ...baseRun,
      draft: { text: 'x', research: { query: 'q', provider: 'duckduckgo', hits: 3 } },
    });
    expect(parsed.draft?.research).toEqual({ query: 'q', provider: 'duckduckgo', hits: 3 });
    expect(
      AutomationRunSchema.parse({ ...baseRun, draft: { text: 'x' } }).draft?.research,
    ).toBeUndefined();
  });
});
