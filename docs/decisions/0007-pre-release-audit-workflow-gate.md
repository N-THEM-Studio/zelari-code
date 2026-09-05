# ADR-0007: Independent pre-release audit (agy) as workflow gate

- **Status:** Accepted
- **Date:** 2026-07-02
- **Deciders:** Andrea, Hermes
- **Related:** ADR-0006 (Lucifero chairman), zelari-code v0.6.0

## Context

zelari-code v0.6.0 shipped the real council chairman (Lucifero) with 759/759 tests green, clean typecheck, OK build. However a 6-minute independent audit with `agy` (Gemini 3.5 Flash, file `/tmp/audit-v060-prompt.md`) found **4 runtime bugs** that the tests did not cover:

| # | Sev | Symptom |
|---|---|---|
| 1 | HIGH | The chairman's `catch` overwrites `fullText` -> the `[Chairman synthesis failed: ...]` fallback NEVER renders |
| 2 | HIGH | `openaiCompatibleProvider` uses `config.signal` instead of `params.signal` -> `cancel()` does not abort HTTP |
| 3 | HIGH | `openaiCompatibleProvider` uses `config.model` instead of `params.model` -> `agentModels` config silently broken |
| 4 | HIGH | Specialist/oracle loops do not detect the `error` event -> `errored=false` on network failure |

All real bugs, each verified one by one before the fix (reproducible with targeted tests). All fixed in v0.6.0 -> 761/761 tests.

## Decision

**Treat the agy audit as a mandatory workflow gate before "done" on non-trivial releases** of zelari-code (and applicable to any project).

What this means in practice:

1. **When the audit is needed:**
   - Releases with new behavior (Lucifero chairman, wizard, monorepo, ...)
   - Refactors of >500 LOC (god-module split, hook extraction, ...)
   - New abstraction layers (council, headless, AgentHarness, ...)
   - Skip for: trivial bug fix (1 line), pure docs, dependency bump

2. **Process (6 steps):**
   1. Write a structured prompt in `/tmp/audit-<release>-prompt.md` (working dir, branch+sha, context, areas to audit, expected format, time budget)
   2. Spawn agy in the background: `agy --print --print-timeout 30m --dangerously-skip-permissions --add-dir <project> --model "Gemini 3.5 Flash (Medium)" < /tmp/prompt.md > /tmp/log 2>&1`
   3. Monitor `wc -l /tmp/log` every 30-60s for 3 minutes (see antigravity-cli pitfall #23: agy can stall in plan-stage)
   4. If agy is producing -> wait
   5. If agy stalls or fails -> manual fallback (read_file + search_files, 5-10 min)
   6. Triage findings: CRITICAL+HIGH fix + regression test, MEDIUM fix or motivated defer, LOW defer to backlog

3. **Triage discipline (see `references/pre-release-audit-pattern.md`):**
   - Verify every finding: reproduce, check git blame, look for missing guards, false positive patterns
   - Do not accept findings blindly (agy can have hallucinations or misread the code)
   - For every fix: write the regression test FIRST, apply the fix, verify the test passes + everything green
   - Structured commit message: `fix(vX.Y.Z): independent audit (agy) found N runtime bugs`

4. **Tooling:**
   - `agy` CLI (Google Antigravity, Gemini 3.5 Flash model) - preferred
   - Fallback: `claude-code` with Sonnet/Opus (slower, but depth)
   - Output: log at `/tmp/agy-audit-<release>.log`

## Alternatives evaluated

### A) No audit, tests only (status quo pre-v0.6.0)
- Fast, no overhead
- The 4 HIGH found by the audit would have shipped to production silently
- Bug 1 (catch overwrite) -> USELESS chairman fallback (never renders)
- Bug 2 (signal) -> HTTP request leaks on cancel (wasted resources)
- Bug 3 (model override) -> USELESS `agentModels` config (users pay for a model that is not used)
- Bug 4 (errored=false) -> corrupted cost metrics (users never see failures)
- **Rejected**: the cost of the bug in production >> audit overhead

### B) Audit only for major releases (x.0.0)
- Less overhead
- All 4 HIGH were on 0.6.0 (a feature minor release)
- It would have required 6 months of waiting to discover them
- **Rejected**: bugs do not wait for major releases

### C) Pair review with a human (Andrea does manual review)
- Maximum control
- Time: ~1h for an exhaustive review of a 110-line chairman loop + surroundings
- Not scalable (frequent releases)
- Same blind spots (humans read code with the author's mental model)
- **Rejected** as a substitute, **adopted** as a complement (agy + human sanity check on HIGHs)

## Consequences

### Positive

- **Catches bugs that elude tests.** 4 HIGH on v0.6.0 that 759 green tests had not found. Observed pattern: bugs hide in branches not exercised by tests (here: the chairman's catch path, signal abort, error event in the provider stream).
- **Verification discipline.** Forces the agent to verify every finding with reproduction + git blame, avoiding hasty fixes.
- **Edge case documentation.** The `// v0.6.0 audit HIGH-N` comments remain in the code as a historical annotation for future contributors.
- **Confidence boost.** A release with an agy audit + all tests green has a different level of trust than a release without an audit.

### Negative

- **6-10 min overhead per release.** Spawn agy + monitoring + triage + fix + regression test.
- **agy hallucination risk.** Found 1 case: finding 3 turned out to be real but agy's analysis of why was imprecise. Mitigated by manual verification.
- **Audit can stall.** Pitfall #23 documents: agy can block in plan-stage for 5+ minutes before aborting. Monitoring + manual fallback needed.
- **Model cost.** Gemini 3.5 Flash is cheap, but if the audit becomes standard practice, it adds up.

### Neutral

- **Does not replace tests.** The audit finds bugs, tests prevent regressions. Both are needed.
- **Does not replace human review.** The audit is a filter, not a final gate. For critical releases (monorepo publish, breaking change), explicit human review is still required.

## Related

- Skill `antigravity-cli` (`~/.hermes/skills/autonomous-ai-agents/antigravity-cli/SKILL.md`)
- `references/pre-release-audit-pattern.md` - full pattern with the zelari-code v0.4.2 case study
- `templates/two-pass-fix-prompt.md` - template for the Pass 2 fix after an audit
- zelari-code v0.4.2 case study: 5 bugs found in 30 min on a release with 679/679 green

## Update log

- 2026-07-02: v0.6.0 -> 4 HIGH found and fixed, workflow gate officially adopted