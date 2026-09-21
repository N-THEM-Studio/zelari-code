/**
 * ADR-0039 Phase 2 — `.zelari/permissions.json` is DEPRECATED, still honored,
 * and honored THROUGH engine B.
 *
 * Phase 1 pinned the parity matrix (`permissionParity.test.ts`: the same intent
 * written in A syntax and in native B syntax must reach the same verdict) and the
 * single `permission.denied` emission point. This suite pins what Phase 2 adds:
 *
 *   1. HONORED VIA B. A rule in the A syntax reaches the native B rule list
 *      (glob `match`, first-match-wins order) and is matched there — the layer,
 *      not just the translator, is what these assertions walk.
 *   2. ONE WARNING, ON LOAD. The file, the translation and the two-minor removal
 *      window are named exactly once per load; absence is silent; a rule-less
 *      template is silent too.
 *   3. FAIL-CLOSED PRESERVED. A malformed file keeps failing closed on the
 *      dispatch (engine A's behavior, untouched) and never turns into a strict
 *      load failure (ADR-0039 §3: exit 2 stays for an explicit `policy.json`).
 *   4. ONE EMISSION. Running the transitional double-evaluation through a real
 *      registry still records exactly ONE `permission.denied` — a compat layer
 *      that also emitted would be a regression of the Phase-1 contract.
 *
 * HERMETIC: every case writes its own temp root AND its own temp home
 * (`loadPolicySet` calls pass `homeDir`), so a developer's real
 * `~/.zelari/policy.json` can never take part in the layer assertions. The two
 * registry cases go through `createBuiltinToolRegistry`, which resolves the real
 * home; they assert DENIALS and fail-closed ASKS, which a stray global rule could
 * only reinforce (restrict-only), never mask.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionLogWriter, readSessionLog } from '@zelari/core/session';
import type { SessionEventInput } from '@zelari/core/session';
import type { ToolContext } from '@zelari/core/harness/tools/toolTypes';
import { AuditLogger } from './auditLogger.js';
import { createBuiltinToolRegistry } from '../toolRegistry.js';
import { PERMISSION_DENIED_KIND } from './permissionGate.js';
import {
  COMPAT_REMOVAL_MINOR_RELEASES,
  COMPAT_WARNING_TAG,
} from './permissionCompat.js';
import {
  agentLayersFor,
  loadPolicySet,
  type LayeredPolicyRuleSet,
  type PolicyRule,
} from './policyEngine.js';
import { matchAgentPolicyRuleLayered } from './policyLayers.js';
import {
  clearSessionPermissionRules,
  resetProjectPermissionRuleCache,
} from './permissionRules.js';
import { clearSessionPermissionGrants, type PermissionPolicy } from './toolPermissions.js';

let root: string;
let home: string;
let writer: SessionLogWriter;
let saved: Record<string, string | undefined>;

/** Product env this file must not inherit (the loaders read it at build time). */
const POLICY_ENV = ['ZELARI_POLICY', 'ZELARI_POLICY_PRECEDENCE', 'ZELARI_POLICY_LOAD_MODE'] as const;

const DENY_SECRETS = { id: 'no-secrets', effect: 'deny', pathPrefix: 'secrets', note: 'never touch secrets' };

function writePermissionFile(content: unknown): void {
  const dir = path.join(root, '.zelari');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'permissions.json'),
    typeof content === 'string' ? content : JSON.stringify(content, null, 2),
  );
  // A's loader caches by (path, mtime, size): a rewrite must not be shadowed.
  resetProjectPermissionRuleCache();
}

function writeGlobalPolicy(content: unknown): void {
  const dir = path.join(home, '.zelari');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'policy.json'), JSON.stringify(content, null, 2));
}

function allowAll(): PermissionPolicy {
  return { read: 'allow', write: 'allow', execute: 'allow', network: 'allow', ui: 'allow', auto: true };
}

function makeCtx(): ToolContext {
  return {
    signal: new AbortController().signal,
    cwd: root,
    audit: () => undefined,
    sessionId: 'adr39-compat',
    emitSessionEvent: (input: SessionEventInput) => writer.append(input),
  };
}

/** The REAL wiring: registry → loadPolicySet → agentLayersFor → wrapWithPermissions. */
async function writeFileTool(policy: PermissionPolicy, pathArg: string) {
  const { registry } = createBuiltinToolRegistry({
    root,
    audit: new AuditLogger(path.join(root, 'audit.jsonl')),
    sessionId: 'adr39-compat',
    profile: 'general',
    enableTask: false,
    enableSkill: false,
    diagnostics: false,
    lspProvider: null,
    permissionPolicy: policy,
  });
  const tool = registry.get('write_file');
  if (!tool) throw new Error('write_file not registered');
  return (await tool.execute({ path: pathArg, content: 'x' } as never, makeCtx())) as {
    ok: boolean;
    error?: string;
  };
}

