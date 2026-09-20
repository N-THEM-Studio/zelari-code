/**
 * WS1 (t133) — the pre-dispatch GATE, end to end through the REAL registry.
 *
 * Pins the four acceptance criteria of the plan §WS1 at the integration seam:
 *   - a `deny` rule BLOCKS the dispatch with a message naming the rule id, and
 *     the denial lands on the session spine as `permission.denied`, visible on
 *     replay (readSessionLog + buildProjection);
 *   - an `allow` rule skips the ask prompt the CATEGORY would have raised;
 *   - ZERO rules configured behaves exactly like the pre-WS1 tree;
 *   - a MALFORMED project config fails closed (ask), never silent allow.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionLogWriter, buildProjection, readSessionLog } from '@zelari/core/session';
import type { SessionEventInput } from '@zelari/core/session';
import type { ToolContext } from '@zelari/core/harness/tools/toolTypes';
import { AuditLogger } from './auditLogger.js';
import { createBuiltinToolRegistry } from '../toolRegistry.js';
import {
  clearSessionPermissionGrants,
  type PermissionPolicy,
} from './toolPermissions.js';
import {
  addSessionPermissionRule,
  clearSessionPermissionRules,
  resetProjectPermissionRuleCache,
} from './permissionRules.js';
import {
  PERMISSION_DENIED_KIND,
  clearPermissionDenials,
  evaluateToolDispatch,
  listRecentPermissionDenials,
} from './permissionGate.js';

let root: string;
let writer: SessionLogWriter;

function allowAll(): PermissionPolicy {
  return { read: 'allow', write: 'allow', execute: 'allow', network: 'allow', ui: 'allow', auto: true };
}

function writePermissionsFile(content: unknown | string): void {
  const dir = path.join(root, '.zelari');
  const body = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'permissions.json'), body);
}

function makeAudit(): AuditLogger {
  return new AuditLogger(
    path.join(os.tmpdir(), `zelari-ws1-${Date.now()}-${Math.random().toString(36).slice(2)}.log`),
  );
}

function makeCtx(): ToolContext {
  return {
    signal: new AbortController().signal,
    cwd: root,
    audit: () => undefined,
    sessionId: 'ws1-permissions',
    emitSessionEvent: (input: SessionEventInput) => writer.append(input),
  };
}

function makeRegistry(policy: PermissionPolicy = allowAll()) {
  const { registry } = createBuiltinToolRegistry({
    root,
    audit: makeAudit(),
    sessionId: 'ws1-permissions',
    profile: 'general',
    enableTask: false,
    enableSkill: false,
    diagnostics: false,
    lspProvider: null,
    permissionPolicy: policy,
  });
  return registry;
}

async function writeFile(pathArg: string) {
  const registry = makeRegistry();
  const tool = registry.get('write_file');
  if (!tool) throw new Error('write_file not registered');
  return (await tool.execute({ path: pathArg, content: 'x' } as never, makeCtx())) as {
    ok: boolean;
    error?: string;
  };
}

async function writeFileWith(policy: PermissionPolicy, pathArg: string) {
  const registry = makeRegistry(policy);
  const tool = registry.get('write_file');
  if (!tool) throw new Error('write_file not registered');
  return (await tool.execute({ path: pathArg, content: 'x' } as never, makeCtx())) as {
    ok: boolean;
    error?: string;
  };
}

describe('WS1 pre-dispatch gate (registry integration)', () => {
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'zelari-policy-ws1-'));
    await fs.mkdir(path.join(root, 'secrets'), { recursive: true });
    await fs.mkdir(path.join(root, 'docs'), { recursive: true });
    await fs.writeFile(path.join(root, 'secrets', 'key.pem'), 'old', 'utf-8');
    await fs.writeFile(path.join(root, 'docs', 'a.md'), 'old', 'utf-8');
    writer = await SessionLogWriter.open(path.join(root, 'session'), 'ws1-permissions', 1);
    resetProjectPermissionRuleCache();
    clearSessionPermissionRules();
    clearSessionPermissionGrants();
    clearPermissionDenials();
  });

  afterEach(async () => {
    await writer.close();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it('ZERO rules ⇒ nothing to say and the category decision stands (today’s behavior)', async () => {
    expect(
      evaluateToolDispatch({ toolName: 'write_file', required: ['write'], args: { path: 'docs/a.md' }, root }),
    ).toBeNull();
    // docs/a.md already exists (beforeEach) so a plain create is refused with
    // FILE_EXISTS: target a FRESH path to prove the (zero-rule) category
    // decision really reached the tool body.
    const res = await writeFile('docs/b.md');
    expect(res.ok, res.error).toBe(true);
    const report = await readSessionLog(writer.path);
    expect(report.events.filter((e) => e.kind === PERMISSION_DENIED_KIND)).toEqual([]);
  });

  it('a MALFORMED project config fails closed: the call asks (and is blocked without a handler)', async () => {
    writePermissionsFile('{ this is not json');
    const res = await writeFile('docs/a.md');
    expect(res.ok).toBe(false);
    expect(res.error).toContain('[permission]');
    expect(res.error).toContain('permissions.json');
    expect(res.error).toContain('No interactive approval available');
  });

  it('a `deny` rule blocks the dispatch, names the rule, and emits permission.denied on the spine', async () => {
    writePermissionsFile({
      version: 1,
      rules: [{ id: 'no-secrets', effect: 'deny', tool: 'write_file', pathPrefix: 'secrets', note: 'never touch secrets' }],
    });
    const res = await writeFile('secrets/key.pem');
    expect(res.ok).toBe(false);
    expect(res.error).toContain("rule 'no-secrets'");
    expect(res.error).toContain('never touch secrets');
    expect(res.error).toContain('[permissions:project]');
    // the file was NOT touched
    expect(await fs.readFile(path.join(root, 'secrets', 'key.pem'), 'utf-8')).toBe('old');

    // …and the denial survives REPLAY (both as raw events and on the projection)
    const report = await readSessionLog(writer.path);
    const denials = report.events.filter((e) => e.kind === PERMISSION_DENIED_KIND);
    expect(denials).toHaveLength(1);
    expect(denials[0]?.data).toMatchObject({
      tool: 'write_file',
      matchedRuleId: 'no-secrets',
      source: 'project',
    });
    expect(String(denials[0]?.data.reason)).toContain('never touch secrets');
    const projection = buildProjection(report.events, report.issues);
    expect(projection.permissionDenials).toEqual([
      expect.objectContaining({ tool: 'write_file', matchedRuleId: 'no-secrets', source: 'project' }),
    ]);
    // the ledger `/permissions` reads
    expect(listRecentPermissionDenials()).toEqual([
      expect.objectContaining({ tool: 'write_file', matchedRuleId: 'no-secrets', source: 'project' }),
    ]);
  });

  it('a rule that matches nothing changes nothing (deny stays scoped to its prefix)', async () => {
    writePermissionsFile({ rules: [{ id: 'no-secrets', effect: 'deny', pathPrefix: 'secrets' }] });
    // Fresh path again: docs/a.md would be refused by the FILE_EXISTS guard
    // BEFORE the (correct) allow decision could be observed.
    const res = await writeFile('docs/b.md');
    expect(res.ok, res.error).toBe(true);
    expect((await readSessionLog(writer.path)).events.filter((e) => e.kind === PERMISSION_DENIED_KIND)).toEqual([]);
  });

  it('an `allow` rule skips the ask prompt the CATEGORY would have raised', async () => {
    const askWrite: PermissionPolicy = { ...allowAll(), write: 'ask', auto: false };
    const before = await writeFileWith(askWrite, 'docs/b.md');
    expect(before.ok).toBe(false);
    expect(before.error).toContain('[permission]'); // category ask, no handler ⇒ fail closed

    writePermissionsFile({ rules: [{ id: 'docs-ok', effect: 'allow', tool: 'write_file', pathPrefix: 'docs' }] });
    const after = await writeFileWith(askWrite, 'docs/b.md');
    expect(after.ok, after.error).toBe(true);
  });

  it('an `allow` rule never relaxes a category DENY or a narrower deny rule', async () => {
    writePermissionsFile({ rules: [{ id: 'docs-ok', effect: 'allow', tool: 'write_file', pathPrefix: 'docs' }] });
    const denyWrite: PermissionPolicy = { ...allowAll(), write: 'deny' };
    const blocked = await writeFileWith(denyWrite, 'docs/a.md');
    expect(blocked.ok).toBe(false);
    expect(blocked.error).toContain('[permission]');

    writePermissionsFile({
      rules: [
        { id: 'docs-ok', effect: 'allow', tool: 'write_file', pathPrefix: 'docs' },
        { id: 'docs-no', effect: 'deny', tool: 'write_file', pathPrefix: 'docs/a.md' },
      ],
    });
    const both = await writeFileWith(allowAll(), 'docs/a.md');
    expect(both.ok).toBe(false);
    expect(both.error).toContain("rule 'docs-no'");
  });

  it('SESSION rules apply at runtime, with source session in the denial', async () => {
    const added = addSessionPermissionRule({ id: 'no-docs', effect: 'deny', pathPrefix: 'docs' });
    expect(added.ok).toBe(true);
    const res = await writeFile('docs/a.md');
    expect(res.ok).toBe(false);
    expect(res.error).toContain("rule 'no-docs'");
    expect(res.error).toContain('[permissions:session]');
    const denials = (await readSessionLog(writer.path)).events.filter((e) => e.kind === PERMISSION_DENIED_KIND);
    expect(denials[0]?.data.source).toBe('session');
  });

  it('an invalid SESSION rule is rejected and stored nowhere', () => {
    expect(addSessionPermissionRule({ id: 'bad', effect: 'nope' }).ok).toBe(false);
    expect(addSessionPermissionRule({ effect: 'deny' }).ok).toBe(false);
    expect(addSessionPermissionRule({ id: 'wide', effect: 'allow' }).ok).toBe(false);
    expect(
      evaluateToolDispatch({ toolName: 'write_file', required: ['write'], args: { path: 'docs/a.md' }, root }),
    ).toBeNull();
  });

  it('a SESSION rule may carry its own `$comment` (accepted, stripped before the engine)', () => {
    const added = addSessionPermissionRule({
      $comment: 'added by hand for one session',
      id: 'no-docs',
      effect: 'deny',
      pathPrefix: 'docs',
    });
    expect(added.ok, added.ok ? '' : added.error).toBe(true);
    if (added.ok) expect(Object.keys(added.rule)).not.toContain('$comment');
  });
});

/**
 * The WS1 self-footgun, at the seam where it was live: the file WS1 ships
 * (top-level `$comment`, `version: 1`, NO rules) sits in the workspace root and
 * the REAL registry dispatches against it. A strict schema rejection there is
 * not a harmless warning — it fails closed, so every tool call of a fresh
 * checkout is denied whenever no interactive approver exists (tests, headless).
 */
