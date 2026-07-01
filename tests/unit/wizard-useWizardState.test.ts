/**
 * wizard-useWizardState.test.ts — pure state machine tests.
 *
 * No React, no Ink, no fs. Each test creates an isolated state machine
 * with stubbed persist callbacks to verify transitions.
 */
import { describe, it, expect, vi } from 'vitest';
import { createWizardState } from '../../src/cli/wizard/useWizardState.js';
import type { ProviderSpec } from '../../src/cli/keyStore.js';

const FAKE_PROVIDERS: readonly ProviderSpec[] = [
  { id: 'grok', displayName: 'xAI Grok', envVar: 'GROK_API_KEY' },
  { id: 'minimax', displayName: 'MiniMax', envVar: 'MINIMAX_API_KEY' },
  { id: 'glm', displayName: 'GLM', envVar: 'GLM_API_KEY' },
];

function makeState(persistActive = vi.fn(), persistModel = vi.fn()) {
  return createWizardState({
    providers: FAKE_PROVIDERS,
    defaultModelFor: (id) => `default-${id}`,
    persistActiveProvider: persistActive,
    persistModel,
  });
}

describe('wizard state machine', () => {
  it('starts on the welcome step', () => {
    const w = makeState();
    expect(w.state.step).toBe('welcome');
    expect(w.state.providerId).toBeUndefined();
    expect(w.state.model).toBeUndefined();
    expect(w.state.committed).toBe(false);
  });

  it('jumpToProvider advances from welcome to provider', () => {
    const w = makeState();
    (w as unknown as { jumpToProvider(): void }).jumpToProvider();
    expect(w.state.step).toBe('provider');
    expect(w.state.providerCursor).toBe(0);
  });

  it('moveProvider wraps around (down)', () => {
    const w = makeState();
    (w as unknown as { jumpToProvider(): void }).jumpToProvider();
    w.moveProvider(false); // 0 -> 1
    w.moveProvider(false); // 1 -> 2
    w.moveProvider(false); // 2 -> 0 (wrap)
    expect(w.state.providerCursor).toBe(0);
  });

  it('moveProvider wraps around (up)', () => {
    const w = makeState();
    (w as unknown as { jumpToProvider(): void }).jumpToProvider();
    w.moveProvider(true); // 0 -> 2 (wrap backward)
    expect(w.state.providerCursor).toBe(2);
  });

  it('selectProvider advances to model and records the choice', () => {
    const w = makeState();
    (w as unknown as { jumpToProvider(): void }).jumpToProvider();
    w.moveProvider(false); // 0 -> 1 (minimax)
    w.selectProvider();
    expect(w.state.step).toBe('model');
    expect(w.state.providerId).toBe('minimax');
    expect(w.state.model).toBe('default-minimax');
  });

  it('setModel overrides the default model', () => {
    const w = makeState();
    (w as unknown as { jumpToProvider(): void }).jumpToProvider();
    w.selectProvider(); // grok + default-grok
    w.setModel('grok-3-custom');
    expect(w.state.model).toBe('grok-3-custom');
  });

  it('setModel ignores empty strings', () => {
    const w = makeState();
    (w as unknown as { jumpToProvider(): void }).jumpToProvider();
    w.selectProvider();
    w.setModel('   ');
    expect(w.state.model).toBe('default-grok');
  });

  it('selectApiKey(env) records the choice and advances to confirm', () => {
    const w = makeState();
    (w as unknown as { jumpToProvider(): void }).jumpToProvider();
    w.selectProvider();
    (w as unknown as { advanceToApikey(): void }).advanceToApikey();
    expect(w.state.step).toBe('apikey');
    w.selectApiKey('env');
    expect(w.state.step).toBe('confirm');
    expect(w.state.apiKeyChoice).toBe('env');
    expect(w.state.apiKeyValue).toBeUndefined();
  });

  it('selectApiKey(keystore, value) stores the value', () => {
    const w = makeState();
    (w as unknown as { jumpToProvider(): void }).jumpToProvider();
    w.selectProvider();
    (w as unknown as { advanceToApikey(): void }).advanceToApikey();
    w.selectApiKey('keystore', 'sk-fakekey');
    expect(w.state.apiKeyChoice).toBe('keystore');
    expect(w.state.apiKeyValue).toBe('sk-fakekey');
  });

  it('back() returns to the previous step', () => {
    const w = makeState();
    (w as unknown as { jumpToProvider(): void }).jumpToProvider();
    w.selectProvider();
    expect(w.state.step).toBe('model');
    w.back();
    expect(w.state.step).toBe('provider');
    w.back();
    expect(w.state.step).toBe('welcome');
    w.back(); // already at start — no-op
    expect(w.state.step).toBe('welcome');
  });

  it('commit() persists provider + model and sets committed=true', () => {
    const persistActive = vi.fn();
    const persistModel = vi.fn();
    const w = makeState(persistActive, persistModel);
    (w as unknown as { jumpToProvider(): void }).jumpToProvider();
    w.selectProvider();
    w.setModel('grok-3');
    (w as unknown as { advanceToApikey(): void }).advanceToApikey();
    w.selectApiKey('env');
    w.commit();

    expect(w.state.committed).toBe(true);
    expect(persistActive).toHaveBeenCalledWith('grok');
    expect(persistModel).toHaveBeenCalledWith('grok', 'grok-3');
  });

  it('commit() is idempotent (second call no-ops)', () => {
    const persistActive = vi.fn();
    const persistModel = vi.fn();
    const w = makeState(persistActive, persistModel);
    (w as unknown as { jumpToProvider(): void }).jumpToProvider();
    w.selectProvider();
    (w as unknown as { advanceToApikey(): void }).advanceToApikey();
    w.selectApiKey('env');
    w.commit();
    w.commit(); // no-op
    expect(persistActive).toHaveBeenCalledTimes(1);
    expect(persistModel).toHaveBeenCalledTimes(1);
  });

  it('commit() refuses without provider + model', () => {
    const persistActive = vi.fn();
    const persistModel = vi.fn();
    const w = makeState(persistActive, persistModel);
    w.commit(); // no-op: state.committed stays false
    expect(w.state.committed).toBe(false);
    expect(persistActive).not.toHaveBeenCalled();
    expect(persistModel).not.toHaveBeenCalled();
  });
});
