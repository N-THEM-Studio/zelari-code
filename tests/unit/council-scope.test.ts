import { describe, it, expect } from 'vitest';
import {
  classifyTaskScope,
  extractTaskScope,
  taskMatchesNfrKeywords,
  warnIfNfrSpecMissing,
} from '@zelari/core/council';

describe('extractTaskScope', () => {
  it('extracts index.html target from animate request', () => {
    const scope = extractTaskScope({
      userMessage: 'Animate the hero section in index.html with compositor-only motion',
    });
    expect(scope.targets).toContain('index.html');
    expect(scope.keywords.some((k) => k.includes('animate') || k.includes('motion'))).toBe(
      true,
    );
    expect(scope.nfrRelevant).toBe(true);
  });

  it('merges nfr-spec targets and inline budget keyword', () => {
    const scope = extractTaskScope({
      userMessage: 'Ship motion polish',
      nfrSpec: {
        version: 1,
        targets: ['index.html'],
        animation: { compositorOnly: true },
        inlineJs: { maxBytes: 5120 },
      },
    });
    expect(scope.targets).toContain('index.html');
    expect(scope.keywords.some((k) => k.includes('5120'))).toBe(true);
    expect(scope.sources).toContain('nfr-spec');
  });

  it('marks command palette as backlog when only in plan', () => {
    const scope = extractTaskScope({
      userMessage: 'Animate index.html transitions',
      planText: JSON.stringify({
        tasks: [{ name: 'Command palette keyboard shortcuts' }],
      }),
    });
    expect(scope.explicitOut.some((o) => o.includes('command palette'))).toBe(true);
  });

  it('classifies motion task in-scope and palette task backlog', () => {
    const scope = extractTaskScope({
      userMessage: 'Animate index.html',
      planText: '{"tasks":[{"name":"Command palette"}]}',
    });
    expect(
      classifyTaskScope({ name: 'Hero fade-in on index.html' }, scope),
    ).toBe('in-scope');
    expect(
      classifyTaskScope({ name: 'Command palette shortcuts' }, scope),
    ).toBe('backlog');
  });
});

describe('taskMatchesNfrKeywords', () => {
  it('detects motion/perf keywords', () => {
    expect(taskMatchesNfrKeywords('Add compositor-only keyframes')).toBe(true);
    expect(taskMatchesNfrKeywords('Update README only')).toBe(false);
  });
});

describe('warnIfNfrSpecMissing', () => {
  it('warns for nettun on NFR-heavy task without createNfrSpec', () => {
    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (msg: string) => {
      warns.push(String(msg));
    };
    try {
      const fired = warnIfNfrSpecMissing('nettun', 'Motion budget for index.html', [
        'createPlan',
      ]);
      expect(fired).toBe(true);
      expect(warns.some((w) => w.includes('createNfrSpec'))).toBe(true);
    } finally {
      console.warn = orig;
    }
  });

  it('does not warn when createNfrSpec was emitted', () => {
    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (msg: string) => {
      warns.push(String(msg));
    };
    try {
      const fired = warnIfNfrSpecMissing('nettun', 'Motion budget', [
        'createPlan',
        'createNfrSpec',
      ]);
      expect(fired).toBe(false);
      expect(warns).toHaveLength(0);
    } finally {
      console.warn = orig;
    }
  });
});
