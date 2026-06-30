import { z } from 'zod';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { typedOk, typedErr, type ToolDefinition } from '../toolTypes.js';

const GrepContentArgsSchema = z.object({
  path: z.string().min(1),
  pattern: z.string().min(1),
  contextLines: z.number().int().nonnegative().default(2),
  maxMatches: z.number().int().positive().max(1000).default(50),
});

type GrepContentArgs = z.infer<typeof GrepContentArgsSchema>;

interface GrepMatch {
  file: string;
  line: number;
  text: string;
  context: { before: string[]; after: string[] };
}

interface GrepResult {
  matches: GrepMatch[];
  totalMatches: number;
  truncated: boolean;
}

export const grepContentTool: ToolDefinition<GrepContentArgs, GrepResult> = {
  name: 'grep_content',
  description: 'Regex search for content in a file. Returns matches with line numbers and context.',
  permissions: ['read'],
  timeoutMs: 10000,
  inputSchema: GrepContentArgsSchema,
  execute: async (args, ctx) => {
    try {
      const absPath = path.isAbsolute(args.path) ? args.path : path.join(ctx.cwd, args.path);
      const content = await fs.readFile(absPath, { encoding: 'utf-8', signal: ctx.signal } as never);
      const text = typeof content === 'string' ? content : content.toString('utf-8');
      const lines = text.split('\n');
      const regex = new RegExp(args.pattern, 'gm');
      const matches: GrepMatch[] = [];
      let totalMatches = 0;
      let truncated = false;
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) {
          regex.lastIndex = 0; // Reset global regex state
          totalMatches++;
          if (matches.length < args.maxMatches) {
            const startBefore = Math.max(0, i - args.contextLines);
            const endAfter = Math.min(lines.length - 1, i + args.contextLines);
            matches.push({
              file: absPath,
              line: i + 1,
              text: lines[i],
              context: {
                before: lines.slice(startBefore, i),
                after: lines.slice(i + 1, endAfter + 1),
              },
            });
          } else {
            truncated = true;
          }
        }
      }
      return typedOk({ matches, totalMatches, truncated });
    } catch (err) {
      return typedErr(err instanceof Error ? err.message : String(err));
    }
  },
};
