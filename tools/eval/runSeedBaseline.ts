/*
 * tools/eval/runSeedBaseline.ts — WS7 slice 0: seed a REAL eval baseline.
 *
 *   node --experimental-strip-types tools/eval/runSeedBaseline.ts \
 *     --label <slug> [--tier 0] [--limit N] [--store <dir>]
 *     [--no-tag] [--strict]
 *
 * WHY THIS EXISTS: eval/results/ carries no manifest-hash suite, so runGate /
 * runMeasured have nothing to compare a candidate against. This job produces
 * that suite from a MEASURED run and tags it.
 *
 * GOLDEN RULE — no fabricated numbers:
 *   - prerequisites are validated BEFORE any write: the credentials the
 *     headless runner needs, the CLI entry point, a resolvable git HEAD;
 *   - when they are missing the job prints an explicit reason and exits 3
 *     WITHOUT creating the label dir, touching the store or tagging anything;
 *   - the `echo` runner (runAnchors' stub, which invents ok/toolCalls/wallMs)
 *     is REFUSED here — a baseline may only be a measured run;
 *   - an already-existing tag is a hard failure (exit 2) BEFORE the suite runs.
 *
 * Provider/model ATTRIBUTION: this job cannot pin them (the headless runner
 * inherits the process env, and resolveProfile owns model selection), so the
 * manifest records what the environment actually pins — `ZELARI_PROVIDER` /
 * `ZELARI_MODEL` — and `null` otherwise. It never claims a model the run did
 * not use.
 *
 * Artefacts of a successful run (all produced BY the run):
 *   eval/results/<manifestHash>/anchors.jsonl   canonical store (runGate reads this)
 *   eval/results/<manifestHash>/summary.json
 *   eval/results/<label>/seed-manifest.json     provenance + measured counts
 *   eval/results/<label>/anchors.jsonl          the same records, tag-addressable
 * plus a LOCAL annotated tag `eval-baseline/<label>` (never pushed).
 */

import { argv, env as processEnv, exit } from 'node:process';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { EvalResultStore } from './resultStore.ts';
import {
  DEFAULT_ANCHORS_DIR,
  headlessAgentRunner,
  runAnchorSuite,
  type SuiteRunResult,
} from './runAnchors.ts';
import { loadAnchors } from './anchorLoader.ts';
import type { AnchorRunRecord } from './types.ts';

/** Tag namespace for seeded baselines (`eval-baseline/<label>`). */
export const SEED_TAG_PREFIX = 'eval-baseline/';
export const SEED_MANIFEST_FILE = 'seed-manifest.json';
export const DEFAULT_CLI_ENTRY = 'bin/zelari-code.js';

/**
 * ANY of these satisfies the credential gate — the SAME predicate
 * runAnchors.ts applies before spawning the headless runner, so this job can
 * never be greener than the run it is about to perform.
 */
export const CREDENTIAL_VARS = [
  'ZELARI_API_KEY',
  'ZELARI_LOCAL_CLI',
  'ZELARI_EVAL_ALLOW_HEADLESS',
] as const;

/** A label becomes a directory name AND a git ref — keep it tight. */
export const SEED_LABEL_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** runGate keys the store by manifest hash; a label must never collide. */
const MANIFEST_HASH_RE = /^[0-9a-f]{16,}$/;

export interface SeedArgs {
  label: string;
  /** Declared reduced subset (default: tier 0 = the PR/anchor-priority set). */
  tiers: (0 | 1 | 2)[];
  limit?: number;
  storeDir?: string;
  tag: boolean;
  strict: boolean;
}

function argOf(argvList: readonly string[], name: string): string | undefined {
  const i = argvList.indexOf(`--${name}`);
  return i >= 0 ? argvList[i + 1] : undefined;
}

function tiersOf(argvList: readonly string[]): (0 | 1 | 2)[] {
  const tiers: (0 | 1 | 2)[] = [];
  for (let i = argvList.indexOf('--tier'); i >= 0; i = argvList.indexOf('--tier', i + 1)) {
    const v = Number(argvList[i + 1]);
    if (v === 0 || v === 1 || v === 2) tiers.push(v);
  }
  return tiers.length ? tiers : [0];
}