describe('WS1 gate — the shipped `$comment` template is not a malformed config', () => {
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'zelari-policy-comment-'));
    await fs.mkdir(path.join(root, 'secrets'), { recursive: true });
    await fs.mkdir(path.join(root, 'docs'), { recursive: true });
    await fs.writeFile(path.join(root, 'secrets', 'key.pem'), 'old', 'utf-8');
    writer = await SessionLogWriter.open(path.join(root, 'session'), 'ws1-comment', 1);
    resetProjectPermissionRuleCache();
    clearSessionPermissionRules();
    clearPermissionDenials();
  });

  afterEach(async () => {
    await writer.close();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it('top-level `$comment` + 0 rules behaves like a rule-less tree: allowed, nothing to say', async () => {
    writePermissionsFile({
      $comment: 'WS1 (t133) local permission policy. Ships with NO rules; a malformed file fails closed.',
      version: 1,
      rules: [],
    });
    expect(
      evaluateToolDispatch({ toolName: 'write_file', required: ['write'], args: { path: 'docs/b.md' }, root }),
    ).toBeNull();
    const res = await writeFile('docs/b.md');
    expect(res.ok, res.error).toBe(true);
  });

  it('a rule carrying a `$comment` is accepted, stripped and still enforced', async () => {
    writePermissionsFile({
      $comment: 'doc',
      rules: [{ $comment: 'doc', id: 'no-secrets', effect: 'deny', pathPrefix: 'secrets' }],
    });
    const res = await writeFile('secrets/key.pem');
    expect(res.ok).toBe(false);
    expect(res.error).toContain("[permissions:project] rule 'no-secrets'");
    expect(await fs.readFile(path.join(root, 'secrets', 'key.pem'), 'utf-8')).toBe('old');
  });

  it('comments never mask a genuinely malformed config: still fails closed, path and field named', async () => {
    writePermissionsFile({
      $comment: 'doc',
      version: 1,
      rules: [{ $comment: 'doc', id: 'x', effect: 'maybe' }],
    });
    const res = await writeFile('docs/b.md');
    expect(res.ok).toBe(false);
    expect(res.error).toContain('invalid permissions config');
    expect(res.error).toContain("at 'rules.0.effect'");
    expect(res.error).toContain('failing closed');
    expect(res.error).toContain(path.join(root, '.zelari', 'permissions.json'));
    expect(res.error).toContain('No interactive approval available');
  });
});
