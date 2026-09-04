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
 *   3. CHANGELOG.md has an entry for the current version;
 *   4. README.md does not hardcode a CLI line version (the npm version badge
 *      is the live source — hardcoded lines drift, e.g. "Current line:
 *      1.35.1" while the package was on 2.0.0-alpha.x);
 *   5. docs/GUIDA.md "Versione documento" (when present) tracks the package
 *      version;
 *   6. packages/core/src/version.ts CORE_VERSION === root version (t32: the
 *      const drifted to 2.6.2 while the monorepo shipped the 2.2x line —
 *      hosts importing it reported stale versions);
 *   7. packages/core/README.md "Current version" === core version (t32: it
 *      still advertised 1.34.0 at 2.27.0).
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
const requiredNpm = '>=11.7.0';
const requiredPackageManager = 'npm@11.7.0';

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

if (rootPkg.engines?.npm !== requiredNpm) {
  failures.push(
    `package.json engines.npm must be "${requiredNpm}" because older npm versions ` +
      `cannot reproduce the workspace lockfile; found "${rootPkg.engines?.npm ?? '<missing>'}".`,
  );
}

if (rootPkg.packageManager !== requiredPackageManager) {
  failures.push(
    `package.json packageManager must pin "${requiredPackageManager}"; ` +
      `found "${rootPkg.packageManager ?? '<missing>'}".`,
  );
}

const changelog = readFileSync(path.join(root, 'CHANGELOG.md'), 'utf-8');
if (!changelog.includes(`## [${rootVersion}]`)) {
  failures.push(`CHANGELOG.md has no "## [${rootVersion}]" entry for the current version.`);
}

// 4. README must not hardcode a CLI line version (Exit-0 E0.4): the npm
//    version badge at the top is the single live source of the version.
const readme = readFileSync(path.join(root, 'README.md'), 'utf-8');
if (/current line:\s*\*?\*?\d/i.test(readme)) {
  failures.push(
    'README.md hardcodes a "Current line: X.Y.Z" version — remove it; the npm version badge is the live source (E0.3/E0.4).',
  );
}
const readmeLineVersion = readme.match(/—\s*v\d+\.\d+\.\d+/);
if (readmeLineVersion) {
  failures.push(
    `README.md hardcodes a CLI version ("${readmeLineVersion[0]}", e.g. in the architecture diagram) — remove it; the npm version badge is the live source (E0.3/E0.4).`,
  );
}

// 5. docs/GUIDA.md "Versione documento" must track the package version.
const guida = readFileSync(path.join(root, 'docs', 'GUIDA.md'), 'utf-8');
const guidaVersion = guida.match(/Versione documento:\*\*\s*([^\s]+)/);
if (guidaVersion && guidaVersion[1] !== rootVersion) {
  failures.push(
    `docs/GUIDA.md "Versione documento" is "${guidaVersion[1]}" but package.json says "${rootVersion}" — keep the doc version in lockstep (E0.3/E0.4).`,
  );
}

// 6. packages/core/src/version.ts CORE_VERSION === root version (t32).
const versionTs = readFileSync(
  path.join(root, 'packages', 'core', 'src', 'version.ts'),
  'utf-8',
);
const coreVersionConst = versionTs.match(/CORE_VERSION\s*=\s*['"]([^'"]+)['"]/);
if (!coreVersionConst) {
  failures.push(
    'packages/core/src/version.ts has no CORE_VERSION export — it is the canonical importable version.',
  );
} else if (coreVersionConst[1] !== rootVersion) {
  failures.push(
    `packages/core/src/version.ts CORE_VERSION is "${coreVersionConst[1]}" but package.json says "${rootVersion}" — ` +
      `keep the const in lockstep (it drifted silently through the 2.x line).`,
  );
}

// 7. packages/core/README.md "Current version" === core version (t32).
const coreReadme = readFileSync(path.join(root, 'packages', 'core', 'README.md'), 'utf-8');
const coreReadmeVersion = coreReadme.match(/Current version:\s*\*\*([^*]+)\*\*/);
if (coreReadmeVersion && coreReadmeVersion[1].trim() !== coreVersion) {
  failures.push(
    `packages/core/README.md "Current version" is "${coreReadmeVersion[1].trim()}" but @zelari/core is "${coreVersion}" — keep the README in lockstep.`,
  );
}

if (failures.length > 0) {
  console.error('[verify-versions] VERSION DRIFT DETECTED:');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

console.log(
  `[verify-versions] coherent: zelari-code@${rootVersion} == @zelari/core@${coreVersion}, devDep exact, CHANGELOG entry present, README/GUIDA version-clean, CORE_VERSION + core README in lockstep.`,
);