/** Pure argv → SeedArgs. Throws on an unusable label / limit (usage error). */
export function parseSeedArgs(
  argvList: readonly string[],
  now: () => string = () => new Date().toISOString(),
): SeedArgs {
  const tiers = tiersOf(argvList);
  const label =
    argOf(argvList, 'label') ??
    // ISO-8601 is UPPERCASE-T (2026-01-01T00:00:00Z) — the label slug is
    // lowercase-only, so the derived default must be lowercased or it would
    // never validate against SEED_LABEL_RE.
    `seed-t${tiers.join('-')}-${now().toLowerCase().replace(/[:.]/g, '-').slice(0, 19)}`;
  if (!SEED_LABEL_RE.test(label)) {
    throw new Error(
      `--label "${label}" must be a slug matching ${SEED_LABEL_RE.source} (it becomes a directory name and a git ref)`,
    );
  }
  if (MANIFEST_HASH_RE.test(label)) {
    throw new Error(
      `--label "${label}" looks like a manifest hash; the store keys those dirs — pick a readable label`,
    );
  }
  const limitRaw = argOf(argvList, 'limit');
  const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    throw new Error('--limit must be an integer >= 1');
  }
  return {
    label,
    tiers,
    ...(limit !== undefined ? { limit } : {}),
    ...(argOf(argvList, 'store') ? { storeDir: argOf(argvList, 'store')! } : {}),
    tag: !argvList.includes('--no-tag'),
    strict: argvList.includes('--strict'),
  };
}

export interface SeedPrereqs {
  ok: boolean;
  /** Var NAME that satisfied the gate — never its value. */
  satisfiedBy?: string;
  gitSha?: string;
  /** One human reason per unmet prerequisite. */
  missing: string[];
}

/** Validate everything the measured run needs, WITHOUT touching the disk. */
export function checkSeedPrereqs(input: {
  env: Record<string, string | undefined>;
  cwd: string;
  gitSha: string | null;
  cliEntry?: string;
}): SeedPrereqs {
  const missing: string[] = [];
  const cliEntry = input.cliEntry ?? DEFAULT_CLI_ENTRY;
  const satisfiedBy = CREDENTIAL_VARS.find((name) => {
    const v = input.env[name];
    return typeof v === 'string' && v.length > 0;
  });
  if (!satisfiedBy) {
    missing.push(
      `provider not configured — none of ${CREDENTIAL_VARS.join(' / ')} is set, so the headless runner cannot run`,
    );
  }
  if (!existsSync(path.join(input.cwd, cliEntry))) {
    missing.push(`CLI entry point missing: ${cliEntry} (relative to ${input.cwd})`);
  }
  if (!input.gitSha) {
    missing.push('git HEAD is unresolvable — the manifest and the baseline tag need a sha');
  }
  return {
    ok: missing.length === 0,
    ...(satisfiedBy ? { satisfiedBy } : {}),
    ...(input.gitSha ? { gitSha: input.gitSha } : {}),
    missing,
  };
}

export interface SeedManifest {
  version: 1;
  kind: 'eval-baseline-seed';
  label: string;
  tag: string;
  createdAt: string;
  gitSha: string;
  runner: 'headless';
  /**
   * What the environment actually pinned for this run. `null` = not pinned by
   * env, so the CLI's own config resolved it (never guessed here).
   */
  attribution: { providerEnv: string | null; modelEnv: string | null };
  credentialsSatisfiedBy: string;
  cliEntry: string;
  /** The DECLARED subset — no silent truncation. */
  subset: { tiers: number[]; limit: number | null; selected: number; available: number };
  /** Canonical store key: what runGate / runMeasured compare against. */
  manifestHash: string;
  storeDir: string;
  counts: { passed: number; failed: number; blocked: number; total: number };
  anchorIds: string[];
}

