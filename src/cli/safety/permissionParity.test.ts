/**
 * ADR-0039 Phase 1 — the parity matrix and the SINGLE emission point.
 *
 * Two things are pinned here, both release blockers of ADR-0039:
 *
 *   1. PARITY. The same intent written twice — engine A's `.zelari/permissions.
 *      json` (`pathPrefix`) and engine B's `.zelari/policy.json` (glob `match`,
 *      produced by `permissionAdapter.translatePermissionRule`) — must reach the
 *      SAME verdict for the same dispatch, and the same FINAL effect once each
 *      engine's composition is applied (toolRegistry.ts). Each row states the
 *      expected verdict too, so the matrix is a spec, not a tautology: it cannot
 *      pass by both engines being wrong in the same way.
 *   2. ONE EMISSION POINT. A deny decided by B (or by the category decision) is
 *      now recorded on the spine exactly ONCE, with the layer that decided it —
 *      before ADR-0039 Phase 1 only engine A emitted, so those denials were
 *      invisible to replay, to the inbox and to `/permissions` (whose ledger is
 *      derive-only from this event, t142).
 *
 * HERMETIC (stated, not hidden): every row writes its own temp root; the B side
 * of the matrix is built IN MEMORY with an empty global layer, so a developer's
 * real `~/.zelari/policy.json` can never take part. The registry case below goes
 * through the production loader (`loadPolicySet`) and therefore CAN see that
 * file; it is harmless here because the layers intersect restrict-only — an
 * extra global deny could only add restriction, never mask the project rule the
 * assertions name. The policy env vars are cleared per test for the same reason.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionLogWriter, buildProjection, readSessionLog } from '@zelari/core/session';
import type { SessionEventInput } from '@zelari/core/session';
import type { ToolPermission } from '@zelari/core/harness/tools/toolTypes';
import type { ToolContext } from '@zelari/core/harness/tools/toolTypes';
import { AuditLogger } from './auditLogger.js';
import { deriveOpenNeeds } from '../inboxSources.js';
import { createBuiltinToolRegistry } from '../toolRegistry.js';
import {
  applyAllowRule,
  evaluateToolDispatch,
  PERMISSION_DENIED_KIND,
} from './permissionGate.js';
import { translatePermissionRules } from './permissionAdapter.js';
import { mergeRuleEffect, type LayeredPolicyRuleSet, type PolicyRule } from './policyEngine.js';
import { intersectEffects, matchAgentPolicyRuleLayered } from './policyLayers.js';
import type { PermissionRule } from './permissionPolicy.js';
import {
  clearSessionPermissionRules,
  resetProjectPermissionRuleCache,
} from './permissionRules.js';
import {
  clearSessionPermissionGrants,
  type PermissionPolicy,
} from './toolPermissions.js';

/** Engine A's whole answer, normalized to one comparable token. */
type Verdict = 'allow' | 'ask' | 'deny' | 'none';

type RuleEffect = PermissionRule['effect'];

let root: string;
let writer: SessionLogWriter;

function allowAll(): PermissionPolicy {
  return { read: 'allow', write: 'allow', execute: 'allow', network: 'allow', ui: 'allow', auto: true };
}

function writePermissionsFile(content: unknown): void {
  const dir = path.join(root, '.zelari');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'permissions.json'), JSON.stringify(content, null, 2));
}

function writePolicyFile(content: unknown): void {
  const dir = path.join(root, '.zelari');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'policy.json'), JSON.stringify(content, null, 2));
}

function makeCtx(): ToolContext {
  return {
    signal: new AbortController().signal,
    cwd: root,
    audit: () => undefined,
    sessionId: 'adr39-parity',
    emitSessionEvent: (input: SessionEventInput) => writer.append(input),
  };
}

function makeRegistry(policy: PermissionPolicy = allowAll()) {
  const { registry } = createBuiltinToolRegistry({
    root,
    audit: new AuditLogger(path.join(root, 'audit.jsonl')),
    sessionId: 'adr39-parity',
    profile: 'general',
    enableTask: false,
    enableSkill: false,
    diagnostics: false,
    lspProvider: null,
    permissionPolicy: policy,
  });
  return registry;
}

