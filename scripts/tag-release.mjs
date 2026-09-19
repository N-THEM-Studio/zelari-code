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
 * Usage: node scripts/tag-release.mjs <version> --scope=plan:<phase>|exception:<reason>
 *   <version>: X.Y.Z or vX.Y.Z.  <phase>: S0|S1|S2|S3|S4|S5|M1|M2 (ZELARI-2.37-NEXT.md §4/§5).
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

// 1. Arguments: version (X.Y.Z or vX.Y.Z) + --scope ack (validated at gate 8).
const usage =
  'usage: node scripts/tag-release.mjs <version> --scope=plan:<phase>|exception:<reason>\n' +
  '  <version>   e.g. v2.45.1\n' +
  '  --scope     what authorizes this tag, against ZELARI-2.37-NEXT.md §4/§5:\n' +
  '              plan:S0|S1|S2|S3|S4|S5|M1|M2  — the content belongs to that plan phase\n' +
  '              exception:<reason>             — written surface exception, recorded in the tag message';
let raw;
let scope;
for (const a of process.argv.slice(2)) {
  if (a.startsWith('--scope=')) scope = a.slice('--scope='.length);
  else if (a.startsWith('--')) {
    console.error(`[tag-release] unknown flag "${a}".`);
    console.error(`[tag-release] ${usage}`);
    process.exit(1);
  } else if (raw === undefined) raw = a;
  else {
    console.error(`[tag-release] unexpected extra argument "${a}".`);
    console.error(`[tag-release] ${usage}`);
    process.exit(1);
  }
}
if (!raw) {
  console.error(`[tag-release] ${usage}`);
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

// 8. Scope ack: every tag must declare what authorizes it — a plan phase (§4)
//    or a written surface exception (§5). Declarations travel in the tag
//    message and are audited against the scorecard (§10).
const planMatch = scope ? /^plan:(S0|S1|S2|S3|S4|S5|M1|M2)$/.exec(scope) : null;
const exceptionMatch = scope ? /^exception:(.+)$/.exec(scope) : null;
const exceptionReason = exceptionMatch ? exceptionMatch[1].trim() : '';
if (!planMatch && !exceptionReason) {
  fail(
    'missing or invalid --scope — every release tag must declare what authorizes it:\n' +
      '[tag-release]   --scope=plan:S0|S1|S2|S3|S4|S5|M1|M2   content belongs to that phase (ZELARI-2.37-NEXT.md §4)\n' +
      '[tag-release]   --scope=exception:<reason>            written surface exception (§5), recorded in the tag message\n' +
      '[tag-release] declarations are audited against the scorecard in ZELARI-2.37-NEXT.md §10.',
  );
}
if (planMatch) {
  log(`scope: plan:${planMatch[1]} (authorized by ZELARI-2.37-NEXT.md §4).`);
} else {
  console.warn(
    `[tag-release] scope EXCEPTION declared: ${exceptionReason} (recorded in the tag message; §10 audit).`,
  );
}

// 9. Create the annotated tag (the scope declaration travels in the message).
log(`tagging ${tag}…`);
{
  const t = git(['tag', '-a', tag, '-m', `release ${tag} (scope: ${scope})`], { stdio: 'inherit' });
  if (t.status !== 0) fail('git tag failed.');
}

// 10. Push main, then the tag.
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
