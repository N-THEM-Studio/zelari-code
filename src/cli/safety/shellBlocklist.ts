/**
 * shellBlocklist — reject shell commands that look destructive or that
 * exfiltrate data.
 *
 * Task A2 of AnathemaCoder v3-A.
 *
 * @see docs/plans/2026-06-29-anathema-coder-v3.md (Task A2)
 */

export class ShellBlockedError extends Error {
  constructor(
    message: string,
    public readonly reason: string,
    public readonly pattern: string,
  ) {
    super(message);
    this.name = 'ShellBlockedError';
  }
}

interface BlockRule {
  /** Regex pattern (case-insensitive). */
  pattern: RegExp;
  /** Short reason for the error message + audit log. */
  reason: string;
}

/**
 * Default blocklist. Conservative: prefers false positives over letting
 * the agent destroy the user's machine.
 */
const DEFAULT_RULES: BlockRule[] = [
  // Recursive destructive on root-ish paths. Match `rm` followed by 1-3
  // single-letter flag clusters (e.g. -rf, -fr, -r, -f) and a root path.
  { pattern: /\brm\s+(?:-[a-z]+\s+){1,3}\/\s*$/, reason: 'rm -rf /' },
  { pattern: /\brm\s+(?:-[a-z]+\s+){1,3}\/etc\b/, reason: 'rm -rf /etc' },
  { pattern: /\brm\s+(?:-[a-z]+\s+){1,3}\/boot\b/, reason: 'rm -rf /boot' },
  { pattern: /\brm\s+(?:-[a-z]+\s+){1,3}\/usr\b/, reason: 'rm -rf /usr' },
  // Disk wipe
  { pattern: /\bmkfs(?:\.[a-z0-9]+)?\s+\/dev\//, reason: 'mkfs on device' },
  { pattern: /\bdd\s+.*of=\/dev\//, reason: 'dd to device' },
  // Fork bomb
  { pattern: /:\(\)\s*\{\s*:\|:&\s*\}/, reason: 'fork bomb' },
  // Network exfiltration / arbitrary download
  { pattern: /\bcurl\s+[^|]*\|\s*(?:sudo\s+)?(?:ba)?sh/, reason: 'curl | sh' },
  { pattern: /\bwget\s+[^|]*\|\s*(?:sudo\s+)?(?:ba)?sh/, reason: 'wget | sh' },
  // Privilege escalation without explicit user intent
  { pattern: /\bsudo\s+/, reason: 'sudo without explicit consent' },
  // System file overwrites
  { pattern: />\s*\/etc\//, reason: 'redirect to /etc' },
  { pattern: />\s*\/boot\//, reason: 'redirect to /boot' },
  { pattern: />\s*\/usr\//, reason: 'redirect to /usr' },
];

/**
 * Test a shell command against the blocklist.
 * Returns null if allowed, or a BlockRule describing why it was blocked.
 */
export function findBlockedReason(
  command: string,
  rules: BlockRule[] = DEFAULT_RULES,
): BlockRule | null {
  if (typeof command !== 'string' || command.length === 0) return null;
  for (const rule of rules) {
    if (rule.pattern.test(command)) {
      return rule;
    }
  }
  return null;
}

/**
 * Throw ShellBlockedError if the command matches any blocklist pattern.
 * Otherwise return normally.
 */
export function assertShellAllowed(command: string): void {
  const blocked = findBlockedReason(command);
  if (blocked) {
    throw new ShellBlockedError(
      `Shell command blocked: ${blocked.reason}`,
      blocked.reason,
      blocked.pattern.source,
    );
  }
}

/** Expose the default rules for testing/introspection. */
export const DEFAULT_BLOCK_RULES = DEFAULT_RULES;