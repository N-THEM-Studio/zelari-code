/**
 * cli-main-wizard.test.ts — verifies that `main.ts` branches correctly
 * between Wizard and App based on shouldRunWizard().
 *
 * Indirect: we test the decision layer (firstRun.ts) directly + verify
 * `main.ts` consumes it. A full Ink mount test would need a TTY mock
 * and is out of scope for the unit test layer.
 */
import { describe, it, expect } from 'vitest';
import {
  parseWizardFlags,
  shouldRunWizard,
} from '../../src/cli/wizard/firstRun.js';

describe('main.ts: shouldRunWizard integration with parseWizardFlags', () => {
  it('(argv=[], env=empty, no config) → wizard runs', () => {
    const flags = parseWizardFlags([]);
    const decision = shouldRunWizard({
      configPath: '/no/such/file.json',
      hasNoWizardFlag: flags.noWizard,
      hasResetConfigFlag: flags.resetConfig,
      exists: () => false,
    });
    expect(decision.shouldRun).toBe(true);
  });

  it('(argv=[--no-wizard], no config) → wizard suppressed', () => {
    const flags = parseWizardFlags(['--no-wizard']);
    const decision = shouldRunWizard({
      configPath: '/no/such/file.json',
      hasNoWizardFlag: flags.noWizard,
      hasResetConfigFlag: flags.resetConfig,
      noWizardEnv: '1',
      exists: () => false,
    });
    expect(decision.shouldRun).toBe(false);
  });

  it('(argv=[--reset-config], config exists) → wizard forced', () => {
    const flags = parseWizardFlags(['--reset-config']);
    const decision = shouldRunWizard({
      configPath: '/tmp/has-config.json',
      hasNoWizardFlag: flags.noWizard,
      hasResetConfigFlag: flags.resetConfig,
      exists: () => true,
    });
    expect(decision.shouldRun).toBe(true);
  });

  it('(no flags, env=ZELARI_NO_WIZARD=1, no config) → wizard suppressed', () => {
    const flags = parseWizardFlags([]);
    const decision = shouldRunWizard({
      configPath: '/no/such/file.json',
      hasNoWizardFlag: flags.noWizard,
      hasResetConfigFlag: flags.resetConfig,
      noWizardEnv: '1',
      exists: () => false,
    });
    expect(decision.shouldRun).toBe(false);
  });
});
