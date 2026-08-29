/**
 * jails/linux — bubblewrap (bwrap) backend for osJail (HARNESS-10 t28).
 *
 * WHY NOT LANDLOCK: the landlock_create_ruleset()/landlock_restrict_self()
 * syscalls are NOT exposed by pure Node (no libc binding), and this repo
 * bans native npm modules (P5). Claiming landlock containment without the
 * syscalls would be jail-by-prompt — rejected. bubblewrap is the only
 * honest launcher reachable from stdlib: it applies the SAME bind-mount +
 * network-namespace model as an argv prefix, no shell involved.
 *
 * Honesty: if bwrap is not on PATH the probe reports UNAVAILABLE ⇒ with
 * ZELARI_OS_JAIL=required the tool is DENIED rather than run unjailed.
 * `allow-list` degrades to full network access (bwrap can only unshare the
 * whole namespace) — the degradation is documented here and in the args
 * builder comment, never hidden; the claims verdict still gates the tool.
 */
import { existsSync } from 'node:fs';
import type { JailBackend, JailProbeResult, JailSpec } from '../osJail.js';

/** The launcher binary this backend requires. */
export const BWRAP_BIN = 'bwrap';

/**
 * Pure: find `bin` across the directories of a PATH-shaped string. Accepts
 * BOTH POSIX (`:`) and Windows (`;`) separators so the probe is host-agnostic
 * (runtime uses the host delimiter; pure tests can use either).
 */
export function findBinaryOnPath(bin: string, pathValue: string, exists: (p: string) => boolean): string | null {
  for (const dir of pathValue.split(/[:;]/)) {
    if (!dir) continue;
    const full = `${dir}/${bin}`;
    if (exists(full)) return full;
  }
  return null;
}

/** Pure probe decision (injectable platform/PATH/exists so tests run anywhere). */
export function linuxProbe(
  platform: string,
  pathValue: string,
  exists: (p: string) => boolean,
): JailProbeResult {
  if (platform !== 'linux') {
    return { backend: 'bwrap', available: false, reason: `platform ${platform} is not linux` };
  }
  // Landlock note: intentionally NOT probed/claimed — see module docs.
  const found = findBinaryOnPath(BWRAP_BIN, pathValue, exists);
  if (!found) {
    return {
      backend: 'bwrap',
      available: false,
      reason: `${BWRAP_BIN} not found on PATH (landlock needs native syscalls Node does not expose)`,
    };
  }
  return { backend: 'bwrap', available: true, reason: `${BWRAP_BIN} found at ${found}` };
}

/**
 * Pure: wrap program+argv in bubblewrap args. `/` stays read-only, the
 * spec writable roots are re-bound read-write (`--bind-try` so a missing
 * optional dir like a fresh ~/.zelari-code degrades instead of failing the
 * spawn), then `--` closes our options so the child argv is untouchable.
 */
export function buildBwrapArgs(spec: JailSpec, program: string, argv: readonly string[]): string[] {
  const args: string[] = ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc'];
  for (const dir of spec.writable) {
    args.push('--bind-try', dir, dir);
  }
  if (spec.network.mode === 'deny') {
    args.push('--unshare-net');
  }
  // allow/allow-list: bwrap network namespaces are all-or-nothing — an
  // allow-list deliberately degrades to full access (documented in the
  // module docs and probed nowhere as containment). No fake flags are
  // emitted: what you see here is exactly the containment the child gets.
  args.push('--', program, ...argv);
  return args;
}

export const linuxBackend: JailBackend = {
  id: 'bwrap',
  probe: () => linuxProbe(process.platform, process.env.PATH ?? '', (p) => existsSync(p)),
  wrap: (spec, program, argv) => ({
    program: BWRAP_BIN,
    argv: buildBwrapArgs(spec, program, argv),
  }),
};