async function writeFileTool(policy: PermissionPolicy, pathArg: string) {
  const tool = makeRegistry(policy).get('write_file');
  if (!tool) throw new Error('write_file not registered');
  return (await tool.execute({ path: pathArg, content: 'x' } as never, makeCtx())) as {
    ok: boolean;
    error?: string;
  };
}

// ── Parity matrix ──────────────────────────────────────────────────────────

interface ParityRow {
  name: string;
  /** `.zelari/permissions.json` rules — engine A syntax. */
  rules: PermissionRule[];
  tool: string;
  required: readonly ToolPermission[];
  args: Record<string, unknown>;
  /** Category policy both compositions start from (defaults to allow-all). */
  category?: PermissionPolicy;
  /** The verdict BOTH engines must reach (`none` = no rule has an opinion). */
  expect: Verdict;
  /** The FINAL effect both compositions must reach (defaults to `expect`, `none` → category). */
  expectEffect?: string;
}

const docRule = (effect: RuleEffect): PermissionRule => ({
  id: 'docs-scope',
  effect,
  tool: 'write_file',
  pathPrefix: 'docs',
});

const ROWS: ParityRow[] = [
  {
    name: 'path write DENIED by prefix',
    rules: [{ id: 'no-secrets', effect: 'deny', tool: 'write_file', pathPrefix: 'secrets', note: 'never touch secrets' }],
    tool: 'write_file',
    required: ['write'],
    args: { path: 'secrets/key.pem' },
    expect: 'deny',
  },
  {
    name: 'path write ALLOWED by prefix',
    rules: [docRule('allow')],
    tool: 'write_file',
    required: ['write'],
    args: { path: 'docs/note.md' },
    expect: 'allow',
  },
  {
    name: 'path write ASKED by prefix',
    rules: [docRule('ask')],
    tool: 'write_file',
    required: ['write'],
    args: { path: 'docs/note.md' },
    expect: 'ask',
  },
  {
    name: 'execute DENIED by category',
    rules: [{ id: 'no-exec', effect: 'deny', category: 'execute' }],
    tool: 'bash',
    required: ['execute'],
    args: { command: 'rm -rf /tmp/adr39' },
    expect: 'deny',
  },
  {
    name: 'NO rule at all (fast path: nothing has an opinion)',
    rules: [],
    tool: 'write_file',
    required: ['write'],
    args: { path: 'docs/note.md' },
    expect: 'none',
    expectEffect: 'allow',
  },
  {
    name: 'a scoped rule that matches nothing else',
    rules: [{ id: 'no-secrets', effect: 'deny', tool: 'write_file', pathPrefix: 'secrets' }],
    tool: 'write_file',
    required: ['write'],
    args: { path: 'docs/note.md' },
    expect: 'none',
    expectEffect: 'allow',
  },
  {
    name: 'a trailing separator in pathPrefix normalizes the same way',
    rules: [{ id: 'no-secrets', effect: 'deny', pathPrefix: 'secrets/' }],
    tool: 'write_file',
    required: ['write'],
    args: { path: 'secrets/key.pem' },
    expect: 'deny',
  },
  {
    name: 'a prefix never matches a SIBLING name (secrets ≠ secrets-old)',
    rules: [{ id: 'no-secrets', effect: 'deny', pathPrefix: 'secrets' }],
    tool: 'write_file',
    required: ['write'],
    args: { path: 'secrets-old/keep.pem' },
    expect: 'none',
    expectEffect: 'allow',
  },
  {
    name: 'an allow rule never relaxes a category DENY',
    rules: [docRule('allow')],
    tool: 'write_file',
    required: ['write'],
    args: { path: 'docs/note.md' },
    category: { ...allowAll(), write: 'deny' },
    expect: 'allow',
    expectEffect: 'deny',
  },
];

/** Engine A's answer: `null` (no rule spoke) becomes `none`. */
function verdictOfA(row: ParityRow): Verdict {
  const verdict = evaluateToolDispatch({
    toolName: row.tool,
    required: row.required,
    args: row.args,
    root,
  });
  return verdict === null ? 'none' : verdict.decision;
}

