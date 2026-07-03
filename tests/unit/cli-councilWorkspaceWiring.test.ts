/**
 * cli-councilWorkspaceWiring.test.ts — Regression test for Bug A
 * (v0.7.5): dispatchCouncil must register workspace stubs in the
 * global static (setWorkspaceStubs) so the dynamic-import path is
 * wired up.
 *
 * Why this test matters: dispatchCouncil creates a per-call
 * ToolRegistry and passes it to runCouncilPure — but never calls
 * setWorkspaceStubs from @zelari/core/skills. Without that call,
 * the global _workspaceStubs stays empty, and any code path that
 * relies on it (e.g. reading the registered stubs back to verify
 * the runtime rootDir) breaks silently.
 *
 * We test by spying on setWorkspaceStubs and confirming it gets
 * called with a non-empty array during dispatchCouncil.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tmpDir: string;
let originalCwd: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'council-wiring-'));
  originalCwd = process.cwd();
  process.chdir(tmpDir);
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('dispatchCouncil — workspace stub wiring (Bug A fix)', () => {
  it('calls setWorkspaceStubs so the global static reflects the workspace tools', async () => {
    // Spy on setWorkspaceStubs BEFORE dispatchCouncil runs. We capture
    // the stubs array it was called with.
    const skillsModule = await import('@zelari/core/skills');
    const setWorkspaceStubsSpy = vi.spyOn(skillsModule, 'setWorkspaceStubs');

    // Import dispatchCouncil AFTER the spy is wired so any call it
    // makes (including the dynamic import inside dispatchCouncil)
    // routes through the spied function.
    const { dispatchCouncil } = await import('../../src/cli/councilDispatcher.js');

    // Fake provider stream: emits a no-op assistant message and ends.
    // We don't need a real LLM here — the wiring happens BEFORE the
    // first LLM call, so draining the iterable is enough to trigger it.
    const fakeStream = async function* () {
      yield { type: 'message_start', messageId: 'm1', role: 'assistant' };
      yield { type: 'message_delta', delta: 'noop' };
      yield { type: 'message_end', totalLength: 4, finishReason: 'stop' };
      yield { type: 'agent_end' };
    };

    const opts = {
      apiKey: 'test-key',
      provider: 'openai-compatible',
      model: 'noop',
      councilSize: 1,
      debateMode: false,
      ragContext: '',
      workspaceContext: 'test',
      workspaceRoot: tmpDir,
      providerStream: fakeStream as never,
    };

    // Drain the async iterable to trigger the wiring code.
    for await (const _e of dispatchCouncil('test task', opts)) {
      /* drain */
    }

    // setWorkspaceStubs must have been called at least once with a
    // non-empty array. (runHeadless.ts:152 and useChatTurn.ts:586
    // already follow this pattern; we extend it to dispatchCouncil.)
    expect(setWorkspaceStubsSpy).toHaveBeenCalled();
    const lastCallArgs = setWorkspaceStubsSpy.mock.calls.at(-1)?.[0];
    expect(Array.isArray(lastCallArgs)).toBe(true);
    expect(lastCallArgs.length).toBeGreaterThan(0);

    // The registered stubs should include at least the 5 most-used
    // workspace tools (createPhase, createTask, addIdea,
    // createDocument, searchDocuments).
    const names = lastCallArgs.map((t: { name: string }) => t.name);
    expect(names).toContain('createPhase');
    expect(names).toContain('createTask');
    expect(names).toContain('addIdea');
    expect(names).toContain('createDocument');
    expect(names).toContain('searchDocuments');
  });

  it('does NOT call setWorkspaceStubs when disableWorkspaceTools is true', async () => {
    const skillsModule = await import('@zelari/core/skills');
    const setWorkspaceStubsSpy = vi.spyOn(skillsModule, 'setWorkspaceStubs');

    const { dispatchCouncil } = await import('../../src/cli/councilDispatcher.js');

    const fakeStream = async function* () {
      yield { type: 'message_start', messageId: 'm1', role: 'assistant' };
      yield { type: 'message_delta', delta: 'noop' };
      yield { type: 'message_end', totalLength: 4, finishReason: 'stop' };
      yield { type: 'agent_end' };
    };

    const opts = {
      apiKey: 'test-key',
      provider: 'openai-compatible',
      model: 'noop',
      councilSize: 1,
      debateMode: false,
      ragContext: '',
      workspaceContext: 'test',
      workspaceRoot: tmpDir,
      disableWorkspaceTools: true, // ← opt-out flag, only used by tests
      providerStream: fakeStream as never,
    };

    for await (const _e of dispatchCouncil('test task', opts)) {
      /* drain */
    }

    // When the test escape hatch is on, we must NOT register stubs.
    expect(setWorkspaceStubsSpy).not.toHaveBeenCalled();
  });
});