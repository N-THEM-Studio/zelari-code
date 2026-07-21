/**
 * Managed tool-output spill — when a tool result is too large for the model
 * transcript, keep a short head/tail preview in history and write the full
 * text to a managed directory so the agent (or user) can re-read it via
 * read_file / bash.
 *
 * Inspired by OpenCode's managed tool-output files: preview is durable in
 * session history; the full file is temporary and best-effort.
 *
 * @since v1.21.0
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

/** Env: absolute dir for full tool outputs. Empty/unset → default under ~/.tmp. */
export function resolveToolOutputDir(): string {
  const fromEnv = process.env.ZELARI_TOOL_OUTPUT_DIR?.trim();
  if (fromEnv) return fromEnv;
  try {
    return join(homedir(), '.tmp', 'zelari-code', 'tool-output');
  } catch {
    return join(tmpdir(), 'zelari-code', 'tool-output');
  }
}

/** Spill is on by default; set ZELARI_TOOL_SPILL=0 to disable disk writes. */
export function isToolSpillEnabled(): boolean {
  const v = process.env.ZELARI_TOOL_SPILL?.trim().toLowerCase();
  if (v === '0' || v === 'false' || v === 'off' || v === 'no') return false;
  return true;
}

/**
 * Write full tool output to the managed directory. Returns absolute path, or
 * null if spill is disabled / write failed (never throws).
 */
export function spillToolOutput(
  fullText: string,
  meta?: { toolName?: string },
): string | null {
  if (!isToolSpillEnabled()) return null;
  if (!fullText) return null;
  try {
    const dir = resolveToolOutputDir();
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const hash = createHash('sha256').update(fullText).digest('hex').slice(0, 12);
    const stamp = Date.now().toString(36);
    const rnd = randomBytes(3).toString('hex');
    const safeTool = (meta?.toolName ?? 'tool')
      .replace(/[^a-zA-Z0-9._-]+/g, '_')
      .slice(0, 32);
    const file = `${stamp}-${safeTool}-${hash}-${rnd}.txt`;
    const path = join(dir, file);
    writeFileSync(path, fullText, 'utf8');
    return path;
  } catch {
    return null;
  }
}
