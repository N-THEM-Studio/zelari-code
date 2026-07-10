import fs from 'node:fs';

const V = process.argv[2] || '1.9.4';

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

let ch = fs.readFileSync('CHANGELOG.md', 'utf8');
if (!ch.includes(`## [${V}]`)) {
  const insert = `## [${V}] - 2026-07-10

### Fixed
- **Release workflows** — correct tag version resolution on \`workflow_dispatch\`; build \`@zelari/core\` before CLI; optional updater signing (installers still build without \`TAURI_SIGNING_PRIVATE_KEY\`).
- **CLI startup** — clean 3-line banner (no messy dual-column ASCII); compact one-line preflight warnings.
- **Sidebar logo** — exact v1.6.0 Braille emblem restored on the right.

### Added
- **Desktop Update CLI** — Settings + topbar when npm latest is newer than installed CLI.

`;
  ch = ch.replace(/## \[1\.9\.3\]/, insert + '## [1.9.3]');
  fs.writeFileSync('CHANGELOG.md', ch);
}

console.log('bumped to', V);
