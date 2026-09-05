/**
 * Contract — runPostCouncilHook sessionId propagation (handoff v2.30, item 5).
 *
 * The spine-evidence gate in the post-council hook (evidenceFromSpine) only
 * fires when the call-site passes sessionId into the hook options. Headless
 * already propagates it on both surfaces (2.31 A1) and the TUI council path
 * does too; this gate makes the rule total: EVERY `runPostCouncilHook(`
 * invocation in the CLI sources must pass a non-undefined sessionId.
 *
 * Source-level assertions on purpose (same style as
 * legacyContextIsolation.test.ts): the behavioral coverage for the hook
 * itself lives in the workspace completion-hook suites.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve against THIS file, never process.cwd() — a cwd-relative path would
// break when the core workspace runs vitest with a different cwd. From
// tests/unit `../..` is always the repo root.
const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);

/** Extract the options object literal `{ ... }` of every runPostCouncilHook( call. */
function postCouncilHookOptions(src: string): string[] {
  const objects: string[] = [];
  const call = /\brunPostCouncilHook\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = call.exec(src)) !== null) {
    const open = src.indexOf('{', m.index + m[0].length);
    if (open === -1) break;
    let depth = 0;
    let end = -1;
    for (let i = open; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end === -1) break;
    objects.push(src.slice(open, end + 1));
  }
  return objects;
}

/** The sessionId expression inside an options literal; null when absent. */
function sessionIdExpr(options: string): string | null {
  const explicit = options.match(/\bsessionId\s*:\s*([^,}]+)/);
  if (explicit) return explicit[1].trim();
  // shorthand binding:  sessionId,
  if (/(^|[{\s,])sessionId\s*[,}]/.test(options)) return 'sessionId';
  return null;
}

// [label, repo-relative source, expected number of call-sites]. The expected
// counts guard against the extraction silently matching nothing — when a new
// call-site is added, keep passing sessionId and bump the count.
const SOURCES: Array<[string, string, number]> = [
  ['runHeadless.ts', path.join('src', 'cli', 'runHeadless.ts'), 2],
  ['useChatTurn.ts', path.join('src', 'cli', 'hooks', 'useChatTurn.ts'), 2],
];

describe('runPostCouncilHook call-sites propagate sessionId (2.31 item 5)', () => {
  for (const [label, rel, expectedCalls] of SOURCES) {
    it(`${label}: exposes the expected number of call-sites`, () => {
      const calls = postCouncilHookOptions(readFileSync(path.join(REPO_ROOT, rel), 'utf8'));
      expect(calls, `${rel} call-site count drifted`).toHaveLength(expectedCalls);
    });

    it(`${label}: every runPostCouncilHook call passes a non-undefined sessionId`, () => {
      const calls = postCouncilHookOptions(readFileSync(path.join(REPO_ROOT, rel), 'utf8'));
      expect(calls.length).toBeGreaterThan(0);
      calls.forEach((options, i) => {
        const expr = sessionIdExpr(options);
        expect(
          expr,
          `${rel} call-site #${i + 1} passes no sessionId: ${options}`,
        ).not.toBeNull();
        expect(
          expr,
          `${rel} call-site #${i + 1} passes undefined sessionId`,
        ).not.toBe('undefined');
      });
    });
  }
});
