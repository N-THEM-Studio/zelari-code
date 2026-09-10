/**
 * t53 (W5.3) — public API contract test for `@zelari/core`.
 *
 * Pins the THREE documented public interfaces (ADR-0037), as they actually
 * exist on disk:
 *
 *   1. `AgentHarness`      — `@zelari/core/harness`         — `run()`
 *   2. `ToolRegistry`      — `@zelari/core/harness/tools`   — `register` / `invoke` / `getToolRegistry()`
 *   3. resource ledger     — `@zelari/core/runtime`         — `ResourceLedgerEntry`, `computeBudget`, `usageFromLedger`
 *
 * Semver teeth (ADR-0004 + ADR-0037): losing one of the pinned names, or
 * losing `AgentHarness.prototype.run` / `ToolRegistry.prototype.invoke`, is a
 * BREAKING change → major. Adding exports is additive → minor.
 *
 * Two deliberate design choices:
 * - Allow-list, NOT a snapshot of the whole barrel. The root barrel is
 *   intentionally permissive (14 `export *`, ~518 value exports), so a full
 *   snapshot would go red on every ADDITIVE change — a false-red.
 * - `ToolRegistry`/`getToolRegistry` are pinned against the
 *   `harness/tools` barrel, because that is where they are public: the root
 *   barrel does not re-export them today (verified at runtime, t53).
 *
 * `Ledger` is NOT a class in this codebase (no such symbol exists): the
 * ledger surface is the type-only pair `ResourceLedgerEntry` +
 * `ResourceLedgerReason` plus the pure helpers asserted below.
 */
import { describe, expect, it } from 'vitest';
import * as rootApi from './index.js';
import * as harnessApi from './harness/index.js';
import * as toolsApi from './harness/tools/index.js';
import { DEFAULT_PRESSURE_THRESHOLDS } from './runtime/resourcePolicy.js';
import type { ResourceLedgerEntry, ResourceLedgerReason } from './runtime/resourceBudget.js';

/** Root-barrel names the docs call stable. Disappearance ⇒ major. */
const STABLE_ROOT_EXPORTS = ['AgentHarness', 'computeBudget', 'usageFromLedger', 'CORE_VERSION'] as const;

describe('@zelari/core public API contract (t53 / ADR-0037)', () => {
  it('root barrel still exports every documented stable value', () => {
    for (const name of STABLE_ROOT_EXPORTS) {
      expect(name in rootApi, `missing stable root export: ${name}`).toBe(true);
      expect(typeof (rootApi as Record<string, unknown>)[name]).not.toBe('undefined');
    }
  });

  it('AgentHarness is a class whose documented entrypoint is run()', () => {
    expect(typeof rootApi.AgentHarness).toBe('function');
    expect(typeof harnessApi.AgentHarness.prototype.run).toBe('function');
    // Same class object via both paths: no duplicated implementation.
    expect(rootApi.AgentHarness).toBe(harnessApi.AgentHarness);
  });

  it('ToolRegistry is a class with register/invoke, plus the getToolRegistry() singleton', () => {
    expect(typeof toolsApi.ToolRegistry).toBe('function');
    expect(typeof toolsApi.ToolRegistry.prototype.register).toBe('function');
    expect(typeof toolsApi.ToolRegistry.prototype.invoke).toBe('function');
    expect(typeof toolsApi.getToolRegistry).toBe('function');
    expect(toolsApi.getToolRegistry()).toBeInstanceOf(toolsApi.ToolRegistry);
  });

  it('the resource ledger is ResourceLedgerEntry/Reason + pure helpers (no `Ledger` class)', () => {
    // `ResourceLedgerEntry` (interface) and `ResourceLedgerReason` (type) are
    // erased at runtime: they can never be seen with `typeof` or
    // `Object.keys`, so pin them at the type level …
    type LedgerReasonPinned = ResourceLedgerEntry['reason'] extends ResourceLedgerReason ? true : never;
    const ledgerReasonPinned: LedgerReasonPinned = true;
    expect(ledgerReasonPinned).toBe(true);

    // … and give the shape runtime teeth through the documented helpers.
    const ledger: ResourceLedgerEntry[] = [
      { seq: 1, reason: 'tool-call', delta: { toolCalls: 2 } },
      { seq: 1, reason: 'tool-call', delta: { toolCalls: 2 } }, // replayed seq: counted once
      { seq: 2, reason: 'model-turn', delta: { tokens: 10, wallMs: 5 } },
    ];
    expect(rootApi.usageFromLedger(ledger)).toEqual({ toolCallsUsed: 2, wallMs: 5, tokensUsed: 10 });

    const budget = rootApi.computeBudget(
      { maxToolCalls: 10, reserve: { verification: 2, repair: 1 }, pressure: DEFAULT_PRESSURE_THRESHOLDS },
      { toolCallsUsed: 3 },
    );
    expect(budget.toolCalls).toMatchObject({ limit: 10, used: 3, remaining: 7, overrun: 0 });
    expect(budget.reserve).toEqual({ verification: 2, repair: 1 });
  });

  it('CORE_VERSION tracks the CLI release (lockstep, verify-versions gate)', () => {
    expect(rootApi.CORE_VERSION).toBe('2.39.0');
  });
});
