import { describe, expect, it } from 'vitest';
import { analyzeScope, parseNameOnlyDiff } from './scopeDiscipline.js';

describe('parseNameOnlyDiff', () => {
  it('splits git diff --name-only output', () => {
    expect(parseNameOnlyDiff('src/a.ts\npackage-lock.json\n\njs\\b.js\n')).toEqual([
      'src/a.ts',
      'package-lock.json',
      'js/b.js',
    ]);
  });
});

describe('analyzeScope', () => {
  it('pass when every source change is expected', () => {
    const r = analyzeScope({
      changedFiles: ['js/lights.js', 'package-lock.json'],
      expectedFiles: ['js/lights.js'],
    });
    expect(r.status).toBe('pass');
    expect(r.unexpected).toEqual([]);
    expect(r.generated).toEqual(['package-lock.json']);
  });

  it('concern for unexpected source files, not a hard fail', () => {
    const r = analyzeScope({
      changedFiles: ['js/lights.js', 'progress.html'],
      expectedFiles: ['js/lights.js'],
    });
    expect(r.status).toBe('concern');
    expect(r.unexpected).toEqual(['progress.html']);
  });

  it('unknown without an allowlist or without changes', () => {
    expect(analyzeScope({ changedFiles: ['a.ts'] }).status).toBe('unknown');
    expect(analyzeScope({ changedFiles: [], expectedFiles: ['a.ts'] }).status).toBe('unknown');
  });
});