/** Pure manifest assembly — every number comes from the run's own records. */
export function buildSeedManifest(input: {
  args: SeedArgs;
  createdAt: string;
  gitSha: string;
  satisfiedBy: string;
  cliEntry?: string;
  providerEnv?: string;
  modelEnv?: string;
  available: number;
  manifestHash: string;
  storeDir: string;
  records: readonly AnchorRunRecord[];
}): SeedManifest {
  const { args, records } = input;
  return {
    version: 1,
    kind: 'eval-baseline-seed',
    label: args.label,
    tag: `${SEED_TAG_PREFIX}${args.label}`,
    createdAt: input.createdAt,
    gitSha: input.gitSha,
    runner: 'headless',
    attribution: {
      providerEnv: input.providerEnv && input.providerEnv.length > 0 ? input.providerEnv : null,
      modelEnv: input.modelEnv && input.modelEnv.length > 0 ? input.modelEnv : null,
    },
    credentialsSatisfiedBy: input.satisfiedBy,
    cliEntry: input.cliEntry ?? DEFAULT_CLI_ENTRY,
    subset: {
      tiers: [...args.tiers],
      limit: args.limit ?? null,
      selected: new Set(records.map((r) => r.anchorId)).size,
      available: input.available,
    },
    manifestHash: input.manifestHash,
    storeDir: input.storeDir,
    counts: {
      passed: records.filter((r) => r.result === 'pass').length,
      failed: records.filter((r) => r.result === 'fail').length,
      blocked: records.filter((r) => r.result === 'blocked').length,
      total: records.length,
    },
    anchorIds: [...new Set(records.map((r) => r.anchorId))],
  };
}

/** Minimal git seam so the orchestration is testable without a repo. */
export interface SeedGit {
  headSha(): string | null;
  tagExists(tag: string): boolean;
  createTag(tag: string, message: string): { ok: boolean; error?: string };
}

export function processSeedGit(cwd: string): SeedGit {
  const run = (args: string[]): ReturnType<typeof spawnSync> =>
    spawnSync('git', args, { cwd, encoding: 'utf8' });
  return {
    headSha() {
      const r = run(['rev-parse', 'HEAD']);
      return r.status === 0 ? String(r.stdout ?? '').trim() || null : null;
    },
    tagExists(tag) {
      if (!tag) return false;
      return run(['rev-parse', '--verify', '--quiet', `refs/tags/${tag}`]).status === 0;
    },
    createTag(tag, message) {
      const r = run(['tag', '-a', tag, '-m', message]);
      return r.status === 0
        ? { ok: true }
        : { ok: false, error: String(r.stderr ?? '').trim() || `git tag exited ${r.status}` };
    },
  };
}

export type SeedSuiteRunner = (input: {
  args: SeedArgs;
  store: EvalResultStore;
  anchorsDir: string;
}) => Promise<SuiteRunResult>;

const defaultSuiteRunner: SeedSuiteRunner = ({ args, store, anchorsDir }) =>
  runAnchorSuite({
    tiers: args.tiers,
    anchorsDir,
    store,
    runner: headlessAgentRunner(), // measured only — never the echo stub.
    ...(args.limit !== undefined ? { limit: args.limit } : {}),
  });

export interface SeedRunDeps {
  cwd: string;
  env: Record<string, string | undefined>;
  args: SeedArgs;
  git: SeedGit;
  anchorsDir?: string;
  suite?: SeedSuiteRunner;
  now?: () => string;
  cliEntry?: string;
  log?: (line: string) => void;
  errlog?: (line: string) => void;
}

/**
 * The whole job, dependency-injected. Returns the exit code; writes NOTHING
 * before every prerequisite has been satisfied and the tag namespace is free.
 */
