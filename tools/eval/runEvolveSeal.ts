/**
 * tools/eval/runEvolveSeal.ts — W2/t45 anchor sealing CLI (anti-Goodhart).
 *
 *   node --experimental-strip-types tools/eval/runEvolveSeal.ts --list
 *   node --experimental-strip-types tools/eval/runEvolveSeal.ts --seal-tier 0
 *   node --experimental-strip-types tools/eval/runEvolveSeal.ts --seal <id> [<id>...]
 *   node --experimental-strip-types tools/eval/runEvolveSeal.ts --unseal <id>
 *   node --experimental-strip-types tools/eval/runEvolveSeal.ts --verify
 *   node --experimental-strip-types tools/eval/runEvolveSeal.ts --rotation-candidates [N] --ledger <file>
 *
 * Options: --anchors <dir> (default <cwd>/eval/anchors), --dry-run, --json.
 *
 * Seal = freeze current anchor bytes' sha256 into eval/anchors/sealed.json;
 * verify-principles fails CI when a sealed anchor drifts. Unseal never
 * touches anchor bytes — it only drops ids from the manifest. NOTHING here
 * edits anchors or proposes anything (ADR-0036: judge state, human hands).
 *
 * Exit: 0 ok/noop — 1 verify drift — 2 usage/validation errors.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { argv, cwd, exit } from 'node:process';
import { readLedgerFile, rotationCandidates } from './behavioral.ts';
import {
  computeSealManifest,
  listAnchorFiles,
  readSealManifest,
  sealManifestHash,
  sealPath,
  unsealIds,
  verifySeal,
  writeSealManifest,
  type SealManifest,
} from './sealedAnchors.ts';

function arg(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  const v = i >= 0 ? argv[i + 1] : undefined;
  // Guard the repeatable-id flags from swallowing a following flag.
  if (v !== undefined && v.startsWith('--')) return undefined;
  return v;
}

function argsAll(name: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === `--${name}` && i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
      values.push(argv[i + 1]);
    }
  }
  return values;
}

function usage(): string {
  return 'usage: runEvolveSeal.ts --list | --seal <id>... | --seal-tier <0|1|2> | --unseal <id>... | --verify | --rotation-candidates [N] [--ledger <file>] [--anchors <dir>] [--dry-run] [--json]';
}

function main(): number {
  const modes = ['list', 'seal', 'seal-tier', 'unseal', 'verify', 'rotation-candidates'].filter((m) =>
    argv.includes(`--${m}`),
  );
  if (modes.length !== 1) {
    console.error(`runEvolveSeal: give exactly ONE mode (${usage()})`);
    return 2;
  }
  const mode = modes[0];
  const anchorsDir = path.resolve(arg('anchors') ?? path.join(cwd(), 'eval', 'anchors'));
  const file = sealPath(anchorsDir);
  const json = argv.includes('--json');
  const dryRun = argv.includes('--dry-run');
  const now = new Date().toISOString();

  if (mode === 'list') {
    const sealed = readSealManifest(file);
    const files = listAnchorFiles(anchorsDir);
    const sealedIds = new Set((sealed?.anchors ?? []).map((a) => a.id));
    const lines = [
      '=== zelari evolve:seal — anchors (sealed = content frozen, CI-verified) ===',
      ...files.map(
        (f) =>
          `${sealedIds.has(f.id) ? '[sealed]' : '       '}  tier-${f.tier}  ${f.id}  (${f.relPath})`,
      ),
      `=== ${files.length} anchor(s), ${sealedIds.size} sealed — manifest: ${file} ===`,
    ];
    if (sealed) lines.push(`manifest hash (publish in docs/EVALS.md): ${sealManifestHash(sealed).slice(0, 16)}…`);
    console.log(lines.join('\n'));
    return 0;
  }

  if (mode === 'verify') {
    const manifest = readSealManifest(file);
    const v = verifySeal(anchorsDir, manifest);
    if (v.ok) {
      console.log(`seal verified: ${v.sealedCount} sealed anchor(s) intact`);
      return 0;
    }
    for (const p of v.problems) console.error(`✗ ${p}`);
    console.error(`seal verify FAILED (${v.problems.length} problem(s)) — exit 1`);
    return 1;
  }

  if (mode === 'rotation-candidates') {
    const ledgerFile = path.resolve(arg('ledger') ?? path.join(cwd(), '.zelari', 'evolution', 'ledger.jsonl'));
    if (!existsSync(ledgerFile)) {
      console.error(`runEvolveSeal: ledger not found (${ledgerFile}) — rotation candidates come from real ledger outcomes`);
      return 2;
    }
    const limitRaw = arg('rotation-candidates');
    const limit = limitRaw !== undefined && /^\d+$/.test(limitRaw) ? Number(limitRaw) : 5;
    const candidates = rotationCandidates(readLedgerFile(ledgerFile), limit);
    if (json) {
      console.log(JSON.stringify({ ledgerFile, candidates }, null, 2));
      return 0;
    }
    const lines = [
      '=== zelari evolve:seal — hold-out rotation candidates (anonymized: class + counts) ===',
      ...candidates.map((c) => `  ${c.taskClass}  fail+hold=${c.failHold}/${c.total}`),
      '=== author NEW anchors from these classes by hand; nothing is auto-generated ===',
    ];
    console.log(lines.join('\n'));
    return 0;
  }

  // seal / seal-tier / unseal — manifest-mutating modes.
  let ids: string[] = [];
  if (mode === 'seal-tier') {
    const tierRaw = arg('seal-tier');
    if (tierRaw !== '0' && tierRaw !== '1' && tierRaw !== '2') {
      console.error('runEvolveSeal: --seal-tier must be 0 | 1 | 2');
      return 2;
    }
    ids = listAnchorFiles(anchorsDir).filter((f) => f.tier === Number(tierRaw)).map((f) => f.id);
    if (ids.length === 0) {
      console.error(`runEvolveSeal: no tier-${tierRaw} anchors under ${anchorsDir}`);
      return 2;
    }
  } else {
    ids = argsAll(mode);
    if (ids.length === 0) {
      console.error(`runEvolveSeal: --${mode} requires at least one anchor id`);
      console.error(usage());
      return 2;
    }
  }

  const existing = readSealManifest(file);
  let next: SealManifest;
  try {
    next = mode === 'unseal' ? unsealIds(existing ?? { version: 1, sealedAt: now, anchors: [] }, ids) : computeSealManifest(anchorsDir, ids, now, existing);
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
  const { written } = writeSealManifest(file, next, { dryRun });
  const summary = { mode, ids, written, dryRun, manifest: file, anchorsSealed: next.anchors.length, manifestHash: sealManifestHash(next) };
  if (json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`${mode}: ${ids.join(', ')} — ${next.anchors.length} sealed total, manifest ${written ? 'written' : 'DRY RUN (not written)'}`);
    console.log(`manifest hash (publish in docs/EVALS.md): ${summary.manifestHash}`);
  }
  return 0;
}

if (argv[1] && path.resolve(argv[1]) === path.resolve(import.meta.filename)) {
  exit(main());
}
