/**
 * cmdline — win32 command-line construction helpers (v0.7.9).
 *
 * Node 24 deprecated `spawn(cmd, argsArray, { shell: true })` (DEP0190):
 * the args were concatenated into the shell line UNESCAPED. Call sites that
 * still need a shell on Windows (.cmd shims like npm/npx/uvx cannot be
 * spawned directly) now build the command line themselves with explicit
 * quoting and pass a single string, which is not deprecated.
 */

/**
 * Quote a single argument for a cmd.exe command line: plain tokens pass
 * through, anything containing whitespace or cmd metacharacters is wrapped
 * in double quotes with embedded quotes doubled.
 */
export function quoteCmdArg(arg: string): string {
  if (arg === '') return '""';
  if (!/[\s"^&|<>()%!]/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '""')}"`;
}

/** Join command + args into a single cmd.exe-safe command line. */
export function buildCmdLine(command: string, args: readonly string[]): string {
  return [command, ...args].map(quoteCmdArg).join(' ');
}
