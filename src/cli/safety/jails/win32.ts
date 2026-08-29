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
 * Therefore this backend ALWAYS probes `available:false`. Consequences, by
 * design and accepted by the HARNESS-10 plan (closure criterion 1):
 *   - ZELARI_OS_JAIL=required (headless/mission/CI default) ⇒ exec tools
 *     are DENIED on Windows with a typed `[jail]` error — "Se il backend OS
 *     manca, il tool è DENIED, non warned".
 *   - ZELARI_OS_JAIL=advisory (TUI default) ⇒ tools run unjailed with a
 *     VISIBLE signal (console + audit + result warning).
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
