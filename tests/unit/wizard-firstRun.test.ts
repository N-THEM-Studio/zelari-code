/**
 * wizard-firstRun.test.ts — pure-logic tests for shouldRunWizard + parseWizardFlags.
 *
 * No fs, no env, no React. Tests run in <50ms.
 */
import { describe, it, expect } from 'vitest';
import {
  parseWizardFlags,
  shouldRunWizard,
} from '../../src/cli/wizard/firstRun.js';

describe('parseWizardFlags', () => {
  it('returns all false for empty argv', () => {
    expect(parseWizardFlags([])).toEqual({ noWizard: false, resetConfig: false });
  });

  it('detects --no-wizard', () => {
    expect(parseWizardFlags(['--no-wizard']).noWizard).toBe(true);
    expect(parseWizardFlags(['--no-wizard']).resetConfig).toBe(false);
  });

  it('detects --reset-config', () => {
    expect(parseWizardFlags(['--reset-config']).resetConfig).toBe(true);
    expect(parseWizardFlags(['--reset-config']).noWizard).toBe(false);
  });

  it('handles both flags independently', () => {
    expect(parseWizardFlags(['--no-wizard', '--reset-config'])).toEqual({
      noWizard: true,
      resetConfig: true,
    });
  });

  it('ignores unrelated flags', () => {
    expect(parseWizardFlags(['--version', 'something', '-x']).noWizard).toBe(false);
    expect(parseWizardFlags(['--version', 'something', '-x']).resetConfig).toBe(false);
  });
});

describe('shouldRunWizard', () => {
  it('runs wizard when config file is missing (first run)', () => {
    const decision = shouldRunWizard({
      configPath: '/nonexistent/never/there.json',
      exists: () => false,
    });
    expect(decision.shouldRun).toBe(true);
    expect(decision.reason).toMatch(/not found/);
  });

  it('skips wizard when config file exists', () => {
    const decision = shouldRunWizard({
      configPath: '/tmp/fake.json',
      exists: () => true,
    });
    expect(decision.shouldRun).toBe(false);
    expect(decision.reason).toMatch(/wizard skipped/);
  });

  it('respects --no-wizard flag (highest priority over file presence)', () => {
    const decision = shouldRunWizard({
      configPath: '/tmp/fake.json',
      exists: () => true,
      hasNoWizardFlag: true,
    });
    expect(decision.shouldRun).toBe(false);
    expect(decision.reason).toMatch(/--no-wizard/);
  });

  it('respects ZELARI_NO_WIZARD env var (non-empty)', () => {
    const decision = shouldRunWizard({
      configPath: '/nonexistent.json',
      exists: () => false,
      noWizardEnv: '1',
    });
    expect(decision.shouldRun).toBe(false);
    expect(decision.reason).toMatch(/ZELARI_NO_WIZARD/);
  });

  it('ignores empty ZELARI_NO_WIZARD', () => {
    const decision = shouldRunWizard({
      configPath: '/nonexistent.json',
      exists: () => false,
      noWizardEnv: '   ',
    });
    expect(decision.shouldRun).toBe(true);
  });

  it('forces wizard with --reset-config even when file exists', () => {
    const decision = shouldRunWizard({
      configPath: '/tmp/fake.json',
      exists: () => true,
      hasResetConfigFlag: true,
    });
    expect(decision.shouldRun).toBe(true);
    expect(decision.reason).toMatch(/--reset-config/);
  });

  it('priority: reset-config > no-wizard > env > file', () => {
    // All three opt-outs + reset-config: reset wins.
    const decision = shouldRunWizard({
      configPath: '/tmp/fake.json',
      exists: () => true,
      hasResetConfigFlag: true,
      hasNoWizardFlag: true,
      noWizardEnv: '1',
    });
    expect(decision.shouldRun).toBe(true);
  });

  it('priority: no-wizard > env > file', () => {
    // --no-wizard beats both env and file.
    const decision = shouldRunWizard({
      configPath: '/nonexistent.json',
      exists: () => false,
      hasNoWizardFlag: true,
      noWizardEnv: '1',
    });
    expect(decision.shouldRun).toBe(false);
  });

  it('priority: env > file', () => {
    // env beats missing file.
    const decision = shouldRunWizard({
      configPath: '/nonexistent.json',
      exists: () => false,
      noWizardEnv: 'yes',
    });
    expect(decision.shouldRun).toBe(false);
  });
});
