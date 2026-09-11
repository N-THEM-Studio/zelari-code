#!/usr/bin/env bash
# zelari-gardener.sh — unattended "gardener" trigger: run Zelari ONLY when
# there is real work to do.
#
# Unlike zelari-cron-example.sh (which fires a mission on every schedule tick),
# this script detects pending work first and exits 0 when the repo is quiet —
# so it is safe to schedule it often (e.g. every 30 min) without burning budget
# on no-op runs.
#
# Usage:
#   scripts/zelari-gardener.sh [repo-dir]
#
# Work detection, in priority order:
#   1. `npm test` is non-zero AND package.json defines a `test` script
#   2. git HEAD differs from .zelari/gardener.last-sha
#   3. .zelari/plan.json holds open tasks (status pending / in_progress)
#
# The mission runs in PLAN phase and is PROPOSE-ONLY: this script never runs
# `git commit` / `git merge`, precisely because it is unattended. `--once`
# already acquires .zelari/trigger.lock (see docs/triggers.md), so concurrent
# gardeners skip instead of racing; stale locks are stolen by the CLI.

set -euo pipefail

REPO_DIR="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
cd "$REPO_DIR"

# Optional: cost guardrail (USD) — always set one for unattended runs.
export ZELARI_MISSION_MAX_COST="${ZELARI_MISSION_MAX_COST:-2.00}"

HEAD_SHA="$(git rev-parse HEAD 2>/dev/null || true)"
LAST_SHA_FILE=".zelari/gardener.last-sha"
LAST_SHA="$(cat "$LAST_SHA_FILE" 2>/dev/null || true)"

has_test_script() {
  [ -f package.json ] || return 1
  node -e 'process.exit((require("./package.json").scripts || {}).test ? 0 : 1)' 2>/dev/null
}

open_task_count() {
  node -e '
    const fs = require("fs");
    let open = 0;
    try {
      const plan = JSON.parse(fs.readFileSync(".zelari/plan.json", "utf8"));
      open = (plan.tasks || []).filter(
        (t) => t.status === "pending" || t.status === "in_progress",
      ).length;
    } catch {
      open = 0;
    }
    process.stdout.write(String(open));
  ' 2>/dev/null || printf '0'
}

REASON=""
if has_test_script && ! npm test --silent >/dev/null 2>&1; then
  REASON="npm test is failing; find the cause of the current failures and propose a minimal fix"
elif [ -n "$HEAD_SHA" ] && [ "$HEAD_SHA" != "$LAST_SHA" ]; then
  REASON="new commits landed since the last gardener run (${LAST_SHA:-none} -> ${HEAD_SHA}); review them for regressions, gaps and stale docs"
else
  OPEN_TASKS="$(open_task_count)"
  if [ "${OPEN_TASKS:-0}" -gt 0 ] 2>/dev/null; then
    REASON="${OPEN_TASKS} open task(s) in .zelari/plan.json; pick the highest-value one and propose the work"
  fi
fi

if [ -z "$REASON" ]; then
  echo "[gardener] nothing to do (tests green, no new commits, no open plan tasks)."
  exit 0
fi

echo "[gardener] work detected: $REASON"
echo "[gardener] propose-only run (plan phase, no commit, no merge)."

STATUS=0
zelari-code --headless --once --mode zelari --phase plan --output plain \
  --task "[gardener] $REASON. Propose-only: investigate, verify against the repo, and report concrete next steps — do not commit, merge or push." \
  || STATUS=$?

# Record where we looked, even when the run failed: otherwise a failing task
# would re-trigger the same mission on every tick forever.
if [ -n "$HEAD_SHA" ]; then
  mkdir -p "$(dirname "$LAST_SHA_FILE")"
  printf '%s\n' "$HEAD_SHA" > "$LAST_SHA_FILE"
fi

exit "$STATUS"