/** Engine B's answer: the translated project layer, an EMPTY global layer. */
function verdictOfB(row: ParityRow): { verdict: Verdict; hit: PolicyRule | null } {
  const translated = translatePermissionRules(row.rules);
  const layers: LayeredPolicyRuleSet = { global: { shell: [], edit: [] }, project: translated };
  const hit = matchAgentPolicyRuleLayered(layers, 'restrict-only', row.required, row.args, root);
  return { verdict: hit === null ? 'none' : hit.effect, hit };
}

/**
 * What the REGISTRY does with engine A's verdict (mirrors wrapWithPermissions):
 * `applyAllowRule` — an allow rule may promote a CATEGORY ask and nothing else —
 * or the restrict-only merge, both inside the same deny>ask>allow lattice.
 */
function effectOfA(row: ParityRow, verdict: Verdict): string {
  const category = (row.category ?? allowAll()).write;
  if (verdict === 'none') return category;
  if (verdict === 'allow') return applyAllowRule(category);
  return mergeRuleEffect(category, { match: 'engine-a', effect: verdict, reason: '' });
}

/** …and with engine B's matched rule: the same lattice through intersectEffects. */
function effectOfB(row: ParityRow, hit: PolicyRule | null): string {
  const category = (row.category ?? allowAll()).write;
  return intersectEffects(mergeRuleEffect(category, hit), undefined, undefined);
}

describe('ADR-0039 Phase 1 — parity matrix (translated A syntax vs native B syntax)', () => {
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'zelari-adr39-parity-'));
    await fs.mkdir(path.join(root, 'secrets'), { recursive: true });
    await fs.mkdir(path.join(root, 'docs'), { recursive: true });
    await fs.mkdir(path.join(root, 'secrets-old'), { recursive: true });
    resetProjectPermissionRuleCache();
    clearSessionPermissionRules();
    clearSessionPermissionGrants();
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  for (const row of ROWS) {
    it(`${row.name}: A verdict === B verdict === '${row.expect}', same final effect`, () => {
      writePermissionsFile({ version: 1, rules: row.rules });
      const a = verdictOfA(row);
      const { verdict: b, hit } = verdictOfB(row);
      // The engine verdicts are the parity claim…
      expect(a).toBe(row.expect);
      expect(b).toBe(a);
      // …and the effect each composition reaches must match too (that is what
      // the dispatch actually obeys).
      const effectA = effectOfA(row, a);
      const effectB = effectOfB(row, hit);
      expect(effectB).toBe(effectA);
      expect(effectA).toBe(row.expectEffect ?? row.expect);
    });
  }

  /**
   * RECORDED, not hidden: one pre-existing divergence survives Phase 1 because
   * it lives in the COMPOSITION, not in the engines — engine A promotes a
   * CATEGORY ask to allow when an allow RULE matched (applyAllowRule: "skip the
   * prompt"), while a native B allow rule only fails to restrict
   * (mergeRuleEffect never relaxes). The parity rows above stay on
   * equal-composition inputs on purpose; Phase 2 (the live adapter) owns this
   * one, and this test is here so it cannot be fixed — or worsened — silently.
   */
  it('RECORDED DIVERGENCE: an A allow rule skips a category ask, a native B allow rule does not', () => {
    const row: ParityRow = {
      name: 'allow rule over a category ask',
      rules: [docRule('allow')],
      tool: 'write_file',
      required: ['write'],
      args: { path: 'docs/note.md' },
      category: { ...allowAll(), write: 'ask' },
      expect: 'allow',
    };
    writePermissionsFile({ version: 1, rules: row.rules });
    expect(verdictOfA(row)).toBe('allow');
    expect(verdictOfB(row).verdict).toBe('allow');
    expect(effectOfA(row, verdictOfA(row))).toBe('allow'); // prompt skipped
    expect(effectOfB(row, verdictOfB(row).hit)).toBe('ask'); // prompt stays
  });
});

