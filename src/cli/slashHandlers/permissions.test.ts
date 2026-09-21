/**
 * WS1 (t133) — `/permissions` slash handler.
 *
 * Pins the P1 acceptance criterion: the command LISTS active rules with their
 * source (default | project | session) plus the recent denials, and add/remove
 * of SESSION rules is zod-validated.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChatMessage } from '../components/ChatStream.js';
import { handlePermissions } from './permissions.js';
import {
  clearSessionPermissionRules,
  listSessionPermissionRules,
  resetProjectPermissionRuleCache,
} from '../safety/permissionRules.js';

let root: string;
let messages: ChatMessage[];

function ctx() {
  return {
    setMessages: ((next: unknown) => {
      messages.push(...(typeof next === 'function' ? [] : (next as ChatMessage[])));
    }) as never,
  };
}

async function run(sub: string | undefined, args: string[] = []): Promise<string> {
  const out = handlePermissions(ctx(), sub, args, root);
  return out;
}

describe('WS1 — /permissions', () => {
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'zelari-policy-handler-'));
    mkdirSync(path.join(root, '.zelari'), { recursive: true });
    messages = [];
    resetProjectPermissionRuleCache();
    clearSessionPermissionRules();
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it('lists the DEFAULT (5 categories), project and session sources', async () => {
    writeFileSync(
      path.join(root, '.zelari', 'permissions.json'),
      JSON.stringify({
        version: 1,
        rules: [{ id: 'no-secrets', effect: 'deny', pathPrefix: 'secrets', note: 'never touch secrets' }],
      }),
    );
    handlePermissions(ctx(), 'add', ['no-push', 'deny', 'tool=bash', 'note=never push'], root);

    const report = await run(undefined);
    expect(report).toContain('default (5 categories, unchanged)');
    expect(report).toContain('read=allow');
    expect(report).toContain('execute=ask');
    expect(report).toContain('network=ask');
    expect(report).toContain('[project] no-secrets → deny (pathPrefix=secrets) — never touch secrets');
    expect(report).toContain('[session] no-push → deny (tool=bash) — never push');
    expect(report).toContain(path.join('.zelari', 'permissions.json'));
    expect(report).toContain('recent denials (0)');
  });

  it('is a no-op that still reports the 5-category defaults when NOTHING is configured', async () => {
    const report = await run('list');
    expect(report).toContain('default (5 categories, unchanged)');
    expect(report).toContain('(no rules — absent or empty file)');
    expect(report).toContain('(none — /permissions add <id> <effect> [matchers…])');
  });

  it('reports a malformed project file as FAIL-CLOSED instead of hiding it', async () => {
    writeFileSync(path.join(root, '.zelari', 'permissions.json'), '{ nope');
    const report = await run('list');
    expect(report).toContain('FAIL-CLOSED');
    expect(report).toContain('permissions.json');
  });

  it('add stores a validated SESSION rule; an invalid one is rejected and stores nothing', async () => {
    const ok = await run('add', ['no-docs', 'deny', 'pathPrefix=docs', 'category=write']);
    expect(ok).toContain("session rule 'no-docs' → deny");
    expect(ok).toContain('pathPrefix=docs');
    expect(listSessionPermissionRules().map((r) => r.rule.id)).toEqual(['no-docs']);

    const badEffect = await run('add', ['x', 'maybe']);
    expect(badEffect).toContain('rejected');
    const unknownKey = await run('add', ['y', 'deny', 'nope=1']);
    expect(unknownKey).toContain("unknown matcher 'nope'");
    const unconstrainedAllow = await run('add', ['z', 'allow']);
    expect(unconstrainedAllow).toContain("unconstrained 'allow'");
    expect(listSessionPermissionRules().map((r) => r.rule.id)).toEqual(['no-docs']);
  });

  it('remove drops a session rule (and says so when there is none)', async () => {
    await run('add', ['tmp-rule', 'deny', 'tool=bash']);
    expect(await run('remove', ['tmp-rule'])).toContain("removed session rule 'tmp-rule'");
    expect(await run('remove', ['tmp-rule'])).toContain("no session rule 'tmp-rule'");
  });

  it('clear empties the session store', async () => {
    await run('add', ['a-rule', 'deny', 'tool=bash']);
    await run('clear');
    expect(listSessionPermissionRules()).toEqual([]);
  });

  it('an unknown subcommand prints the usage instead of silently doing nothing', async () => {
    expect(await run('frobnicate')).toContain('unknown subcommand');
  });
});