export async function runSeed(deps: SeedRunDeps): Promise<number> {
  const log = deps.log ?? ((l: string) => console.log(l));
  const errlog = deps.errlog ?? ((l: string) => console.error(l));
  const now = deps.now ?? (() => new Date().toISOString());
  const tag = `${SEED_TAG_PREFIX}${deps.args.label}`;
  const anchorsDir = deps.anchorsDir ?? DEFAULT_ANCHORS_DIR;

  // 1. Prerequisites — NO write happens before this passes.
  const prereqs = checkSeedPrereqs({
    env: deps.env,
    cwd: deps.cwd,
    gitSha: deps.git.headSha(),
    ...(deps.cliEntry ? { cliEntry: deps.cliEntry } : {}),
  });
  if (!prereqs.ok) {
    for (const reason of prereqs.missing) errlog(`runSeedBaseline: ${reason}`);
    errlog(
      'runSeedBaseline: provider non configurato — baseline non seedata ' +
        '(provider not configured — no baseline seeded). Nothing was written to eval/results/ ' +
        'and no tag was created.',
    );
    return 3;
  }

  // 2. Tag namespace must be free BEFORE a single anchor runs.
  if (deps.args.tag && deps.git.tagExists(tag)) {
    errlog(
      `runSeedBaseline: tag "${tag}" already exists — refusing to overwrite a recorded baseline. ` +
        'Pick another --label, or delete the tag deliberately with `git tag -d ' +
        tag +
        '`.',
    );
    return 2;
  }

  const store = deps.args.storeDir
    ? new EvalResultStore(path.resolve(deps.args.storeDir))
    : EvalResultStore.default();
  const available = loadAnchors(anchorsDir).filter((a) =>
    (deps.args.tiers as number[]).includes(a.tier),
  ).length;
  log(
    `runSeedBaseline: label=${deps.args.label} tiers=[${deps.args.tiers.join(', ')}] ` +
      `anchors=${deps.args.limit ? `${deps.args.limit}/${available}` : available} ` +
      `store=${store.rootDir}`,
  );

  // 3. The measured run (the ONLY source of numbers in every artefact below).
  const suite = deps.suite ?? defaultSuiteRunner;
  const result = await suite({ args: deps.args, store, anchorsDir });

  // 4. Label dir — written AFTER the run, so a failed run leaves no stub.
  const labelDir = path.join(store.rootDir, deps.args.label);
  mkdirSync(labelDir, { recursive: true });
  const manifest = buildSeedManifest({
    args: deps.args,
    createdAt: now(),
    gitSha: prereqs.gitSha!,
    satisfiedBy: prereqs.satisfiedBy!,
    ...(deps.cliEntry ? { cliEntry: deps.cliEntry } : {}),
    ...(deps.env.ZELARI_PROVIDER ? { providerEnv: deps.env.ZELARI_PROVIDER } : {}),
    ...(deps.env.ZELARI_MODEL ? { modelEnv: deps.env.ZELARI_MODEL } : {}),
    available,
    manifestHash: result.manifestHash,
    storeDir: path.relative(deps.cwd, store.rootDir) || store.rootDir,
    records: result.records,
  });
  writeFileSync(
    path.join(labelDir, SEED_MANIFEST_FILE),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );
  writeFileSync(
    path.join(labelDir, 'anchors.jsonl'),
    result.records.map((r) => JSON.stringify(r)).join('\n') + '\n',
    'utf8',
  );
  log(`runSeedBaseline: seeded ${result.manifestHash} (${result.records.length} record(s))`);
  log(`runSeedBaseline: manifest → ${path.join(labelDir, SEED_MANIFEST_FILE)}`);

  // 5. Local tag only — this job NEVER pushes.
  if (deps.args.tag) {
    const created = deps.git.createTag(
      tag,
      `eval baseline ${deps.args.label} — manifest ${result.manifestHash}, ` +
        `${manifest.counts.passed}/${manifest.counts.total} pass @ ${manifest.gitSha.slice(0, 12)}`,
    );
    if (!created.ok) {
      errlog(
        `runSeedBaseline: artefacts written but the tag "${tag}" could NOT be created: ` +
          `${created.error ?? 'unknown error'}. The baseline is NOT tagged.`,
      );
      return 1;
    }
    log(`runSeedBaseline: tag ${tag} created (local only — not pushed)`);
  }

  log(
    `runSeedBaseline: ${manifest.counts.passed} pass / ${manifest.counts.failed} fail / ` +
      `${manifest.counts.blocked} blocked`,
  );
  if (deps.args.strict && manifest.counts.passed !== manifest.counts.total) return 1;
  return 0;
}

/** Re-exported for tests: read back what a previous seed wrote. */
export function readSeedManifest(labelDir: string): SeedManifest {
  return JSON.parse(readFileSync(path.join(labelDir, SEED_MANIFEST_FILE), 'utf8')) as SeedManifest;
}

async function main(): Promise<number> {
  if (argv.includes('--runner')) {
    console.error(
      'runSeedBaseline: --runner is not accepted here. A baseline is a MEASURED run only; ' +
        "the synthetic runner (runAnchors --runner echo) invents outcomes and must never seed a baseline.",
    );
    return 2;
  }
  let args: SeedArgs;
  try {
    args = parseSeedArgs(argv);
  } catch (err) {
    console.error(`runSeedBaseline: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
  return runSeed({
    cwd: process.cwd(),
    env: processEnv,
    args,
    git: processSeedGit(process.cwd()),
  });
}

if (argv[1] && path.resolve(argv[1]) === path.resolve(import.meta.filename)) {
  main().then(
    (code) => exit(code),
    (err: unknown) => {
      console.error(`runSeedBaseline: ${err instanceof Error ? err.message : String(err)}`);
      exit(1);
    },
  );
}
