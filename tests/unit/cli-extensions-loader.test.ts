/**
 * cli-extensions-loader.test.ts — t30 (Pilastro C) unit coverage for the
 * ExtensionAPI seam wiring in the CLI:
 *   (a) an extension tool declaring broad permissions is intersected DOWN by
 *       wrapWithPermissions: parent deny ⇒ typedErr, execute never runs;
 *       ask-without-UI ⇒ typedErr too;
 *   (b) onPreToolUse deny blocks the tool; a crashing handler denies in
 *       fail-closed and allows+logs in fail-open (t22 semantics);
 *   (c) untrusted project folder ⇒ project extensions NOT loaded, global
 *       still load;
 *   (d) extensions.lock hash mismatch ⇒ strict rejects (typed
 *       ExtensionLockError), permissive warns + skips;
 *   (e) sandboxedFs: write outside the root fails typed, inside works;
 *   (f) ContractCompiler stays the LAST intersect: a contract deny keeps
 *       denying even though the extension tool itself allows.
 * Everything runs in tmp dirs — no real ~/.zelari-code is touched.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { AuditLogger } from '../../src/cli/safety/auditLogger.js';
import {
  _setTrustStorePathForTests,
  trustFolder,
} from '../../src/cli/safety/folderTrust.js';
import {
  EXTENSIONS_LOCK_FILE,
  ExtensionLockError,
  extensionSourceDirs,
  loadDefaultExtensionRuntime,
  loadExtensionsFromDirs,
  projectExtensionsDir,
} from '../../src/cli/extensions/loader.js';
import { bindSandboxedFs } from '../../src/cli/extensions/sandboxedFs.js';
import { createBuiltinToolRegistry } from '../../src/cli/toolRegistry.js';
import { setActiveContractScope } from '../../src/cli/kraken/contractCompiler.js';
import type { ExtensionRegistry, ZelariExtension } from '@zelari/core/harness';
import type { PermissionPolicy, ToolContext } from '../../src/cli/safety/toolPermissions.js';

let tmp: string;
let trustStore: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zelari-t30-'));
  trustStore = path.join(tmp, 'trust.json');
  _setTrustStorePathForTests(trustStore);
  fs.writeFileSync(trustStore, JSON.stringify({ folders: [] }));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** An extension dir MUST declare ESM or node's .js default (CJS) bites. */
function mkExtDir(name: string): string {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
  return dir;
}

function writeExtension(dir: string, file: string, id: string, toolName: string): void {
  fs.writeFileSync(
    path.join(dir, file),
    `export default {
  id: ${JSON.stringify(id)},
  async register(host) {
    let calls = 0;
    host.registerTool({
      name: ${JSON.stringify(toolName)},
      description: 'extension tool ${toolName}',
      inputSchema: { safeParse: (v) => ({ success: true, data: v }) },
      permissions: ['read'],
      execute: async (input) => { calls++; globalThis.__t30Calls = globalThis.__t30Calls || {}; globalThis.__t30Calls[${JSON.stringify(toolName)}] = calls; return { ok: true, value: { ran: true, input } }; },
    });
  },
};\n`,
  );
}

const logs: string[] = [];
const collectLogs = (m: string) => logs.push(m);

function allowAll(): PermissionPolicy {
  return { read: 'allow', write: 'allow', execute: 'allow', network: 'allow', ui: 'allow', auto: true };
}

function makeAudit(): AuditLogger {
  return new AuditLogger(path.join(tmp, `audit-${Math.random().toString(36).slice(2)}.log`));
}

function makeCtx(cwd: string): ToolContext {
  return { signal: new AbortController().signal, cwd, audit: () => undefined, sessionId: 't30-test' };
}

function makeRegistry(root: string, extensions: ExtensionRegistry, policy: PermissionPolicy) {
  return createBuiltinToolRegistry({
    root,
    audit: makeAudit(),
    sessionId: 't30-test',
    enableTask: false,
    enableSkill: false,
    enableTodos: false,
    enablePlanTasks: false,
    diagnostics: false,
    lspProvider: null,
    permissionPolicy: policy,
    extensions,
  });
}

function callsOf(toolName: string): number {
  return (globalThis.__t30Calls as Record<string, number> | undefined)?.[toolName] ?? 0;
}

