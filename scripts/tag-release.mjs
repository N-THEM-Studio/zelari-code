#!/usr/bin/env node
/**
 * tag-release.mjs — the ONLY supported way to cut a release tag locally.
 *
 * Why this exists (lessons v2.43.0 / v2.45.0):
 *   - v2.43.0 was tagged on a DIRTY tree: `verify:versions` was green over
 *     uncommitted fixes, the tag pointed at a different commit, and `main`
 *     went red minutes after publish.
 *   - v2.45.0 published to npm while its ci.yml run on the tagged SHA was
 *     still red — the publish path never waited for CI.
 * The fix is one entry point that refuses to tag unless: the tree is clean,
 * HEAD is on `main` aligned with `origin/main`, the tag does not already
 * exist, root `package.json` matches, and the version gate passes on the
 * exact commit being tagged. Only then does it create the annotated tag and
 * push `main` + the tag. This is the local mirror of the CI release gate
 * (release-gate.yml) that publish.yml / release-desktop.yml now call.
 *
 * Usage: node scripts/tag-release.mjs <version>   # X.Y.Z or vX.Y.Z
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function log(msg) {
  console.log(`[tag-release] ${msg}`);
}
function fail(msg) {
  console.error(`[tag-release] ${msg}`);
  process.exit(1);
}
function git(args, opts = {}) {
  return spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: opts.stdio ?? 'pipe',
  });
}

// 1. Version argument (accept X.Y.Z or vX.Y.Z).
const raw = process.argv[2];
if (!raw) {
  console.error('[tag-release] usage: node scripts/tag-release.mjs <version>  (e.g. v2.45.1)');
  process.exit(1);
}
const version = raw.replace(/^v/i, '');
const tag = `v${version}`;

// 2. Clean working tree (must be checked before anything is written).
log('checking the working tree is clean…');
{
  const st = git(['status', '--porcelain']);
  if (st.status !== 0) fail('git status failed.');
  if ((st.stdout ?? '').trim() !== '') {
    fail('working tree not clean — commit or stash first; the tag must point at the reviewed commit.');
  }
}

// 3. Root package.json version must match the requested version.
log('checking root package.json version…');
{
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (pkg.version !== version) {
    fail(
      `version mismatch — root package.json is "${pkg.version}" but you asked to tag "${version}". ` +
        `Bump first (see CONTRIBUTING.md → Releases).`,
    );
  }
}

// 4. The tag must not already exist (never move an existing release tag).
log(`checking tag ${tag} does not already exist…`);
{
  const has = git(['rev-parse', '-q', '--verify', `refs/tags/${tag}`]);
  if ((has.stdout ?? '').trim() !== '') {
    fail(`tag ${tag} already exists — refusing to move an existing release tag.`);
  }
}

// 5. Release tags are cut from main.
log('checking the current branch is main…');
{
  const br = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  const branch = (br.stdout ?? '').trim();
  if (branch !== 'main') {
    fail(`current branch is "${branch}", expected "main" — release tags are cut from main.`);
  }
}

// 6. Local main must be aligned with origin/main.
log('fetching origin/main and checking alignment…');
{
  const fetched = git(['fetch', 'origin', 'main'], { stdio: 'inherit' });
  if (fetched.status !== 0) fail('git fetch origin main failed — cannot verify you are up to date.');
  const head = (git(['rev-parse', 'HEAD']).stdout ?? '').trim();
  const originMain = (git(['rev-parse', 'origin/main']).stdout ?? '').trim();
  if (head !== originMain) {
    fail(
      `local main (${head.slice(0, 8)}) is not aligned with origin/main (${originMain.slice(0, 8)}) — ` +
        `push/pull so the tag lands on the reviewed commit.`,
    );
  }
}

// 7. Version gate on the exact commit, clean tree required.
log('running verify-versions on the exact commit…');
{
  const res = spawnSync(process.execPath, [path.join(root, 'scripts', 'verify-versions.mjs')], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, ZELARI_VERIFY_VERSIONS_REQUIRE_CLEAN: '1' },
  });
  if (res.status !== 0) process.exit(res.status ?? 1);
}

// 8. Create the annotated tag.
log(`tagging ${tag}…`);
{
  const t = git(['tag', '-a', tag, '-m', `release ${tag}`], { stdio: 'inherit' });
  if (t.status !== 0) fail('git tag failed.');
}

// 9. Push main, then the tag.
log('pushing main…');
{
  const p = git(['push', 'origin', 'main'], { stdio: 'inherit' });
  if (p.status !== 0) fail('git push origin main failed.');
}
log(`pushing tag ${tag}…`);
{
  const p = git(['push', 'origin', tag], { stdio: 'inherit' });
  if (p.status !== 0) fail(`git push origin ${tag} failed.`);
}

log(
  `done — ${tag} pushed. Watch publish.yml + release-desktop.yml; the release gate also ` +
    `requires ci.yml to be green on the same SHA.`,
);
