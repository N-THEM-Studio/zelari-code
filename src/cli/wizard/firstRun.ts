/**
 * firstRun — detection logic for the onboarding wizard.
 *
 * Decides whether `zelari-code` should launch the wizard instead of
 * the regular TUI. The decision is a pure function of:
 *   - CLI flags (--no-wizard, --reset-config)
 *   - Environment variables (ZELARI_NO_WIZARD)
 *   - Presence of the provider config file on disk
 *
 * All three inputs are injected so tests don't touch real fs/env.
 *
 * @public
 * @since 0.5.0
 */
import { existsSync } from 'node:fs';

export interface FirstRunInput {
  /** Path to the provider.json config file. */
  configPath: string;
  /** True if --reset-config was passed on argv. */
  hasResetConfigFlag?: boolean;
  /** True if --no-wizard was passed on argv. */
  hasNoWizardFlag?: boolean;
  /** Truthy if ZELARI_NO_WIZARD env var is set to a non-empty value. */
  noWizardEnv?: string | undefined;
  /** Override existsSync — defaults to the real one. Inject for tests. */
  exists?: (path: string) => boolean;
}

export interface FirstRunDecision {
  /**
   * `true` → render the wizard before App.
   * `false` → skip wizard, render App directly.
   */
  shouldRun: boolean;
  /** Human-readable reason — surfaced in debug logs. */
  reason: string;
}

/**
 * Decide whether the wizard should run on startup.
 *
 * Order of precedence (highest first):
 *   1. `--reset-config` → always run wizard (force re-onboarding).
 *   2. `--no-wizard` or `ZELARI_NO_WIZARD` → never run wizard.
 *   3. Config file missing on disk → run wizard (first-run case).
 *   4. Otherwise → skip wizard.
 *
 * @public
 */
export function shouldRunWizard(input: FirstRunInput): FirstRunDecision {
  const exists = input.exists ?? existsSync;

  if (input.hasResetConfigFlag) {
    return { shouldRun: true, reason: '--reset-config flag forced wizard' };
  }

  if (input.hasNoWizardFlag) {
    return { shouldRun: false, reason: '--no-wizard flag suppressed wizard' };
  }

  if (input.noWizardEnv && input.noWizardEnv.trim().length > 0) {
    return {
      shouldRun: false,
      reason: `ZELARI_NO_WIZARD=${input.noWizardEnv} suppressed wizard`,
    };
  }

  if (!exists(input.configPath)) {
    return {
      shouldRun: true,
      reason: `provider config not found at ${input.configPath} (first run)`,
    };
  }

  return {
    shouldRun: false,
    reason: `provider config exists at ${input.configPath}; wizard skipped`,
  };
}

/**
 * Parse argv for wizard-related flags. Lightweight — only catches the
 * exact tokens `--no-wizard` and `--reset-config`; doesn't try to be
 * a full arg parser.
 *
 * @public
 */
export interface WizardFlags {
  noWizard: boolean;
  resetConfig: boolean;
}

export function parseWizardFlags(argv: readonly string[]): WizardFlags {
  let noWizard = false;
  let resetConfig = false;
  for (const arg of argv) {
    if (arg === '--no-wizard') noWizard = true;
    else if (arg === '--reset-config') resetConfig = true;
  }
  return { noWizard, resetConfig };
}
