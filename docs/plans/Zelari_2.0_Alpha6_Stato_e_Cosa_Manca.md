# Zelari 2.0 Alpha.6 - Current state and what is missing

**Reference:** `v2.0.0-alpha.6`
**Goal:** take a snapshot of the real implementation state versus the Zelari 2.0 plan and define the residual work before an RC.

---

## 1. Executive summary

Alpha.6 is noticeably ahead of alpha.4.

The two main P0s previously identified are closed:

1. **the versions and exports of `@zelari/core` are coherent**;
2. **the Session spine is now the source of truth of the model context** on headless/TUI, with `deriveMessages()` as the canonical path and architectural tests preventing regressions.

The fundamental part of 2.0 therefore really exists:

- event-sourced Session spine;
- replay and resume;
- execution seams;
- WorkspaceProvider;
- versioned profiles;
- deterministic verification contract;
- CompletionPolicy;
- optional VerifierService;
- verifier model `inherit | fixed`;
- mission projection;
- Desktop controls for strict done, verifier and BoN alpha.

The bulk of the remaining work is no longer "inventing the architecture", but **closing the Verification 2.0 wiring**, making evidence truly traceable to tool results, completing mission progress and consolidating docs/smoke/CI before an RC.

Qualitative assessment:

```text
Foundation / hygiene        ##########  100%
Session spine               ##########  100%
Execution seams/profiles    #########~   ~90%
Deterministic verification  ########~#   ~80%
LLM verifier integration    ####~######   ~50%
Mission reliability         ######~####   ~60%
Desktop product surface     ########~#   ~80%
Docs / migration / CI       ####~######   ~50%
----------------------------------------
Alpha -> RC readiness        ~75-80%
```

The percentages are indicative, not project metrics.

---

## 2. What is already closed

### 2.1 Session spine

The Session spine is now the canonical path:

```text
Session log
    |
deriveMessages()
    |
derivedToAgentMessages()
    |
model context
```

The old `sessionManager` can stay as compatibility/migration/UI, but it is no longer the second source of truth of the model context.

Desktop uses the `sessionId` and subsequent turns can resume instead of depending on the history snapshot alone.

**State:** closed.

---

### 2.2 Core versioning and exports

Root and `@zelari/core` are aligned on alpha.6.

The public 2.0 exports are present for:

```text
@zelari/core/session
@zelari/core/runtime
@zelari/core/verification
@zelari/core/mission
```

**State:** closed.

---

### 2.3 Workspace and execution seams

The abstractions for the following are present:

- `ExecutionContext`;
- workspace;
- worktree;
- filesystem;
- shell;
- subagent;
- profiles.

The worktree has been moved in the right direction: **workspace policy**, not a mere shell flag.

**State:** substantially closed.

---

### 2.4 Host / Profile / Phase

The conceptual separation is correct:

```text
Host
- TUI
- headless
- Desktop
- serve

Profile
- minimal
- kraken
- council
- mission

Phase
- plan
- build
```

`headless` has not been turned into a profile.

**State:** closed.

---

### 2.5 Deterministic verification core

The 2.0 core contains:

```text
VerificationEngine
CompletionPolicy
criteria pack
metrics
VerifierService
```

The separation between deterministic evidence and probabilistic verifier is correct.

The LLM verifier:

- is opt-in;
- is not the final authority;
- can use `inherit` or a dedicated model;
- records the effective provider/model;
- does not turn uninterpretable output into `pass`;
- keeps progress and BoN as experimental/advisory surfaces.

**State:** core closed, runtime wiring still incomplete.

---

### 2.6 Dedicated verifier / inherit

The configuration supports:

```text
Same as current model
```

or:

```text
Dedicated provider + model
```

This is coherent with the Zelari 2.0 plan.

**State:** backend closed.

---

### 2.7 Desktop verifier controls

The Desktop UI includes the control:

```text
Kraken - Verification model

Same as current model (recommended)
Custom provider + model.
```

and controls are also present for:

- strict BUILD gate;
- Best-of-N alpha;
- execution profile.

**State:** UI present; smoke/round-trip consolidation missing.

---

## 3. Main P1 - VerifierService runtime wiring

The most important remaining problem is wiring the `VerifierService` into the normal Kraken lifecycle.

The service exists, but closing the contract requires end-to-end tests demonstrating that:

```text
deterministic evidence
       |
       v
CompletionPolicy
       |
       +- PASS
       +- BLOCKED
       +- REPAIR_REQUIRED
```

remains the final authority even when the LLM verifier is active.

### Required lock test

Case 1:

```text
deterministic criterion = UNKNOWN/FAIL
verifier LLM = CONFIRMED
```

Expected result:

```text
CompletionPolicy = BLOCKED
strict mode => no clean success
```

Case 2:

```text
deterministic criteria = PASS
verifier LLM = REJECTED
```

Expected result:

- deterministic completion is not rewritten;
- the LLM review is shown as advisory/risk;
- the system can ask for attention, but must not falsify the deterministic verdict.

### Priority

