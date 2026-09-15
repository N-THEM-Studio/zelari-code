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
 *   5. docs/GUIDA.md version badge (`> **X.Y.Z**` under the H1; legacy
 *      "Versione documento" honored as fallback) tracks the package
 *      version;
 *   6. packages/core/src/version.ts CORE_VERSION === root version (t32: the
 *      const drifted to 2.6.2 while the monorepo shipped the 2.2x line —
 *      hosts importing it reported stale versions);
 *   7. packages/core/README.md "Current version" === core version (t32: it
 *      still advertised 1.34.0 at 2.27.0);
 *   8. the release runtime floor (scripts/runtime-floor.mjs): engines.node on
 *      the root and @zelari/core, the CI smoke Node matrix, and the pinned
 *      npm — so the floor is enforced by code, not prose.
 *
 * Exit 0 = coherent; exit 1 = drift (printed to stderr).
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { NODE_FLOOR, NPM_PIN, NPM_ENGINES_MIN } from './runtime-floor.mjs';

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
const requiredNpm = NPM_ENGINES_MIN;
const requiredPackageManager = `npm@${NPM_PIN}`;

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

// 8. Cargo.lock structural gate (2.31.0 lesson): a textual bump regex ate the
//    `name = "zelari-desktop"` stanza and the TOML died at parse time on all
//    3 CI platforms AFTER the tag (see the v2.31.0 tag move). Every
//    [[package]] stanza must carry BOTH `name = "…"` and `version = "…"` in
//    its header scope, and the workspace crate must appear exactly once.
//    Bump policy: `cargo update --workspace`, or line-edit + `cargo
//    verify-project` BEFORE tagging — never a regex over the whole file.
{
  const lines = readFileSync(
    path.join(root, 'apps/desktop/src-tauri/Cargo.lock'),
    'utf-8',
  ).split(/\r?\n/);
  const starts = lines.reduce(
    (a, l, i) => (l.trim() === '[[package]]' ? (a.push(i), a) : a),
    [],
  );
  starts.push(lines.length);
  for (let s = 0; s + 1 < starts.length; s++) {
    const from = starts[s] + 1;
    const to = starts[s + 1];
    const rel = lines.slice(from, to).findIndex((l) => l.startsWith('['));
    const scope = lines.slice(from, rel === -1 ? to : from + rel);
    for (const key of ['name', 'version']) {
      if (!scope.some((l) => l.startsWith(`${key} = "`))) {
        failures.push(
          `Cargo.lock [[package]] (line ${from}): missing \`${key} = "…"\` — ` +
            `2.31.0 lesson: bump with \`cargo update --workspace\` or line-edit + ` +
            `\`cargo verify-project\` BEFORE tagging.`,
        );
      }
    }
  }
  const z = lines.filter((l) => l.trim() === 'name = "zelari-desktop"').length;
  if (z !== 1) {
    failures.push(
      `Cargo.lock: expected exactly one \`name = "zelari-desktop"\` stanza, found ${z}.`,
    );
  }
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

// 5. docs/GUIDA.md version badge must track the package version.
//    Canonical format (since 2.37.x): a `> **X.Y.Z**` quote line under the H1.
//    Legacy `Versione documento:** X.Y.Z` is still honored when present, so
//    neither format can drift silently.
const guida = readFileSync(path.join(root, 'docs', 'GUIDA.md'), 'utf-8');
const guidaBadge = guida.match(/^>\s*\*\*(\d+\.\d+\.\d+(?:[-+][\w.]+)?)\*\*\s*$/m);
const guidaLegacy = guida.match(/Versione documento:\*\*\s*([^\s]+)/);
const guidaVersion = guidaBadge ?? guidaLegacy;
if (guidaVersion && guidaVersion[1] !== rootVersion) {
  failures.push(
    `docs/GUIDA.md version badge is "${guidaVersion[1]}" but package.json says "${rootVersion}" — keep the doc version in lockstep (E0.3/E0.4).`,
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

// 9. Desktop manifests in lockstep with the root (alignment plan, phase 4):
//    bump-version.mjs stamps them; this gate proves they cannot drift
//    silently again. package-lock entries are checked when present (an
//    npm install with the workspace link may not materialize the
//    node_modules entry on every platform).
{
  const desktopPkg = readJson('apps/desktop/package.json');
  if (desktopPkg.version !== rootVersion) {
    failures.push(
      `apps/desktop/package.json version is "${desktopPkg.version}" but root is "${rootVersion}" — the Desktop shell releases in lockstep.`,
    );
  }

  const tauriConf = readJson('apps/desktop/src-tauri/tauri.conf.json');
  if (tauriConf.version !== rootVersion) {
    failures.push(
      `apps/desktop/src-tauri/tauri.conf.json version is "${tauriConf.version}" but root is "${rootVersion}".`,
    );
  }

  const cargoToml = readFileSync(path.join(root, 'apps/desktop/src-tauri/Cargo.toml'), 'utf-8');
  const cargoVersion = cargoToml.match(/^version = "([^"]+)"/m);
  if (!cargoVersion || cargoVersion[1] !== rootVersion) {
    failures.push(
      `apps/desktop/src-tauri/Cargo.toml [package] version is "${cargoVersion?.[1] ?? '<missing>'}" but root is "${rootVersion}".`,
    );
  }

  const cargoLock = readFileSync(path.join(root, 'apps/desktop/src-tauri/Cargo.lock'), 'utf-8');
  const desktopLockVersion = cargoLock.match(/name = "zelari-desktop"\r?\nversion = "([^"]+)"/);
  if (!desktopLockVersion || desktopLockVersion[1] !== rootVersion) {
    failures.push(
      `Cargo.lock zelari-desktop stanza version is "${desktopLockVersion?.[1] ?? '<missing>'}" but root is "${rootVersion}".`,
    );
  }

  const lock = readJson('package-lock.json');
  const lockEntries = [
    ['packages[""].version', lock.packages?.['']?.version],
    ['packages["packages/core"].version', lock.packages?.['packages/core']?.version],
    [
      'packages["node_modules/@zelari/core"].version',
      lock.packages?.['node_modules/@zelari/core']?.version,
    ],
  ];
  for (const [label, value] of lockEntries) {
    if (value !== undefined && value !== rootVersion) {
      failures.push(`package-lock.json ${label} is "${value}" but root is "${rootVersion}".`);
    }
  }
}

// 10. Release runtime floor (release-floor F2.1): the root and the workspace
//     core must advertise the exact Node floor from scripts/runtime-floor.mjs
//     — the same value the CI smoke matrix exercises. One source of truth
//     stops the floor from drifting between manifests.
{
  const requiredNode = `>=${NODE_FLOOR}`;
  if (rootPkg.engines?.node !== requiredNode) {
    failures.push(
      `package.json engines.node must be "${requiredNode}" (runtime floor); ` +
        `found "${rootPkg.engines?.node ?? '<missing>'}".`,
    );
  }
  if (corePkg.engines?.node !== requiredNode) {
    failures.push(
      `packages/core/package.json engines.node must be "${requiredNode}" (runtime floor); ` +
        `found "${corePkg.engines?.node ?? '<missing>'}".`,
    );
  }
}

// 11. CI runtime matrix + npm pin (release-floor F2.2): the smoke matrix must
//     run the floor major and the current Node line, and CI must pin the same
//     npm as packageManager. Read as text — no YAML dependency in the gate.
{
  const ciYaml = readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf-8');
  const nodeMajor = NODE_FLOOR.split('.')[0];
  const matrixLine = ciYaml.match(/^\s*node:\s*\[[^\]]*\]/m);
  if (!matrixLine) {
    failures.push(
      'ci.yml has no `node: [...]` matrix line — the smoke job must exercise the runtime floor.',
    );
  } else {
    const line = matrixLine[0].trim();
    if (!matrixLine[0].includes(`'${nodeMajor}'`)) {
      failures.push(
        `ci.yml smoke matrix must include Node '${nodeMajor}' (the runtime floor ${NODE_FLOOR}); ` +
          `found "${line}".`,
      );
    }
    if (!matrixLine[0].includes("'24'")) {
      failures.push(`ci.yml smoke matrix must include Node '24'; found "${line}".`);
    }
  }
  if (!ciYaml.includes(NPM_PIN)) {
    failures.push(
      `ci.yml must pin npm@${NPM_PIN} (corepack) to match packageManager; "${NPM_PIN}" not found.`,
    );
  }
}

