/**
 * verificationAdapters/python — Python projects (t19 §P1.A).
 *
 * Honest-unknown semantics throughout: a tool is bound ONLY when the repo
 * references it somewhere real — absence of evidence means `null` (dropped),
 * NEVER a fabricated command that would just fail confusingly at runtime.
 *
 * Detection markers, strongest first: pyproject.toml, setup.py,
 * requirements.txt (any one suffices).
 *
 * Binding rules:
 * - test  → `pytest` when the token appears in a recognized config file
 *   (pyproject.toml / setup.cfg / requirements.txt — covers
 *   [dependency-groups], optional-dependencies, [tool.pytest.ini_options])
 *   OR a tests/ directory exists (best-effort heuristic per t19 scope).
 * - typecheck → `mypy` or `pyright` ONLY when referenced in a config file
 *   (dedicated mypy.ini / .mypy.ini / pyrightconfig.json count by existence).
 *   If both are referenced, mypy wins (brief order). Else null.
 * - build → ALWAYS null: Python has no single standard build verb; picking
 *   one arbitrarily would violate the honest-unknown contract.
 */
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { NativePackCommands, VerificationAdapter } from './types.js';

async function fileExists(candidate: string): Promise<boolean> {
  try {
    return (await stat(candidate)).isFile();
  } catch {
    return false;
  }
}

async function dirExists(candidate: string): Promise<boolean> {
  try {
    return (await stat(candidate)).isDirectory();
  } catch {
    return false;
  }
}

const DETECT_MARKERS: ReadonlyArray<readonly [marker: string, score: number]> = [
  ['pyproject.toml', 10],
  ['setup.py', 8],
  ['requirements.txt', 6],
];

/** Text candidates scanned once per buildPlan: tool references live here. */
const SCAN_FILES = [
  'pyproject.toml',
  'requirements.txt',
  'setup.cfg',
  'mypy.ini',
  '.mypy.ini',
  'pyrightconfig.json',
] as const;

export const pythonAdapter: VerificationAdapter = {
  async detect(root: string): Promise<number> {
    let best = 0;
    for (const [marker, score] of DETECT_MARKERS) {
      if (score > best && (await fileExists(path.join(root, marker)))) best = score;
    }
    return best;
  },

  async buildPlan(root: string): Promise<NativePackCommands> {
    // Read every candidate once; presence itself can be a signal
    // (pyrightconfig.json exists → pyright regardless of tokens).
    const present = new Map<string, string>();
    for (const name of SCAN_FILES) {
      try {
        present.set(name, await readFile(path.join(root, name), 'utf-8'));
      } catch {
        // absent → skip
      }
    }
    const hasToken = (token: string): boolean =>
      [...present.values()].some((text) => text.includes(token));

    const pytestEvidenced = hasToken('pytest') || (await dirExists(path.join(root, 'tests')));
    const mypyReferenced = hasToken('mypy') || present.has('mypy.ini') || present.has('.mypy.ini');
    const pyrightReferenced = hasToken('pyright') || present.has('pyrightconfig.json');

    return {
      testCommand: pytestEvidenced ? 'pytest' : null,
      typecheckCommand: mypyReferenced ? 'mypy' : pyrightReferenced ? 'pyright' : null,
      buildCommand: null, // see rationale in the header: never fabricated
    };
  },
};
