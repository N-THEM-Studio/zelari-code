/**
 * Volatile one-pager working set (S4).
 *
 * A request-only system message carrying the LIVE working set — open session
 * todos, the how-we-test index (path + mtime ONLY), verified procedure aliases,
 * and an optional compact recap. Like RESOURCE STATUS it is NEVER persisted on
 * the session spine and never enters rolling history: callers pass it to
 * `buildModelContext` (occupancy) and to the AgentHarness `requestTail` arrow
 * (so the model actually sees it).
 *
 * Fail-open by contract — any throw becomes `[]`; `ZELARI_ONE_PAGER=0`
 * disables it entirely (occupancy identical to today).
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { AgentMessage } from '@zelari/core/harness';
import { formatTodosForModel, listSessionTodos } from '../sessionTodos.js';
import {
  HOW_WE_TEST_RELATIVE,
  listVerifiedProcedureNodes,
  type HowWeTestSource,
} from './howWeTest.js';

/** Hard cap on the emitted system message (chars). */
export const ONE_PAGER_CHAR_CAP = 1500;
/** Marker prefix — occupancy assertions detect the message by this. */
export const ONE_PAGER_PREFIX = 'WORKING SET';

const SECTION_RECAP_CAP = 400;
const MAX_PROCEDURES = 8;
const TRUNCATION_MARKER = '\n…(working set truncated)';

export interface OnePagerOpts {
  /** Project root; defaults to process.cwd(). */
  cwd?: string;
  /** HowWeTestSource-compatible memory handle (needs `export`). */
  memory?: HowWeTestSource | null;
  /** When this turn compacted, skip the recap section. */
  skipCompactRecap?: boolean;
  /** Compact summary to surface as a recap (when not skipped). */
  compactSummary?: string | null;
  env?: NodeJS.ProcessEnv;
}

/** Default ON; `ZELARI_ONE_PAGER=0` disables. Independent of MEMORY_V2. */
export function isOnePagerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ZELARI_ONE_PAGER !== '0';
}

/** Grep-friendly short label: first line, truncated. */
function slug(text: string, max = 48): string {
  const line = text.split(/\r?\n/, 1)[0]!.trim();
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}

/** Path + mtime ONLY — never the file body. Missing file → null (fail-open). */
async function howWeTestIndex(cwd: string): Promise<string | null> {
  try {
    const stat = await fs.stat(path.join(cwd, HOW_WE_TEST_RELATIVE));
    return `${HOW_WE_TEST_RELATIVE} · ${new Date(stat.mtimeMs).toISOString()}`;
  } catch {
    return null;
  }
}

async function procedureAliases(
  memory: HowWeTestSource | null | undefined,
): Promise<string | null> {
  if (!memory) return null;
  const nodes = await listVerifiedProcedureNodes(memory);
  if (!nodes || nodes.length === 0) return null;
  return nodes
    .slice(0, MAX_PROCEDURES)
    .map((node) => `- ${slug(node.tags[0] ?? node.content)}`)
    .join('\n');
}

function truncate(text: string, cap: number): string {
  if (text.length <= cap) return text;
  return `${text.slice(0, cap - TRUNCATION_MARKER.length).trimEnd()}${TRUNCATION_MARKER}`;
}

/**
 * Build the volatile working-set system message. Returns `[]` on a disabled
 * flag, on any error, or when every section is empty.
 */
export async function buildOnePager(opts: OnePagerOpts = {}): Promise<AgentMessage[]> {
  if (!isOnePagerEnabled(opts.env)) return [];
  try {
    const cwd = opts.cwd ?? process.cwd();
    const sections: string[] = [];

    const todos = formatTodosForModel(listSessionTodos());
    if (todos && todos !== '(no todos)') sections.push(`## Open loops\n${todos}`);

    const index = await howWeTestIndex(cwd);
    if (index) sections.push(`## How we test\n${index}`);

    const procedures = await procedureAliases(opts.memory);
    if (procedures) sections.push(`## Procedures\n${procedures}`);

    if (!opts.skipCompactRecap) {
      const recap = opts.compactSummary?.trim();
      if (recap) sections.push(`## Compact recap\n${recap.slice(0, SECTION_RECAP_CAP)}`);
    }

    if (sections.length === 0) return [];
    const body = `${ONE_PAGER_PREFIX}\n${sections.join('\n\n')}`;
    return [{ role: 'system', content: truncate(body, ONE_PAGER_CHAR_CAP) }];
  } catch {
    return [];
  }
}
