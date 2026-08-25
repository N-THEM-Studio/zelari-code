import { describe, expect, it } from 'vitest';
import {
  DuplicateSearchGuard,
  SEARCH_TOOLS,
  extractSearchQuery,
  isSearchTool,
  normalizeQuery,
  queryJaccard,
} from './DuplicateSearchGuard.js';

const identity = { runId: 'r1', agentId: 'a1', role: 'lead', mode: 'kraken' } as const;

let seq = 0;
function call(toolName: string, args: unknown, turn = 1) {
  seq += 1;
  return {
    id: `e${seq}`,
    ts: 1,
    identity,
    turn,
    toolCallId: `tc${seq}`,
    toolName,
    args,
  };
}

describe('isSearchTool / SEARCH_TOOLS', () => {
  it('classifies the search family', () => {
    expect(isSearchTool('grep_content')).toBe(true);
    expect(isSearchTool('semantic_search')).toBe(true);
    expect(isSearchTool('web_search')).toBe(true);
    expect(isSearchTool('list_files')).toBe(true);
    expect(isSearchTool('bash')).toBe(false);
    expect(isSearchTool('read_file')).toBe(false);
    expect(SEARCH_TOOLS.size).toBe(4);
  });
});

describe('normalizeQuery', () => {
  it('lowercases, strips punctuation and collapses whitespace', () => {
    expect(normalizeQuery('  Rate.Limit,   (v2) — BACKOFF!  ')).toBe(
      'rate limit v2 backoff',
    );
  });

  it('keeps identifier separators intact', () => {
    expect(normalizeQuery('refreshToken_handler')).toBe('refreshtoken_handler');
  });
});

describe('jaccardSimilarity', () => {
  it('returns 1 for identical token sets and 0 for disjoint ones', () => {
    expect(queryJaccard('find rate limit code', 'find rate limit code')).toBe(1);
    expect(queryJaccard('find rate limit code', 'migrate database schema')).toBe(0);
  });

  it('returns a fraction for partial overlap', () => {
    // {find,rate,limit,code} vs {find,the,rate,limit,code} → 4/5
    expect(queryJaccard('find rate limit code', 'find the rate limit code')).toBeCloseTo(0.8);
  });
});

describe('extractSearchQuery', () => {
  it('returns undefined for non-search tools and missing queries', () => {
    expect(extractSearchQuery('bash', { command: 'ls' })).toBeUndefined();
    expect(extractSearchQuery('grep_content', { path: 'src' })).toBeUndefined();
    expect(extractSearchQuery('semantic_search', {})).toBeUndefined();
    expect(extractSearchQuery('list_files', {})).toBeUndefined();
  });

  it('scopes grep by path and include, normalizes the pattern', () => {
    const ref = extractSearchQuery('grep_content', {
      pattern: 'Rate.Limit',
      path: 'src/auth',
      include: '*.ts',
    });
    expect(ref).toEqual({ scope: 'src/auth\u0000*.ts', query: 'rate limit' });
  });

  it('scopes list_files by maxDepth', () => {
    expect(extractSearchQuery('list_files', { path: 'src', maxDepth: 1 })?.scope).toBe('1');
    expect(extractSearchQuery('list_files', { path: 'src', maxDepth: 3 })?.scope).toBe('3');
  });
});

describe('DuplicateSearchGuard', () => {
  it('continues on the first search and non-search tools', async () => {
    const guard = new DuplicateSearchGuard();
    expect(await guard.onToolCall(call('bash', { command: 'ls' }))).toEqual({ action: 'continue' });
    expect(
      await guard.onToolCall(call('grep_content', { pattern: 'session', path: 'src' })),
    ).toEqual({ action: 'continue' });
  });

  it('injects on the second identical query in the same scope', async () => {
    const guard = new DuplicateSearchGuard();
    await guard.onToolCall(call('grep_content', { pattern: 'session', path: 'src' }));
    const second = await guard.onToolCall(
      call('grep_content', { pattern: 'session', path: 'src' }),
    );
    expect(second.action).toBe('inject');
  });

  it('stops at stopAfter near-duplicates with code duplicate_search', async () => {
    const guard = new DuplicateSearchGuard();
    let last = { action: 'continue' } as { action: string; code?: string };
    for (let i = 0; i < 5; i++) {
      last = await guard.onToolCall(
        call('semantic_search', { query: 'where is auth handled', k: 8 }),
      );
    }
    expect(last.action).toBe('stop');
    expect(last.code).toBe('duplicate_search');
  });

  it('treats near-identical queries (stopword added) as duplicates', async () => {
    const guard = new DuplicateSearchGuard();
    await guard.onToolCall(call('web_search', { query: 'node vitest pool forks', maxResults: 5 }));
    const second = await guard.onToolCall(
      call('web_search', { query: 'node vitest pool the forks', maxResults: 10 }),
    );
    expect(second.action).toBe('inject');
  });

  it('ignores irrelevant arg differences (maxResults/k) but not scope changes', async () => {
    const guard = new DuplicateSearchGuard();
    await guard.onToolCall(call('semantic_search', { query: 'auth flow', k: 5 }));
    expect(
      (await guard.onToolCall(call('semantic_search', { query: 'auth flow', k: 25 }))).action,
    ).toBe('inject');

    const scoped = new DuplicateSearchGuard();
    await scoped.onToolCall(call('grep_content', { pattern: 'session', path: 'src/a' }));
    expect(
      (await scoped.onToolCall(call('grep_content', { pattern: 'session', path: 'src/b' }))).action,
    ).toBe('continue');
  });

  it('treats different list_files depths as different scopes', async () => {
    const guard = new DuplicateSearchGuard();
    await guard.onToolCall(call('list_files', { path: 'src', maxDepth: 1 }));
    expect(
      (await guard.onToolCall(call('list_files', { path: 'src', maxDepth: 3 }))).action,
    ).toBe('continue');
  });

  it('does not count genuinely different queries as duplicates', async () => {
    const guard = new DuplicateSearchGuard();
    await guard.onToolCall(call('semantic_search', { query: 'auth token refresh flow' }));
    const second = await guard.onToolCall(
      call('semantic_search', { query: 'database migration rollback strategy' }),
    );
    expect(second.action).toBe('continue');
  });

  it('honours a custom exact-match threshold', async () => {
    const guard = new DuplicateSearchGuard({ similarityThreshold: 1 });
    await guard.onToolCall(call('web_search', { query: 'find rate limit code' }));
    expect(
      (await guard.onToolCall(call('web_search', { query: 'find the rate limit code' }))).action,
    ).toBe('continue');
    expect(
      (await guard.onToolCall(call('web_search', { query: 'find rate limit code' }))).action,
    ).toBe('inject');
  });

  it('reset clears all duplicate counters', async () => {
    const guard = new DuplicateSearchGuard();
    await guard.onToolCall(call('grep_content', { pattern: 'session', path: 'src' }));
    await guard.onToolCall(call('grep_content', { pattern: 'session', path: 'src' }));
    guard.reset();
    expect(
      (await guard.onToolCall(call('grep_content', { pattern: 'session', path: 'src' }))).action,
    ).toBe('continue');
  });
});
