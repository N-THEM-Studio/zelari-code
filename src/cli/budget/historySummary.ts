/**
 * Extractive (+ optional LLM) summaries for dropped history.
 * Used when context pressure forces compaction — better than "N messages dropped".
 *
 * @since v1.21.0
 */
import type { AgentMessage } from '@zelari/core/harness';

const MAX_SUMMARY_CHARS = 3_500;
const MAX_LLM_INPUT_CHARS = 24_000;

/**
 * Build a structured extractive summary of messages that will be dropped from
 * the rolling history. No network — pure heuristics.
 */
export function extractiveHistorySummary(
  dropped: readonly AgentMessage[],
  opts?: { maxChars?: number },
): string {
  const maxChars = opts?.maxChars ?? MAX_SUMMARY_CHARS;
  if (dropped.length === 0) return 'No prior turns.';

  const userGoals: string[] = [];
  const assistantNotes: string[] = [];
  const tools = new Map<string, number>();
  const files = new Set<string>();
  let toolResults = 0;

  for (const m of dropped) {
    if (m.role === 'user' && m.content.trim()) {
      userGoals.push(oneLine(m.content, 220));
    } else if (m.role === 'assistant') {
      if (m.content.trim()) {
        assistantNotes.push(oneLine(m.content, 180));
      }
      if (m.toolCalls) {
        for (const tc of m.toolCalls) {
          tools.set(tc.name, (tools.get(tc.name) ?? 0) + 1);
          collectPaths(tc.args, files);
        }
      }
    } else if (m.role === 'tool') {
      toolResults += 1;
      collectPathsFromText(m.content, files);
    }
  }

  const parts: string[] = [
    '[history-summary] Earlier turns were compacted to stay within the context budget.',
    `Dropped ${dropped.length} message(s) (${userGoals.length} user, ${assistantNotes.length} assistant notes, ${toolResults} tool results).`,
  ];

  if (userGoals.length) {
    parts.push('## User goals / requests');
    for (const g of userGoals.slice(-6)) parts.push(`- ${g}`);
  }

  if (assistantNotes.length) {
    parts.push('## Assistant conclusions (truncated)');
    for (const a of assistantNotes.slice(-5)) parts.push(`- ${a}`);
  }

  if (tools.size) {
    const ranked = [...tools.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([n, c]) => `${n}×${c}`);
    parts.push(`## Tools used: ${ranked.join(', ')}`);
  }

  if (files.size) {
    const list = [...files].slice(0, 24);
    parts.push(`## Paths mentioned: ${list.join(', ')}`);
  }

  parts.push(
    'Continue from the recent messages below; do not re-ask goals already answered above unless the user changes them.',
  );

  let out = parts.join('\n');
  if (out.length > maxChars) {
    out = `${out.slice(0, maxChars - 1)}…`;
  }
  return out;
}

/**
 * Compact representation of dropped history for an LLM summarizer (bounded).
 */
export function formatDroppedForLlm(dropped: readonly AgentMessage[]): string {
  const lines: string[] = [];
  for (const m of dropped) {
    if (m.role === 'user') {
      lines.push(`USER: ${oneLine(m.content, 400)}`);
    } else if (m.role === 'assistant') {
      const tools =
        m.toolCalls?.map((t) => t.name).join(',') || '';
      const body = oneLine(m.content, 300);
      lines.push(
        tools
          ? `ASSISTANT(tools=${tools}): ${body}`
          : `ASSISTANT: ${body}`,
      );
    } else if (m.role === 'tool') {
      lines.push(`TOOL(${m.toolCallId ?? '?'}): ${oneLine(m.content, 160)}`);
    } else if (m.role === 'system') {
      lines.push(`SYSTEM: ${oneLine(m.content, 200)}`);
    }
  }
  let body = lines.join('\n');
  if (body.length > MAX_LLM_INPUT_CHARS) {
    body = body.slice(body.length - MAX_LLM_INPUT_CHARS);
  }
  return body;
}

function oneLine(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

function collectPaths(args: unknown, out: Set<string>): void {
  if (!args || typeof args !== 'object') return;
  const obj = args as Record<string, unknown>;
  for (const key of ['path', 'file', 'filepath', 'filePath', 'target', 'cwd']) {
    const v = obj[key];
    if (typeof v === 'string' && v.length > 1 && v.length < 260) {
      out.add(v.replace(/\\/g, '/'));
    }
  }
  // Nested common shapes
  if (typeof obj.file_path === 'string') out.add(String(obj.file_path));
}

function collectPathsFromText(text: string, out: Set<string>): void {
  // Cheap path-ish tokens (src/foo.ts, packages/core/x.ts)
  const re = /(?:^|[\s"'`])((?:[\w.-]+\/)+[\w.-]+\.\w{1,8})/g;
  let m: RegExpExecArray | null;
  let n = 0;
  while ((m = re.exec(text)) !== null && n < 8) {
    out.add(m[1]);
    n += 1;
  }
}