describe('loader — discovery + folderTrust (c)', () => {
  it('untrusted project folder: project extensions NOT loaded; global ones are', async () => {
    const globalDir = mkExtDir('global');
    const projectDir = projectExtensionsDir(tmp);
    writeExtension(globalDir, 'greet.js', 'greet', 'ext_greet');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'package.json'), JSON.stringify({ type: 'module' }));
    writeExtension(projectDir, 'poked.js', 'poked', 'ext_poked');

    expect(extensionSourceDirs(tmp)).toHaveLength(1); // global only (untrusted project)
    // Hermetic composition: tmp "global" dir + whatever PROJECT dir the
    // trust gate admits (extensionSourceDirs decides trust; the loader
    // only sees the dir list — exactly like lifecycleHooks).
    const dirsFor = () => [
      { path: globalDir, scope: 'global' as const },
      ...extensionSourceDirs(tmp).filter((d) => d.scope === 'project'),
    ];
    const untrusted = await loadExtensionsFromDirs(dirsFor(), { mode: 'permissive', fsRoot: tmp, logger: collectLogs });
    expect(untrusted.ok).toBe(true);
    if (untrusted.ok) {
      expect(untrusted.runtime.loaded.map((e) => e.id)).toEqual(['greet']);
      expect(untrusted.runtime.loaded.every((e) => e.scope === 'global')).toBe(true);
    }

    trustFolder(tmp); // now the project folder is trusted
    expect(extensionSourceDirs(tmp)).toHaveLength(2);
    const trusted = await loadExtensionsFromDirs(dirsFor(), { mode: 'permissive', fsRoot: tmp, logger: collectLogs });
    expect(trusted.ok).toBe(true);
    if (trusted.ok) {
      expect(trusted.runtime.loaded.map((e) => e.id).sort()).toEqual(['greet', 'poked']);
      expect(trusted.runtime.loaded.find((e) => e.id === 'poked')?.scope).toBe('project');
    }
  });
});

describe('loader — extensions.lock (d)', () => {
  it('matching hash loads; mismatch ⇒ strict rejects typed, permissive skips + warns', async () => {
    const dir = mkExtDir('locked');
    writeExtension(dir, 'main.js', 'locked-ext', 'ext_locked');
    const good = createHash('sha256').update(fs.readFileSync(path.join(dir, 'main.js'))).digest('hex');

    // Correct lock → loads.
    fs.writeFileSync(path.join(dir, EXTENSIONS_LOCK_FILE), JSON.stringify({ 'main.js': good }));
    const ok = await loadExtensionsFromDirs([{ path: dir, scope: 'global' }], { mode: 'strict', logger: collectLogs });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.runtime.loaded.map((e) => e.id)).toEqual(['locked-ext']);

    // Tampered file → strict: typed error, NOTHING loads.
    fs.appendFileSync(path.join(dir, 'main.js'), '\n// tampered\n');
    const bad = await loadExtensionsFromDirs([{ path: dir, scope: 'global' }], { mode: 'strict', logger: collectLogs });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.error).toBeInstanceOf(ExtensionLockError);
      expect(bad.error.name).toBe('ExtensionLockError');
      expect(bad.error.mismatches[0]).toContain('sha256 mismatch');
    }

    // Tampered file → permissive: warn + skip (empty load, no throw).
    const skipped = await loadExtensionsFromDirs([{ path: dir, scope: 'global' }], { mode: 'permissive', logger: collectLogs });
    expect(skipped.ok).toBe(true);
    if (skipped.ok) {
      expect(skipped.runtime.loaded).toHaveLength(0);
      expect(skipped.runtime.skipped.join('\n')).toContain('sha256 mismatch');
    }
  });

  it('a file NOT listed in an existing lock is a mismatch too (strict)', async () => {
    const dir = mkExtDir('locklist');
    writeExtension(dir, 'surprise.js', 'sneak', 'ext_sneak');
    fs.writeFileSync(path.join(dir, EXTENSIONS_LOCK_FILE), JSON.stringify({}));
    const res = await loadExtensionsFromDirs([{ path: dir, scope: 'global' }], { mode: 'strict', logger: collectLogs });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.mismatches[0]).toContain('not listed');
  });
});

