/**
 * tools/eval/editBench.ts — t79 ADR-0033 measurement bench (PURE parts).
 *
 * Deterministic 200-patch set (100 TS + 100 Python, 10 families × 20) for the
 * anchored-edit A/B experiment. Std-lib only, no network, no CLI spawn:
 * live execution lives in runEditBench.ts (integration).
 *
 * Metriche ADR-0033: pass-rate primo colpo, token totali, corruzioni
 * (parse-error residui post-run). Se il delta non è positivo, l'ADR si riapre.
 */

import type { ArmRunRecord } from './arms/types.ts';

export const EDIT_BENCH_SEED = 0x00ad33;
export const EDIT_BENCH_CASES = 200;
export const EDIT_BENCH_REPS = 3;

export type BenchLanguage = 'ts' | 'py';

export interface EditBenchPatch {
  id: string;
  family: string;
  language: BenchLanguage;
  task: string;
  files: Array<{ path: string; content: string }>;
  success: Array<{ command: string; expectExit: number }>;
}

/** Deterministic PRNG (mulberry32) — same seed, same 200 patches, forever. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NAMES = [
  'alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel',
  'india', 'juliet', 'kilo', 'lima', 'mike', 'november', 'oscar', 'papa',
  'quebec', 'romeo', 'sierra', 'tango',
] as const;

interface Vars {
  name: string;
  k: number;
  a: number;
  b: number;
  n: number;
  q: number;
  p: string;
}

function vars(r: () => number): Vars {
  return {
    name: NAMES[Math.floor(r() * NAMES.length)],
    k: 2 + Math.floor(r() * 8),
    a: 1 + Math.floor(r() * 40),
    b: 1 + Math.floor(r() * 40),
    n: 2 + Math.floor(r() * 90),
    q: 1 + Math.floor(r() * 9),
    p: (1 + r() * 9).toFixed(2),
  };
}

type FamilyBuilder = (v: Vars) => Omit<EditBenchPatch, 'id' | 'family'>;

const TS_CHECK = 'node --experimental-strip-types t.mts';

/** 10 families: 5 TS + 5 Python mirrors. Every template FAILS pre-patch. */
const FAMILIES: Array<{ family: string; language: BenchLanguage; build: FamilyBuilder }> = [
  {
    family: 'ts-null-guard',
    language: 'ts',
    build: (v) => ({
      language: 'ts',
      task: `mod.mts: first() throws on an empty array (${v.name}). Return undefined instead; keep first([x]) behaviour. t.mts must pass.`,
      files: [
        {
          path: 'mod.mts',
          content: `// module: ${v.name}\nexport function first(xs: Array<{ value: number }>): number | undefined {\n  return xs[0].value;\n}\n`,
        },
        {
          path: 't.mts',
          content: `import { first } from './mod.mts';\nimport assert from 'node:assert';\nassert.strictEqual(first([]), undefined);\nassert.strictEqual(first([{ value: ${v.n} }]), ${v.n});\nconsole.log('ok');\n`,
        },
      ],
      success: [{ command: TS_CHECK, expectExit: 0 }],
    }),
  },
  {
    family: 'ts-off-by-one',
    language: 'ts',
    build: (v) => ({
      language: 'ts',
      task: `mod.mts: total() (${v.name}) returns NaN — the loop bound is wrong. Fix it so the sum of the array is returned. t.mts must pass.`,
      files: [
        {
          path: 'mod.mts',
          content: `// module: ${v.name}\nexport function total(xs: number[]): number {\n  let s = 0;\n  for (let i = 0; i <= xs.length; i++) {\n    s += xs[i];\n  }\n  return s;\n}\n`,
        },
        {
          path: 't.mts',
          content: `import { total } from './mod.mts';\nimport assert from 'node:assert';\nassert.strictEqual(total([${v.a}, ${v.b}]), ${v.a + v.b});\nconsole.log('ok');\n`,
        },
      ],
      success: [{ command: TS_CHECK, expectExit: 0 }],
    }),
  },
  {
    family: 'ts-rename-export',
    language: 'ts',
    build: (v) => ({
      language: 'ts',
      task: `mod.mts: rename the exported function legacyCompute to computeTax (${v.name}) — definition and any internal references. t.mts imports computeTax and must pass.`,
      files: [
        {
          path: 'mod.mts',
          content: `// module: ${v.name}\nexport function legacyCompute(n: number): number {\n  return n * ${v.k};\n}\n`,
        },
        {
          path: 't.mts',
          content: `import { computeTax } from './mod.mts';\nimport assert from 'node:assert';\nassert.strictEqual(computeTax(${v.n}), ${v.n * v.k});\nconsole.log('ok');\n`,
        },
      ],
      success: [{ command: TS_CHECK, expectExit: 0 }],
    }),
  },
  {
    family: 'ts-add-default-param',
    language: 'ts',
    build: (v) => ({
      language: 'ts',
      task: `mod.mts: label() (${v.name}) must accept an optional suffix parameter defaulting to '_' appended to the result (signature and body). t.mts must pass.`,
      files: [
        {
          path: 'mod.mts',
          content: `// module: ${v.name}\nexport function label(name: string): string {\n  return 'v' + name;\n}\n`,
        },
        {
          path: 't.mts',
          content: `import { label } from './mod.mts';\nimport assert from 'node:assert';\nassert.strictEqual(label('x'), 'vx_');\nassert.strictEqual(label('x', '-'), 'vx-');\nconsole.log('ok');\n`,
        },
      ],
      success: [{ command: TS_CHECK, expectExit: 0 }],
    }),
  },
  {
    family: 'ts-extract-const',
    language: 'ts',
    build: (v) => ({
      language: 'ts',
      task: `mod.mts: extract the price literal into an exported const UNIT_PRICE: number (${v.name}) and use it inside cost(). t.mts must pass.`,
      files: [
        {
          path: 'mod.mts',
          content: `// module: ${v.name}\nexport function cost(qty: number): number {\n  return qty * ${v.p};\n}\n`,
        },
        {
          path: 't.mts',
          content: `import { cost, UNIT_PRICE } from './mod.mts';\nimport assert from 'node:assert';\nassert.strictEqual(UNIT_PRICE, ${v.p});\nassert.strictEqual(cost(${v.q}), ${v.q} * ${v.p});\nconsole.log('ok');\n`,
        },
      ],
      success: [{ command: TS_CHECK, expectExit: 0 }],
    }),
  },
  {
    family: 'py-null-guard',
    language: 'py',
    build: (v) => ({
      language: 'py',
      task: `mod.py: first() raises IndexError on an empty list (${v.name}). Return None instead; keep first([x]) behaviour. t.py must pass.`,
      files: [
        {
          path: 'mod.py',
          content: `# module: ${v.name}\ndef first(xs):\n    return xs[0]['value']\n`,
        },
        {
          path: 't.py',
          content: `from mod import first\nassert first([]) is None\nassert first([{'value': ${v.n}}]) == ${v.n}\nprint('ok')\n`,
        },
      ],
      success: [{ command: 'python t.py', expectExit: 0 }],
    }),
  },
  {
    family: 'py-off-by-one',
    language: 'py',
    build: (v) => ({
      language: 'py',
      task: `mod.py: total() (${v.name}) raises IndexError — the range bound is wrong. Fix it so the sum of the list is returned. t.py must pass.`,
      files: [
        {
          path: 'mod.py',
          content: `# module: ${v.name}\ndef total(xs):\n    s = 0\n    for i in range(len(xs) + 1):\n        s += xs[i]\n    return s\n`,
        },
        {
          path: 't.py',
          content: `from mod import total\nassert total([${v.a}, ${v.b}]) == ${v.a + v.b}\nprint('ok')\n`,
        },
      ],
      success: [{ command: 'python t.py', expectExit: 0 }],
    }),
  },
  {
    family: 'py-rename-def',
    language: 'py',
    build: (v) => ({
      language: 'py',
      task: `mod.py: rename the function legacy_compute to compute_tax (${v.name}) — definition and any internal references. t.py imports compute_tax and must pass.`,
      files: [
        {
          path: 'mod.py',
          content: `# module: ${v.name}\ndef legacy_compute(n):\n    return n * ${v.k}\n`,
        },
        {
          path: 't.py',
          content: `from mod import compute_tax\nassert compute_tax(${v.n}) == ${v.n * v.k}\nprint('ok')\n`,
        },
      ],
      success: [{ command: 'python t.py', expectExit: 0 }],
    }),
  },
  {
    family: 'py-add-default-param',
    language: 'py',
    build: (v) => ({
      language: 'py',
      task: `mod.py: label() (${v.name}) must accept an optional suffix parameter defaulting to '_' appended to the result (signature and body). t.py must pass.`,
      files: [
        {
          path: 'mod.py',
          content: `# module: ${v.name}\ndef label(name):\n    return 'v' + name\n`,
        },
        {
          path: 't.py',
          content: `from mod import label\nassert label('x') == 'vx_'\nassert label('x', '-') == 'vx-'\nprint('ok')\n`,
        },
      ],
      success: [{ command: 'python t.py', expectExit: 0 }],
    }),
  },
  {
    family: 'py-extract-const',
    language: 'py',
    build: (v) => ({
      language: 'py',
      task: `mod.py: extract the price literal into a module-level constant UNIT_PRICE (${v.name}) and use it inside cost(). t.py must pass.`,
      files: [
        {
          path: 'mod.py',
          content: `# module: ${v.name}\ndef cost(qty):\n    return qty * ${v.p}\n`,
        },
        {
          path: 't.py',
          content: `from mod import cost, UNIT_PRICE\nassert UNIT_PRICE == ${v.p}\nassert cost(${v.q}) == ${v.q} * ${v.p}\nprint('ok')\n`,
        },
      ],
      success: [{ command: 'python t.py', expectExit: 0 }],
    }),
  },
];