describe('permissionAdapter — the Phase-2 seed, honest edges', () => {
  it('a pathPrefix becomes the node AND its subtree (one glob cannot say both)', () => {
    expect(translatePermissionRules([{ id: 'r', effect: 'deny', pathPrefix: 'secrets' }])).toEqual({
      shell: [],
      edit: [
        { match: 'secrets', effect: 'deny' },
        { match: 'secrets/**', effect: 'deny' },
      ],
    });
    // …and NEVER `secrets*`, which would also swallow `secrets-old/**`: A's
    // prefix is a whole-segment run, so an over-broad glob is a different rule.
    expect(translatePermissionRules([{ id: 'r', effect: 'deny', pathPrefix: 'secrets' }]).edit).not.toContainEqual(
      expect.objectContaining({ match: 'secrets*' }),
    );
  });

  it('Windows separators, duplicate and surrounding slashes normalize like A does', () => {
    expect(translatePermissionRules([{ id: 'r', effect: 'deny', pathPrefix: '\\docs\\sub\\' }])).toEqual({
      shell: [],
      edit: [
        { match: 'docs/sub', effect: 'deny' },
        { match: 'docs/sub/**', effect: 'deny' },
      ],
    });
  });

  it('a category rule lands in the native list that matches that dimension', () => {
    expect(translatePermissionRules([{ id: 'x', effect: 'deny', category: 'execute' }])).toEqual({
      shell: [{ match: '*', effect: 'deny' }],
      edit: [],
    });
    expect(translatePermissionRules([{ id: 'w', effect: 'ask', category: 'write' }])).toEqual({
      shell: [],
      edit: [{ match: '*', effect: 'ask' }],
    });
  });

  it('the A note survives as the native reason (the same explanation reaches the user)', () => {
    expect(
      translatePermissionRules([{ id: 'r', effect: 'deny', pathPrefix: 's', note: 'never touch secrets' }]).edit[0],
    ).toEqual({ match: 's', effect: 'deny', reason: 'never touch secrets' });
  });

  it('what has no native home yields NO rule (never an invented catch-all)', () => {
    // A tool-only rule, the read/network/ui categories, an execute rule that
    // also demands a path, and a prefix made only of separators (which A itself
    // can never match): every one of them returns nothing on purpose.
    expect(translatePermissionRules([{ id: 'r', effect: 'deny', tool: 'write_file' }]).edit).toEqual([]);
    expect(translatePermissionRules([{ id: 'r', effect: 'deny', category: 'network' }]).edit).toEqual([]);
    expect(translatePermissionRules([{ id: 'r', effect: 'deny', category: 'execute', pathPrefix: 'x' }])).toEqual({
      shell: [],
      edit: [],
    });
    expect(translatePermissionRules([{ id: 'r', effect: 'deny', pathPrefix: '/' }]).edit).toEqual([]);
  });

  it('declaration order is preserved (B is first-match-wins, so order is meaning)', () => {
    const translated = translatePermissionRules([
      { id: 'a', effect: 'ask', pathPrefix: 'src' },
      { id: 'b', effect: 'deny', pathPrefix: 'src/gen' },
    ]);
    expect(translated.edit.map((r) => r.match)).toEqual(['src', 'src/**', 'src/gen', 'src/gen/**']);
  });
});

// ── ONE emission point ─────────────────────────────────────────────────────

/** Product env this file must not inherit (the loader reads it at build time). */
const POLICY_ENV = ['ZELARI_POLICY', 'ZELARI_POLICY_PRECEDENCE', 'ZELARI_POLICY_LOAD_MODE'] as const;

