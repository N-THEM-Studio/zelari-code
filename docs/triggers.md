# Event-Driven Triggers for Zelari Code

> ADR-0014 — Making Zelari Code a teammate that works while you sleep.

## Overview

Zelari Code's mission loop (`/zelari`, `--mode zelari`) is now triggerable
**without human interaction**. This document covers the two built-in trigger
patterns: **cron scheduling** and **git hooks**.

Both use the `--once` flag, which:
- Forces a single mission cycle (`ZELARI_MISSION_MAX_ITER=1`)
- Acquires a lockfile (`.zelari/trigger.lock`) to prevent concurrent missions
- Respects budget caps (`ZELARI_MISSION_MAX_COST` / `ZELARI_MISSION_MAX_TOKENS`)

## Cron Trigger

Run a mission on a schedule. Example: every morning, check if tests pass
and attempt a fix if they don't.

### Linux / macOS (crontab)

```cron
# Every day at 08:00 — run tests, fix failures if any
0 8 * * * /path/to/zelari-code/scripts/zelari-cron-example.sh /path/to/repo \
  "run tests; if any fail, fix the top failing test and verify"
```

### Windows (Task Scheduler)

Create a Basic Task with action:
```
Program: "C:\Program Files\Git\bin\bash.exe"
Arguments: -c '/path/to/zelari-cron-example.sh /e/repo "run tests; fix failures"'
```

### Cost guardrail

Always set a cost cap for unattended runs:

```bash
export ZELARI_MISSION_MAX_COST=2.00   # USD — hard ceiling
```

## Git Hook Trigger

Review changes before they leave your machine.

### pre-push (review only, plan phase)

```bash
# Install
cp scripts/zelari-git-hook.mjs .git/hooks/pre-push
chmod +x .git/hooks/pre-push
```

Now every `git push` triggers a Zelari mission in **plan** phase (no writes)
that reviews the diff and prints the synthesis. The push is **not blocked** —
the review is informational.

To block pushes on issues, set `ZELARI_HOOK_PHASE=build` (the mission will
attempt fixes in your working tree before the push proceeds).

### CI / GitHub Actions

```yaml
- name: Zelari review
  run: |
    zelari-code --headless --once --mode zelari --phase plan \
      --task "review the PR diff for security and correctness" \
      --output plain
```

## Lockfile behavior

`.zelari/trigger.lock` is a JSON file containing the PID of the process
that acquired it:

```json
{ "pid": 12345, "acquiredAt": "2026-07-20T08:00:00.000Z" }
```

- **Concurrent runs:** the second invocation sees the lock, checks if the
  PID is alive, and exits `0` with `skip: another mission is running`.
- **Stale lock (crash):** if the PID is no longer alive, the lock is stolen
  with a warning and the new run proceeds.
- **Manual removal:** `rm .zelari/trigger.lock` if you need to force-clear.

## Combining with budget caps (ADR-0013)

For unattended runs, always combine `--once` with cost guardrails:

```bash
ZELARI_MISSION_MAX_COST=1.00 \
ZELARI_MISSION_MAX_TOKENS=500000 \
zelari-code --headless --once --mode zelari --phase build --task "..."
```

This gives you three independent stop-rules:
1. **Success** — the verifier confirms the goal
2. **Iteration cap** — `--once` forces `MAX_ITER=1`
3. **Budget cap** — hard ceiling on USD/token spend
