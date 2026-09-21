/**
 * tools/eval/extensionAnchors.ts — extension/plugin CAPABILITY suite (t147).
 *
 * WHY THIS FILE EXISTS: `eval:gate` can only compare a suite it has RUN
 * records for. The extension surface (single-file extensions, onPreToolUse
 * deny, JSON lifecycle observers, plugin bundles, fail-closed loading) had
 * zero recorded anchors, so `eval:gate --candidate all` found no manifest
 * directories and exited 2 (tools/eval/resultStore.ts `listManifestHashes`
 * only matches `<16+ hex>` dirs). This module defines the missing suite.
 *
 * HONESTY (anti-Goodhart, mirroring tools/eval/runSeedBaseline.ts): every
 * check below EXECUTES the REAL capability code under `src/cli` —
 * `loadExtensionsFromDirs` dynamic-imports the fixture module itself, the
 * core `ExtensionRegistry` registers it, `withExtensionPreToolUse` runs the
 * real deny wiring, the lifecycle hook runner SPAWNS a real child process,
 * and `loadBundle` reads the shipped example bundle through the real parser.
 * `detail` reports what was actually observed; there is no echo-stub runner
 * anywhere on this path.
 *
 * OFFLINE + DETERMINISTIC BY CONSTRUCTION: no model, no network, no
 * credentials, no clock-dependent assertions. So the recorded cost is zero
 * except the MEASURED `wallMs` (see tools/eval/cost.ts) — these anchors are
 * capability anchors, NOT model-measured cost baselines, and their numbers
 * are not comparable with runSeedBaseline.ts output.
 *
 * Fixtures are written per check into a temp workspace INSIDE the repo
 * (`<root>/.zelari/eval-extension-workspaces/<id>-<rand>`, gitignored) so the
 * shipped `examples/extensions/echo-tool/extension.js` still resolves its own
 * bare imports (`zod`, `@zelari/core/...`) exactly as it does in-tree.
 */

import { createHash, randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ToolContext } from '@zelari/core/harness/tools/toolTypes';
import {
  EXTENSIONS_LOCK_FILE,
  ExtensionLockError,
  loadExtensionsFromDirs,
} from '../../src/cli/extensions/loader.ts';
import {
  extensionToolToDefinition,
  withExtensionPreToolUse,
} from '../../src/cli/extensions/extensionToolWiring.ts';
import {
  createLifecycleHooksFromDirs,
  resetLifecycleHookCache,
} from '../../src/cli/safety/lifecycleHooks.ts';
import { loadBundle } from '../../src/cli/plugins/bundleLoad.ts';

/** Repo root derived from THIS file (cwd-independent, like runAnchors.ts). */
export const EVAL_REPO_ROOT = path.resolve(import.meta.dirname, '../..');

/** Scratch root for the suite's fixture workspaces (gitignored `.zelari/`). */
export const EXTENSION_WORKSPACE_ROOT = path.join(EVAL_REPO_ROOT, '.zelari', 'eval-extension-workspaces');

/** Shipped single-file extension the echo check loads. */
export const ECHO_TOOL_EXAMPLE = path.join(EVAL_REPO_ROOT, 'examples/extensions/echo-tool/extension.js');

/** Shipped plugin bundle the bundle check validates. */
export const PLUGIN_BUNDLE_EXAMPLE = path.join(EVAL_REPO_ROOT, 'examples/extensions/zelari-plugin-example');

/**
 * Resource-policy provenance tag. This suite runs no model and no tool
 * subprocess beyond the capability itself, so there is no resource policy to
 * resolve: the hash is a FIXED, documented label — never a fabricated
 * `defaultResourcePolicy()` result for a profile this run never used.
 */
export const EXTENSION_RESOURCE_POLICY_TAG = 'extension-baseline/offline-deterministic/v1';

export interface CapabilityCheckResult {
  ok: boolean;
  /** What was OBSERVED (never a restated expectation). */
  detail: string;
  /** Measured wall time of the check, in ms. */
  wallMs: number;
}