// 12. Optional clean-tree gate (release-floor F2.2): when
//     ZELARI_VERIFY_VERSIONS_REQUIRE_CLEAN=1, the working tree must be clean
//     so a release gate cannot certify uncommitted drift.
if (process.env.ZELARI_VERIFY_VERSIONS_REQUIRE_CLEAN === '1') {
  const git = spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' });
  if (git.error || git.status !== 0 || (git.stdout ?? '').trim() !== '') {
    failures.push('working tree not clean (required by ZELARI_VERIFY_VERSIONS_REQUIRE_CLEAN).');
  }
} else {
  console.log(
    '[verify-versions] clean-tree check skipped (set ZELARI_VERIFY_VERSIONS_REQUIRE_CLEAN=1 to require a clean tree).',
  );
}

if (failures.length > 0) {
  console.error('[verify-versions] VERSION DRIFT DETECTED:');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

console.log(
  `[verify-versions] coherent: zelari-code@${rootVersion} == @zelari/core@${coreVersion}, devDep exact, ` +
    `Desktop manifests (package.json, tauri.conf.json, Cargo.toml, Cargo.lock) in lockstep, ` +
    `lockfile entries aligned, CHANGELOG entry present, README/GUIDA version-clean, CORE_VERSION + core README in lockstep, ` +
    `runtime floor (node ${NODE_FLOOR}, npm ${NPM_PIN}) enforced.`,
);
