import { appendSystem } from "../hooks/messageHelpers.js";
import type { ChatMessage } from "../components/ChatStream.js";

/**
 * Slash command handlers — self-update operations (/update).
 * Extracted from `git.ts` (v0.4.4 audit) — the file's name was misleading.
 * This file owns the "update zelari-code itself" concern: it lazily imports
 * the updater module (which spawns `npm install -g`) to keep cold-start
 * time minimal for users who never run /update.
 *
 * v0.4.4 (agy audit MEDIUM-1 fix): `setInput` removed — input clearing is
 * centralized in `useSlashDispatch` and the update handlers never read it.
 */
export interface UpdaterSlashContext {
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
}

export async function handleUpdateCheck(
  ctx: UpdaterSlashContext,
): Promise<void> {
  try {
    const { checkForUpdate } = await import("../updater.js");
    const info = await checkForUpdate();
    if (info.error) {
      appendSystem(ctx.setMessages, `[update] check failed: ${info.error}`);
    } else if (info.updateAvailable) {
      appendSystem(
        ctx.setMessages,
        `[update] 🆕 zelari-code ${info.latestVersion} available (current: ${info.currentVersion})\n` +
          `       Run \`/update --yes\` to install. You'll need to restart manually after.`,
      );
    } else {
      appendSystem(
        ctx.setMessages,
        `[update] up to date (${info.currentVersion})`,
      );
    }
  } catch (err) {
    appendSystem(
      ctx.setMessages,
      `[update error] ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export async function handleUpdatePerform(
  ctx: UpdaterSlashContext,
): Promise<void> {
  appendSystem(
    ctx.setMessages,
    "[update] running `npm install -g zelari-code@latest`...",
  );
  try {
    const { performUpdate } = await import("../updater.js");
    const res = await performUpdate();
    if (res.ok) {
      appendSystem(
        ctx.setMessages,
        `[update] ✅ installed successfully\n\n` +
          `Please restart zelari-code manually to use the new version.\n` +
          `(exit with /exit or Ctrl+C, then run \`zelari-code\` again)`,
      );
    } else {
      // v1.0.3: show the FULL npm output (not just the last error line) so
      // the user can see exactly what npm complained about, and append a
      // targeted recovery hint for the most common failure modes we have
      // seen in the wild: missing global-prefix shim (Windows npm 10/11),
      // and a stale shim pointing at an older install.
      const output = res.output?.trim() || "(empty)";
      const hint = buildUpdateFailureHint(
        res.error ?? "",
        output,
        res.exitCode,
      );
      appendSystem(
        ctx.setMessages,
        `[update] ❌ failed: ${res.error ?? "unknown error"}\n` +
          `exit code: ${res.exitCode ?? "n/a"}\n\n` +
          `npm output:\n${output}\n\n` +
          hint,
      );
    }
  } catch (err) {
    appendSystem(
      ctx.setMessages,
      `[update error] ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Build a short, targeted recovery hint based on the npm error text.
 *
 * The "shim broken" / "command not found after update" failure mode is
 * the most common one in the field (Windows + npm 10/11 drops the
 * global shim on major upgrades). We detect it heuristically from the
 * error + output and surface the exact recovery command.
 *
 * @internal exported for unit testing
 */
export function buildUpdateFailureHint(
  error: string,
  output: string,
  exitCode: number | null,
): string {
  const haystack = `${error}\n${output}`.toLowerCase();
  const isWin = process.platform === "win32";

  // ERESOLVE / EPEERINVALID — usually means the user has a different
  // version of @zelari/core or another peer installed globally.
  if (
    haystack.includes("eresolve") ||
    haystack.includes("epeerinvalid") ||
    haystack.includes("peer dep")
  ) {
    return (
      "💡 hint: peer-dependency conflict. Try:\n" +
      "         npm install -g zelari-code@latest --legacy-peer-deps\n" +
      "   or:  npm install -g zelari-code@latest --force"
    );
  }

  // EACCES / EPERM — permission issue, common on macOS/Linux when the
  // global prefix is owned by root.
  if (haystack.includes("eacces") || haystack.includes("eperm")) {
    return (
      "💡 hint: permission denied. On macOS/Linux, avoid sudo with npm:\n" +
      "         https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally\n" +
      "   On Windows, re-run the terminal as Administrator."
    );
  }

  // ENOENT for npm itself — the shell could not find `npm` on PATH.
  if (haystack.includes("enoent") && haystack.includes("npm")) {
    return (
      "💡 hint: `npm` was not found on PATH for the spawned shell.\n" +
      "   Re-open the terminal so it picks up your current PATH, or set:\n" +
      '         export PATH="$(npm prefix -g)/bin:$PATH"   (POSIX)\n' +
      '         $env:Path = "$(npm prefix -g);$env:Path"   (PowerShell)'
    );
  }

  // Shim-related: shim not created / "command not found" on next run.
  // We can't always see this from the npm output (the failure often
  // happens silently), but if the output mentions zelari-code and any
  // of the typical shim failure tokens, surface the recovery.
  if (
    haystack.includes("zelari-code") &&
    (haystack.includes("not found") ||
      haystack.includes("eexist") ||
      haystack.includes("ebusy") ||
      haystack.includes("shim") ||
      exitCode === 0) // exit 0 but we got here means ok=false — defensive
  ) {
    return (
      "💡 hint: the install may have completed but the global bin shim\n" +
      "   is missing or stale (common on Windows + npm 10/11 after major\n" +
      "   upgrades). To repair:\n" +
      "         npm install -g zelari-code@latest --force\n" +
      "   Then re-open the terminal. If `zelari-code` is still not found,\n" +
      "   run the doctor: `zelari-code doctor`"
    );
  }

  // Generic: at least tell the user what we tried and where the output went.
  return (
    "💡 hint: the install did not succeed. To retry with more detail:\n" +
    "         npm install -g zelari-code@latest --verbose 2>&1 | tail -40\n" +
    "   On Windows, also try: `npm install -g zelari-code@latest --force`\n" +
    (isWin
      ? "   Run `zelari-code doctor` from a new terminal to diagnose shim / PATH issues.\n"
      : "")
  );
}
