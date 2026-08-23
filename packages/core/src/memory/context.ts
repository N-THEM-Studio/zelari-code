import type { MemoryContext, RecallResult } from './types.js';

function compact(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, Math.max(0, max - 1))}…`;
}

export function formatMemorySource(result: RecallResult): string {
  const source = result.node.source;
  const fields: Array<[string, string | undefined]> = [
    ['agent', source.agent],
    ['session', source.sessionId],
    ['mission', source.missionId],
    ['slice', source.sliceId],
    ['tentacle', source.tentacleId],
    ['verification', source.verificationId],
    ['file', source.file],
    ['symbol', source.symbol],
    ['commit', source.commit],
  ];
  const visible = fields.filter((entry): entry is [string, string] => Boolean(entry[1]));
  return visible.length > 0
    ? visible.map(([key, value]) => `${key}=${compact(value, 160)}`).join(' ')
    : 'agent=unknown';
}

/** Pack ranked results into a hard character budget. */
export function formatMemoryContext(
  ranked: RecallResult[],
  options: { maxChars: number; maxMemories: number },
): MemoryContext {
  const budget = Number.isFinite(options.maxChars)
    ? Math.max(0, Math.floor(options.maxChars))
    : 0;
  const header = '[ZELARI MEMORY]\n';
  const footer = '[/ZELARI MEMORY]';
  if (budget < header.length + footer.length) {
    return {
      text: '',
      memories: [],
      usedChars: 0,
      budgetChars: budget,
      truncated: ranked.length > 0,
    };
  }

  let text = header;
  const included: RecallResult[] = [];
  const memoryLimit = Number.isFinite(options.maxMemories)
    ? Math.max(0, Math.floor(options.maxMemories))
    : 0;
  const candidates = ranked.slice(0, memoryLimit);
  for (const result of candidates) {
    const node = result.node;
    const block =
      `${node.id} ${node.kind} ${result.score.toFixed(2)}:\n` +
      `${compact(node.content, 600)}\n` +
      `Source: ${formatMemorySource(result)}\n`;
    const separator = included.length > 0 ? '\n' : '';
    if (text.length + separator.length + block.length + footer.length > budget) break;
    text += separator + block;
    included.push(result);
  }
  text += footer;
  return {
    text,
    memories: included,
    usedChars: text.length,
    budgetChars: budget,
    truncated: included.length < ranked.length,
  };
}