describe('sandboxedFs binding (e)', () => {
  it('write inside the root works; outside the root is a typed deny', async () => {
    const fsx = bindSandboxedFs(tmp);
    const inside = await fsx.writeFile(path.join('sub', 'file.txt'), 'hello');
    expect(inside.ok).toBe(true);
    expect(fs.readFileSync(path.join(tmp, 'sub', 'file.txt'), 'utf8')).toBe('hello');

    const escape = await fsx.writeFile('..\\outside.txt', 'nope');
    expect(escape.ok).toBe(false);
    if (!escape.ok) expect(escape.error).toContain('[extension-fs]');

    const absoluteEscape = await fsx.writeFile(path.join(os.tmpdir(), `outside-${Date.now()}.txt`), 'nope');
    expect(absoluteEscape.ok).toBe(false);

    const listed = await fsx.listFiles('.');
    expect(listed.ok).toBe(true);
  });
});

describe('wiring through wrapWithPermissions (a) + onPreToolUse (b)', () => {
  it('(a) parent policy deny ⇒ typedErr, extension execute NEVER runs; ask-without-UI ⇒ typedErr', async () => {
    const reg = new (await import('@zelari/core/harness')).ExtensionRegistry();
    await reg.registerExtension(
      {
        id: 'rogue',
        async register(host) {
          host.registerTool({
            name: 'ext_write_anywhere',
            description: 'declares write+execute and hopes for the best',
            inputSchema: { safeParse: (v: unknown) => ({ success: true, data: v }) },
            permissions: ['write', 'execute'],
            execute: async () => ({ ok: true, value: 'WROTE EVERYWHERE' }),
          });
        },
      },
      { fs: bindSandboxedFs(tmp) },
    );

    const denyWrite: PermissionPolicy = { ...allowAll(), write: 'deny' };
    const { registry } = makeRegistry(tmp, reg, denyWrite);
    expect(registry.list()).toContain('ext_write_anywhere');
    const def = registry.get('ext_write_anywhere');
    const res = await def?.execute({ path: 'whatever.txt' }, makeCtx(tmp));
    expect(res?.ok).toBe(false);
    if (!res?.ok) expect(res?.error).toContain('[permission]');
    expect((globalThis.__t30Calls as Record<string, number>)?.ext_write_anywhere ?? 0).toBe(0);

    // Ask without an interactive approval handler also fails CLOSED.
    const reg2 = new (await import('@zelari/core/harness')).ExtensionRegistry();
    await reg2.registerExtension(
      {
        id: 'asky',
        async register(host) {
          host.registerTool({
            name: 'ext_ask_tool',
            description: 'needs approval',
            inputSchema: { safeParse: (v: unknown) => ({ success: true, data: v }) },
            permissions: ['write'],
            execute: async () => ({ ok: true, value: 'approved!' }),
          });
        },
      },
      { fs: bindSandboxedFs(tmp) },
    );
    const askNoUi: PermissionPolicy = { ...allowAll(), write: 'ask', auto: false };
    const { registry: reg3 } = makeRegistry(tmp, reg2, askNoUi);
    const res2 = await reg3.get('ext_ask_tool')?.execute({}, makeCtx(tmp));
    expect(res2?.ok).toBe(false);
    if (!res2?.ok) expect(res2?.error).toContain('No interactive approval available');
  });

  it('(b) onPreToolUse deny blocks the tool; crash denies in fail-closed, allows+logs in fail-open', async () => {
    const makeWatcher = (): ZelariExtension => ({
      id: 'watcher',
      async register(host) {
        host.registerTool({
          name: 'ext_ping',
          description: 'ping',
          inputSchema: { safeParse: (v: unknown) => ({ success: true, data: v }) },
          permissions: ['read'],
          execute: async () => ({ ok: true, value: 'pinged' }),
        });
        host.onPreToolUse('*', () => ({ deny: true, reason: 'no pings allowed' }));
      },
    });

    // Explicit deny → typed error, tool body never runs.
    const regDeny = new (await import('@zelari/core/harness')).ExtensionRegistry();
    await regDeny.registerExtension(makeWatcher(), { fs: bindSandboxedFs(tmp) });
    const r1 = makeRegistry(tmp, regDeny, allowAll());
    const d = await r1.registry.get('ext_ping')?.execute({}, makeCtx(tmp));
    expect(d?.ok).toBe(false);
    if (!d?.ok) expect(d?.error).toBe('[extension-hook:watcher] no pings allowed');

    // Crashing handler under ZELARI_HOOKS_FAILURE=fail-closed ⇒ deny 'extension-hook-failed'.
    const makeCrasher = (): ZelariExtension => ({
      id: 'crasher',
      async register(host) {
        host.registerTool({
          name: 'ext_ping',
          description: 'ping',
          inputSchema: { safeParse: (v: unknown) => ({ success: true, data: v }) },
          permissions: ['read'],
          execute: async () => ({ ok: true, value: 'pinged' }),
        });
        host.onPreToolUse('*', () => {
          throw new Error('handler kaboom');
        });
      },
    });
    const prev = process.env.ZELARI_HOOKS_FAILURE;
    process.env.ZELARI_HOOKS_FAILURE = 'fail-closed';
    try {
      const regC = new (await import('@zelari/core/harness')).ExtensionRegistry();
      await regC.registerExtension(makeCrasher(), { fs: bindSandboxedFs(tmp) });
      const r2 = makeRegistry(tmp, regC, allowAll());
      const closed = await r2.registry.get('ext_ping')?.execute({}, makeCtx(tmp));
      expect(closed?.ok).toBe(false);
      if (!closed?.ok) expect(closed?.error).toContain('extension-hook-failed');

      // fail-open ⇒ allow + log, the tool RUNS.
      process.env.ZELARI_HOOKS_FAILURE = 'fail-open';
      const regO = new (await import('@zelari/core/harness')).ExtensionRegistry();
      await regO.registerExtension(makeCrasher(), { fs: bindSandboxedFs(tmp) });
      const r3 = makeRegistry(tmp, regO, allowAll());
      const opened = await r3.registry.get('ext_ping')?.execute({}, makeCtx(tmp));
      expect(opened?.ok).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.ZELARI_HOOKS_FAILURE;
      else process.env.ZELARI_HOOKS_FAILURE = prev;
    }
  });
});

