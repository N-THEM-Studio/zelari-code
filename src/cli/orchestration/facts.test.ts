/**
 * orchestration/facts — t23: cheap decision-input collectors.
 *
 * The PURE policy never touches I/O; these tests pin down that the collectors
 * fail soft (unknown ≠ error) and surface the active-contract seam (t22).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectOrchestrationFacts, collectRepoFileCount } from './facts.js';
import { setActiveContractScope } from '../kraken/contractCompiler.js';
import { deriveInitialContract } from '@zelari/core';

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'zelari-orch-facts-'));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('collectRepoFileCount', () => {
  it('counts files recursively, skipping dependency/vendor dirs', async () => {
    await fs.writeFile(path.join(tmp, 'a.ts'), 'x');
    await fs.mkdir(path.join(tmp, 'nested'));
    await fs.writeFile(path.join(tmp, 'nested', 'b.ts'), 'x');
    await fs.mkdir(path.join(tmp, 'node_modules'));
    await fs.writeFile(path.join(tmp, 'node_modules', 'dep.js'), 'x');
    await fs.mkdir(path.join(tmp, '.git'));
    await fs.writeFile(path.join(tmp, '.git', 'HEAD'), 'x');

    const count = await collectRepoFileCount(tmp);
    expect(count).toBe(2);
  });

  it('unreadable root ⇒ undefined (never throws)', async () => {
    const missing = path.join(tmp, 'does-not-exist');
    expect(await collectRepoFileCount(missing)).toBeUndefined();
  });
});

describe('collectOrchestrationFacts — t22 seam inputs', () => {
  afterEach(() => {
    // Never leak an active scope into other suites.
    setActiveContractScope(undefined);
  });

  it('no active contract ⇒ neutral facts with previousFailures pinned to 0', async () => {
    setActiveContractScope(undefined);
    const facts = await collectOrchestrationFacts(tmp);
    expect(facts.previousFailures).toBe(0); // spine look-up not threaded pre-dispatch
    expect(facts.risk).toBeUndefined();
    expect(facts.scopePathsCount).toBeUndefined();
    expect(typeof facts.repoSize).toBe('number');
  });

  it('active contract risk/scope flow through the seam', async () => {
    const base = deriveInitialContract(1, 'Harden the verifier end to end');
    setActiveContractScope({ ...base, risk: 'high', scope: { allowedPaths: ['src/**'], forbiddenPaths: [] } });
    const facts = await collectOrchestrationFacts(tmp);
    expect(facts.risk).toBe('high');
    expect(facts.scopePathsCount).toBe(1); // non-empty declared paths only
  });
});
