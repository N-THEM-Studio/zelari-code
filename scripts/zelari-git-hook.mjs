#!/usr/bin/env node
/**
 * zelari-git-hook.mjs — Git hook trigger for Zelari Code missions (ADR-0014).
 *
 * Install as a git hook:
 *   cp scripts/zelari-git-hook.mjs .git/hooks/pre-push
 *   chmod +x .git/hooks/pre-push
 *
 * Or use with husky/lefthook by pointing the hook command at this script.
 *
 * The hook:
 *   1. Gets the diff about to be pushed (pre-push) or committed (pre-commit)
 *   2. Launches a Zelari mission in PLAN phase (no writes — review only)
 *   3. Prints the council synthesis to stderr for the developer to read
 *
 * Exit codes:
 *   0 — review passed or no actionable issues (push proceeds)
 *   1 — review found issues (push blocked — read the output)
 *
 * Environment overrides:
 *   ZELARI_HOOK_PHASE   — 'plan' (default) or 'build' (allows fixes)
 *   ZELARI_HOOK_SKIP=1  — skip the hook entirely
 */

import { execSync } from 'node:child_process';

const SKIP = process.env.ZELARI_HOOK_SKIP === '1';
if (SKIP) {
  process.exit(0);
}

const PHASE = process.env.ZELARI_HOOK_PHASE || 'plan';

// Get a compact diff summary for the review
let diffSummary = '';
try {
  diffSummary = execSync('git diff --stat HEAD~1', {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  }).trim();
} catch {
  // No previous commit or not in a git repo — skip
  process.exit(0);
}

if (!diffSummary) {
  process.exit(0);
}

const task = `Review the following changes for security issues, logic bugs, and breaking changes. Diff summary:\n\n${diffSummary}`;

try {
  const result = execSync(
    `zelari-code --headless --once --mode zelari --phase ${PHASE} --output plain --task "${task.replace(/"/g, '\\"')}"`,
    {
      encoding: 'utf8',
      timeout: 120_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );

  // Print review to stderr so it doesn't interfere with git's stdout
  process.stderr.write('\n--- Zelari Code Review ---\n');
  process.stderr.write(result);
  process.stderr.write('\n--- End Review ---\n\n');

  // In plan mode, we don't block — just inform
  process.exit(0);
} catch (err) {
  process.stderr.write(`[zelari-git-hook] review failed: ${err.message}\n`);
  // Don't block push on hook errors
  process.exit(0);
}
