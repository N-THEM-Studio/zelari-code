#!/usr/bin/env node
// bump-version.mjs — monorepo version bump (ADR-0003 lockstep).
//
// Updates EVERY version representation that scripts/verify-versions.mjs
// checks, and NOTHING else:
//   - package.json + root devDependencies["@zelari/core"]
//   - packages/core/package.json
//   - apps/desktop/package.json
//   - package-lock.json (root, packages[""], packages/core,
//     node_modules/@zelari/core)
//   - apps/desktop/src-tauri/Cargo.toml ([package] version)
//   - apps/desktop/src-tauri/tauri.conf.json
//   - apps/desktop/src-tauri/Cargo.lock (zelari-desktop stanza)
//   - docs/GUIDA.md "Versione documento" (when present)
//   - packages/core/src/version.ts CORE_VERSION
//   - packages/core/README.md "Current version" (when present)
//
// CHANGELOG.md is NOT written by this script: the `## [version]` entry
// must already exist (fail-fast below — no partial writes). Release notes
// are authored by humans; the bump only stamps versions. (It used to
// inject a hardcoded 2026-07-10 entry with unrelated release notes.)
//
// Usage: node scripts/bump-version.mjs <version|major|minor|patch>
import fs from 'node:fs';

const arg = process.argv[2];
if (!arg) {
  console.error('usage: node scripts/bump-version.mjs <version|major|minor|patch>');
  process.exit(1);
}
const KEYWORDS = ['major', 'minor', 'patch'];
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;
const current = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
let V = arg;
if (KEYWORDS.includes(arg)) {
  const parts = current.split('.').map((n) => parseInt(n, 10));
  if (parts.length !== 3 || parts.some(Number.isNaN)) {
    console.error(`bump-version: cannot bump "${arg}" — current version "${current}" is not plain semver`);
    process.exit(1);
  }
  const idx = KEYWORDS.indexOf(arg);
  parts[idx] += 1;
  for (let i = idx + 1; i < 3; i += 1) parts[i] = 0;
  V = parts.join('.');
}
if (!SEMVER.test(V)) {
  console.error(`bump-version: "${arg}" is neither a bump keyword (${KEYWORDS.join('|')}) nor a valid semver version`);
  process.exit(1);
}

// Precondition: the changelog entry for the target version must already
// exist. This is what keeps verify-versions check #3 green right after a
// bump, without the script ever inventing release notes.
{
  const changelog = fs.readFileSync('CHANGELOG.md', 'utf8');
  if (!changelog.includes(`## [${V}]`)) {
    console.error(
      `bump-version: CHANGELOG.md has no "## [${V}]" entry — write the release notes first, then bump. ` +
        `(The bump stamps versions only; it no longer generates changelog content.)`,
    );
    process.exit(1);
  }
}

for (const f of ['package.json', 'packages/core/package.json', 'apps/desktop/package.json']) {
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  j.version = V;
  if (f === 'package.json' && j.devDependencies?.['@zelari/core']) {
    j.devDependencies['@zelari/core'] = V;
  }
  fs.writeFileSync(f, JSON.stringify(j, null, 2) + '\n');
}

const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
lock.version = V;
if (lock.packages['']) {
  lock.packages[''].version = V;
  if (lock.packages[''].devDependencies) {
    lock.packages[''].devDependencies['@zelari/core'] = V;
  }
}
if (lock.packages['packages/core']) lock.packages['packages/core'].version = V;
if (lock.packages['node_modules/@zelari/core']) {
  lock.packages['node_modules/@zelari/core'].version = V;
}
fs.writeFileSync('package-lock.json', JSON.stringify(lock, null, 2) + '\n');

let cargo = fs.readFileSync('apps/desktop/src-tauri/Cargo.toml', 'utf8');
cargo = cargo.replace(/^version = ".*"$/m, `version = "${V}"`);
fs.writeFileSync('apps/desktop/src-tauri/Cargo.toml', cargo);

const conf = JSON.parse(fs.readFileSync('apps/desktop/src-tauri/tauri.conf.json', 'utf8'));
conf.version = V;
fs.writeFileSync('apps/desktop/src-tauri/tauri.conf.json', JSON.stringify(conf, null, 2) + '\n');

let cl = fs.readFileSync('apps/desktop/src-tauri/Cargo.lock', 'utf8');
cl = cl.replace(
  /(name = "zelari-desktop"\r?\n)version = "[^"]+"/,
  `$1version = "${V}"`,
);
fs.writeFileSync('apps/desktop/src-tauri/Cargo.lock', cl);

// Doc/const representations — same ones verify-versions checks. Replaced
// only when the pattern exists (verify-versions treats absence as OK).
function replaceInFile(file, pattern, replacement) {
  let text = fs.readFileSync(file, 'utf8');
  const next = text.replace(pattern, replacement);
  if (next !== text) fs.writeFileSync(file, next);
}
replaceInFile('docs/GUIDA.md', /Versione documento:\*\*\s*\S+/, `Versione documento:** ${V}`);
replaceInFile(
  'packages/core/src/version.ts',
  /(CORE_VERSION\s*=\s*['"])[^'"]+(['"])/,
  `$1${V}$2`,
);
replaceInFile(
  'packages/core/README.md',
  /(Current version:\s*\*\*)[^*]+(\*\*)/,
  `$1${V}$2`,
);

console.log('bumped to', V);
