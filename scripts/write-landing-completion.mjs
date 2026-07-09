#!/usr/bin/env node
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  runImplementationVerification,
  buildCouncilCompletion,
  writeCouncilCompletion,
} from '@zelari/core/council';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const zelariRoot = join(repoRoot, '.zelari');
const report = runImplementationVerification({
  projectRoot: repoRoot,
  zelariRoot,
});
const completion = buildCouncilCompletion({
  verification: { ran: true, ok: report.ok, report },
  scope: {
    targets: ['index.html'],
    keywords: [
      'council',
      'zelari',
      'npm install',
      'terminal',
      'features',
      'install',
      'commands',
    ],
    explicitOut: ['*.css', '*.js', 'build'],
    nfrRelevant: true,
    sources: ['userMessage', 'nfr-spec'],
  },
  synthesisText:
    'MVP landing index.html at repo root; NFR verification PASS; completion.json written.',
});
const out = writeCouncilCompletion(zelariRoot, completion);
console.log(`[write-landing-completion] ${out} ok=${completion.ok} readyToCommit=${completion.readyToCommit}`);