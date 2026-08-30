/**
 * jails/win32 — restricted-token backend for osJail (HARNESS-10 t28).
 *
 * HONEST UNAVAILABLE: a REAL Windows jail needs
 *   1. CreateRestrictedToken() / CreateLowBoxToken() — strip SIDs, cap the
 *      integrity level to Low (S-1-16-4096) so the child cannot write
 *      outside writeable-by-Low locations,
 *   2. a Job Object with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE so the whole
 *      process tree dies with the tool call,
 *   3. ACL drops on the spawned process handle.
 * NONE of these are reachable from pure Node: libuv exposes no token APIs
 * and this repo bans native npm modules (P5). Faking it (e.g. env tricks or
 * "we asked nicely") would be jail-by-prompt — the exact thing t28 forbids.
 *
 * Therefore this backend ALWAYS probes `available:false`. Consequences after
 * the honest jail default (commit 7d70bf5 — resolveJailMode): `required` is
 * resolved on strict surfaces ONLY WHEN the platform backend actually probes
 * available. On Windows it never does, so the effective default here is a
 * VISIBLE ADVISORY — tools run unjailed with a loud signal (console + audit
 * + result warning), never a silent skip and never a fake deny:
 *   - ZELARI_OS_JAIL=required (EXPLICIT only) ⇒ exec tools are DENIED with
 *     a typed `[jail]` error — enforcement presupposes a backend that
 *     exists; the explicit operator opt-in still fails closed here.
 *   - ZELARI_OS_JAIL unset/strict (default resolution) on Windows ⇒ the
 *     visible advisory above, NOT a deny (the old "required ⇒ DENIED
 *     default" claim was pre-7d70bf5).
 * The typedErr surface lives in safety/osJail.decideJailSpawn — this module
 * only owns the honest probe. When a native path lands, probe() flips to a
 * real capability check and wrap() assembles [CreateProcess w/ token] — the
 * JailSpec already carries everything such an implementation needs.
 */
import type { JailBackend, JailProbeResult } from '../osJail.js';

export const WIN32_UNAVAILABLE_REASON =
  'restricted-token + Job Object require native Windows APIs that pure Node does not expose ' +
  '(no native npm deps allowed, P5) — honest unavailable; see src/cli/safety/jails/win32.ts';

/** Pure probe decision — always unavailable TODAY, honestly. */
export function win32Probe(platform: string): JailProbeResult {
  if (platform !== 'win32') {
    return { backend: 'win32-restricted-token', available: false, reason: `platform ${platform} is not win32` };
  }
  return { backend: 'win32-restricted-token', available: false, reason: WIN32_UNAVAILABLE_REASON };
}

export const win32Backend: JailBackend = {
  id: 'win32-restricted-token',
  probe: () => win32Probe(process.platform),
  wrap: () => {
    // Unreachable via the decision path (probe gates wrap) — kept as a hard
    // guard so a future caller cannot accidentally skip the honest probe.
    throw new Error(`win32 jail backend unavailable: ${WIN32_UNAVAILABLE_REASON}`);
  },
};
