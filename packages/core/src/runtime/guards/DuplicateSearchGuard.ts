/**
 * DuplicateSearchGuard — detect repeated or near-identical search queries
 * (Frontier upgrade, PHASE 1B §16).
 *
 * RepetitionGuard catches *identical* calls of any tool; this guard adds
 * query-level awareness for the search family: the same query — or a
 * cosmetically different one — in the same scope counts as a duplicate even
 * when irrelevant args (limits, depth, key order) differ.
 */
import { CONTINUE } from '../observers/types.js';
import type {
  AgentObserver,
  ObserverResult,
  ToolCallEvent,
} from '../observers/types.js';

/** Tools whose primary argument is a search query / target path. */
export const SEARCH_TOOLS: ReadonlySet<string> = new Set([
  'grep_content',
  'semantic_search',
  'web_search',
  'list_files',
]);

export function isSearchTool(tool: string): boolean {
  return SEARCH_TOOLS.has(tool);
}

/** Lowercase, strip punctuation noise, collapse whitespace, cap length. */
export function normalizeQuery(text: string): string {
  return text
    .toLowerCase()
    .replace(/[.,;:!?()"'`—–…]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 512);
}

/** Jaccard similarity of the token sets of two normalized queries. */
export function queryJaccard(a: string, b: string): number {
  const ta = new Set(a.split(' ').filter(Boolean));
  const tb = new Set(b.split(' ').filter(Boolean));
  if (ta.size === 0 && tb.size === 0) return 1;
  if (ta.size === 0 || tb.size === 0) return 0;
  let intersection = 0;
  for (const token of ta) if (tb.has(token)) intersection++;
  const union = ta.size + tb.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export interface SearchQueryRef {
  /** Same-scope bucket: duplicates are only counted within a scope. */
  scope: string;
  /** Normalized query text compared for near-duplicates. */
  query: string;
}

/** Extract the comparable (scope, query) pair for a search-family call. */
export function extractSearchQuery(
  toolName: string,
  args: unknown,
): SearchQueryRef | undefined {
  if (!isSearchTool(toolName)) return undefined;
  const a = (args ?? {}) as Record<string, unknown>;
  switch (toolName) {
    case 'grep_content': {
      if (typeof a.pattern !== 'string' || a.pattern.trim() === '') return undefined;
      const include = Array.isArray(a.include)
        ? a.include.join(',')
        : typeof a.include === 'string'
          ? a.include
          : '';
      return {
        scope: [
          typeof a.path === 'string' ? a.path : '',
          include,
        ].join('\u0000'),
        query: normalizeQuery(a.pattern),
      };
    }
    case 'semantic_search':
    case 'web_search': {
      if (typeof a.query !== 'string' || a.query.trim() === '') return undefined;
      return { scope: '', query: normalizeQuery(a.query) };
    }
    case 'list_files': {
      if (typeof a.path !== 'string' || a.path.trim() === '') return undefined;
      // Depth changes the returned tree, so it belongs to the scope.
      return { scope: String(a.maxDepth ?? ''), query: normalizeQuery(a.path) };
    }
    default:
      return undefined;
  }
}

export interface DuplicateSearchGuardConfig {
  /** Inject a refine message at this many near-duplicate calls (default 2). */
  warnAfter?: number;
  /** Stop the run at this many near-duplicate calls (default 5). */
  stopAfter?: number;
  /** Token-set similarity above which two queries are duplicates (0–1, default 0.8). */
  similarityThreshold?: number;
  /** Recent queries kept per scope bucket for comparison (default 8). */
  window?: number;
  /** Maximum scope buckets retained (FIFO eviction, default 256). */
  maxBuckets?: number;
}

const REFINE_MESSAGE = [
  'Search queries are being repeated with only cosmetic differences in the same scope.',
  'Reuse the results already in context, or change the query/scope meaningfully.',
].join('\n');

interface ScopeBucket {
  recent: string[];
  duplicateCount: number;
}

export class DuplicateSearchGuard implements AgentObserver {
  private readonly buckets = new Map<string, ScopeBucket>();
  private readonly warnAfter: number;
  private readonly stopAfter: number;
  private readonly similarityThreshold: number;
  private readonly window: number;
  private readonly maxBuckets: number;

  constructor(config: DuplicateSearchGuardConfig = {}) {
    this.warnAfter = config.warnAfter ?? 2;
    this.stopAfter = config.stopAfter ?? 5;
    this.similarityThreshold = config.similarityThreshold ?? 0.8;
    this.window = config.window ?? 8;
    this.maxBuckets = config.maxBuckets ?? 256;
  }

  async onToolCall(event: ToolCallEvent): Promise<ObserverResult> {
    const ref = extractSearchQuery(event.toolName, event.args);
    if (!ref) return CONTINUE;

    const key = `${event.toolName}\u0000${ref.scope}`;
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { recent: [], duplicateCount: 0 };
      this.buckets.set(key, bucket);
      this.evictIfNeeded();
    }

    let best = 0;
    for (const previous of bucket.recent) {
      best = Math.max(best, queryJaccard(previous, ref.query));
    }
    bucket.duplicateCount = best >= this.similarityThreshold
      ? bucket.duplicateCount + 1
      : 1;

    bucket.recent.push(ref.query);
    if (bucket.recent.length > this.window) bucket.recent.shift();

    if (bucket.duplicateCount >= this.stopAfter) {
      return {
        action: 'stop',
        reason: `near-duplicate search queries for "${event.toolName}" ` +
          `${bucket.duplicateCount} times in the same scope`,
        code: 'duplicate_search',
      };
    }
    if (bucket.duplicateCount >= this.warnAfter) {
      return {
        action: 'inject',
        message: { role: 'user', kind: 'runtime-warning', content: REFINE_MESSAGE },
      };
    }
    return CONTINUE;
  }

  reset(): void {
    this.buckets.clear();
  }

  private evictIfNeeded(): void {
    while (this.buckets.size > this.maxBuckets) {
      const oldest = this.buckets.keys().next().value;
      if (oldest === undefined) break;
      this.buckets.delete(oldest);
    }
  }
}
