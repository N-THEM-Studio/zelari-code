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

### Gardener: run only when there is work

`scripts/zelari-gardener.sh` is the cron example's cheaper sibling — it skips
the mission entirely when the repo is quiet, so it is safe to schedule often.
Work is detected in this order:

1. `npm test` exits non-zero (and `package.json` defines a `test` script)
2. remote CI is red — the latest failed GitHub Actions run — or an open PR has
   failing checks
3. `git HEAD` differs from `.zelari/gardener.last-sha`
4. `.zelari/plan.json` has tasks with status `pending` / `in_progress`

When none apply it exits `0` without spending budget. Otherwise it runs
`--headless --once --mode zelari --phase plan --output plain` — **plan** phase,
so the run is **propose-only**: the script never commits or merges. After the
run (success or failure) it writes the current HEAD to
`.zelari/gardener.last-sha`, so one broken task cannot re-trigger every tick.
Concurrency reuses the `--once` lockfile described below.

#### Remote CI / PR trigger

The second trigger probes GitHub **once per tick**, with no daemon and no new
dependency, in this preference order:

- `gh`, when it is on `PATH`: `gh run list --status failure` plus
  `gh pr list --state open` (the PR rollup comes straight from `gh`);
- otherwise `curl` against the public REST API —
  `/repos/<slug>/actions/runs?status=failure&per_page=1` and
  `/pulls?state=open`. That `pulls` payload carries no check rollup outside
  GraphQL, so up to three open PRs get one extra
  `/commits/<sha>/check-runs` call each.

The repository comes from `git remote get-url origin` — both
`git@github.com:owner/repo.git` and `https://…/owner/repo.git` — unless it is
overridden by `ZELARI_GARDENER_REPO`.

| Variable | Effect |
| --- | --- |
| `ZELARI_GARDENER_REPO` | `owner/repo` to poll, overriding the `origin` remote |
| `ZELARI_GARDENER_TOKEN` | token for private repos / higher rate limits (`GH_TOKEN`, then `GITHUB_TOKEN`, are honoured as fallbacks; the public API answers unauthenticated for public repos) |
| `ZELARI_GARDENER_CI=0` | disables this trigger entirely (air-gapped runner, API quota) |

**Anti-loop:** the signalled signal — `run:<id>` or `pr:<number>@<head-sha>` —
is written to `.zelari/gardener.ci-state` even when the mission fails, exactly
like `.zelari/gardener.last-sha`: a pipeline that stays red asks for help
**once**, not once per tick, while a new failed run (or a new PR head commit)
triggers again.

**Never fatal:** every way the probe can fail is printed on stdout and falls
through to the remaining triggers —

```
[gardener] ci check skipped (no github remote)
[gardener] ci check skipped (no gh CLI and no network/token)
[gardener] ci check skipped (gh probe failed (unauthenticated, rate limited or unreachable))
[gardener] ci check skipped (api probe failed (no network or api.github.com unreachable))
[gardener] ci check skipped (Not Found)          # API error body, verbatim
[gardener] ci check skipped (already signalled run:4242)
[gardener] ci check: no failed run and no failing open PR.
```

The mission itself is unchanged: same `--task "[gardener] <reason> …"`
invocation, same `--phase plan` propose-only contract, and the script still
never runs `git commit`, `git merge` or `git push`.

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