export interface ExtensionCapabilityCheck {
  /** kebab-case, stable across versions (AnchorRunRecord.anchorId). */
  id: string;
  /** Bump when the check's fixture/assertions change (manifest identity). */
  version: number;
  description: string;
  run: (workspaceRoot: string) => Promise<CapabilityCheckResult>;
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Fixed provenance hash for every record of this suite (see the tag above). */
export function extensionResourcePolicyHash(): string {
  return sha256(EXTENSION_RESOURCE_POLICY_TAG);
}

/**
 * The suite's manifest hash: sha256 over the STABLE (id, version) list only.
 * Titles/details are deliberately excluded — editing prose must not churn the
 * manifest dir a recorded baseline lives in. Reordering or re-versioning a
 * check DOES change it, which is the point: the hash identifies the suite
 * definition a baseline was measured with.
 */
export function extensionSuiteManifestHash(): string {
  const manifest = {
    suite: 'extension-capability',
    tag: EXTENSION_RESOURCE_POLICY_TAG,
    anchors: EXTENSION_SUITE.map((check) => ({ id: check.id, version: check.version })),
  };
  return sha256(JSON.stringify(manifest));
}

// ---------------------------------------------------------------------------
// Fixture plumbing
// ---------------------------------------------------------------------------

function makeWorkspace(workspaceRoot: string, id: string): string {
  const dir = path.join(workspaceRoot, `${id}-${randomUUID().slice(0, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Fixture extension dir: an ESM marker plus the given files. The loader only
 * picks up `.js|.mjs|.cjs`, so the marker never becomes a candidate.
 */
function writeEsmExtensionDir(dir: string, files: Readonly<Record<string, string>>): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(path.join(dir, name), content, 'utf8');
  }
}

/** Extension tools ignore the context, but the seam still requires the shape. */
function toolContext(cwd: string): ToolContext {
  return {
    signal: new AbortController().signal,
    cwd,
    audit: () => undefined,
    sessionId: 't147-eval',
  } as unknown as ToolContext;
}

function errorText(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

/**
 * Wrap a check body: dedicated temp workspace, measured wall time, and NO
 * escape hatch for exceptions — a throwing check is an honest `fail` with the
 * thrown text as detail, never a crash that would abort the whole suite.
 */
function defineCheck(
  id: string,
  version: number,
  description: string,
  body: (workspaceDir: string) => Promise<{ ok: boolean; detail: string }>,
): ExtensionCapabilityCheck {
  return {
    id,
    version,
    description,
    async run(workspaceRoot: string): Promise<CapabilityCheckResult> {
      const workspaceDir = makeWorkspace(workspaceRoot, id);
      const startedAt = Date.now();
      try {
        const outcome = await body(workspaceDir);
        return { ...outcome, wallMs: Date.now() - startedAt };
      } catch (err) {
        return { ok: false, detail: `threw ${errorText(err)}`, wallMs: Date.now() - startedAt };
      } finally {
        rmSync(workspaceDir, { recursive: true, force: true });
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Checks (a)-(e)
// ---------------------------------------------------------------------------

/** (a) the real loader loads a real single-file extension and its tool runs. */
const echoToolLoad = defineCheck(
  'ext-echo-tool-load',
  1,
  'loadExtensionsFromDirs loads examples/extensions/echo-tool and echo_tool echoes its input',
  async (workspaceDir) => {
    const source = readFileSync(ECHO_TOOL_EXAMPLE, 'utf8');
    const extDir = path.join(workspaceDir, 'extensions');
    writeEsmExtensionDir(extDir, { 'extension.js': source });

    const loaded = await loadExtensionsFromDirs([{ path: extDir, scope: 'global' }], {
      mode: 'permissive',
      fsRoot: workspaceDir,
      logger: () => undefined,
    });
    if (!loaded.ok) return { ok: false, detail: `loader refused the fixture: ${loaded.error.message}` };

    const entry = loaded.runtime.registry.listExtensionTools().find((t) => t.spec.name === 'echo_tool');
    if (!entry) {
      const ids = loaded.runtime.loaded.map((e) => e.id).join(', ') || 'none';
      return { ok: false, detail: `echo_tool not registered (loaded: ${ids}; skipped: ${loaded.runtime.skipped.join(' | ')})` };
    }

    const result = await extensionToolToDefinition(entry).execute({ message: 't147-echo' }, toolContext(workspaceDir));
    if (!result.ok) return { ok: false, detail: `echo_tool execute failed: ${result.error}` };
    const echoed = (result.value as { echoed?: unknown }).echoed;
    if (echoed !== 't147-echo') return { ok: false, detail: `echoed ${JSON.stringify(echoed)} != 't147-echo'` };

    return {
      ok: true,
      detail: `loaded ${loaded.runtime.loaded.length} extension via the real loader (fixture sha256 ${sha256(source).slice(0, 12)}…); echo_tool echoed 't147-echo'`,
    };
  },
);

const DENY_EXTENSION_SOURCE = `import { writeFileSync } from 'node:fs';
export default {
  id: 't147-deny-hook',
  async register(host) {
    host.registerTool({
      name: 't147_probe',
      description: 'fixture tool that must never run once the onPreToolUse handler denies',
      inputSchema: { safeParse: (v) => ({ success: true, data: v }) },
      permissions: ['read'],
      execute: async () => {
        writeFileSync(new URL('./RAN.txt', import.meta.url), 'the tool body ran', 'utf8');
        return { ok: true, value: 'ran' };
      },
    });
    host.onPreToolUse('*', () => ({ deny: true, reason: 't147: no probe allowed' }));
  },
};
`;

/** (b) an extension onPreToolUse deny blocks the call BEFORE the tool body. */
const onPreToolUseDeny = defineCheck(
  'ext-onpre-deny',
  1,
  'an extension onPreToolUse deny is a typed error and the tool body never runs',
  async (workspaceDir) => {
    const extDir = path.join(workspaceDir, 'extensions');
    writeEsmExtensionDir(extDir, { 'deny-hook.js': DENY_EXTENSION_SOURCE });

    const loaded = await loadExtensionsFromDirs([{ path: extDir, scope: 'global' }], {
      mode: 'permissive',
      fsRoot: workspaceDir,
      logger: () => undefined,
    });
    if (!loaded.ok) return { ok: false, detail: `loader refused the fixture: ${loaded.error.message}` };

    const entry = loaded.runtime.registry.listExtensionTools().find((t) => t.spec.name === 't147_probe');
    if (!entry) return { ok: false, detail: 't147_probe not registered by the fixture extension' };
    if (loaded.runtime.registry.preToolUseHandlers.length !== 1) {
      return { ok: false, detail: `expected 1 onPreToolUse handler, got ${loaded.runtime.registry.preToolUseHandlers.length}` };
    }

    const wrapped = withExtensionPreToolUse(loaded.runtime.registry.preToolUseHandlers, {
      failureMode: 'fail-closed',
      logger: () => undefined,
    })(extensionToolToDefinition(entry));
    const result = await wrapped.execute({}, toolContext(workspaceDir));
    if (result.ok) return { ok: false, detail: 'the denied call was ALLOWED (deny wiring not applied)' };
    if (!result.error.includes('[extension-hook:t147-deny-hook]')) {
      return { ok: false, detail: `denied with an unexpected error: ${result.error}` };
    }
    if (!result.error.includes('no probe allowed')) {
      return { ok: false, detail: `hook reason missing from the typed error: ${result.error}` };
    }
    if (existsSync(path.join(extDir, 'RAN.txt'))) {
      return { ok: false, detail: 'the tool body RAN despite the deny (deny came too late)' };
    }
    return { ok: true, detail: `typed deny observed (${result.error}) and the tool body never ran` };
  },
);

const OBSERVER_HOOK_SOURCE = `import { appendFileSync } from 'node:fs';
let payload = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { payload += chunk; });
process.stdin.on('end', () => { appendFileSync(process.argv[2], payload.trim() + '\\n', 'utf8'); });
`;

/** (c) a JSON hook in a dir fires on the real PermissionRequest observer seam. */
const lifecycleObserver = defineCheck(
  'ext-lifecycle-observer',
  1,
  'createLifecycleHooksFromDirs loads a hook JSON and PermissionRequest reaches the hook process',
  async (workspaceDir) => {
    const hooksDir = path.join(workspaceDir, 'hooks');
    mkdirSync(hooksDir, { recursive: true });
    const observerPath = path.join(hooksDir, 'observer.mjs');
    writeFileSync(observerPath, OBSERVER_HOOK_SOURCE, 'utf8');
    const observedPath = path.join(workspaceDir, 'observed.jsonl');
    writeFileSync(
      path.join(hooksDir, 'permission-observer.json'),
      JSON.stringify({
        name: 't147-permission-observer',
        match: { tools: ['*'], events: ['PermissionRequest'] },
        command: `node "${observerPath}" "${observedPath}"`,
        timeoutMs: 10_000,
      }),
      'utf8',
    );

    // The runner is process-cached by hook-dir fingerprint; start clean.
    resetLifecycleHookCache();
    const runner = createLifecycleHooksFromDirs([hooksDir]);
    if (runner.listHooks().length !== 1) {
      return { ok: false, detail: `expected 1 hook in the runner, got ${runner.listHooks().length}` };
    }

    await runner.runPermissionRequest(
      { tool: 'write_file', categories: ['write'], effect: 'ask', matchedRuleId: 't147-rule' },
      { sessionId: 't147-eval', cwd: workspaceDir },
    );

    if (!existsSync(observedPath)) return { ok: false, detail: 'the hook process produced no payload chunk' };
    const received = readFileSync(observedPath, 'utf8')
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as { event?: string; sessionId?: string; permission?: { tool?: string } });
    if (received.length !== 1) return { ok: false, detail: `expected 1 observed payload, got ${received.length}` };
    const [payload] = received;
    if (payload?.event !== 'PermissionRequest') return { ok: false, detail: `event ${String(payload?.event)} != PermissionRequest` };
    if (payload?.permission?.tool !== 'write_file') {
      return { ok: false, detail: `permission.tool ${String(payload?.permission?.tool)} != write_file` };
    }
    if (payload?.sessionId !== 't147-eval') return { ok: false, detail: `sessionId ${String(payload?.sessionId)} != t147-eval` };
    return { ok: true, detail: 'hook process received {event: PermissionRequest, permission.tool: write_file, sessionId: t147-eval}' };
  },
);

/** (d) the shipped plugin bundle validates, contributes, and fails closed. */
const pluginBundleContract = defineCheck(
  'plugin-bundle-contract',
  1,
  'loadBundle validates examples/extensions/zelari-plugin-example and a malformed manifest contributes nothing',
  async (workspaceDir) => {
    const enabled = await loadBundle(PLUGIN_BUNDLE_EXAMPLE, { enabled: true });
    if (!enabled.ok) {
      return { ok: false, detail: `shipped example bundle failed to load: ${enabled.errors.join(' | ')}` };
    }
    const contributions = enabled.contributions;
    if (!contributions) return { ok: false, detail: 'ok:true without contributions' };
    if (contributions.skills.length !== 1 || contributions.skills[0]?.id !== 'repo-hygiene') {
      return { ok: false, detail: `unexpected skills: ${JSON.stringify(contributions.skills.map((s) => s.id))}` };
    }
    if (contributions.hooks.length !== 1 || contributions.hooks[0]?.observer !== true) {
      return { ok: false, detail: 'expected the one declared observer hook (PermissionRequest)' };
    }
    if (contributions.mcp.length !== 1 || contributions.mcp[0]?.name !== 'echo-example') {
      return { ok: false, detail: `unexpected mcp contributions: ${JSON.stringify(contributions.mcp.map((m) => m.name))}` };
    }

    const disabled = await loadBundle(PLUGIN_BUNDLE_EXAMPLE, { enabled: false });
    if (!disabled.ok || disabled.contributions?.skills.length !== 0 || disabled.contributions?.hooks.length !== 0) {
      return { ok: false, detail: 'a DISABLED bundle must contribute nothing (fail-closed)' };
    }

    // Malformed manifest (one unknown key — the schema is strict): refused,
    // with the file named, and NO partial contributions.
    const brokenDir = path.join(workspaceDir, 'broken-bundle');
    cpSync(PLUGIN_BUNDLE_EXAMPLE, brokenDir, { recursive: true });
    const manifestPath = path.join(brokenDir, 'zelari-plugin.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, notAThing: true }), 'utf8');
    const broken = await loadBundle(brokenDir, { enabled: true });
    if (broken.ok || broken.contributions !== undefined) {
      return { ok: false, detail: 'a malformed manifest was accepted (strict schema not enforced)' };
    }
    if (!broken.errors.some((e) => e.includes('zelari-plugin.json'))) {
      return { ok: false, detail: `malformed-bundle errors do not name the manifest: ${broken.errors.join(' | ')}` };
    }

    return {
      ok: true,
      detail: `example bundle: 1 skill + 1 observer hook + 1 mcp enabled, 0 while disabled; malformed manifest refused (${broken.errors.length} error(s))`,
    };
  },
);

/** (e) the loader is fail-closed: a bad module is skipped, a bad lock aborts typed. */
const loaderFailClosed = defineCheck(
  'ext-loader-fail-closed',
  1,
  'a crashing extension is skipped without aborting the load, and a lock mismatch is a typed strict abort',
  async (workspaceDir) => {
    // 1. A module that throws at import time must not take down the batch.
    const crashingDir = path.join(workspaceDir, 'crashing');
    writeEsmExtensionDir(crashingDir, { 'crashing.js': "throw new Error('t147: fixture explodes at import time');\n" });
    const crashing = await loadExtensionsFromDirs([{ path: crashingDir, scope: 'global' }], {
      mode: 'permissive',
      fsRoot: workspaceDir,
      logger: () => undefined,
    });
    if (!crashing.ok) return { ok: false, detail: 'a crashing extension module aborted the whole load' };
    if (crashing.runtime.loaded.length !== 0) return { ok: false, detail: 'a crashing module was reported as loaded' };
    if (!crashing.runtime.skipped.some((s) => s.includes('import failed'))) {
      return { ok: false, detail: `crashing module not reported in skipped: ${JSON.stringify(crashing.runtime.skipped)}` };
    }

    // 2. Strict + extensions.lock mismatch ⇒ typed error, nothing imported.
    const lockedDir = path.join(workspaceDir, 'locked');
    writeEsmExtensionDir(lockedDir, { 'main.js': "export default { id: 't147-locked', async register() {} };\n" });
    writeFileSync(
      path.join(lockedDir, EXTENSIONS_LOCK_FILE),
      JSON.stringify({ 'main.js': 'not-the-real-sha256' }),
      'utf8',
    );
    const locked = await loadExtensionsFromDirs([{ path: lockedDir, scope: 'global' }], {
      mode: 'strict',
      fsRoot: workspaceDir,
      logger: () => undefined,
    });
    if (locked.ok) return { ok: false, detail: 'a strict lock mismatch was ACCEPTED' };
    if (!(locked.error instanceof ExtensionLockError) || locked.error.name !== 'ExtensionLockError') {
      return { ok: false, detail: `lock mismatch is not the typed ExtensionLockError (${errorText(locked.error)})` };
    }
    if (!locked.error.mismatches.some((m) => m.includes('sha256 mismatch'))) {
      return { ok: false, detail: `mismatch detail missing: ${JSON.stringify(locked.error.mismatches)}` };
    }

    return {
      ok: true,
      detail: `crashing module skipped (${crashing.runtime.skipped[0]}); strict lock mismatch → ExtensionLockError "${locked.error.mismatches[0]}"`,
    };
  },
);

/** The suite, in stable order (the manifest hash depends on this order). */
export const EXTENSION_SUITE: readonly ExtensionCapabilityCheck[] = [
  echoToolLoad,
  onPreToolUseDeny,
  lifecycleObserver,
  pluginBundleContract,
  loaderFailClosed,
];
