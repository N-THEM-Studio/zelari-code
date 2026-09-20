/**
 * permission-observer.mjs — WS6 example bundle: an OBSERVER hook.
 *
 * The `PermissionRequest` event is fire-and-forget (WS5): the runner spawns this
 * process, writes the structured payload as JSON on stdin, and DISCARDS the
 * decision it replies with. An observer therefore cannot block a tool — the
 * only honest reply is `allow`, which is what this script always prints.
 *
 * Side effect is OPT-IN: set ZELARI_EXAMPLE_HOOK_LOG to a file path and one
 * JSONL record is appended per event. With the variable unset the script only
 * writes a one-line summary to stderr and stays read-only.
 *
 * Contract it must respect (`@zelari/core/harness` lifecycleHookRunner):
 * exit 0 and print exactly one JSON object on stdout. Anything else is a hook
 * FAILURE (logged, and in fail-closed surfaces mapped to a deny).
 */
import { appendFileSync } from 'node:fs';

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);

/** Always exit 0 with a well-formed decision, whatever the input was. */
function replyAllow() {
  process.stdout.write('{"decision":"allow"}\n');
}

let payload;
try {
  payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
} catch (err) {
  process.stderr.write(
    `[example permission-observer] unreadable payload: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  replyAllow();
  process.exit(0);
}

const permission = payload?.permission ?? {};
const record = {
  at: new Date().toISOString(),
  event: payload?.event ?? 'PermissionRequest',
  sessionId: payload?.sessionId ?? null,
  tool: permission.tool ?? null,
  effect: permission.effect ?? null,
  categories: permission.categories ?? [],
  matchedRuleId: permission.matchedRuleId ?? null,
  source: permission.source ?? null,
};

const logFile = process.env.ZELARI_EXAMPLE_HOOK_LOG;
if (logFile) {
  try {
    appendFileSync(logFile, `${JSON.stringify(record)}\n`, 'utf8');
  } catch (err) {
    process.stderr.write(
      `[example permission-observer] cannot append to ${logFile}: ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    );
  }
} else {
  process.stderr.write(
    `[example permission-observer] ${record.tool ?? '?'} → ${record.effect ?? '?'}` +
      `${record.matchedRuleId ? ` (rule ${record.matchedRuleId})` : ''}\n`,
  );
}

replyAllow();
