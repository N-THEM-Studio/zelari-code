/**
 * When the CLI process is the NDJSON harness server rather than the TUI.
 *
 * `--serve-harness` is the public flag. Desktop 2.16.0 spawned the sidecar
 * with piped stdio and no argv, so Ink's PluginGate frame
 * ("Checking for optional tool plugins…") became the handshake line.
 * The empty-argv + sidecar env fingerprint recovers those clients until
 * they pick up a Desktop build that passes the flag.
 */

export interface HarnessModeProbe {
  argv: readonly string[];
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  stdinIsTTY?: boolean;
  stdoutIsTTY?: boolean;
}

function isPiped(probe: HarnessModeProbe): boolean {
  return probe.stdinIsTTY !== true && probe.stdoutIsTTY !== true;
}

function envOn(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  key: string,
): boolean {
  const v = env[key];
  return v === '1' || v === 'true';
}

export function shouldStartHarnessServer(probe: HarnessModeProbe): boolean {
  if (probe.argv.includes('--serve-harness')) return true;
  if (probe.argv.length > 0) return false;
  if (!isPiped(probe)) return false;
  const env = probe.env ?? {};
  if (envOn(env, 'ZELARI_SERVE_HARNESS')) return true;
  // 2.16.0 Desktop sidecar: spawn_cli_base (ANATHEMA_DEV + skip preflight)
  // plus sidecar-only ZELARI_MEMORY_V2, and zero CLI args.
  return (
    envOn(env, 'ANATHEMA_DEV') &&
    envOn(env, 'ZELARI_SKIP_PREFLIGHT') &&
    envOn(env, 'ZELARI_MEMORY_V2')
  );
}