**P1 / Exit-2.3**

---

## 4. Criteria Pack still not fully native in the Kraken path

`codingCriteriaPack()` exists, but the Kraken runtime still partly depends on the legacy selection structure and the verify tentacle report.

Today the flow is still too close to:

```text
Kraken selection
      |
required checks
      |
verify tentacle
      |
verification bridge
      |
CompletionPolicy
```

The 2.0 target is:

```text
Task
 |
AcceptanceCriteria
 +
Zelari Coding Criteria Pack
 |
VerificationEngine
 |
actual deterministic checks
 |
EvidenceRef
 |
CompletionPolicy
```

The bridge is correct as a migration phase, but it must not remain the final shape.

### Action

Bring the criteria pack directly into the normal Kraken verification path.

### Priority

**P1 / Exit-2.4**

---

## 5. EvidenceRef must become truly event-backed

In the current bridge some verify notes are turned into pseudo-evidence of tier `tool-output`.

Conceptual example:

```text
verify agent says:
"npm test: 58 passed"
```

and this string is used as the evidence reference.

This is stronger than the pure final narrative, but it is not yet the ideal P1 shape.

The target is:

```text
VerificationResult
       |
EvidenceRef
       |
session seq / event id
       |
actual tool/result
       |
real command output
```

### TypeScript target

```ts
interface EvidenceRef {
  eventSeq: number;
  tier: EvidenceTier;
  digest?: string;
}
```

The verify agent can still add a note, but the note must not be confused with the original tool output.

### Priority

**P1 before stable**

---

## 6. Mission progress / advisory early-stop

The mission core and `VerifierService.progressScore()` exist.

The real integration is still missing:

```text
mission evidence
      +
deterministic progress
      +
optional verifier trend
      |
mission continuation policy
```

Progress must stay advisory:

- no silent goal rewrite;
- no done from score alone;
- no early-stop while required criteria remain incomplete;
- user steer always sovereign.

### Priority

**Exit-2.5, after verifier wiring and the criteria pack**

---

## 7. Strict Done - product decision still to freeze

The strict gate exists and can produce:

```text
blocked after repair
-> non-zero exit
-> session status stopped
```

It is a good implementation.

The open question is the **default**.

### Option A

Interactive Kraken:

```text
strict done = opt-in
```

Mission:

```text
strict done = default
```

### Option B

The whole 2.0 build:

```text
deterministic verification default
```

with adaptive intensity.

The recommended solution:

```text
Kraken interactive
-> strict configurable

Mission
-> strict evidence gate default
```

The decision must be frozen before stable.

---

## 8. Legacy `history_snapshot`

`history_snapshot` is still present in some paths.

It is no longer a source of truth of the model, so it is not P0.

It can temporarily stay as:

- UI compatibility;
- export compatibility;
- migration helper.

Before the RC, however, the following must be evaluated:

- deprecation;
- removal;
- or explicit documentation as a non-canonical mirror.

Target:

```text
Session spine = canonical
history_snapshot = compatibility only
```

---

## 9. Desktop - round-trip smoke missing

The verifier UI exists.

A complete test/smoke is missing:

```text
Desktop settings
   |
Same as session / Dedicated
   |
persist
   |
restart/load
   |
runtime resolution
   |
verification event logs actual model
```

The test must cover:

### Inherit

```text
Primary = A
Verifier = inherit

effective verifier = A
```

### Dedicated

```text
Primary = A
Verifier = B

effective verifier = B
```

### Reset

```text
Dedicated B
-> clear override
-> inherit A
```

### Priority

**Exit-3.1**

---

## 10. Profile smoke tests

Profiles exist but a real smoke matrix is needed.

Minimum:

```text
minimal + plan
minimal + build

kraken + plan
kraken + build

council + plan

mission + build
```

Use fake/deterministic providers where possible.

Goals:

- correct profile loader;
- correct capability manifest;
- correct Session metadata;
- no unauthorized side effects in plan;
- stable host/profile/phase wiring.

### Priority

**Exit-3.2**

---

## 11. GUIDA 2.0 still incomplete

The guide must clearly document:

```text
Host
Profile
Phase
Session spine
resume
fork
export session
Strict Done
VerificationEngine
Verifier LLM
Same as session
Dedicated model
Progress
Best-of-N alpha
```

The legacy session/history sections must be updated to distinguish:

```text
legacy session/history compatibility
```

from:

```text
2.0 canonical Session spine
```

### Priority

**Exit-3.3**

---

## 12. MIGRATION 1.x -> 2.x to complete

The migration file already exposes the new 2.0 package paths, but must explain the fundamental change:

### Before

```text
consumer reconstructs/provides history
```

### After

```text
append Session events
       |
deriveMessages()
       |
AgentHarness
```

Also document:

- profile metadata;
- resume/fork;
- the verification contract;
- EvidenceRef;
- any legacy adapters;
- effective breaking changes.

### Priority

**Exit-3.4**

---

## 13. CI matrix

The current CI is a good single gate, but not a real matrix.

