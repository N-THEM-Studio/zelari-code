/**
 * Concurrency class for one tool call (Zelari 2.x workstream F).
 *
 * Parallel-safe tools may run in the same Promise.all chunk.
 * Exclusive tools stay serial: no write-write, no shell-shell, no
 * general-tentacle overlapping a sibling writer.
 */
export type ToolConcurrencyClass = 'parallel-safe' | 'exclusive';

export interface ClassifyToolConcurrencyInput {
  toolName: string;
  args?: unknown;
  /** Registry permissions when known. Missing → treat as unknown tool. */
  permissions?: ReadonlyArray<string>;
  /** True when the name is a registered tool (or a known builtin like `task`). */
  registered?: boolean;
  env?: NodeJS.ProcessEnv;
}

function taskAgent(args: unknown): string {
  if (!args || typeof args !== 'object') return 'explore';
  const agent = (args as { agent?: unknown }).agent;
  return typeof agent === 'string' && agent.trim() ? agent : 'explore';
}

/**
 * First allowlist: reads + explore/verify tentacles are parallel-safe;
 * writers, shell, and `task agent=general` are exclusive.
 */
export function classifyToolConcurrency(
  input: ClassifyToolConcurrencyInput,
): ToolConcurrencyClass {
  const env = input.env ?? process.env;
  if (env.ZELARI_PARALLEL_TOOLS === '0') return 'exclusive';

  const name = input.toolName;
  if (name === 'task') {
    return taskAgent(input.args) === 'general' ? 'exclusive' : 'parallel-safe';
  }

  if (input.registered === false) {
    if (name.startsWith('mcp_')) {
      const lower = name.toLowerCase();
      if (lower.includes('write') || lower.includes('edit') || lower.includes('delete')) {
        return 'exclusive';
      }
      return 'parallel-safe';
    }
    return 'exclusive';
  }

  const perms = input.permissions ?? [];
  if (perms.includes('write') || perms.includes('execute')) return 'exclusive';
  return 'parallel-safe';
}
