/**
 * core-extensionApi.test.ts — t30 (Pilastro C) unit coverage for the core
 * ExtensionAPI seam (packages/core/src/harness/extensionApi.ts):
 *   - ExtensionRegistry collects tools/handlers and stamps extensionId;
 *   - duplicate / empty tool names are rejected (no shadowing);
 *   - the ExtensionHost surface is NARROW (registerTool / onPreToolUse / fs);
 *   - runExtensionPreToolUse follows the t22 failure semantics: explicit
 *     deny blocks, a CRASHING handler is fail-open (log + allow) or
 *     fail-closed (deny, reason 'extension-hook-failed').
 * All fakes are injected — no disk, no CLI imports.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  ExtensionRegistry,
  extensionMatcherMatches,
  runExtensionPreToolUse,
} from '@zelari/core/harness';
import type {
  ExtensionHost,
  SandboxedFs,
  ZelariExtension,
} from '@zelari/core/harness';

/** In-memory sandboxed fs fake — same shape the CLI binds for real. */
function fakeFs(root = '/ws'): SandboxedFs {
  return {
    root,
    readFile: async () => ({ ok: true, value: '' }),
    writeFile: async () => ({ ok: true, value: { path: `${root}/x` } }),
    listFiles: async () => ({ ok: true, value: [] }),
  };
}

function echoExtension(id: string, onHost?: (host: ExtensionHost) => void): ZelariExtension {
  return {
    id,
    async register(host) {
      host.registerTool({
        name: `tool_${id}`,
        description: `${id} tool`,
        inputSchema: z.object({ v: z.string() }),
        permissions: ['read'],
        execute: async (input) => ({ ok: true, value: `echo:${input.v}` }),
      });
      onHost?.(host);
    },
  };
}

describe('ExtensionRegistry (t30 core seam)', () => {
  it('collects tool specs stamped with the extension id, in order', async () => {
    const reg = new ExtensionRegistry();
    await reg.registerExtension(echoExtension('a'), { fs: fakeFs() });
    await reg.registerExtension(echoExtension('b'), { fs: fakeFs() });
    const tools = reg.listExtensionTools();
    expect(tools.map((t) => t.extensionId)).toEqual(['a', 'b']);
    expect(tools[0].spec.name).toBe('tool_a');
    expect(tools[0].spec.permissions).toEqual(['read']);
  });

  it('rejects duplicate tool names and empty names with a thrown error', async () => {
    const reg = new ExtensionRegistry();
    await reg.registerExtension(echoExtension('a'), { fs: fakeFs() });
    await expect(
      reg.registerExtension(echoExtension('a'), { fs: fakeFs() }),
    ).rejects.toThrow(/duplicate tool "tool_a"/);
    await expect(
      reg.registerExtension(
        { id: 'x', register: (h) => h.registerTool({ ...({} as never), name: ' ' } as never) },
        { fs: fakeFs() },
      ),
    ).rejects.toThrow(/empty name/);
  });

  it('removeExtension drops a partial registration after a failure', async () => {
    const reg = new ExtensionRegistry();
    const partial: ZelariExtension = {
      id: 'partial',
      async register(host) {
        host.registerTool({
          name: 'tool_partial',
          description: 'd',
          inputSchema: z.object({}),
          permissions: [],
          execute: async () => ({ ok: true, value: null }),
        });
        throw new Error('boom halfway');
      },
    };
    await expect(reg.registerExtension(partial, { fs: fakeFs() })).rejects.toThrow('boom halfway');
    reg.removeExtension('partial');
    expect(reg.listExtensionTools()).toHaveLength(0);
    expect(reg.preToolUseHandlers).toHaveLength(0);
  });

  it('the host surface stays narrow: registerTool / onPreToolUse / fs — nothing else', async () => {
    let seen: ExtensionHost | null = null;
    const reg = new ExtensionRegistry();
    await reg.registerExtension(echoExtension('a', (h) => (seen = h)), { fs: fakeFs('/ws') });
    expect(Object.keys(seen as unknown as object).sort()).toEqual(['fs', 'onPreToolUse', 'registerTool']);
    expect((seen as ExtensionHost).fs.root).toBe('/ws');
  });

  it('collects onPreToolUse handlers with the declared matcher', async () => {
    const reg = new ExtensionRegistry();
    await reg.registerExtension(
      echoExtension('w', (h) => h.onPreToolUse('bash', () => undefined)),
      { fs: fakeFs() },
    );
    const handlers = reg.preToolUseHandlers;
    expect(handlers).toHaveLength(1);
    expect(handlers[0]).toMatchObject({ extensionId: 'w', matcher: 'bash' });
  });
});

describe('extensionMatcherMatches', () => {
  it("'*' matches everything; exact names match case-insensitively; others never", () => {
    expect(extensionMatcherMatches('*', 'bash')).toBe(true);
    expect(extensionMatcherMatches('', 'bash')).toBe(true);
    expect(extensionMatcherMatches('BaSh', 'bash')).toBe(true);
    expect(extensionMatcherMatches('bash', 'read_file')).toBe(false);
  });
});

describe('runExtensionPreToolUse — t22 failure semantics', () => {
  const call = { toolName: 'bash', toolInput: { command: 'ls' } };
  const logs: string[] = [];
  const logger = (m: string) => logs.push(m);

  it('an explicit deny blocks with the given reason (attributed to the extension)', async () => {
    const verdict = await runExtensionPreToolUse(
      [{ extensionId: 'guard', matcher: '*', handler: () => ({ deny: true, reason: 'no shell for you' }) }],
      call,
      { logger },
    );
    expect(verdict).toEqual({ ok: false, extensionId: 'guard', reason: 'no shell for you' });
  });

  it('a deny without reason falls back to a named default', async () => {
    const verdict = await runExtensionPreToolUse(
      [{ extensionId: 'guard', matcher: '*', handler: () => ({ deny: true }) }],
      call,
      { logger },
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('guard');
  });

  it('no opinion (void / non-deny) allows; non-matching handlers are skipped', async () => {
    const seen: string[] = [];
    const verdict = await runExtensionPreToolUse(
      [
        { extensionId: 'other', matcher: 'read_file', handler: () => ({ deny: true }) },
        { extensionId: 'ok', matcher: '*', handler: () => seen.push('called') },
      ],
      call,
      { logger },
    );
    expect(verdict).toEqual({ ok: true });
    expect(seen).toEqual(['called']);
  });

  it('fail-open (default): a crashing handler logs + allows', async () => {
    const verdict = await runExtensionPreToolUse(
      [{ extensionId: 'crasher', matcher: '*', handler: () => { throw new Error('kaboom'); } }],
      call,
      { logger },
    );
    expect(verdict).toEqual({ ok: true });
    expect(logs.some((l) => l.includes('crasher') && l.includes('fail-open') && l.includes('kaboom'))).toBe(true);
  });

  it("fail-closed: a crashing handler denies with reason 'extension-hook-failed'", async () => {
    const verdict = await runExtensionPreToolUse(
      [{ extensionId: 'crasher', matcher: '*', handler: () => { throw new Error('kaboom'); } }],
      call,
      { failureMode: 'fail-closed', logger },
    );
    expect(verdict).toEqual({
      ok: false,
      extensionId: 'crasher',
      reason: 'extension-hook-failed',
    });
  });
});