Zelari touches platform-sensitive components:

- shell;
- paths;
- process groups;
- signals;
- worktrees;
- locks.

Before the RC add at least multi-OS smoke.

### Proposal

Full suite:

```text
Ubuntu + Node 24
```

Core/session/runtime smoke:

```text
Ubuntu
Windows
macOS
```

Possible Node matrix:

```text
Node 20
Node 24
```

Desktop build smoke where reasonable.

### Priority

**Exit-3.5**

---

## 14. Headless Session smoke end-to-end

A product test is needed:

```text
headless run
   |
session_started
   |
session id
   |
resume
   |
second turn
   |
export session
   |
fresh reader/replay
   |
same semantic trajectory
```

Run it at least for:

```text
Kraken
Council
```

and, if possible, Mission.

### Priority

**Exit-3.6**

---

## 15. Dependabot / dependency security

Before an RC:

```text
alerts
  |
triage
  |
runtime vs dev-only
  |
reachable vs non-reachable
  |
upgrade / mitigate / documented accept
```

High alerts should not remain untriaged before an RC.

It is not necessary to block the alpha on every moderate warning, but a signed snapshot is needed.

---

## 16. Technical cleanup

Small points to clean up before the RC:

- duplicate/residual comments in the verification bridge;
- `@ts-nocheck` in central files when removable;
- legacy adapters clearly marked;
- documented alpha flags;
- dead code produced by the Session migration;
- any env flags replaced by config/profile policy when appropriate.

These are not architectural priorities, but they improve the quality of the RC.

---

## 17. What must NOT be redone

Do not reopen these topics except for bugs:

- Session spine;
- `deriveMessages` canonical path;
- replay invariants;
- root/core version alignment;
- public exports;
- WorkspaceProvider;
- execution seams;
- host/profile separation;
- versioned profiles;
- CompletionPolicy;
- deterministic evidence tiers;
- strict non-zero exit;
- verifier `inherit | fixed`;
- Desktop verifier selector;
- Desktop strict gate;
- Desktop BoN alpha control.

The current risk is scope creep, not a lack of foundations.

---

## 18. Recommended roadmap

### Alpha.7 - close Exit-2

Order:

1. **VerifierService runtime wiring + lock tests**
2. **Criteria Pack native in the Kraken verification path**
3. **EvidenceRef event-backed**
4. **Mission progress/advisory early-stop**
5. no new big features

Goal:

```text
Verification 2.0 native
```

and no longer primarily:

```text
legacy verify report
-> 2.0 adapter
```

---

### Alpha.8 / Beta - Exit-3

1. Desktop verifier round-trip smoke
2. profile smoke matrix
3. GUIDA 2.0
4. complete MIGRATION
5. multi-OS CI
6. headless resume/export smoke
7. dependency triage
8. legacy mirror cleanup

---

### RC.1

An RC should start only when the circuit is complete:

```text
AcceptanceCriteria
       |
deterministic checks
       |
real event-backed evidence
       |
CompletionPolicy
       |
optional verifier
       |
logged verdict
       |
host / mission consume verdict
```

At that point freeze new features and concentrate only on:

- bugs;
- regressions;
- portability;
- docs;
- security;
- migration.

---

## 19. Criteria to move to RC

### Session

- [ ] single canonical context path
- [ ] resume/replay smoke
- [ ] export smoke
- [ ] no legacy source-of-truth

### Verification

- [ ] criteria pack really used
- [ ] verifier advisory lock test
- [ ] evidence refs to tool/session events
- [ ] strict completion behavior defined
- [ ] false-done test suite

### Profiles/runtime

- [ ] profile smoke matrix
- [ ] plan/build capability tests
- [ ] worktree isolation smoke

### Mission

- [ ] progress integration
- [ ] interrupt/resume
- [ ] evidence-based completion

### Desktop

- [ ] inherit verifier smoke
- [ ] dedicated verifier smoke
- [ ] reset/fallback smoke

### Docs

- [ ] GUIDA 2.0
- [ ] MIGRATION 2.0
- [ ] documented alpha flags

### CI/security

- [ ] minimal OS matrix
- [ ] supported Node versions tested
- [ ] dependency alerts triaged
- [ ] principles/version/typecheck/tests green

---

## 20. Verdict

Alpha.6 has passed the phase where Zelari 2.0 was mainly a new architecture alongside 1.x.

The new spine is now real.

What is missing is mainly transforming Verification 2.0 from:

```text
legacy verification
       |
2.0 bridge
       |
CompletionPolicy
```

to:

```text
AcceptanceCriteria
       |
native deterministic verification
       |
event-backed EvidenceRef
       |
CompletionPolicy
       |
optional independent verifier
```

This is the most important qualitative milestone before the RC.

The rule to follow now is:

> **Do not add more capability until the evidence -> completion circuit is native, tested and traceable end-to-end.**

And the operational priority is:

> **Alpha.7 = complete Verification 2.0. Alpha.8/Beta = surface, docs, portability and hardening. Then RC.**