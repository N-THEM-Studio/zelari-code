/**
 * launch — how the extension starts the CLI (`zelari-code acp`).
 *
 * PURE and injectable: no `vscode`, no `child_process`, no filesystem probe.
 * Everything about *what* to run lives here so it is unit-tested; the actual
 * spawning is childTransport.ts.
 *
 * Resolution order (settings are read in extension.ts):
 *   1. `zelari.cliPath` — absolute path to `<checkout>/bin/zelari-code.js`.
 *      Runs `zelari.nodePath <cliPath> <args>` with NO shell: the portable,
 *      Windows-safe form (no `.cmd` shim involved) and the recommended one.
 *   2. `zelari.command` — a command on PATH, args from `zelari.args`
 *      (default `zelari-code acp`). On Windows a bare `zelari-code` resolves
 *      to `zelari-code.cmd`, which Node refuses to spawn without a shell
 *      (CVE-2024-27980 hardening) — so a shell is used there, and the
 *      command/args are validated against shell metacharacters FIRST.
 *   3. An empty `zelari.command` means "use the default".
 *
 * The metacharacter rule is the reason this module exists: `shell: true` on
 * Windows would otherwise turn a settings string into a shell injection, and
 * a silent fallback would turn a typo into a mystery hang.
 */

/** Shell metacharacters that only matter when a shell is in the loop. */
const SHELL_UNSAFE = /[&|<>^"'`$(){}%!;\r\n\t]/;

export const DEFAULT_COMMAND = 'zelari-code';
export const DEFAULT_ARGS: readonly string[] = ['acp'];
export const DEFAULT_NODE = 'node';

export interface ZelariLaunchConfig {
  /** Command on PATH (used when `cliPath` is empty). */
  command: string;
  /** Arguments for `command` (default: `['acp']`). */
  args: readonly string[];
  /** Path to `<checkout>/bin/zelari-code.js`; when set it wins over `command`. */
  cliPath: string;
  /** Node runtime used for the `cliPath` form (default: `node`). */
  nodePath: string;
}

export type LaunchResolution =
  | {
      ok: true;
      source: 'cliPath' | 'command';
      program: string;
      args: string[];
      useShell: boolean;
    }
  | { ok: false; reason: string };

function firstUnsafeToken(values: readonly string[]): string | undefined {
  return values.find((value) => SHELL_UNSAFE.test(value));
}

/**
 * Resolve settings into a spawn spec. Never throws: an unusable configuration
 * comes back as `{ ok: false, reason }` so the extension can show WHY instead
 * of starting a broken process.
 */
export function resolveLaunchSpec(
  config: Partial<ZelariLaunchConfig>,
  platform: NodeJS.Platform,
): LaunchResolution {
  const args = [...(config.args ?? DEFAULT_ARGS)];
  const cliPath = (config.cliPath ?? '').trim();

  if (cliPath.length > 0) {
    // No shell in this form, so metacharacters are just characters: a checkout
    // path may legitimately contain spaces, parentheses, `&`, quotes, … and
    // must not be rejected for it.
    return {
      ok: true,
      source: 'cliPath',
      program: (config.nodePath ?? '').trim() || DEFAULT_NODE,
      args: [cliPath, ...args],
      useShell: false,
    };
  }

  const command = (config.command ?? '').trim() || DEFAULT_COMMAND;
  // A shell is needed only on Windows (the `.cmd` PATH shim). Elsewhere the
  // command is spawned directly, so metacharacters are just characters.
  const useShell = platform === 'win32';
  if (useShell) {
    const unsafe = firstUnsafeToken([command, ...args]);
    if (unsafe !== undefined) {
      return {
        ok: false,
        reason:
          `zelari.command / zelari.args contain the shell metacharacter ${JSON.stringify(unsafe)}; ` +
          'Windows needs a shell to start the `zelari-code` shim, so this would be interpreted by cmd.exe. ' +
          'Use zelari.cliPath (path to bin/zelari-code.js) or remove the character.',
      };
    }
  }
  return { ok: true, source: 'command', program: command, args, useShell };
}
