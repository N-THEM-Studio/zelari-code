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
#   2. remote CI is red (latest failed run) or an open PR has failing checks:
#      `gh` when it is installed, else the public GitHub REST API via curl
#   3. git HEAD differs from .zelari/gardener.last-sha
#   4. .zelari/plan.json holds open tasks (status pending / in_progress)
#
# Trigger 2 deliberately sits between the local test probe and the HEAD probe:
# a red pipeline is a sharper task than "new commits landed" and must not be
# masked by it. Its probe is never fatal — no remote, no gh and no curl, an HTTP
# error or an unparsable payload all print an explicit
# `[gardener] ci check skipped (…)` line and let triggers 3 and 4 run.
#
# Anti-loop, same philosophy as trigger 3: the signalled run id / PR head-sha is
# written to .zelari/gardener.ci-state — also when the mission fails — so one
# permanently red pipeline asks for help once, not on every tick.
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

# Trigger 2 state (see the ci_* helpers below).
CI_STATE_FILE=".zelari/gardener.ci-state"
CI_STATE="$(cat "$CI_STATE_FILE" 2>/dev/null || true)"
CI_PENDING_KEY=""
# ZELARI_GARDENER_CI=0 removes the remote probe (air-gapped runner, API quota).
GARDENER_CI="${ZELARI_GARDENER_CI:-1}"
# Page size for the open-PR listing, and how many of those PRs get the extra
# per-PR check-runs call (the curl fallback has no rollup field to read).
CI_PR_LIMIT=10
export CI_PR_SCAN=3

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

# ── trigger 2: remote CI / open-PR probe ────────────────────────────────────
# ci_probe prints exactly ONE line on stdout; the caller turns it into either a
# mission reason or a visible skip line:
#   "<key><TAB><reason>"  unsignalled failure → mission
#   "#<key>"              same failure already signalled → skip (anti-loop)
#   "!<reason>"           probe unusable / API error → skip, keep other triggers
#   ""                    checked: no failed run and no failing open PR

# owner/repo of the GitHub remote: ZELARI_GARDENER_REPO overrides, else parsed
# out of `origin` (git@github.com:owner/repo.git, https://…/owner/repo.git,
# ssh://git@github.com/owner/repo.git).
repo_slug() {
  local url
  if [ -n "${ZELARI_GARDENER_REPO:-}" ]; then
    printf '%s' "$ZELARI_GARDENER_REPO"
    return 0
  fi
  url="$(git remote get-url origin 2>/dev/null || true)"
  printf '%s' "$url" \
    | sed -E 's#^[^/]*@[^:/]+:# #; s#^[a-z]+://[^/]+/# #; s#\.git$##; s#^[[:space:]]+##' \
    || true
}

# Optional token (private repo, higher rate limit). The public REST API answers
# unauthenticated for public repos, so a missing token is not a skip reason.
github_token() {
  printf '%s' "${ZELARI_GARDENER_TOKEN:-${GH_TOKEN:-${GITHUB_TOKEN:-}}}"
}

api_get() {
  local token="$1" url="$2"
  if [ -n "$token" ]; then
    curl -sSL -m 10 -H 'Accept: application/vnd.github+json' \
      -H "Authorization: Bearer $token" "$url"
  else
    curl -sSL -m 10 -H 'Accept: application/vnd.github+json' "$url"
  fi
}

# Head shas of the first CI_PR_SCAN open PRs, one per line (stdin = pulls JSON).
pr_head_shas() {
  node -e '
    let raw = "";
    process.stdin.on("data", (chunk) => (raw += chunk));
    process.stdin.on("end", () => {
      let list = [];
      try { list = JSON.parse(raw); } catch { list = []; }
      if (!Array.isArray(list)) list = [];
      const shas = list
        .slice(0, Number(process.env.CI_PR_SCAN || 3))
        .map((pr) => (pr && pr.head && pr.head.sha) || "");
      process.stdout.write(shas.join("\n") + "\n");
    });
  ' 2>/dev/null || true
}