describe('ADR-0039 Phase 1 — EVERY deny is recorded exactly once, with its deciding layer', () => {
  let saved: Record<string, string | undefined>;

  beforeEach(async () => {
    saved = {};
    for (const key of POLICY_ENV) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'zelari-adr39-emit-'));
    await fs.mkdir(path.join(root, 'secrets'), { recursive: true });
    await fs.mkdir(path.join(root, 'docs'), { recursive: true });
    await fs.writeFile(path.join(root, 'secrets', 'key.pem'), 'old', 'utf-8');
    writer = await SessionLogWriter.open(path.join(root, 'session'), 'adr39-parity', 1);
    resetProjectPermissionRuleCache();
    clearSessionPermissionRules();
    clearSessionPermissionGrants();
  });

  afterEach(async () => {
    await writer.close();
    for (const key of POLICY_ENV) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it('a policy.json rule deny with NO A rules configured emits ONE permission.denied naming the B rule', async () => {
    writePolicyFile({
      version: 1,
      agents: { lead: { edit: [{ match: 'secrets/**', effect: 'deny', reason: 'never touch secrets' }] } },
    });
    // NO `.zelari/permissions.json`: engine A has nothing to say, so the deny can
    // come from B only — exactly the case that used to emit NOTHING (ADR-0039 §4).
    const res = await writeFileTool(allowAll(), 'secrets/key.pem');
    expect(res.ok).toBe(false);
    expect(res.error).toContain('[permission]');
    expect(res.error).toContain("[policy] rule 'secrets/**'");
    expect(res.error).toContain('never touch secrets');
    expect(await fs.readFile(path.join(root, 'secrets', 'key.pem'), 'utf-8')).toBe('old');

    const report = await readSessionLog(writer.path);
    const denials = report.events.filter((e) => e.kind === PERMISSION_DENIED_KIND);
    expect(denials).toHaveLength(1);
    expect(denials[0]?.data).toMatchObject({
      tool: 'write_file',
      source: 'policy',
      matchedRuleId: 'secrets/**',
    });
    expect(String(denials[0]?.data.reason)).toContain('never touch secrets');
    // Replayable (the ADR's claim), and a decision point like any other.
    const projection = buildProjection(report.events, report.issues);
    expect(projection.permissionDenials.map((d) => d.matchedRuleId)).toEqual(['secrets/**']);
    expect(projection.decisionEvents.filter((d) => d.kind === 'permission.denied')).toHaveLength(1);
    // …and inbox-visible: the denial is a claimable need, not a silent block.
    const needs = deriveOpenNeeds(report.events).filter((n) => n.need === 'denied');
    expect(needs).toHaveLength(1);
    expect(needs[0]).toMatchObject({ tool: 'write_file', matchedRuleId: 'secrets/**' });
  });

  it('a CATEGORY deny (no rules anywhere) is recorded too, with source `default`', async () => {
    const res = await writeFileTool({ ...allowAll(), write: 'deny' }, 'secrets/key.pem');
    expect(res.ok).toBe(false);
    expect(res.error).toContain('[permission]');

    const denials = (await readSessionLog(writer.path)).events.filter(
      (e) => e.kind === PERMISSION_DENIED_KIND,
    );
    expect(denials).toHaveLength(1);
    expect(denials[0]?.data).toMatchObject({ tool: 'write_file', source: 'default' });
  });

  it('an engine-A deny keeps its byte-compatible payload (`session`/`project` source)', async () => {
    writePermissionsFile({
      version: 1,
      rules: [{ id: 'no-secrets', effect: 'deny', tool: 'write_file', pathPrefix: 'secrets', note: 'nope' }],
    });
    const res = await writeFileTool(allowAll(), 'secrets/key.pem');
    expect(res.ok).toBe(false);
    expect(res.error).toContain("rule 'no-secrets'");

    const denials = (await readSessionLog(writer.path)).events.filter(
      (e) => e.kind === PERMISSION_DENIED_KIND,
    );
    expect(denials).toHaveLength(1);
    expect(denials[0]?.data).toMatchObject({
      tool: 'write_file',
      matchedRuleId: 'no-secrets',
      source: 'project',
    });
  });

  it('an ALLOW is not a denial: nothing is written on the deny channel', async () => {
    writePermissionsFile({ version: 1, rules: [docRule('allow')] });
    const res = await writeFileTool(allowAll(), 'docs/fresh.md');
    expect(res.ok, res.error).toBe(true);
    const denials = (await readSessionLog(writer.path)).events.filter(
      (e) => e.kind === PERMISSION_DENIED_KIND,
    );
    expect(denials).toEqual([]);
  });
});
