/**
 * Policy engine v1 (P0.5) — load/validate `.zelari/policy.json` +
 * `~/.zelari/policy.json`, glob matching, first-match-wins ordering,
 * per-agent isolation, and enforcement through createBuiltinToolRegistry
 * (same registry-level style as toolPermissions.intersect.test.ts).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { tmpdir } from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import type { ToolContext } from '@zelari/core/harness/tools/toolTypes';
import { AuditLogger } from './auditLogger.js';
import { clearSessionPermissionGrants, type PermissionPolicy } from './toolPermissions.js';
import {
  agentRulesFor,
  emptyPolicySet,
  loadPolicySet,
  matchAgentPolicyRule,
  mergeRuleEffect,
  resolvePolicyRule,
  type PolicyRule,
} from './policyEngine.js';
import { createBuiltinToolRegistry } from '../toolRegistry.js';

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(tmpdir(), 'zelari-policy-'));
}

/** Write a policy file under `<root>/.zelari/policy.json` (string = raw, for invalid-JSON tests). */
function writePolicyFile(root: string, content: unknown): void {
  fs.mkdirSync(path.join(root, '.zelari'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.zelari', 'policy.json'),
    typeof content === 'string' ? content : JSON.stringify(content, null, 2),
  );
}

/** Hermetic home dir (so tests never read the real ~/.zelari/policy.json). */
function tmpHome(): string {
  return fs.mkdtempSync(path.join(tmpdir(), 'zelari-policy-home-'));
}

function makeAudit(): AuditLogger {
  return new AuditLogger(
    path.join(
      tmpdir(),
      `zelari-policy-${Date.now()}-${Math.random().toString(36).slice(2)}.log`,
    ),
  );
}

function makeCtx(cwd: string): ToolContext {
  return {
    signal: new AbortController().signal,
    cwd,
    audit: () => undefined,
    sessionId: 'policy-engine-test',
  };
}

/** All-allow, auto category policy — wiring tests isolate the RULE layer. */
function allowAll(): PermissionPolicy {
  return {
    read: 'allow',
    write: 'allow',
    execute: 'allow',
    network: 'allow',
    ui: 'allow',
    auto: true,
  };
}

function rule(match: string, effect: PolicyRule['effect'], reason?: string): PolicyRule {
  return reason ? { match, effect, reason } : { match, effect };
}

/** Registry in the exact shape createKrakenSubAgentContextFactory builds. */
function makeRegistry(root: string, policyAgent?: string) {
  return createBuiltinToolRegistry({
    root,
    audit: makeAudit(),
    sessionId: 'policy-engine-test',
    profile: 'general',
    enableTask: false,
    enableSkill: false,
    diagnostics: false,
    lspProvider: null,
    permissionPolicy: allowAll(),
    ...(policyAgent ? { policyAgent } : {}),
  });
}

describe('policyEngine.loadPolicySet', () => {
  it('missing project + global files -> empty set, no warnings', () => {
    const set = loadPolicySet(tmpRoot(), { homeDir: tmpHome() });
    expect(set.agents.size).toBe(0);
    expect(set.warnings).toEqual([]);
  });

  it('invalid JSON -> warnings + empty set (never throws)', () => {
    const root = tmpRoot();
    writePolicyFile(root, '{ definitely not json');
    const set = loadPolicySet(root, { homeDir: tmpHome() });
    expect(set.agents.size).toBe(0);
    expect(set.warnings.length).toBe(1);
    expect(set.warnings[0]).toContain('invalid JSON');
  });

  it('ZELARI_POLICY=0 -> always the empty set, even with valid files', () => {
    const prev = process.env.ZELARI_POLICY;
    process.env.ZELARI_POLICY = '0';
    try {
      const root = tmpRoot();
      writePolicyFile(root, { agents: { general: { shell: [rule('*', 'deny')] } } });
      const set = loadPolicySet(root, { homeDir: tmpHome() });
      expect(set).toEqual(emptyPolicySet());
    } finally {
      if (prev === undefined) delete process.env.ZELARI_POLICY;
      else process.env.ZELARI_POLICY = prev;
    }
  });

  it('unknown agent key -> warning, ignored', () => {
    const root = tmpRoot();
    writePolicyFile(root, { version: 1, agents: { intern: { shell: [rule('*', 'deny')] } } });
    const set = loadPolicySet(root, { homeDir: tmpHome() });
    expect(set.agents.size).toBe(0);
    expect(set.warnings.join('\n')).toContain('unknown agent "intern"');
  });

  it('invalid rule -> warning + skipped, valid sibling rule kept', () => {
    const root = tmpRoot();
    writePolicyFile(root, {
      agents: {
        general: {
          shell: [rule('git push*', 'maybe' as PolicyRule['effect']), rule('rm *', 'deny')],
        },
      },
    });
    const set = loadPolicySet(root, { homeDir: tmpHome() });
    const shell = agentRulesFor(set, 'general').shell;
    expect(shell).toHaveLength(1);
    expect(shell[0].match).toBe('rm *');
    expect(set.warnings.join('\n')).toContain('effect');
  });

  it('unsupported version -> whole file ignored with a warning', () => {
    const root = tmpRoot();
    writePolicyFile(root, {
      version: 2,
      agents: { general: { shell: [rule('*', 'deny')] } },
    });
    const set = loadPolicySet(root, { homeDir: tmpHome() });
    expect(set.agents.size).toBe(0);
    expect(set.warnings.join('\n')).toContain('version');
  });

  it('project rules precede global rules (project legitimately overrides global)', () => {
    const root = tmpRoot();
    writePolicyFile(root, { agents: { general: { shell: [rule('echo hi', 'allow')] } } });
    const home = tmpHome();
    writePolicyFile(home, { agents: { general: { shell: [rule('echo *', 'deny')] } } });
    const set = loadPolicySet(root, { homeDir: home });
    const shell = agentRulesFor(set, 'general').shell;
    expect(shell).toHaveLength(2);
    // Project rule first: first-match-wins means the project allow wins for
    // its exact pattern while the global deny still catches the rest.
    expect(resolvePolicyRule(shell, 'echo hi')?.effect).toBe('allow');
    expect(resolvePolicyRule(shell, 'echo bye')?.effect).toBe('deny');
  });

  it('global file applies when the project file is missing', () => {
    const home = tmpHome();
    writePolicyFile(home, { agents: { verify: { shell: [rule('git push*', 'deny')] } } });
    const set = loadPolicySet(tmpRoot(), { homeDir: home });
    expect(resolvePolicyRule(agentRulesFor(set, 'verify').shell, 'git push origin main')?.effect).toBe('deny');
  });
});

describe('policyEngine glob semantics (resolvePolicyRule)', () => {
  const cases: Array<[string, string, boolean]> = [
    // Command prefix patterns
    ['git push*', 'git push --force', true],
    ['git push*', 'git push', true],
    ['git push*', 'git status', false],
    ['git push', 'git push', true], // no wildcard = exact match only
    ['git push', 'git push --force', false],
    // Path patterns
    ['src/**', 'src/x.ts', true],
    ['src/**', 'src/a/b/c.ts', true],
    ['src/**', 'dist/x.ts', false],
    ['src/**', 'srcx.ts', false], // needs the literal `src/` boundary
    ['src/**', 'src\\x.ts', true], // Windows separators normalize to /
    // Bare `*` is the catch-all (crosses path separators)
    ['*', 'git push --force', true],
    ['*', 'src/x.ts', true],
    // Regex metacharacters in patterns are escaped
    ['data.json', 'dataXjson', false],
    ['data.json', 'data.json', true],
  ];
  for (const [pattern, value, shouldMatch] of cases) {
    it(`"${pattern}" ${shouldMatch ? 'matches' : 'rejects'} "${value}"`, () => {
      const hit = resolvePolicyRule([rule(pattern, 'deny')], value);
      expect(hit !== null).toBe(shouldMatch);
    });
  }
});

describe('policyEngine ordering and isolation', () => {
  it('first match wins (ordered rules)', () => {
    const rules = [
      rule('git push --force-with-lease*', 'allow', 'safe-ish'),
      rule('git push*', 'deny'),
    ];
    expect(resolvePolicyRule(rules, 'git push --force-with-lease origin main')?.effect).toBe('allow');
    expect(resolvePolicyRule(rules, 'git push --force origin main')?.effect).toBe('deny');
  });

  it("a rule for 'explore' does not affect 'general'", () => {
    const root = tmpRoot();
    writePolicyFile(root, { agents: { explore: { shell: [rule('*', 'deny')] } } });
    const set = loadPolicySet(root, { homeDir: tmpHome() });
    expect(agentRulesFor(set, 'explore').shell).toHaveLength(1);
    expect(agentRulesFor(set, 'general').shell).toHaveLength(0);
    expect(resolvePolicyRule(agentRulesFor(set, 'general').shell, 'rm -rf /')).toBeNull();
  });

  it('mergeRuleEffect: rules only add restriction (deny > ask > allow)', () => {
    expect(mergeRuleEffect('allow', rule('*', 'allow'))).toBe('allow');
    expect(mergeRuleEffect('allow', rule('*', 'ask'))).toBe('ask');
    expect(mergeRuleEffect('allow', rule('*', 'deny'))).toBe('deny');
    expect(mergeRuleEffect('ask', rule('*', 'allow'))).toBe('ask'); // allow rule cannot un-ask
    expect(mergeRuleEffect('deny', rule('*', 'allow'))).toBe('deny'); // nor un-deny
    expect(mergeRuleEffect('deny', null)).toBe('deny');
  });

  it('matchAgentPolicyRule: edit rules match root-relative paths under root', () => {
    const rules = { shell: [], edit: [rule('secret/**', 'deny')] };
    const root = path.join(tmpdir(), 'repo-root');
    // Absolute path arg under root -> stripped to `secret/k.txt` -> matches.
    expect(
      matchAgentPolicyRule(rules, ['write'], { path: path.join(root, 'secret', 'k.txt') }, root),
    ).toEqual(rules.edit[0]);
    // Relative arg as-is also matches.
    expect(matchAgentPolicyRule(rules, ['write'], { path: 'secret/k.ts' }, root)).toEqual(rules.edit[0]);
    // Outside the guarded subtree: no match.
    expect(matchAgentPolicyRule(rules, ['write'], { path: path.join(root, 'public', 'k.ts') }, root)).toBeNull();
    // A write tool without a path argument never matches edit rules.
    expect(matchAgentPolicyRule(rules, ['write'], { note: 'no path here' }, root)).toBeNull();
  });
});

describe('policyEngine enforcement through createBuiltinToolRegistry (wiring)', () => {
  // NOTE (wiring seam): createKrakenSubAgentContextFactory passes
  // `policyAgent: agent` to createBuiltinToolRegistry — asserted by grep in
  // the parent acceptance, exercised here by building the same registry
  // shape directly (mirroring toolPermissions.intersect.test.ts). The
  // 'explore' PROFILE is read-only and registers no bash, so the bash test
  // uses the bash-capable 'general' profile while selecting the 'explore'
  // AGENT identity via policyAgent — that identity seam is exactly what the
  // factory wires for tentacles.

  beforeEach(() => {
    clearSessionPermissionGrants();
  });

  it("bash: deny rule for agent 'explore' refuses the command; lead is unaffected", async () => {
    const root = tmpRoot();
    writePolicyFile(root, {
      agents: { explore: { shell: [rule('echo *', 'deny', 'explore must not echo')] } },
    });

    const exploreBash = makeRegistry(root, 'explore').registry.get('bash');
    if (!exploreBash) throw new Error('bash not registered for profile=general');
    const denied = (await exploreBash.execute(
      { command: 'echo tentacle' } as never,
      makeCtx(root),
    )) as { ok: boolean; error?: string };
    expect(denied.ok).toBe(false);
    expect(denied.error).toContain('[permission]');
    expect(denied.error).toContain('[policy]');
    expect(denied.error).toContain('echo *');

    // Same temp root, no policyAgent -> the lead's own (empty) rule set.
    const leadBash = makeRegistry(root).registry.get('bash');
    if (!leadBash) throw new Error('bash not registered for lead registry');
    const allowed = (await leadBash.execute(
      { command: 'echo tentacle' } as never,
      makeCtx(root),
    )) as { ok: boolean; error?: string };
    // Policy non-interference for the lead is the contract under test: the
    // explore rule must not reach it. Real bash spawn success is
    // environment-dependent (vitest on Windows may fail to spawn) — accept
    // success OR a non-policy failure, never a [permission]/[policy] denial.
    const leadUnaffected =
      allowed.ok === true ||
      (allowed.ok === false &&
        !String(allowed.error ?? '').includes('[permission]') &&
        !String(allowed.error ?? '').includes('[policy]'));
    expect(leadUnaffected).toBe(true);
  });

  it("write_file: edit rule 'secret/**' denies for agent 'general'; lead may write", async () => {
    const root = tmpRoot();
    fs.mkdirSync(path.join(root, 'secret'), { recursive: true });
    writePolicyFile(root, {
      agents: { general: { edit: [rule('secret/**', 'deny', 'secrets are CI-managed')] } },
    });
    const target = path.join(root, 'secret', 'k.txt');

    const generalWrite = makeRegistry(root, 'general').registry.get('write_file');
    if (!generalWrite) throw new Error('write_file not registered for profile=general');
    const denied = (await generalWrite.execute(
      { path: target, content: 'x' } as never,
      makeCtx(root),
    )) as { ok: boolean; error?: string };
    expect(denied.ok).toBe(false);
    expect(denied.error).toContain('secret/**');
    expect(fs.existsSync(target)).toBe(false);

    const leadWrite = makeRegistry(root).registry.get('write_file');
    if (!leadWrite) throw new Error('write_file not registered for lead registry');
    const allowed = (await leadWrite.execute(
      { path: target, content: 'x' } as never,
      makeCtx(root),
    )) as { ok: boolean; error?: string };
    expect(allowed.ok).toBe(true);
    expect(fs.existsSync(target)).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("rule 'ask' without an interactive handler resolves DENY (fail-closed)", async () => {
    const root = tmpRoot();
    writePolicyFile(root, {
      agents: { general: { shell: [rule('rm *', 'ask', 'destructive')] } },
    });
    const bash = makeRegistry(root, 'general').registry.get('bash');
    if (!bash) throw new Error('bash not registered for profile=general');
    const res = (await bash.execute(
      { command: 'rm -rf ./nope' } as never,
      makeCtx(root),
    )) as { ok: boolean; error?: string };
    // Even though the category policy is all-allow + auto, a rule-level
    // 'ask' is not auto-promotable: with no onPermissionAsk handler it must
    // fail closed (mirrors the P0.4 ask-without-handler behavior).
    expect(res.ok).toBe(false);
    expect(res.error).toContain('No interactive approval available');
  });
});
