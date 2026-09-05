/**
 * Destructive-command classifier (v2.32 S5) — first-class ASK for commands
 * whose SHAPE is inherently destructive, even when execute=allow.
 *
 * Why: outside-write discipline made exec-side too. The sandbox (OS jail),
 * the workspace resolver and provenance cover WHERE and WITH WHAT content a
 * command runs; this module covers WHAT the command IS. `rm -rf`, `del /s`,
 * `format X:`, `git push --force` escalate allow → ask at the single
 * permission choke-point (toolRegistry.wrapWithPermissions), right after the
 * provenance escalation, before the jail/spawn path.
 *
 * Contract (reviewer directive 2.32, item 5):
 * - standard/strict: destructive shape ⇒ ask, even with execute=allow
 *   (explicit ZELARI_PERMISSION_EXECUTE=allow included — the shape still asks).
 * - yolo: keeps its contract — explicit opt-in stays allow.
 * - An explicit session grant for this tool (the user already answered this
 *   exact ask in-session) is honored by the caller, not here.
 * - Deterministic substring/regex match, zero LLM (P2). Conservative by
 *   design: a false positive costs one confirmation, a false negative costs
 *   the workspace. Echoing a destructive string (e.g. `echo rm -rf`) can hit
 *   — accepted cost of conservatism.
 */

/** One conservative destructive-shape rule. */
export interface DestructiveRule {
  readonly id: string;
  readonly pattern: RegExp;
  readonly label: string;
}

/** The rule list — keep it SHORT and unambiguous (see module doc). */
export const DESTRUCTIVE_RULES: readonly DestructiveRule[] = [
  // `rm` with BOTH recursive and force flags, any combination (-rf, -fr, -rvf).
  { id: 'rm-recursive-force', pattern: /\brm\s+(?:-{1,2}[a-z]*r[a-z]*f|-{1,2}[a-z]*f[a-z]*r)\b/i, label: "'rm' recursive+force delete" },
  // Windows del/rd with the /s (subdirectories) switch.
  { id: 'del-subtree', pattern: /\bdel\b[^&|;]*\/s\b/i, label: "'del /s' subtree delete" },
  { id: 'rd-subtree', pattern: /\brd\b[^&|;]*\/s\b/i, label: "'rd /s' subtree delete" },
  // PowerShell recursive delete.
  { id: 'remove-item-recurse', pattern: /\bremove-item\b[^&|;]*-recurse\b/i, label: "'Remove-Item -Recurse' recursive delete" },
  // Volume format (DOS/Windows drive letter form).
  { id: 'format-volume', pattern: /\bformat\s+[a-z]:/i, label: "'format <volume>:'" },
  // History rewrite on a shared ref.
  { id: 'git-push-force', pattern: /\bgit\s+push\b[^&|;]*--force\b/i, label: "'git push --force'" },
  // Filesystem-level destroyers.
  { id: 'mkfs', pattern: /\bmkfs(?:\.\w+)?\b/i, label: "'mkfs' filesystem format" },
  { id: 'dd-raw-device', pattern: /\bdd\b[^&|;]*of=\/dev\//i, label: "'dd' raw device write" },
  // Root-wide permission wipe.
  { id: 'chmod-root-777', pattern: /\bchmod\s+-R\s+777\s+\/(?:\s|$)/i, label: "'chmod -R 777 /' root permission wipe" },
];

/**
 * Extract the command text a tool is about to run. Covers both exec tool
 * shapes: `command` (shell string) and `program`+`args` (argv, exec_process).
 */
export function commandTextFrom(input: Record<string, unknown>): string {
  const parts: string[] = [];
  if (typeof input.command === 'string' && input.command) parts.push(input.command);
  if (typeof input.program === 'string' && input.program) {
    const args = Array.isArray(input.args)
      ? input.args.filter((a): a is string => typeof a === 'string')
      : [];
    parts.push([input.program, ...args].join(' '));
  }
  return parts.join(' ; ');
}

/**
 * Returns the matched rule's human label (for the ask reason), or null when
 * the command shape is not in the conservative list.
 */
export function destructiveCommandHit(input: Record<string, unknown>): string | null {
  const text = commandTextFrom(input);
  if (!text) return null;
  for (const rule of DESTRUCTIVE_RULES) {
    if (rule.pattern.test(text)) return rule.label;
  }
  return null;
}
