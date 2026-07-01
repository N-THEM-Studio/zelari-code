/**
 * wizard-postCommit.test.ts — verifies the post-commit state shape
 * that drives the live transition to <App>, plus audit-driven edge
 * cases (whitespace, undefined, fire-and-forget).
 *
 * We don't render <RunWizard> directly (would need TTY mock + Ink
 * bootstrapping); instead we exercise the wizard state machine the
 * same way RunWizard would, asserting that the state transitions
 * correctly into the "ready to mount App" state.
 */
import { describe, it, expect, vi } from 'vitest';
import { createWizardState } from '../../src/cli/wizard/useWizardState.js';
import type { ProviderSpec } from '../../src/cli/keyStore.js';

const FAKE_PROVIDERS: readonly ProviderSpec[] = [
  { id: 'grok', displayName: 'xAI Grok', envVar: 'GROK_API_KEY' },
];

describe('post-commit state (drives wizard -> App transition)', () => {
  it('state.committed flips to true after commit() runs successfully', () => {
    const w = createWizardState({
      providers: FAKE_PROVIDERS,
      defaultModelFor: () => 'grok-4',
    });
    expect(w.state.committed).toBe(false);

    (w as unknown as { jumpToProvider(): void }).jumpToProvider();
    w.selectProvider();
    (w as unknown as { advanceToApikey(): void }).advanceToApikey();
    w.selectApiKey('env');
    w.commit();

    expect(w.state.committed).toBe(true);
  });

  it('state.committed stays false when commit() is refused (no provider)', () => {
    const w = createWizardState({
      providers: FAKE_PROVIDERS,
      defaultModelFor: () => 'grok-4',
    });
    w.commit(); // refused: no providerId
    expect(w.state.committed).toBe(false);
  });

  it('state carries the persisted values needed by App on remount', () => {
    const persistActive = vi.fn();
    const persistModel = vi.fn();
    const w = createWizardState({
      providers: FAKE_PROVIDERS,
      defaultModelFor: () => 'grok-4',
      persistActiveProvider: persistActive,
      persistModel,
    });
    (w as unknown as { jumpToProvider(): void }).jumpToProvider();
    w.selectProvider();
    w.setModel('grok-3-fast');
    (w as unknown as { advanceToApikey(): void }).advanceToApikey();
    w.selectApiKey('env');
    w.commit();

    expect(w.state.providerId).toBe('grok');
    expect(w.state.model).toBe('grok-3-fast');
    expect(w.state.apiKeyChoice).toBe('env');
    expect(persistActive).toHaveBeenCalledWith('grok');
    expect(persistModel).toHaveBeenCalledWith('grok', 'grok-3-fast');
  });
});

describe('wizard post-commit edge cases (audit-driven)', () => {
  it('commit() with keystore + whitespace-only value does NOT persist (trimmed empty)', () => {
    const persistKey = vi.fn();
    const w = createWizardState({
      providers: FAKE_PROVIDERS,
      defaultModelFor: (id) => `default-${id}`,
      persistApiKey: persistKey,
    });
    (w as unknown as { jumpToProvider(): void }).jumpToProvider();
    w.selectProvider();
    (w as unknown as { advanceToApikey(): void }).advanceToApikey();
    w.selectApiKey('keystore', '   \t  ');
    w.commit();
    expect(persistKey).not.toHaveBeenCalled();
    expect(w.state.committed).toBe(true);
  });

  it('commit() with keystore + undefined value (defensive) does NOT persist', () => {
    const persistKey = vi.fn();
    const w = createWizardState({
      providers: FAKE_PROVIDERS,
      defaultModelFor: (id) => `default-${id}`,
      persistApiKey: persistKey,
    });
    (w as unknown as { jumpToProvider(): void }).jumpToProvider();
    w.selectProvider();
    (w as unknown as { advanceToApikey(): void }).advanceToApikey();
    w.selectApiKey('keystore'); // no value
    w.commit();
    expect(persistKey).not.toHaveBeenCalled();
    expect(w.state.committed).toBe(true);
  });

  it('selectApiKey(keystore, undefined) sets apiKeyValue to undefined', () => {
    const w = createWizardState({
      providers: FAKE_PROVIDERS,
      defaultModelFor: (id) => `default-${id}`,
    });
    (w as unknown as { jumpToProvider(): void }).jumpToProvider();
    w.selectProvider();
    (w as unknown as { advanceToApikey(): void }).advanceToApikey();
    w.selectApiKey('keystore');
    expect(w.state.apiKeyValue).toBeUndefined();
  });

  it('selectApiKey trims whitespace from keystore value', () => {
    const w = createWizardState({
      providers: FAKE_PROVIDERS,
      defaultModelFor: (id) => `default-${id}`,
    });
    (w as unknown as { jumpToProvider(): void }).jumpToProvider();
    w.selectProvider();
    (w as unknown as { advanceToApikey(): void }).advanceToApikey();
    w.selectApiKey('keystore', '  sk-abc123  ');
    expect(w.state.apiKeyValue).toBe('sk-abc123');
  });

  it('commit() is fire-and-forget safe: re-call after error does not double-persist', () => {
    const persistActive = vi.fn();
    const persistModel = vi.fn();
    let keyCalls = 0;
    const persistKey = vi.fn(() => {
      keyCalls++;
      if (keyCalls === 1) throw new Error('transient');
    });
    const w = createWizardState({
      providers: FAKE_PROVIDERS,
      defaultModelFor: (id) => `default-${id}`,
      persistActiveProvider: persistActive,
      persistModel,
      persistApiKey: persistKey,
    });
    (w as unknown as { jumpToProvider(): void }).jumpToProvider();
    w.selectProvider();
    (w as unknown as { advanceToApikey(): void }).advanceToApikey();
    w.selectApiKey('keystore', 'sk-x');
    w.commit();
    // After commit, committed=true → second commit() is no-op.
    w.commit();
    expect(persistKey).toHaveBeenCalledTimes(1);
    expect(persistActive).toHaveBeenCalledTimes(1);
    expect(persistModel).toHaveBeenCalledTimes(1);
  });
});
