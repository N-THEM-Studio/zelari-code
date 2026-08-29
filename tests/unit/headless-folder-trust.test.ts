/**
 * headless-folder-trust.test.ts — HARNESS-10 §6.7 regression lock: a folder
 * is UNTRUSTED by default ⇒ project-scoped lifecycle hooks
 * (`.zelari/hooks/`) and project MCP (`.zelari/mcp.json`) are NOT loaded;
 * the explicit `--trust` flag (whose only code path is `trustFolder()` in
 * main.ts) — or its documented env equivalent — enables them.
 *
 * Tests the pure trust-resolution surface (`folderTrust` +
 * `describeHookSources` — the exact `isFolderTrusted()` call the hook
 * loader and mcpManager gate on) against a throwaway trust store, so the
 * test never touches the real `~/.zelari-code/trust.json`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  _setTrustStorePathForTests,
  isFolderTrusted,
  trustFolder,
  untrustFolder,
} from '../../src/cli/safety/folderTrust.js';
import { describeHookSources, projectHooksDir } from '../../src/cli/safety/lifecycleHooks.js';

let root = '';
let storeDir = '';

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'zelari-trust-proj-'));
  storeDir = mkdtempSync(path.join(tmpdir(), 'zelari-trust-store-'));
  _setTrustStorePathForTests(path.join(storeDir, 'trust.json'));
  delete process.env.ZELARI_FOLDER_TRUST;
});

afterEach(() => {
  _setTrustStorePathForTests(''); // falsy → back to the real store path
  delete process.env.ZELARI_FOLDER_TRUST;
  rmSync(root, { recursive: true, force: true });
  rmSync(storeDir, { recursive: true, force: true });
});

describe('headless folder trust defaults (HARNESS-10 §6.7)', () => {
  it('default: the folder is UNTRUSTED ⇒ project hooks/MCP sources inactive', () => {
    expect(isFolderTrusted(root)).toBe(false);
    const sources = describeHookSources(root);
    expect(sources.find((s) => s.scope === 'global')?.active).toBe(true); // user-global always
    expect(sources.find((s) => s.scope === 'project')?.active).toBe(false);
  });

  it('--trust (trustFolder) ⇒ project hooks source becomes active', () => {
    expect(isFolderTrusted(root)).toBe(false);
    trustFolder(root); // exactly what `zelari-code --trust` does (main.ts)
    expect(isFolderTrusted(root)).toBe(true);
    const sources = describeHookSources(root);
    expect(sources.find((s) => s.scope === 'project')?.active).toBe(true);
    expect(sources.find((s) => s.scope === 'project')?.path).toBe(projectHooksDir(root));
  });

  it('untrustFolder revokes ⇒ project sources inactive again', () => {
    trustFolder(root);
    expect(isFolderTrusted(root)).toBe(true);
    untrustFolder(root);
    expect(isFolderTrusted(root)).toBe(false);
    expect(describeHookSources(root).find((s) => s.scope === 'project')?.active).toBe(false);
  });

  it('ZELARI_FOLDER_TRUST=1 trusts every folder; =0 is a strict lockdown', () => {
    process.env.ZELARI_FOLDER_TRUST = '1';
    expect(isFolderTrusted(root)).toBe(true);
    expect(describeHookSources(root).find((s) => s.scope === 'project')?.active).toBe(true);

    process.env.ZELARI_FOLDER_TRUST = '0';
    trustFolder(root); // store trust cannot beat the lockdown
    expect(isFolderTrusted(root)).toBe(false);
    expect(describeHookSources(root).find((s) => s.scope === 'project')?.active).toBe(false);
  });
});