/** Generate the deterministic bench set: `count` cases round-robin over families. */
export function generateEditBenchSet(
  seed: number = EDIT_BENCH_SEED,
  count: number = EDIT_BENCH_CASES,
): EditBenchPatch[] {
  const r = mulberry32(seed);
  const perFamily = new Map<string, number>();
  const cases: EditBenchPatch[] = [];
  for (let i = 0; i < count; i++) {
    const f = FAMILIES[i % FAMILIES.length];
    const n = (perFamily.get(f.family) ?? 0) + 1;
    perFamily.set(f.family, n);
    const built = f.build(vars(r));
    cases.push({
      id: `eb-${f.family}-${String(n).padStart(3, '0')}`,
      family: f.family,
      ...built,
      language: f.language,
    });
  }
  return cases;
}

/** A/B arms for the ADR-0033 experiment (§82 env-diff arms). */
export interface EditBenchArm {
  armId: string;
  /** null = filled by the runner (baseline git worktree entry). */
  cliEntry: string | null;
  env: Record<string, string>;
}

export function editBenchArms(): EditBenchArm[] {
  return [
    { armId: 'legacy-relocating', cliEntry: null, env: {} },
    { armId: 'anchored-edit', cliEntry: 'bin/zelari-code.js', env: {} },
  ];
}

