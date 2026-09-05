# ADR-0014: Event-driven mission triggers

- **Status:** Accepted (implemented)
- **Proposed:** 2026-07-20
- **Author:** Zelari Code (PLAN phase)
- **Inspiration:** Loop Engineering (rari/@0xwhrrari, Jun 2026) - the loop's third
  frontier: *"runs while you sleep"* (triggered by cron/event, not by a human);
  From Loop Engineering to Graph Engineering (Carlos Perez/@IntuitMachine, Jul
  2026).
- **Depends on:** headless entry-point already complete - `runHeadlessZelari`
  (`src/cli/runHeadless.ts:758`) + CLI dispatch (`src/cli/main.ts:205`
  `pickRootComponent`, flag `--mode zelari`).

## Context

The Zelari mission today has **three triggers, all manual**:

| Trigger | Where | Type |
|---|---|---|
| `/zelari` | slash command (TUI) | manual, interactive |
| `--mode zelari` | `main.ts:327` CLI flag | manual, batch |
| Shift+Tab | TUI toggle | manual, interactive |

The entry point for running **without a human** already exists and is
complete:

```
zelari-code --headless --mode zelari --task "fix the failing test in auth.ts"
```

starts `runHeadlessZelari` -> `runZelariMission` (`zelariMission.ts:200`)
without mounting the TUI. So **the loop is already automatable**: only the
*trigger layer* above it is missing (who starts it, when, and how to avoid
overlaps).

Loop Engineering (rari) is explicit: the jump from "tool" to "teammate" is the
**event-driven** loop - triggered by cron, an opened PR, a red test, a changed
file - not by a human Enter. Today the only way to start a loop in the
background is an ad-hoc shell: no native support for scheduling, dedup, lock,
or trigger persistence.

## Decision

Add an **optional trigger layer** above `runHeadlessZelari`, **without touching
the mission loop**. The loop stays passive: someone must still call it. What we
add is *who calls it*.

We pick **two concrete triggers** (ordered by value/effort) and document the
others as future-work:

### Trigger 1 - System cron + `--once` flag + lockfile (ZERO new dependencies)

We do not embed a scheduler inside the CLI (it would require an always-on
daemon + a new heavy dep like `node-cron`). Instead we leverage the cron
already present on every OS (crontab / launchd / Task Scheduler) and make the
mission **safe to invoke repeatedly**:

- **`--once` flag**: guarantees a cron-run mission executes a single cycle and
  terminates (avoids infinite loops if someone omits the phase cap). It maps
  onto existing parameters (`ZELARI_MISSION_MAX_ITER=1`), but with an explicit
  "trigger run" semantic.
- **Lockfile `.zelari/trigger.lock`**: before starting, `runHeadlessZelari`
  checks the lock; if present and alive (PID check), it exits with code `0`
  and logs `skip: another mission is running`. It releases the lock on exit
  (including `SIGINT`/`uncaughtException`).
- **Doc + example script** (`docs/triggers.md` +
  `scripts/zelari-cron-example.sh`): a ready crontab line that starts
  `zelari-code --headless --once --mode zelari --task "..."`.

Use case: *"every morning at 8, re-run the tests and if red attempt the fix"*:

```cron
0 8 * * * cd /repo && zelari-code --headless --once --mode zelari \
  --task "run tests; if any fail, fix the top failing test and verify"
```

### Trigger 2 - Git hook (`pre-push` / CI on PR)

A `scripts/zelari-git-hook.mjs` script that, on a git event, starts a headless
mission with a task derived from context:

- **`pre-push`** (local): `--task "review the diff about to be pushed for
  security/correctness"`, phase `plan` (design only, no writes).
- **CI on PR** (GitHub Actions): the mission runs in phase `plan` on a clean
  worktree and comments on the PR with Minosse's synthesis.

The flow: the hook builds the task (diff via `git diff`), invokes
`zelari-code --headless --once --mode council --phase plan --task "..."`, and
shows the synthesis. It reuses `--once` + lockfile from Trigger 1.

### Future-work (not in this ADR)

- **`--watch` (file-watch trigger)**: recursive `fs.watch` on a pattern ->
  re-run the mission. Useful but introduces debounce/dedup complexity;
  deferred.
- **Webhook trigger**: a small HTTP server (GitHub PR webhook -> mission).
  Requires an always-on daemon; conflicts with the "no daemon" decision.
  Deferred until a `zelari-code serve` mode is introduced.

## Consequences

**Positive:**
- The mission becomes a teammate that works on events, not only on Enter.
- Natural integration with CI/CD and cron - zero new runtime dependencies
  (triggers 1 and 2 use only `child_process` + `fs`, already in the stdlib).
- `--once` + lockfile make the loop **cron-safe** even alongside the budget cap
  (ADR-0013): double protection against runaway runs.

**Negative:**
- Risk of **overlapping missions** on the same repo (two concurrent triggers
  -> git conflict on the working tree). Mitigated by the (PID-checked)
  lockfile, but not solved if the user runs on separate clones.
- The lockfile can become **stale** on a forced crash (`kill -9`). Mitigated
  with a PID check: if the PID is no longer alive, the lock is stolen with a
  warning.

**Preserved invariants:**
- The mission loop (`runZelariMission`) does not change - it stays passive.
- No always-on daemon introduced in the CLI (it coexists with system cron).
- Backward compatible: without `--once`/lockfile, behavior identical to today.

## Alternatives considered

1. **Embed `node-cron` + `zelari-code serve` daemon.** Rejected: a new heavy
   dep, an always-on process for a CLI, and it duplicates what system cron
   already does better. Keep it simple: the CLI is an executor, not a
   scheduler.
2. **GitHub Actions as the only trigger.** Rejected: too specific (cloud),
   does not cover local / self-hosted scenarios. The git-hook + cron trigger
   is cloud-agnostic.
3. **Internal scheduler with `setTimeout` + minimal cron parsing.** Rejected
   for the same reason as (1): reimplementing cron is extremely fragile. OS
   cron is battle-tested.

## Concrete integration points

| File | Change | Effort |
|---|---|---|
| `src/cli/main.ts:324-331` | add `--once` flag to help + parsing | XS |
| `src/cli/headless.ts` (`parseHeadlessFlags`) | parse `--once` -> `HeadlessOptions.once` | XS |
| `src/cli/runHeadless.ts:758` (`runHeadlessZelari`) | if `opts.once`: force `MAX_ITER=1`; acquire/release lockfile | S |
| new `src/cli/triggerLock.ts` | `acquireLock(path) -> bool`, `releaseLock`, PID check, `SIGINT` handler | S |
| `scripts/zelari-cron-example.sh` | crontab example | XS |
| `scripts/zelari-git-hook.mjs` | git hook (pre-push) | S |
| `docs/triggers.md` | trigger guide | S |

**Acceptance tests:**
- `--once` forces `MAX_ITER=1` even with `ZELARI_MISSION_MAX_ITER=6` in env.
- Two concurrent invocations -> the second exits `code 0` with a `skip:` log.
- `kill -9` + re-run -> the stale lock is stolen via PID check.