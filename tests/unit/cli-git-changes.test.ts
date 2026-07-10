import { describe, it, expect } from 'vitest';
import {
  parseNumstat,
  parseUntracked,
  mergeChanges,
  normalizeRenamePath,
} from '../../src/cli/hooks/useGitChanges.js';
import { shortenCwd } from '../../src/cli/utils/paths.js';
import { shouldShowSidebar, truncatePath, SIDEBAR_MIN_COLUMNS } from '../../src/cli/components/Sidebar.js';

describe('parseNumstat', () => {
  it('parses added/removed/path lines', () => {
    const out = '12\t3\tsrc/cli/app.tsx\n0\t45\tREADME.md\n';
    expect(parseNumstat(out)).toEqual([
      { path: 'src/cli/app.tsx', added: 12, removed: 3, untracked: false },
      { path: 'README.md', added: 0, removed: 45, untracked: false },
    ]);
  });

  it('maps binary files (-) to null counts', () => {
    const [f] = parseNumstat('-\t-\tassets/logo.png\n');
    expect(f).toEqual({ path: 'assets/logo.png', added: null, removed: null, untracked: false });
  });

  it('ignores blank/malformed lines', () => {
    expect(parseNumstat('\n\nnot-a-numstat-line\n')).toEqual([]);
  });

  it('collapses rename notation to the new path', () => {
    const out = '5\t0\tsrc/{old => new}/file.ts\n1\t1\told.ts => new.ts\n';
    expect(parseNumstat(out).map((f) => f.path)).toEqual(['src/new/file.ts', 'new.ts']);
  });
});

describe('normalizeRenamePath', () => {
  it('passes plain paths through', () => {
    expect(normalizeRenamePath('a/b/c.ts')).toBe('a/b/c.ts');
  });
  it('handles braced renames with prefix/suffix', () => {
    expect(normalizeRenamePath('src/{cli => core}/x.ts')).toBe('src/core/x.ts');
  });
  it('handles whole-path renames', () => {
    expect(normalizeRenamePath('old.ts => new.ts')).toBe('new.ts');
  });
});

describe('parseUntracked', () => {
  it('extracts only ?? entries', () => {
    const out = ' M src/a.ts\n?? new-file.ts\nA  staged.ts\n?? "with space.ts"\n';
    expect(parseUntracked(out)).toEqual(['new-file.ts', 'with space.ts']);
  });
});

describe('mergeChanges', () => {
  it('sums staged + unstaged counts per path and sorts by churn', () => {
    const unstaged = [
      { path: 'a.ts', added: 1, removed: 1, untracked: false },
      { path: 'b.ts', added: 100, removed: 0, untracked: false },
    ];
    const staged = [{ path: 'a.ts', added: 4, removed: 2, untracked: false }];
    const merged = mergeChanges(unstaged, staged, []);
    expect(merged[0]).toEqual({ path: 'b.ts', added: 100, removed: 0, untracked: false });
    expect(merged[1]).toEqual({ path: 'a.ts', added: 5, removed: 3, untracked: false });
  });

  it('null (binary) counts stay null after merge', () => {
    const merged = mergeChanges(
      [{ path: 'x.png', added: null, removed: null, untracked: false }],
      [{ path: 'x.png', added: 3, removed: 1, untracked: false }],
      [],
    );
    expect(merged[0].added).toBeNull();
    expect(merged[0].removed).toBeNull();
  });

  it('appends untracked files last, without duplicating tracked paths', () => {
    const merged = mergeChanges(
      [{ path: 'a.ts', added: 1, removed: 0, untracked: false }],
      [],
      ['new.ts', 'a.ts'],
    );
    expect(merged.map((f) => f.path)).toEqual(['a.ts', 'new.ts']);
    expect(merged[1].untracked).toBe(true);
  });
});

describe('shortenCwd', () => {
  it('collapses the home prefix to ~', () => {
    expect(shortenCwd('C:\\Users\\andre\\proj', 40, 'C:\\Users\\andre')).toBe('~\\proj');
    expect(shortenCwd('/home/andre/proj', 40, '/home/andre')).toBe('~/proj');
  });
  it('keeps the tail when longer than maxLen', () => {
    const out = shortenCwd('/very/long/path/to/some/deep/project', 12, '/nope');
    expect(out.length).toBe(12);
    expect(out.startsWith('…')).toBe(true);
    expect(out.endsWith('project')).toBe(true);
  });
  it('does not collapse sibling dirs that merely share the home prefix string', () => {
    expect(shortenCwd('/home/andrea/x', 40, '/home/andre')).toBe('/home/andrea/x');
  });
});

describe('Sidebar helpers', () => {
  it('shouldShowSidebar gates on width and height', () => {
    expect(shouldShowSidebar(SIDEBAR_MIN_COLUMNS, 30)).toBe(true);
    expect(shouldShowSidebar(SIDEBAR_MIN_COLUMNS - 1, 30)).toBe(false);
    expect(shouldShowSidebar(200, 10)).toBe(false);
  });

  it('sidebarVisibility uses hysteresis so resize edges do not thrash', async () => {
    const { sidebarVisibility, SIDEBAR_HIDE_COLUMNS } = await import(
      '../../src/cli/components/Sidebar.js'
    );
    // Enter at 96×30
    expect(sidebarVisibility(96, 30, false)).toBe(true);
    // Stay visible slightly below enter threshold
    expect(sidebarVisibility(90, 30, true)).toBe(true);
    // Only hide once past the hide floor
    expect(sidebarVisibility(SIDEBAR_HIDE_COLUMNS - 1, 30, true)).toBe(false);
    // Stay hidden until clear enter threshold again
    expect(sidebarVisibility(90, 30, false)).toBe(false);
  });
  it('truncatePath keeps the filename tail', () => {
    expect(truncatePath('src/cli/components/Sidebar.tsx', 12)).toBe('…Sidebar.tsx');
    expect(truncatePath('short.ts', 12)).toBe('short.ts');
  });
});
