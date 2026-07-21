#!/usr/bin/env bash
# zelari-cron-example.sh — Example cron trigger for Zelari Code missions.
#
# Usage in crontab (Linux/macOS):
#   0 8 * * * /path/to/zelari-cron-example.sh /path/to/repo "run tests; fix any failures"
#
# On Windows Task Scheduler, call via Git Bash:
#   "C:\Program Files\Git\bin\bash.exe" -c '/path/to/zelari-cron-example.sh /repo "task"'
#
# The --once flag ensures:
#   1. Only one mission cycle runs (ZELARI_MISSION_MAX_ITER=1)
#   2. A lockfile prevents concurrent missions on the same repo
#   3. Budget caps (ZELARI_MISSION_MAX_COST / TOKENS) still apply

set -euo pipefail

REPO_DIR="${1:?Usage: $0 <repo-dir> <task>}"
TASK="${2:?Usage: $0 <repo-dir> <task>}"

# Optional: set a cost guardrail (USD)
export ZELARI_MISSION_MAX_COST="${ZELARI_MISSION_MAX_COST:-2.00}"

cd "$REPO_DIR"

# --once: single cycle + lockfile
# --headless: no TUI
# --mode zelari: autonomous multi-step
# --phase build: allow project writes
exec zelari-code --headless --once --mode zelari --phase build --task "$TASK"