# Payload protocol: "@@RUNS@@" + runs JSON, "@@PULLS@@" + pulls JSON, then one
# "@@PR<n>@@" block per listed PR (curl fallback only). Both builders return
# non-zero when the fetch itself failed, so the caller can print a skip line
# instead of mistaking an empty payload for a green pipeline.
ci_payload_gh() {
  local slug="$1" runs pulls
  runs="$(gh run list --repo "$slug" --status failure --limit 1 \
    --json databaseId,headBranch,workflowName,displayTitle,url 2>/dev/null)" || return 1
  pulls="$(gh pr list --repo "$slug" --state open --limit "$CI_PR_LIMIT" \
    --json number,title,headRefOid,url,statusCheckRollup 2>/dev/null)" || return 1
  printf '@@RUNS@@\n%s\n@@PULLS@@\n%s\n' "$runs" "$pulls"
}

# Fallback without `gh`: the same two signals over the public REST API. The
# `pulls` payload carries no check rollup outside GraphQL, so up to CI_PR_SCAN
# open PRs get one extra `check-runs` call each — the only REST way to see it.
ci_payload_api() {
  local slug="$1" token="$2" api runs pulls shas sha index=0
  api="https://api.github.com/repos/$slug"
  runs="$(api_get "$token" "$api/actions/runs?status=failure&per_page=1")" || return 1
  pulls="$(api_get "$token" "$api/pulls?state=open&per_page=$CI_PR_LIMIT")" || return 1
  printf '@@RUNS@@\n%s\n@@PULLS@@\n%s\n' "$runs" "$pulls"
  shas="$(pr_head_shas <<< "$pulls")"
  while IFS= read -r sha; do
    [ -n "$sha" ] || continue
    index=$((index + 1))
    printf '@@PR%d@@\n' "$index"
    # Best effort: a failed call only leaves that PR unjudged.
    if api_get "$token" "$api/commits/$sha/check-runs?per_page=100"; then
      printf '\n'
    fi
  done <<< "$shas"
}

ci_decide() {
  local out
  if ! out="$(printf '%s' "$1" | node -e '
    const RED = ["FAILURE", "TIMED_OUT", "STARTUP_FAILURE", "ACTION_REQUIRED"];
    let raw = "";
    process.stdin.on("data", (chunk) => (raw += chunk));
    process.stdin.on("end", () => {
      const blocks = {};
      let current = null;
      for (const line of raw.split("\n")) {
        const marker = /^@@([A-Z0-9]+)@@\r?$/.exec(line);
        if (marker) {
          current = marker[1];
          blocks[current] = [];
          continue;
        }
        if (current) blocks[current].push(line);
      }
      const section = (name, fallback) => {
        try {
          return JSON.parse((blocks[name] || []).join("\n"));
        } catch {
          return fallback;
        }
      };
      const state = process.argv[1] || "";
      const runs = section("RUNS", null);
      const pulls = section("PULLS", null);
      const errorOf = (value) =>
        value && !Array.isArray(value) && typeof value.message === "string"
          ? value.message
          : null;
      const apiError = errorOf(runs) || errorOf(pulls);
      if (apiError) {
        process.stdout.write("!" + apiError + "\n");
        return;
      }
      const isRed = (value) => RED.indexOf(String(value || "").toUpperCase()) >= 0;
      const candidates = [];
      const run = Array.isArray(runs)
        ? runs[0]
        : runs && Array.isArray(runs.workflow_runs)
          ? runs.workflow_runs[0]
          : null;
      if (run) {
        const id = String(run.databaseId || run.id || "");
        if (id) {
          const workflow = run.workflowName || run.name || "";
          const branch = run.headBranch || run.head_branch || "";
          const url = run.html_url || run.url || "";
          candidates.push([
            "run:" + id,
            "remote CI is red: run " + id + (workflow ? " (" + workflow + ")" : "") +
              (branch ? " on " + branch : "") + (url ? " — " + url : ""),
          ]);
        }
      }
      if (Array.isArray(pulls)) {
        pulls.forEach((pr, index) => {
          if (!pr) return;
          const rollup = Array.isArray(pr.statusCheckRollup) ? pr.statusCheckRollup : [];
          const rollupRed = rollup.some(
            (check) => isRed(check && check.conclusion) || isRed(check && check.state),
          );
          const checks = section("PR" + (index + 1), {});
          const checksRed =
            Array.isArray(checks.check_runs) &&
            checks.check_runs.some((check) => isRed(check && check.conclusion));
          if (!rollupRed && !checksRed) return;
          const sha = String(pr.headRefOid || (pr.head && pr.head.sha) || "");
          const url = pr.html_url || pr.url || "";
          candidates.push([
            "pr:" + pr.number + "@" + sha.slice(0, 12),
            "open PR #" + pr.number + (pr.title ? " (" + pr.title + ")" : "") +
              " has failing checks on " + sha.slice(0, 7) + (url ? " — " + url : ""),
          ]);
        });
      }
      if (candidates.length === 0) return;
      const fresh = candidates.filter((candidate) => candidate[0] !== state);
      if (fresh.length === 0) {
        process.stdout.write("#" + candidates[0][0] + "\n");
        return;
      }
      process.stdout.write(fresh[0][0] + "\t" + fresh[0][1] + "\n");
    });
  ' "$2" 2>/dev/null)"; then
    printf '%s\n' "!probe payload could not be evaluated (node failed)"
    return 0
  fi
  printf '%s' "$out"
}