describe('in-tree example extension + ContractCompiler last intersect (f)', () => {
  it('the example loads, registers echo_tool, and a contract deny still wins', async () => {
    const mod = (await import('../../examples/extensions/echo-tool/extension.js')) as { default: ZelariExtension };
    const reg = new (await import('@zelari/core/harness')).ExtensionRegistry();
    await reg.registerExtension(mod.default, { fs: bindSandboxedFs(tmp) });
    const { registry } = makeRegistry(tmp, reg, allowAll());
    expect(registry.list()).toContain('echo_tool');

    // Sanity: without a contract, the extension tool executes.
    const def = registry.get('echo_tool');
    const good = await def?.execute({ message: 'hi' }, makeCtx(tmp));
    expect(good?.ok).toBe(true);

    // (f): the contract forbids secret/** — the extension tool declares
    // only 'read', the contract layer is edit-category, so give the
    // example's call a path-like shape by routing through a write-category
    // extension tool: the deny must STILL apply (contract intersects LAST).
    const regW = new (await import('@zelari/core/harness')).ExtensionRegistry();
    await regW.registerExtension(
      {
        id: 'notewrite',
        async register(host) {
          host.registerTool({
            name: 'ext_note',
            description: 'writes a note wherever it wants',
            inputSchema: { safeParse: (v: unknown) => ({ success: true, data: v }) },
            permissions: ['write'],
            execute: async (input: { path?: string }) => ({ ok: true, value: input?.path ?? 'wrote' }),
          });
        },
      },
      { fs: bindSandboxedFs(tmp) },
    );
    const r2 = makeRegistry(tmp, regW, allowAll());
    const note = r2.registry.get('ext_note');
    setActiveContractScope({ scope: { forbiddenPaths: ['secret/**'] } } as never);
    try {
      const denied = await note?.execute({ path: 'secret/x.txt' }, makeCtx(tmp));
      expect(denied?.ok).toBe(false);
      if (!denied?.ok) expect(denied?.error).toContain('[contract]');

      const allowed = await note?.execute({ path: 'notes/x.txt' }, makeCtx(tmp));
      expect(allowed?.ok).toBe(true);
    } finally {
      setActiveContractScope(undefined);
    }
  });
});
