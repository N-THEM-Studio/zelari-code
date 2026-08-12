/**
 * cli-brokerHandlers.test.ts — v1.30.0 broker handler coverage.
 *
 * Focus: policy → handler flow of `createBrokerPermissionHandler`, in
 * particular the `always` propagation to the external agent when the human
 * chose "Allow always this session" (the TUI picker grants the session
 * BEFORE resolving true; the broker must surface that as `always: true` so
 * the external CLI stops re-asking for the same tool — OpenMausBot
 * `updatedPermissions` equivalent).
 *
 * Session grants are process-global: each test clears them before/after.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  clearSessionPermissionGrants,
  grantSessionTool,
  grantSessionCategory,
  type PermissionAskHandler,
} from '../../src/cli/safety/toolPermissions.js';
import { createBrokerPermissionHandler } from '../../src/cli/mcp/brokerHandlers.js';
import type { BrokerPermissionRequest } from '../../src/cli/mcp/permissionBroker.js';

function permReq(overrides?: Partial<BrokerPermissionRequest>): BrokerPermissionRequest {
  return {
    id: 'req-1',
    tool: 'Bash',
    input: { command: 'ls' },
    ...overrides,
  };
}

beforeEach(() => clearSessionPermissionGrants());
afterEach(() => clearSessionPermissionGrants());

describe('createBrokerPermissionHandler — policy flow', () => {
  it('allows when the policy already allows (no always flag)', async () => {
    const handler = createBrokerPermissionHandler({
      policy: { read: 'allow', write: 'allow', execute: 'allow', network: 'allow', ui: 'allow', auto: false },
    });
    const res = await handler(permReq());
    expect(res).toEqual({ behavior: 'allow' });
  });

  it('denies with the policy reason when policy denies', async () => {
    const handler = createBrokerPermissionHandler({
      policy: { read: 'allow', write: 'deny', execute: 'deny', network: 'deny', ui: 'allow', auto: false },
    });
    const res = await handler(permReq());
    expect(res.behavior).toBe('deny');
    expect(res.message).toContain('denied');
  });

  it('denies (never hangs) when ask-state has no interactive handler', async () => {
    const handler = createBrokerPermissionHandler({
      policy: { read: 'allow', write: 'ask', execute: 'ask', network: 'ask', ui: 'allow', auto: false },
    });
    const res = await handler(permReq());
    expect(res.behavior).toBe('deny');
    expect(res.message).toContain('no interactive approval');
  });

  it('denies when the user rejects in the picker', async () => {
    const handler = createBrokerPermissionHandler({
      policy: { read: 'allow', write: 'ask', execute: 'ask', network: 'ask', ui: 'allow', auto: false },
      onPermissionAsk: (async () => false) as PermissionAskHandler,
    });
    const res = await handler(permReq());
    expect(res).toEqual({ behavior: 'deny', message: '[zelari] denied by user' });
  });

  it('allows when the user approves once (no always flag)', async () => {
    const handler = createBrokerPermissionHandler({
      policy: { read: 'allow', write: 'ask', execute: 'ask', network: 'ask', ui: 'allow', auto: false },
      onPermissionAsk: (async () => true) as PermissionAskHandler,
    });
    const res = await handler(permReq());
    expect(res).toEqual({ behavior: 'allow' });
  });
});

describe('createBrokerPermissionHandler — always propagation', () => {
  it('propagates always:true when the picker granted the tool for the session', async () => {
    const handler = createBrokerPermissionHandler({
      policy: { read: 'allow', write: 'ask', execute: 'ask', network: 'ask', ui: 'allow', auto: false },
      // Mirrors createPermissionAskHandler: grants BEFORE resolving true.
      onPermissionAsk: (async (req) => {
        grantSessionTool(req.toolName);
        return true;
      }) as PermissionAskHandler,
    });
    const res = await handler(permReq());
    expect(res).toEqual({ behavior: 'allow', always: true });
  });

  it('propagates always:true when a category grant already covers the tool', async () => {
    grantSessionCategory('execute');
    const handler = createBrokerPermissionHandler({
      policy: { read: 'allow', write: 'ask', execute: 'ask', network: 'ask', ui: 'allow', auto: false },
      onPermissionAsk: (async () => true) as PermissionAskHandler,
    });
    const res = await handler(permReq());
    expect(res.behavior).toBe('allow');
    expect(res.always).toBe(true);
  });

  it('does not propagate always for a plain policy allow', async () => {
    // Tool-level grant exists but policy would allow anyway — no ask involved.
    const handler = createBrokerPermissionHandler({
      policy: { read: 'allow', write: 'allow', execute: 'allow', network: 'allow', ui: 'allow', auto: false },
    });
    const res = await handler(permReq());
    expect(res).toEqual({ behavior: 'allow' });
  });
});