ci_probe() {
  local slug payload
  slug="$(repo_slug)"
  if [[ "$slug" != */* || "$slug" == */*/* || "$slug" == *" "* ]]; then
    printf '%s\n' "!no github remote"
    return 0
  fi
  if command -v gh >/dev/null 2>&1; then
    if ! payload="$(ci_payload_gh "$slug")"; then
      printf '%s\n' "!gh probe failed (unauthenticated, rate limited or unreachable)"
      return 0
    fi
  elif command -v curl >/dev/null 2>&1; then
    if ! payload="$(ci_payload_api "$slug" "$(github_token)")"; then
      printf '%s\n' "!api probe failed (no network or api.github.com unreachable)"
      return 0
    fi
  else
    printf '%s\n' "!no gh CLI and no network/token"
    return 0
  fi
  ci_decide "$payload" "$CI_STATE"
}

REASON=""
if has_test_script && ! npm test --silent >/dev/null 2>&1; then
  REASON="npm test is failing; find the cause of the current failures and propose a minimal fix"
fi

# Trigger 2: remote CI / open PRs (skipped entirely when a sharper trigger fired).
if [ -z "$REASON" ] && [ "$GARDENER_CI" != "0" ]; then
  CI_RESULT="$(ci_probe)"
  case "$CI_RESULT" in
    '!'*)
      echo "[gardener] ci check skipped (${CI_RESULT#'!'})"
      ;;
    '#'*)
      echo "[gardener] ci check skipped (already signalled ${CI_RESULT#'#'})"
      ;;
    '')
      echo "[gardener] ci check: no failed run and no failing open PR."
      ;;
    *)
      CI_PENDING_KEY="${CI_RESULT%%$'\t'*}"
      REASON="${CI_RESULT#*$'\t'}"
      ;;
  esac
fi

if [ -z "$REASON" ] && [ -n "$HEAD_SHA" ] && [ "$HEAD_SHA" != "$LAST_SHA" ]; then
  REASON="new commits landed since the last gardener run (${LAST_SHA:-none} -> ${HEAD_SHA}); review them for regressions, gaps and stale docs"
fi

if [ -z "$REASON" ]; then
  OPEN_TASKS="$(open_task_count)"
  if [ "${OPEN_TASKS:-0}" -gt 0 ] 2>/dev/null; then
    REASON="${OPEN_TASKS} open task(s) in .zelari/plan.json; pick the highest-value one and propose the work"
  fi
fi

if [ -z "$REASON" ]; then
  echo "[gardener] nothing to do (tests green, no red CI, no new commits, no open plan tasks)."
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

# Same contract for the remote signal: the run id / PR head-sha we just handed
# to the mission is remembered even on failure, so a pipeline that stays red
# asks for help once instead of on every tick.
if [ -n "$CI_PENDING_KEY" ]; then
  mkdir -p "$(dirname "$CI_STATE_FILE")"
  printf '%s\n' "$CI_PENDING_KEY" > "$CI_STATE_FILE"
fi

exit "$STATUS"
