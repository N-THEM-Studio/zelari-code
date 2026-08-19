#!/usr/bin/env node
/**
 * verify-versions.mjs — version coherence gate (Zelari 2.0 Phase 0).
 *
 * Enforces the ADR-0003 monorepo versioning policy mechanically:
 *   1. root `zelari-code` version === `packages/core` `@zelari/core` version
 *      (lockstep releases);
 *   2. root devDependency `@zelari/core` is an EXACT match of the workspace
 *      package version (a stale range silently installs a registry copy
 *      next to the workspace — the 1.48.1-vs-1.49.0 drift this gate kills);
 *   3. CHANGELOG.md has an entry for the current version.
 *
 * Exit 0 = coherent; exit 1 = drift (printed to stderr).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readJson(rel) {
  return JSON.parse(readFileSync(path.join(root, rel), 'utf-8'));
}

const failures = [];

const rootPkg = readJson('package.json');
const corePkg = readJson('packages/core/package.json');

const rootVersion = rootPkg.version;
const coreVersion = corePkg.version;
const devDepVersion = rootPkg.devDependencies?.['@zelari/core'];

if (rootVersion !== coreVersion) {
  failures.push(
    `root version (${rootVersion}) !== @zelari/core version (${coreVersion}) — ` +
      `the monorepo releases in lockstep (ADR-0003).`,
  );
}

if (devDepVersion !== coreVersion) {
  failures.push(
    `root devDependencies["@zelari/core"] must be the exact workspace version: ` +
      `expected "${coreVersion}", found "${devDepVersion}". A non-matching range ` +
      `resolves to a registry copy instead of the workspace link (split-brain).`,
  );
}

const changelog = readFileSync(path.join(root, 'CHANGELOG.md'), 'utf-8');
if (!changelog.includes(`## [${rootVersion}]`)) {
  failures.push(`CHANGELOG.md has no "## [${rootVersion}]" entry for the current version.`);
}

if (failures.length > 0) {
  console.error('[verify-versions] VERSION DRIFT DETECTED:');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

console.log(`[verify-versions] coherent: zelari-code@${rootVersion} == @zelari/core@${coreVersion}, devDep exact, CHANGELOG entry present.`);
