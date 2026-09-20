---
name: repo-hygiene
description: Keep a working tree reviewable — minimal diffs, no drive-by refactors, honest reports about what was and was not verified.
category: review
cost: low
tools: [bash, read_file, grep_content, edit]
---

# Repo hygiene

Apply this when a change is about to land and someone else has to review it.

1. **Diff first, always.** Run `git status --porcelain` and `git diff --stat`
   before writing anything, so "what I changed" is a fact, not a memory.
2. **One change, one reason.** Never mix a refactor, a formatting pass and a
   behaviour fix in the same edit. If a fix *needs* a refactor, land the
   refactor separately and say so.
3. **Touch what the task names.** Files outside the task's scope are read-only
   evidence. If one must change, say which and why in the report.
4. **No stray artifacts.** Temporary files, logs and probe scripts are deleted
   before the final `git status`. A dirty tree is a claim the reviewer must
   investigate.
5. **Report verification as evidence.** For every check, give the exact command
   and its exit code — "tests pass" without the command is not evidence.
6. **Say what you did NOT verify.** An unverified claim is more expensive than
   an admitted gap: state the gap, the reason, and what would close it.
7. **Failures stay failures.** If a check fails, report the failure and its
   classification. Renaming a failure, or quietly dropping the check, is worse
   than the failure itself.