/** Model-pinning env diff applied to BOTH arms (same cheap model, §spec). */
export function modelPinEnv(model: string): Record<string, string> {
  return {
    ZELARI_KRAKEN_EXPLORE_MODEL: model,
    ZELARI_KRAKEN_GENERAL_MODEL: model,
    ZELARI_KRAKEN_VERIFY_MODEL: model,
  };
}

export interface ArmSummary {
  armId: string;
  runs: number;
  passed: number;
  firstShotPassRate: number;
  avgInputTokens: number;
  avgOutputTokens: number;
  avgToolCalls: number;
  avgRetries: number;
  /** Post-run files failing a syntax check (residual corruptions). */
  parseErrorFiles: number;
}

/** Aggregate one arm's run records (+ post-run parse-error count). */
export function summarizeArm(armId: string, runs: ArmRunRecord[], parseErrorFiles: number): ArmSummary {
  const n = runs.length || 1;
  const sum = (get: (m: ArmRunRecord['metrics']) => number): number =>
    runs.reduce((acc, r) => acc + get(r.metrics), 0) / n;
  return {
    armId,
    runs: runs.length,
    passed: runs.filter((r) => r.metrics.passed).length,
    firstShotPassRate: runs.length === 0 ? 0 : runs.filter((r) => r.metrics.passed).length / runs.length,
    avgInputTokens: sum((m) => m.inputTokens),
    avgOutputTokens: sum((m) => m.outputTokens),
    avgToolCalls: sum((m) => m.toolCalls),
    avgRetries: sum((m) => m.retries),
    parseErrorFiles,
  };
}

// Linear ETA (minutes) from done/total and elapsed ms; null when not estimable.
export function etaMinutesFrom(done: number, total: number, elapsedMs: number): number | null {
  if (done <= 0 || elapsedMs <= 0 || total <= 0 || done >= total) return null;
  return ((elapsedMs / done) * (total - done)) / 60000;
}

/** Publishable delta report (markdown). Descriptive, never a fabricated verdict. */
export function renderDeltaReport(meta: {
  seed: number;
  count: number;
  reps: number;
  model: string;
  baselineRef: string;
  gitCommit: string;
}, baseline: ArmSummary, candidate: ArmSummary): string {
  const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
  const row = (label: string, b: number, c: number, fmt: (x: number) => string): string =>
    `| ${label} | ${fmt(b)} | ${fmt(c)} |`;
  return [
    '# ADR-0033 edit bench — delta report',
    '',
    `- seed \`${meta.seed}\` · ${meta.count} patch × ${meta.reps} run per arm · model \`${meta.model}\``,
    `- baseline \`${baseline.armId}\` @ ${meta.baselineRef} · candidate \`${candidate.armId}\` @ ${meta.gitCommit}`,
    '',
    '| metric | baseline | anchored |',
    '|---|---|---|',
    row('first-shot pass-rate', baseline.firstShotPassRate, candidate.firstShotPassRate, pct),
    row('runs passed', baseline.passed, candidate.passed, (x) => String(x)),
    row('total runs', baseline.runs, candidate.runs, (x) => String(x)),
    row('avg input tokens', baseline.avgInputTokens, candidate.avgInputTokens, (x) => x.toFixed(0)),
    row('avg output tokens', baseline.avgOutputTokens, candidate.avgOutputTokens, (x) => x.toFixed(0)),
    row('avg tool calls', baseline.avgToolCalls, candidate.avgToolCalls, (x) => x.toFixed(1)),
    row('avg retries', baseline.avgRetries, candidate.avgRetries, (x) => x.toFixed(1)),
    row('residual parse-error files', baseline.parseErrorFiles, candidate.parseErrorFiles, (x) => String(x)),
    '',
    '_Gate ADR-0033: se il delta (pass-rate, token, corruzioni) non è positivo, l\'ADR si riapre._',
    '',
  ].join('\n');
}
