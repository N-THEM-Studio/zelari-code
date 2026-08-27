/**
 * Resource claims (P0.C1) — tool→claims table, per-claim layered matching,
 * multi-claim intersection (one deny denies the call), policy.json v2
 * `claims` schema (+ v1 retrocompat), and the enforcement wiring through
 * createBuiltinToolRegistry, including the subagent ⊆ parent regression.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { tmpdir } from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import type { ToolContext } from '@zelari/core/harness/tools/toolTypes';
import { AuditLogger } from './auditLogger.js';
import { clearSessionPermissionGrants, type PermissionPolicy } from './toolPermissions.js';
import {
  CLAIM_KINDS,
  PolicyLoadError,
  loadPolicySet,
  agentLayersFor,
  type LayeredPolicyRuleSet,
  type PolicyClaimRule,
  type PolicyRule,
  type PolicyRuleSet,
} from './policyEngine.js';
import { intersectEffects } from './policyLayers.js';
import { resourceClaimsFor, resolveClaimsVerdict } from './resourceClaims.js';
import { createBuiltinToolRegistry } from '../toolRegistry.js';

// ── Helpers (same shapes as policyEngine.test.ts) ──────────────────────────

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(tmpdir(), 'zelari-claims-'));
}
function tmpHome(): string {
  return fs.mkdtempSync(path.join(tmpdir(), 'zelari-claims-home-'));
}
function writePolicyFile(root: string, content: unknown): void {
  fs.mkdirSync(path.join(root, '.zelari'), { recursive: true });
  fs.writeFileSync(path.join(root, '.zelari', 'policy.json'), JSON.stringify(content, null, 2));
}
function makeAudit(): AuditLogger {
  return new AuditLogger(
    path.join(tmpdir(), `zelari-claims-${Date.now()}-${Math.random().toString(36).slice(2)}.log`),
  );
}
function makeCtx(cwd: string): ToolContext {
  return {
    signal: new AbortController().signal,
    cwd,
    audit: () => undefined,
    sessionId: 'resource-claims-test',
  };
}
function allowAll(): PermissionPolicy {
  return { read: 'allow', write: 'allow', execute: 'allow', network: 'allow', ui: 'allow', auto: true };
}
function makeRegistry(root: string, policyAgent?: string) {
  return createBuiltinToolRegistry({
    root,
    audit: makeAudit(),
    sessionId: 'resource-claims-test',
    profile: 'general',
    enableTask: false,
    enableSkill: false,
    diagnostics: false,
    lspProvider: null,
    permissionPolicy: allowAll(),
    ...(policyAgent ? { policyAgent } : {}),
  });
}

function rs(partial: Partial<PolicyRuleSet>): PolicyRuleSet {
  return {
    shell: partial.shell ?? [],
    edit: partial.edit ?? [],
    ...(partial.claims ? { claims: partial.claims } : {}),
  };
}
function layers(project: Partial<PolicyRuleSet>, global: Partial<PolicyRuleSet>): LayeredPolicyRuleSet {
  return { project: rs(project), global: rs(global) };
}
function cr(
  kind: PolicyClaimRule['kind'],
  pattern: string,
  effect: PolicyRule['effect'],
  operation?: 'read' | 'write',
): PolicyClaimRule {
  return operation ? { kind, pattern, effect, operation } : { kind, pattern, effect };
}

const FRESH: LayeredPolicyRuleSet = layers({}, {});

// ── The tool → claims table ────────────────────────────────────────────────

describe('resourceClaimsFor (table)', () => {
  it('write_file / edit_file produce a single WRITE path claim', () => {
    expect(resourceClaimsFor('write_file', { path: 'a/b.txt', content: 'x' })).toEqual([
      { kind: 'path', operation: 'write', path: 'a/b.txt' },
    ]);
    expect(resourceClaimsFor('edit_file', { file_path: 'c.md' })).toEqual([
      { kind: 'path', operation: 'write', path: 'c.md' },
    ]);
  });

  it('apply_diff covers every path it can touch (primary + diff headers, deduped)', () => {
    // Header path equals the primary path -> exactly ONE claim (/dev/null skipped).
    const same = [
      '--- a/src/one.ts',
      '+++ b/src/one.ts',
      '@@ -1 +1 @@',
      '-a',
      '+b',
    ].join('\n');
    expect(resourceClaimsFor('apply_diff', { path: 'src/one.ts', diff: same })).toEqual([
      { kind: 'path', operation: 'write', path: 'src/one.ts' },
    ]);
    // A multi-file-shaped patch yields every referenced path as WRITE claim.
    const multi = ['--- /dev/null', '+++ b/secret/new.ts', '@@ -0,0 +1 @@', '+x'].join('\n');
    const claims = resourceClaimsFor('apply_diff', { path: 'docs/open.md', diff: multi });
    expect(claims).toEqual([
      { kind: 'path', operation: 'write', path: 'docs/open.md' },
      { kind: 'path', operation: 'write', path: 'secret/new.ts' },
    ]);
  });

  it('read tools produce READ claims; bash produces a best-effort PROCESS claim', () => {
    for (const t of ['read_file', 'list_files', 'grep_content', 'show_diff']) {
      expect(resourceClaimsFor(t, { path: 'src/x.ts' })).toEqual([
        { kind: 'path', operation: 'read', path: 'src/x.ts' },
      ]);
    }
    expect(resourceClaimsFor('bash', { command: 'echo   hi  there' })).toEqual([
      { kind: 'process', executable: 'echo', argv: ['hi', 'there'] },
    ]);
  });

  it('network/browser/ssh/mcp/observe_batch mappings and unknown tools', () => {
    expect(resourceClaimsFor('fetch_url', { url: 'https://api.example.com/v1?x=1' })).toEqual([
      { kind: 'network', host: 'api.example.com' },
    ]);
    expect(resourceClaimsFor('fetch_url', { url: 'https://host.dev:8443/' })).toEqual([
      { kind: 'network', host: 'host.dev', port: 8443 },
    ]);
    expect(
      resourceClaimsFor('browser_check', {
        url: 'http://localhost:3000',
        actions: [{ type: 'goto', url: 'http://example.test/next' }],
      }),
    ).toEqual([
      { kind: 'network', host: 'localhost', port: 3000 },
      { kind: 'network', host: 'example.test' },
    ]);
    // Documented deferral: web_search has no argument-controlled destination
    // host, so v1 emits NO claim (category policy still gates it).
    expect(resourceClaimsFor('web_search', { query: 'anything' })).toEqual([]);
    expect(resourceClaimsFor('ssh_run', { targetId: 'prod', command: 'uptime' })).toEqual([
      { kind: 'ssh', target: 'prod', command: 'uptime' },
    ]);
    expect(resourceClaimsFor('ssh_status', { targetId: 'prod' })).toEqual([
      { kind: 'ssh', target: 'prod' },
    ]);
    expect(resourceClaimsFor('mcp_github_create_issue', { title: 'x' })).toEqual([
      { kind: 'mcp', server: 'github', tool: 'create_issue' },
    ]);
    expect(
      resourceClaimsFor('observe_batch', {
        operations: [
          { id: 'a', tool: 'read_file', args: { path: 'p.txt' } },
          { id: 'b', tool: 'semantic_search', args: { query: 'q' } },
        ],
      }),
    ).toEqual([{ kind: 'path', operation: 'read', path: 'p.txt' }]);
    expect(resourceClaimsFor('totally_unknown_tool', { whatever: 1 })).toEqual([]);
    expect(CLAIM_KINDS).toContain('ui'); // parsed by v2; emission deferred to v1.1
  });
});

// ── Raw-shell normalization + exec_process (P0.C2 / t17) ───────────────────

describe('raw-shell normalization (best-effort) + exec_process claims', () => {
  it('env FOO=x git push hits a v1 shell `git push*` deny rule', () => {
    const claims = resourceClaimsFor('bash', { command: 'env FOO=x git push' });
    expect(claims).toEqual([
      { kind: 'process', executable: 'git', argv: ['push'], raw: 'env FOO=x git push' },
    ]);
    const L = layers({ shell: [{ match: 'git push*', effect: 'deny' }] }, {});
    expect(resolveClaimsVerdict(L, 'restrict-only', 'bash', { command: 'env FOO=x git push' }).effect).toBe('deny');
  });

  it('command git push hits a v2 process-claim `git push*` deny rule', () => {
    expect(resourceClaimsFor('bash', { command: 'command git push --force' })).toEqual([
      { kind: 'process', executable: 'git', argv: ['push', '--force'], raw: 'command git push --force' },
    ]);
    const L = layers({ claims: [cr('process', 'git push*', 'deny')] }, {});
    expect(resolveClaimsVerdict(L, 'restrict-only', 'bash', { command: 'command git push --force' }).effect).toBe('deny');
  });

  it('interpreters, cmd.exe and extra whitespace are stripped too; wrappers keep the raw value', () => {
    expect(resourceClaimsFor('bash', { command: "bash -lc 'env FOO=x git push'" })[0]).toMatchObject({
      executable: 'git',
      argv: ['push'],
    });
    expect(resourceClaimsFor('bash', { command: 'cmd.exe /c git status' })[0]).toMatchObject({
      executable: 'git',
      argv: ['status'],
    });
    expect(
      resourceClaimsFor('bash', { command: 'env   FOO=bar BAZ=q EXEC=1 exec git push' })[0],
    ).toMatchObject({ executable: 'git', argv: ['push'] });
    // Unstripped shapes stay byte-identical to the P0.C1 behavior.
    expect(resourceClaimsFor('bash', { command: 'git push' })).toEqual([
      { kind: 'process', executable: 'git', argv: ['push'] },
    ]);
  });

  it('exec_process emits a direct process claim (basename, no normalization needed)', () => {
    expect(resourceClaimsFor('exec_process', { program: 'git', args: ['push', '--force'] })).toEqual([
      { kind: 'process', executable: 'git', argv: ['push', '--force'] },
    ]);
    // Windows-style absolute path matches rules via the basename first…
    const win = resourceClaimsFor('exec_process', { program: 'C:\\Tools\\Git\\bin\\git.exe', args: ['status'] });
    expect(win[0]).toEqual({ kind: 'process', executable: 'git', argv: ['status'] });
    const L = layers({ claims: [cr('process', 'git push*', 'deny')] }, {});
    expect(resolveClaimsVerdict(L, 'restrict-only', 'exec_process', { program: 'C:\\Tools\\Git\\bin\\git.exe', args: ['push'] }).effect).toBe('deny');
    expect(resourceClaimsFor('exec_process', {})).toEqual([]); // fail-open
  });

  it('prefix semantics: program-only and non-prefix invocations do NOT match `git push*`', () => {
    const L = layers({ claims: [cr('process', 'git push*', 'deny')] }, {});
    expect(resolveClaimsVerdict(L, 'restrict-only', 'exec_process', { program: 'git' }).effect).toBeUndefined();
    expect(resolveClaimsVerdict(L, 'restrict-only', 'exec_process', { program: 'git', args: ['status'] }).effect).toBeUndefined();
    expect(resolveClaimsVerdict(L, 'restrict-only', 'exec_process', { program: 'git', args: ['push'] }).effect).toBe('deny');
  });
});

// ── Per-claim evaluation + intersection ────────────────────────────────────

describe('resolveClaimsVerdict (intersection)', () => {
  it('claims that match nothing stay undefined and never widen', () => {
    const v = resolveClaimsVerdict(FRESH, 'restrict-only', 'write_file', { path: 'a.txt' }, '/r');
    expect(v.effect).toBeUndefined();
    expect(v.matchedRules).toEqual([]);
  });

  it('ONE denied claim denies the whole call', () => {
    const L = layers({ claims: [cr('path', 'docs/**', 'allow'), cr('path', 'secret/**', 'deny')] }, {});
    const v = resolveClaimsVerdict(
      L,
      'restrict-only',
      'apply_diff',
      { path: 'docs/open.md', diff: '--- a/x\n+++ b/secret/k.ts\n@@\n-a\n+b\n' },
      '/r',
    );
    expect(v.effect).toBe('deny');
    expect(v.matchedRules.map((m) => m.match)).toContain('secret/**');
  });

  it('ask + otherwise-unmatched claims resolves to ask', () => {
    const L = layers({ claims: [cr('process', 'npm publish*', 'ask')] }, {});
    const v = resolveClaimsVerdict(L, 'restrict-only', 'bash', { command: 'npm publish' }, '/r');
    expect(v.effect).toBe('ask');
  });

  it('v1 shells/edit lists are reused; reads are NOT newly restricted by edit rules', () => {
    const L = layers({ shell: [{ match: 'git push*', effect: 'deny' }] }, {});
    expect(resolveClaimsVerdict(L, 'restrict-only', 'bash', { command: 'git push --force' }).effect).toBe('deny');
    const E = layers({ edit: [{ match: 'secret/**', effect: 'ask' }] }, {});
    expect(resolveClaimsVerdict(E, 'restrict-only', 'write_file', { path: 'secret/k.ts' }).effect).toBe('ask');
    // A read claim never touches the legacy edit list -> undefined.
    expect(resolveClaimsVerdict(E, 'restrict-only', 'read_file', { path: 'secret/k.ts' }).effect).toBeUndefined();
  });

  it('restrict-only layering: global deny cannot be relaxed by a project allow', () => {
    const L = layers(
      { claims: [cr('path', 'src/x', 'allow', 'write')] },
      { claims: [cr('path', 'src/**', 'deny', 'write')] },
    );
    expect(resolveClaimsVerdict(L, 'restrict-only', 'write_file', { path: 'src/x/f.ts' }, '/r').effect).toBe('deny');
    // identity of intersection helpers reused by the verdict
    expect(intersectEffects(undefined, undefined)).toBe('allow');
  });
});

// ── policy.json v2 schema + retrocompat ────────────────────────────────────

describe('loadPolicySet v2 claims schema', () => {
  it('accepts version 2 and parses the per-agent claims section', () => {
    const root = tmpRoot();
    writePolicyFile(root, {
      version: 2,
      agents: { general: { claims: [cr('path', 'src/auth/**', 'deny', 'write'), cr('mcp', 'github.*', 'ask')] } },
    });
    const set = loadPolicySet(root, { homeDir: tmpHome() });
    expect(set.warnings).toEqual([]);
    expect(agentLayersFor(set, 'general').project.claims).toHaveLength(2);
    expect(agentLayersFor(set, 'general').project.claims?.[0]).toMatchObject({
      kind: 'path',
      operation: 'write',
      pattern: 'src/auth/**',
      effect: 'deny',
    });
  });

  it('malformed single claim rules are warnings, kept section survives strict mode too', () => {
    const root = tmpRoot();
    writePolicyFile(root, {
      version: 2,
      agents: {
        general: {
          claims: [
            { kind: 'banana', pattern: 'x', effect: 'deny' }, // bad kind
            { kind: 'path', pattern: '', effect: 'deny' }, // empty pattern
            { kind: 'process', pattern: 'y', effect: 'deny', operation: 'read' }, // op only on path
            cr('path', 'ok/**', 'ask'),
          ],
        },
      },
    });
    const set = loadPolicySet(root, { homeDir: tmpHome(), mode: 'strict' });
    expect(set.warnings.length).toBeGreaterThanOrEqual(3);
    expect(agentLayersFor(set, 'general').project.claims).toEqual([cr('path', 'ok/**', 'ask')]);
  });

  it('version 3 is still a whole-file reject (strict throws PolicyLoadError)', () => {
    const root = tmpRoot();
    writePolicyFile(root, { version: 3, agents: {} });
    expect(() => loadPolicySet(root, { homeDir: tmpHome(), mode: 'strict' })).toThrow(PolicyLoadError);
    const soft = loadPolicySet(root, { homeDir: tmpHome() });
    expect(soft.agents.size).toBe(0);
    expect(soft.warnings.join(' ')).toContain('expected 1 or 2');
  });

  it('version 1 files keep working unchanged (and may optionally carry claims)', () => {
    const root = tmpRoot();
    writePolicyFile(root, { agents: { general: { edit: [{ match: 'vault/**', effect: 'deny' }] } } });
    const set = loadPolicySet(root, { homeDir: tmpHome() });
    expect(set.warnings).toEqual([]);
    expect(agentLayersFor(set, 'general').project.edit).toEqual([{ match: 'vault/**', effect: 'deny' }]);
    expect(agentLayersFor(set, 'general').project.claims).toBeUndefined();

    const root2 = tmpRoot();
    writePolicyFile(root2, { version: 1, agents: { general: { claims: [cr('network', 'evil.com*', 'deny')] } } });
    const set2 = loadPolicySet(root2, { homeDir: tmpHome() });
    expect(set2.warnings).toEqual([]);
    expect(agentLayersFor(set2, 'general').project.claims).toEqual([cr('network', 'evil.com*', 'deny')]);
  });
});

// ── Enforcement through the registry ───────────────────────────────────────

describe('claims enforcement through createBuiltinToolRegistry', () => {
  beforeEach(() => {
    clearSessionPermissionGrants();
  });

  /** Real file + unified diff that flips `hello` -> `world` (valid patch). */
  function makeEditableFile(dir: string, rel: string, content = 'hello\n'): void {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }

  it('multi-path hole closed with PLAIN v1 rules: hidden diff path triggers its deny rule', async () => {
    const dir = tmpRoot();
    writePolicyFile(dir, { agents: { general: { edit: [{ match: 'secret/**', effect: 'deny', reason: 'no secrets' }] } } });
    makeEditableFile(dir, 'docs/open.md');
    const { registry } = makeRegistry(dir, 'general');
    const applyDiff = registry.get('apply_diff');
    if (!applyDiff) throw new Error('apply_diff not registered');
    const res = (await applyDiff.execute(
      {
        path: 'docs/open.md',
        diff: '--- /dev/null\n+++ b/secret/leak.txt\n@@ -0,0 +1 @@\n+sneaky\n',
      } as never,
      makeCtx(dir),
    )) as { ok: boolean; error?: string };
    expect(res.ok).toBe(false);
    expect(res.error).toContain('[permission]');
    expect(res.error).toContain('secret/**');
    expect(fs.existsSync(path.join(dir, 'secret', 'leak.txt'))).toBe(false);
  });

  it('positive control: the same single-path call with an allowed patch still executes', async () => {
    const dir = tmpRoot();
    makeEditableFile(dir, 'docs/open.md');
    const { registry } = makeRegistry(dir, 'general');
    const applyDiff = registry.get('apply_diff');
    if (!applyDiff) throw new Error('apply_diff not registered');
    const res = (await applyDiff.execute(
      {
        path: 'docs/open.md',
        diff: '--- a/docs/open.md\n+++ b/docs/open.md\n@@ -1 +1 @@\n-hello\n+world\n',
      } as never,
      makeCtx(dir),
    )) as { ok: boolean };
    expect(res.ok).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'docs', 'open.md'), 'utf8')).toContain('world');
  });

  it('subagent subset regression: parent-floor deny on write src/** beats own claims allow on src/x', () => {
    // Parent floor = GLOBAL layer file (~/.zelari/policy.json — user-level,
    // cannot be relaxed in-project); the tentacle's own rule lives in the
    // PROJECT layer and would allow the specific subtree. Registry wiring
    // composes these exact two layers (agentLayersFor over loadPolicySet),
    // so proving the combined evaluation here proves what any tentacle
    // built by createKrakenSubAgentContextFactory would experience.
    const parentRoot = tmpRoot();
    writePolicyFile(parentRoot, {
      version: 2,
      agents: { general: { claims: [cr('path', 'src/**', 'deny', 'write')] } },
    });
    const childRoot = tmpRoot();
    writePolicyFile(childRoot, {
      version: 2,
      agents: {
        // The tentacle's OWN allow rule on the narrower subtree:
        claims: [cr('path', 'src/x/**', 'allow', 'write')],
      },
    });

    const parent = loadPolicySet(parentRoot, { homeDir: tmpHome() });
    const child = loadPolicySet(childRoot, { homeDir: tmpHome() });
    const composed: LayeredPolicyRuleSet = {
      global: agentLayersFor(parent, 'general').project,
      project: agentLayersFor(child, 'general').project,
    };

    const verdict = resolveClaimsVerdict(
      composed,
      'restrict-only',
      'apply_diff',
      { path: 'src/readme.md', diff: '--- a/src/x/k.ts\n+++ b/src/x/k.ts\n@@ -1 +1 @@\n-a\n+b\n' },
      childRoot,
    );
    expect(verdict.effect).toBe('deny');
    expect(verdict.matchedRules.map((m) => m.match)).toContain('src/**');
    // Sanity: without the parent floor the child's allow rule MATCHES — an
    // explicit claim allow is a defined effect ('allow'), not unconstrained.
    expect(
      resolveClaimsVerdict(layers({ claims: [cr('path', 'src/x/**', 'allow', 'write')] }, {}), 'restrict-only', 'write_file', { path: 'src/x/k.ts' }, childRoot)
        .effect,
    ).toBe('allow');
  });

  it('v2 claims reach the registry decision (path write claim -> ask fails closed without handler)', async () => {
    const dir = tmpRoot();
    writePolicyFile(dir, {
      version: 2,
      agents: { general: { claims: [cr('path', 'review/**', 'ask', 'write')] } },
    });
    makeEditableFile(dir, 'review/me.txt');
    const { registry } = makeRegistry(dir, 'general'); // no onPermissionAsk
    const writeFile = registry.get('write_file');
    if (!writeFile) throw new Error('write_file not registered');
    const res = (await writeFile.execute(
      { path: 'review/me.txt', content: 'new' } as never,
      makeCtx(dir),
    )) as { ok: boolean; error?: string };
    expect(res.ok).toBe(false);
    expect(res.error).toContain("claim 'review/**'");
  });
});
