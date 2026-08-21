/**
 * Gauntlet pieces. Structured JSON from a decomposer; never invented from
 * free prose. Invalid/empty replies fall back to one piece = the Goal.
 */
import { extractJsonObject } from '../kraken/planner.js';

export interface GauntletPiece {
  id: string;
  label: string;
  prompt: string;
  acceptance: string[];
  scope?: string[];
  /** On-disk quality-bar paths the critic compares against (blind). */
  bar?: string[];
}

const MAX_LABEL = 80;
const MAX_PROMPT = 8_000;
const MAX_ACCEPTANCE = 8;

export function fallbackPieces(goal: string): GauntletPiece[] {
  const prompt = goal.trim() || 'Complete the user Goal.';
  return [
    {
      id: 'g1',
      label: labelFromGoal(prompt),
      prompt,
      acceptance: [],
    },
  ];
}

export function labelFromGoal(goal: string): string {
  const line = goal.trim().split(/\r?\n/, 1)[0] ?? 'Goal';
  return line.slice(0, MAX_LABEL) || 'Goal';
}

/**
 * Parse `{ pieces: [...] }` or `{ nodes: [...] }` from a model reply.
 * Invalid / empty → null (caller falls back).
 */
export function parsePiecesJson(raw: unknown, maxPieces: number): GauntletPiece[] | null {
  if (!raw || typeof raw !== 'object') return null;
  const rec = raw as Record<string, unknown>;
  const list = rec.pieces ?? rec.nodes;
  if (!Array.isArray(list) || list.length === 0) return null;
  const out: GauntletPiece[] = [];
  for (let i = 0; i < list.length && out.length < maxPieces; i++) {
    const item = list[i];
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const prompt =
      typeof row.prompt === 'string'
        ? row.prompt.trim()
        : typeof row.goal === 'string'
          ? row.goal.trim()
          : '';
    if (!prompt) continue;
    const id =
      typeof row.id === 'string' && row.id.trim()
        ? row.id.trim().slice(0, 32)
        : `g${out.length + 1}`;
    const label =
      typeof row.label === 'string' && row.label.trim()
        ? row.label.trim().slice(0, MAX_LABEL)
        : labelFromGoal(prompt);
    const acceptance = Array.isArray(row.acceptance)
      ? row.acceptance
          .filter((a): a is string => typeof a === 'string' && a.trim().length > 0)
          .map((a) => a.trim())
          .slice(0, MAX_ACCEPTANCE)
      : [];
    const scope = Array.isArray(row.scope)
      ? row.scope
          .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
          .map((s) => s.trim())
          .slice(0, 16)
      : undefined;
    const bar = Array.isArray(row.bar)
      ? row.bar
          .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
          .map((s) => s.trim())
          .slice(0, 4)
      : undefined;
    out.push({
      id: uniqueId(id, out),
      label,
      prompt: prompt.slice(0, MAX_PROMPT),
      acceptance,
      ...(scope && scope.length > 0 ? { scope } : {}),
      ...(bar && bar.length > 0 ? { bar } : {}),
    });
  }
  return out.length > 0 ? out : null;
}

export const GAUNTLET_DECOMPOSE_SYSTEM = [
  'Decompose the user Goal into independently shippable Gauntlet pieces.',
  'Return ONLY JSON (no markdown, no prose):',
  '{ "pieces": [ { "id": string, "label": string, "prompt": string, "scope"?: string[], "acceptance"?: string[], "bar"?: string[] } ] }',
  'Rules:',
  '- 1 to N pieces (N is given in the user message). Prefer fewer. One piece is valid when the goal is atomic.',
  '- "prompt" is self-contained: the builder will not see this conversation.',
  '- "scope" is a path allowlist so disjoint pieces can run in parallel. Omit if unsure (forces sequential).',
  '- "acceptance" is checkable (file, command, observable). Never subjective ("elegant").',
  '- "bar" (optional) is on-disk reference path(s) the critic compares against blindly (gold file, screenshot, test).',
  '- Use paths from the workspace listing. Do not invent a tree.',
  '- Decompose the USER GOAL literally. Do not enlarge it into a different project.',
].join('\n');

export function formatHistoryNote(
  messages: ReadonlyArray<{ role: string; content: string }>,
  maxMessages = 4,
  each = 400,
): string {
  const slice = messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .slice(-maxMessages);
  if (slice.length === 0) return '';
  return slice
    .map((m) => {
      const body = m.content.replace(/\s+/g, ' ').trim().slice(0, each);
      return `${m.role}: ${body}`;
    })
    .join('\n');
}

export function buildDecomposeUser(opts: {
  goal: string;
  maxPieces: number;
  workspace?: string;
  historyNote?: string;
}): string {
  const parts = [
    `Max pieces: ${opts.maxPieces}`,
    '',
    '## Goal',
    opts.goal.trim() || '(empty)',
  ];
  if (opts.historyNote?.trim()) {
    parts.push('', '## Prior turns (context only — the Goal above is authoritative)', opts.historyNote.trim());
  }
  if (opts.workspace?.trim()) {
    parts.push('', '## Workspace', opts.workspace.trim());
  }
  return parts.join('\n');
}

export function piecesFromModelText(text: string, maxPieces: number): GauntletPiece[] | null {
  try {
    const json = extractJsonObject(text, { requireKey: 'pieces' });
    return parsePiecesJson(json, maxPieces);
  } catch {
    return null;
  }
}

export async function decomposeGoal(opts: {
  goal: string;
  maxPieces: number;
  workspace?: string;
  historyNote?: string;
  complete?: (args: { system: string; user: string }) => Promise<string>;
}): Promise<{ pieces: GauntletPiece[]; source: 'llm' | 'fallback'; error?: string }> {
  const fallback = fallbackPieces(opts.goal);
  if (!opts.complete) return { pieces: fallback, source: 'fallback' };
  try {
    const text = await opts.complete({
      system: GAUNTLET_DECOMPOSE_SYSTEM,
      user: buildDecomposeUser(opts),
    });
    const parsed = piecesFromModelText(text, opts.maxPieces);
    if (parsed && parsed.length > 0) return { pieces: parsed, source: 'llm' };
    return { pieces: fallback, source: 'fallback', error: 'decompose JSON unusable' };
  } catch (err) {
    return {
      pieces: fallback,
      source: 'fallback',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function uniqueId(id: string, existing: GauntletPiece[]): string {
  if (!existing.some((p) => p.id === id)) return id;
  let n = 2;
  while (existing.some((p) => p.id === `${id}-${n}`)) n += 1;
  return `${id}-${n}`;
}
