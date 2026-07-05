import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROLES_PATH = join(process.cwd(), 'packages/core/src/agents/roles.ts');
const DIRECTIVES_PATH = join(process.cwd(), 'packages/core/src/agents/councilDirectives.ts');

/** Patterns that must not appear in council prompts (answer fitting / test leakage). */
const FORBIDDEN_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'TESTMCP workspace', re: /\bTESTMCP\b/ },
  { name: 'T3MP3ST workspace', re: /\bT3MP3ST\b/ },
  { name: 'Windows absolute path', re: /[A-Z]:\\EasyPeasy/ },
  { name: 'hardcoded byte benchmark', re: /\b48183\s*bytes\b/i },
  { name: 'hardcoded Lighthouse score', re: /Lighthouse\s*≥\s*9[0-9]/ },
];

function readPromptSources(): string {
  return [ROLES_PATH, DIRECTIVES_PATH]
    .map((p) => readFileSync(p, 'utf8'))
    .join('\n\n');
}

describe('council prompt integrity (test-no-fitting)', () => {
  it('roles.ts + councilDirectives.ts contain no forbidden fitting patterns', () => {
    const src = readPromptSources();
    for (const { name, re } of FORBIDDEN_PATTERNS) {
      expect(src, `forbidden pattern: ${name}`).not.toMatch(re);
    }
  });

  it('would fail if a hardcoded benchmark were injected (guard test)', () => {
    const poisoned = readPromptSources() + '\nBudget is exactly 48183 bytes verified.';
    expect(poisoned).toMatch(/\b48183\s*bytes\b/i);
  });
});