/** B's answer for one dispatch, over the layers a real registry would see. */
function matchB(pathArg: string, agent = 'general'): PolicyRule | null {
  const set = loadPolicySet(root, { homeDir: home });
  return matchAgentPolicyRuleLayered(agentLayersFor(set, agent), 'restrict-only', ['write'], { path: pathArg }, root);
}

describe('ADR-0039 Phase 2 — the compat layer: `.zelari/permissions.json` honored through B', () => {
  beforeEach(async () => {
    saved = {};
    for (const key of POLICY_ENV) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'zelari-adr39-compat-'));
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'zelari-adr39-compat-home-'));
    await fs.mkdir(path.join(root, 'secrets'), { recursive: true });
    await fs.mkdir(path.join(root, 'docs'), { recursive: true });
    await fs.writeFile(path.join(root, 'secrets', 'x'), 'old', 'utf-8');
    writer = await SessionLogWriter.open(path.join(root, 'session'), 'adr39-compat', 1);
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
    await fs.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it('a pathPrefix deny becomes native B globs and IS what the layered matcher decides', () => {
    writePermissionFile({ version: 1, rules: [DENY_SECRETS] });
    const set = loadPolicySet(root, { homeDir: home });
    // B's syntax, B's list, A's note as the native reason — one glob cannot say
    // "this node and its subtree", so the translation emits both (Phase 1 seed).
    expect(set.compat).toEqual({
      shell: [],
      edit: [
        { match: 'secrets', effect: 'deny', reason: 'never touch secrets' },
        { match: 'secrets/**', effect: 'deny', reason: 'never touch secrets' },
      ],
    });
    // The layer reaches agents `policy.json` never mentions (A's file has no
    // agent dimension) — otherwise a sub-agent would silently lose the file.
    expect(agentLayersFor(set, 'general').compat).toEqual(set.compat);
    // The subtree glob is the one that decides for a path UNDER the prefix…
    expect(matchB('secrets/x')).toEqual({
      match: 'secrets/**',
      effect: 'deny',
      reason: 'never touch secrets',
    });
    // …while the node itself is covered by the first glob (that is why the
    // translation emits two: one pattern cannot mean "this and everything under it").
    expect(matchB('secrets')).toEqual({
      match: 'secrets',
      effect: 'deny',
      reason: 'never touch secrets',
    });
    // …and a SIBLING name is not swallowed: A's prefix is a whole-segment run.
    expect(matchB('secrets-old/x')).toBeNull();
    expect(matchB('docs/note.md')).toBeNull();
  });

  it('the dispatch over that rule is denied once, naming the A rule (Phase-1 emission contract)', async () => {
    writePermissionFile({ version: 1, rules: [DENY_SECRETS] });
    const res = await writeFileTool(allowAll(), 'secrets/x');
    expect(res.ok).toBe(false);
    expect(res.error).toContain('[permission]');
    expect(res.error).toContain("rule 'no-secrets'");
    expect(res.error).toContain('never touch secrets');
    expect(await fs.readFile(path.join(root, 'secrets', 'x'), 'utf-8')).toBe('old');

    // Transitional double-evaluation, ONE emission: engine A still decides this
    // dispatch (it is not removed until Phase 3) and the compat layer must not add
    // a second `permission.denied` on the way.
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

  it('ONE deprecation warning on load, naming the file, the translation and the window', () => {
    writePermissionFile({
      version: 1,
      rules: [DENY_SECRETS, { id: 'no-exec', effect: 'deny', category: 'execute' }],
    });
    const set = loadPolicySet(root, { homeDir: home });
    const notices = set.warnings.filter((w) => w.includes(COMPAT_WARNING_TAG));
    expect(notices).toHaveLength(1);
    const notice = notices[0] as string;
    expect(notice).toContain('permissions.json');
    expect(notice).toMatch(/deprecat/i);
    // The window, twice-named: the count and the earliest release it implies.
    expect(notice).toContain(`${COMPAT_REMOVAL_MINOR_RELEASES} minor releases`);
    expect(notice).toContain('v2.59');
    // The translation it promises, and where to go instead.
    expect(notice).toContain("pathPrefix -> edit 'match'");
    expect(notice).toContain("category execute -> shell '*'");
    expect(notice).toContain('2 rule(s) translated to 3 engine-B glob rule(s)');
    expect(notice).toContain('MIGRATION.md');
    // Once per LOAD, not once per dispatch and never an accumulating list.
    expect(
      loadPolicySet(root, { homeDir: home }).warnings.filter((w) => w.includes(COMPAT_WARNING_TAG)),
    ).toHaveLength(1);
  });

  it('rules B cannot express are REPORTED, not dropped silently', () => {
    writePermissionFile({
      version: 1,
      rules: [
        { id: 'tool-only', effect: 'deny', tool: 'bash' },
        { id: 'no-net', effect: 'deny', category: 'network' },
        DENY_SECRETS,
      ],
    });
    const set = loadPolicySet(root, { homeDir: home });
    const notice = set.warnings.find((w) => w.includes(COMPAT_WARNING_TAG)) ?? '';
    expect(notice).toContain('3 rule(s) translated to 2 engine-B glob rule(s)');
    expect(notice).toContain('2 rule(s) have no engine-B equivalent and stay enforced by engine A');
    // Only the pathPrefix rule has a native home — the layer holds its two globs.
    expect(set.compat?.edit).toHaveLength(2);
    expect(set.compat?.shell).toEqual([]);
  });

  it('an ALLOW rule from A is translated and honored through B — without ever widening', () => {
    writePermissionFile({
      version: 1,
      rules: [{ id: 'docs-scope', effect: 'allow', pathPrefix: 'docs', note: 'docs are fine' }],
    });
    const set = loadPolicySet(root, { homeDir: home });
    expect(agentLayersFor(set, 'lead').compat?.edit).toEqual([
      { match: 'docs', effect: 'allow', reason: 'docs are fine' },
      { match: 'docs/**', effect: 'allow', reason: 'docs are fine' },
    ]);
    expect(matchB('docs/note.md', 'lead')).toMatchObject({ effect: 'allow' });

    // Restrict-only: the same translated allow next to a global deny cannot
    // relax it — the deny is what the dispatch would obey.
    const floored: LayeredPolicyRuleSet = {
      global: { shell: [], edit: [{ match: 'docs/**', effect: 'deny', reason: 'global floor' }] },
      project: { shell: [], edit: [] },
      compat: agentLayersFor(set, 'lead').compat,
    };
    const hit = matchAgentPolicyRuleLayered(
      floored,
      'restrict-only',
      ['write'],
      { path: 'docs/note.md' },
      root,
    );
    expect(hit).toMatchObject({ effect: 'deny', reason: 'global floor' });
  });

  it('no file → no warning, no compat layer, nothing decided (B is exactly as before)', async () => {
    const set = loadPolicySet(root, { homeDir: home });
    expect(set.warnings).toEqual([]);
    expect(set.compat).toBeUndefined();
    expect(agentLayersFor(set, 'general')).not.toHaveProperty('compat');
    expect(matchB('secrets/x')).toBeNull();
    // …and the real wiring agrees: no phantom restriction appears out of nowhere.
    const res = await writeFileTool(allowAll(), 'docs/note.md');
    expect(res.ok, res.error).toBe(true);
  });

  it('a rule-less file is silent too (the shipped template decides nothing)', () => {
    writePermissionFile({ $comment: 'template', version: 1, rules: [] });
    const set = loadPolicySet(root, { homeDir: home });
    expect(set.warnings).toEqual([]);
    expect(set.compat).toBeUndefined();
  });

  it('malformed file → B warns, injects nothing and NEVER turns into a strict load failure', () => {
    writePermissionFile('{ not json');
    const soft = loadPolicySet(root, { homeDir: home });
    expect(soft.compat).toBeUndefined();
    const notice = soft.warnings.find((w) => w.includes(COMPAT_WARNING_TAG));
    expect(notice).toBeDefined();
    expect(notice).toContain('permissions.json');
    expect(notice).toContain('failing closed');
    // ADR-0039 §3: exit 2 stays reserved for an EXPLICIT strict policy.json load,
    // so a user config engine A already degrades to `ask` cannot brick a run.
    expect(() => loadPolicySet(root, { homeDir: home, mode: 'strict' })).not.toThrow();
    expect(loadPolicySet(root, { homeDir: home, mode: 'strict' }).compat).toBeUndefined();
  });

  it('malformed file → the DISPATCH still fails closed (pinned engine-A behavior)', async () => {
    writePermissionFile('{ not json');
    const res = await writeFileTool(allowAll(), 'secrets/x');
    expect(res.ok).toBe(false);
    expect(res.error).toContain('[permission]');
    expect(res.error).toContain(path.join(root, '.zelari', 'permissions.json'));
    expect(res.error).toContain('failing closed');
    expect(res.error).toContain('No interactive approval available');
  });

  it('ZELARI_POLICY=0 keeps meaning "the empty set": engine B off, so no compat layer', () => {
    writePermissionFile({ version: 1, rules: [DENY_SECRETS] });
    process.env.ZELARI_POLICY = '0';
    const set = loadPolicySet(root, { homeDir: home });
    expect(set.agents.size).toBe(0);
    expect(set.compat).toBeUndefined();
    expect(set.warnings).toEqual([]);
  });

  it('a global policy.json floor is not relaxed by the compat layer (restrict-only composition)', () => {
    writePermissionFile({ version: 1, rules: [{ id: 'docs-scope', effect: 'allow', pathPrefix: 'docs' }] });
    writeGlobalPolicy({
      version: 1,
      agents: { general: { edit: [{ match: 'docs/**', effect: 'deny', reason: 'repo floor' }] } },
    });
    const hit = matchB('docs/note.md');
    // Both layers matched (allow from compat, deny from global): the deny wins.
    expect(hit).toMatchObject({ effect: 'deny', reason: 'repo floor' });
  });
});
