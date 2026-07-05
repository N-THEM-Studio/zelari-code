/**
 * Implementation-mode completion gate — Lucifero must verify writes with tools.
 */

const WRITE_TOOLS = new Set(['write_file', 'edit_file']);
const VERIFY_TOOLS = new Set(['grep_content', 'bash']);

export interface ImplementationCompletionCheck {
  ok: boolean;
  /** Tool(s) to advertise on forced retry (first executable wins). */
  missing: string[];
  reason?: string;
}

/** Escape hatch for dev / tests. */
export function isVerifyToolCheckSkipped(): boolean {
  return process.env.ZELARI_VERIFY_SKIP_TOOL === '1';
}

/**
 * True when at least one verify tool ran after the last write/edit in the turn.
 */
export function checkImplementationCompletion(
  emittedToolNames: readonly string[],
): ImplementationCompletionCheck {
  if (isVerifyToolCheckSkipped()) {
    return { ok: true, missing: [] };
  }

  let lastWriteIdx = -1;
  for (let i = 0; i < emittedToolNames.length; i++) {
    if (WRITE_TOOLS.has(emittedToolNames[i]!)) {
      lastWriteIdx = i;
    }
  }
  if (lastWriteIdx === -1) {
    return { ok: true, missing: [] };
  }

  const afterWrite = emittedToolNames.slice(lastWriteIdx + 1);
  if (afterWrite.some((t) => VERIFY_TOOLS.has(t))) {
    return { ok: true, missing: [] };
  }

  return {
    ok: false,
    missing: ['grep_content'],
    reason: 'No grep_content or bash after last write_file/edit_file',
  };
}

/** Pick the first verify tool the runtime can execute for retry. */
export function resolveVerifyRetryTool(
  executableTools: ReadonlySet<string> | null,
): string | null {
  if (!executableTools) return 'grep_content';
  if (executableTools.has('grep_content')) return 'grep_content';
  if (executableTools.has('bash')) return 'bash';
  return null;
}

export function buildImplementationVerifyRetryPrompt(toolName: string): string {
  return (
    `You wrote files but did not run ${toolName} or bash to verify them. ` +
    `Call ${toolName} NOW on your changed HTML (search @keyframes, transition, classList.add). No prose.`
  );
}
