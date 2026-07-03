# Council Workspace Wiring Fixes (v0.7.5)

> **For Hermes:** Subagent-driven execution preferred (3 atomic tasks + spec/quality review per task).
> Each task is 2-5 min, fully reversible, TDD where applicable.

**Goal:** Fix 3 council bugs that prevent workspace artifacts from being created in design mode. Zero new tests for already-tested paths; one new test for the missing wiring.

**Architecture:** The council needs workspace tools registered in TWO places — the per-call `ToolRegistry` (which the harness uses to execute tool calls) AND the global `setWorkspaceStubs` static (which `getAllTools()` reads when building LLM-visible schemas). `runHeadless.ts` already does both. `dispatchCouncil` only does the first. That's the root cause.

**Tech Stack:** TypeScript 5.7, ESM, vitest, no new deps.

---

## Background

The 3 bugs discovered in the v0.7.5 council design run for `borsa-lusso-react`:

### Bug A — `dispatchCouncil` does not call `setWorkspaceStubs`

`src/cli/councilDispatcher.ts:94-138` passes a `ToolRegistry` to `runCouncilPure` (so tool calls can execute), but does NOT call `setWorkspaceStubs(...)` from `@zelari/core/skills`. Without that, `_workspaceStubs` (the module-global at `packages/core/src/agents/tools.ts:188`) stays empty, and `getAllTools()` does not include the 9 workspace tools in its returned schemas. So `buildSystemPrompt` builds the prompt from `getAllTools()` and the registry Map passed to `getToolDescriptions` doesn't have `createPhase`/`addIdea`/etc. as known names. The model never sees them listed in AVAILABLE TOOLS.

`src/cli/runHeadless.ts:152` and `src/cli/hooks/useChatTurn.ts:586` already call `setWorkspaceStubs` — proven pattern.

### Bug B — `filterExecutable` removes all role tools when workspace-only registry is used

`packages/core/src/agents/councilApi.ts:333-341`:

```ts
const agentToolNames = filterExecutable(computeAgentTools(agent, config.aiConfig));
const agentTools: AgentToolSpec[] = agentToolNames.length > 0
  ? getProviderTools(agentToolNames).map(...)
  : [];  // ← when role.tools ∩ workspace_tools = ∅, model sees zero tools
```

For `Nettuno`, `computeAgentTools` returns `['list_files', 'read_file', 'grep_content']`. None are in the workspace registry. `filterExecutable` strips them all. The harness gets `tools: []`. The model is told "no tools available" even though the registry can execute workspace tool calls if it guessed the names.

Fix: union the role's declared tools with the workspace tool names BEFORE filtering. The model needs to SEE the workspace tools (so it knows they exist), even if its own role doesn't declare them.

### Bug C — `Minosse` only runs in `debateMode`

`packages/core/src/agents/councilApi.ts:436`:

```ts
if (config.debateMode && oracle && !completedIds.has(oracle.id)) {
```

Default `debateMode: false` → Minosse is skipped. The 6-member council silently becomes 5. Users passing `councilSize: 6` see Minosse in agent_start events but it never executes. Bug: the orchestrator logs `member_cost` for a member that never ran.

Fix: run Minosse always, but only run the debate loop (specialist → Minosse → specialist → Minosse → ...) when `debateMode: true`. A single non-debate Minosse review is always useful before Lucifero synthesis.

---

## Files

- **Modify:** `src/cli/councilDispatcher.ts` (Bug A — add `setWorkspaceStubs` call)
- **Modify:** `packages/core/src/agents/councilApi.ts` (Bug B — union tools; Bug C — always run Minosse)
- **New test:** `tests/unit/cli-councilWorkspaceWiring.test.ts` (Bug A — verify `setWorkspaceStubs` is called)

No changes to: `roles.ts` (out of scope), workspace stubs (working), dispatch options interface (backward compatible).

---

## Task 1: Fix dispatchCouncil to call setWorkspaceStubs (Bug A)

**Objective:** `dispatchCouncil` must register workspace stubs in the global static so `getAllTools()` returns them.

**Files:**
- Modify: `src/cli/councilDispatcher.ts` (add dynamic import + call)
- New: `tests/unit/cli-councilWorkspaceWiring.test.ts`

**Step 1: Read current dispatcher**

The function body (lines 95-138). Current code uses static imports. We must add `await import(...)` for `@zelari/core/skills` (same dynamic-import pattern used in `runHeadless.ts:143` to avoid load-order cycles).

**Step 2: Write failing test**

```ts
// tests/unit/cli-councilWorkspaceWiring.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getAllTools } from '@zelari/core/skills';

let tmpDir: string;
let originalCwd: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'council-wiring-'));
  originalCwd = process.cwd();
  process.chdir(tmpDir);
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('dispatchCouncil — workspace stub wiring (Bug A fix)', () => {
  it('registers workspace stubs via setWorkspaceStubs so getAllTools() exposes them', async () => {
    // Import AFTER chdir so workspace context picks up the tmp dir as root.
    const { dispatchCouncil } = await import('../../src/cli/councilDispatcher.js');
    const { setWorkspaceStubs } = await import('@zelari/core/skills');

    // Reset stubs before the test (defensive — other tests may have set them).
    setWorkspaceStubs([]);

    // Build a fake provider stream that just returns a single message with no tool calls.
    // We don't need a real LLM here — the wiring happens BEFORE any LLM call.
    const fakeStream = async function* () {
      yield { type: 'message_start', messageId: 'm1' };
      yield { type: 'message_delta', delta: 'noop' };
      yield { type: 'message_end', totalLength: 4, finishReason: 'stop' };
      yield { type: 'agent_end' };
    };

    const opts = {
      apiKey: 'test-key',
      provider: 'openai-compatible',
      model: 'noop',
      councilSize: 1,
      debateMode: false,
      ragContext: '',
      workspaceContext: 'test',
      providerStream: fakeStream as never,
    };

    // Drain the async iterable (we don't care about events, only that dispatchCouncil
    // executed the wiring).
    for await (const _e of dispatchCouncil('test task', opts)) { /* drain */ }

    // After dispatchCouncil, getAllTools() must include workspace tool names.
    const allNames = getAllTools().map((t) => t.name);
    expect(allNames).toContain('createPhase');
    expect(allNames).toContain('createTask');
    expect(allNames).toContain('addIdea');
    expect(allNames).toContain('createDocument');
    expect(allNames).toContain('searchDocuments');
  });
});
```

**Step 3: Run test to verify failure**

```bash
cd ~/zelari-code && npx vitest run tests/unit/cli-councilWorkspaceWiring.test.ts 2>&1 | tail -20
```

Expected: FAIL — `getAllTools()` does NOT include `createPhase` (workspace stubs not registered). Test will throw "expected 'createPhase' to be in array".

**Step 4: Apply the fix**

In `src/cli/councilDispatcher.ts`, after the `tools` line in the `config` object (around line 121), add dynamic import + call to `setWorkspaceStubs`. Pattern mirrors `runHeadless.ts:141-152`:

```ts
// After the `config` object is constructed, before `yield* runCouncilPure(...)`:
if (!options.disableWorkspaceTools) {
  // Bug A fix: also register workspace stubs in the global static so that
  // getAllTools() (called by buildSystemPrompt) returns them. Without this,
  // the model never sees the workspace tool names in its AVAILABLE TOOLS
  // block, even though the per-call ToolRegistry can execute them.
  const { setWorkspaceStubs, createWorkspaceStubs } = await import('@zelari/core/skills');
  const { createWorkspaceContext } = await import('./workspace/stubs.js');
  const ctx = options.workspaceRoot
    ? createWorkspaceContext(options.workspaceRoot)
    : createWorkspaceContext();
  setWorkspaceStubs(createWorkspaceStubs(ctx));
}
```

Also extend `CouncilDispatchOptions` interface to accept `workspaceRoot?: string` (backward compatible — defaults to cwd).

**Step 5: Run test to verify pass**

```bash
cd ~/zelari-code && npx vitest run tests/unit/cli-councilWorkspaceWiring.test.ts 2>&1 | tail -10
```

Expected: PASS — all 5 workspace tool names present in `getAllTools()` output.

**Step 6: Run full test suite**

```bash
cd ~/zelari-code && npm test 2>&1 | tail -10
```

Expected: same number of passing tests as baseline (875) + 1 new test. No regressions.

**Step 7: Commit**

```bash
cd ~/zelari-code && git add src/cli/councilDispatcher.ts tests/unit/cli-councilWorkspaceWiring.test.ts
git commit -m "$(cat <<'EOF'
fix(council): wire workspace stubs into global static (Bug A)

dispatchCouncil created a per-call ToolRegistry bound to the 9
workspace stubs and passed it to runCouncilPure — but never called
setWorkspaceStubs from @zelari/core/skills. As a result, the global
static _workspaceStubs in packages/core/src/agents/tools.ts stayed
empty, and getAllTools() (called by buildSystemPrompt) returned only
the core tool schemas. The model never saw the workspace tool names
in its AVAILABLE TOOLS block.

Fix mirrors runHeadless.ts:141-152: dynamically import
setWorkspaceStubs/createWorkspaceStubs, build a context, and register
the stubs BEFORE yield* runCouncilPure(...) dispatches the first
member. Skip when options.disableWorkspaceTools is set (same escape
hatch used by the test suite).

Adds CouncilDispatchOptions.workspaceRoot?: string so the workspace
context can be pinned to a directory other than cwd (used by the
council design driver for borsa-lusso-react and by tests).

Test: tests/unit/cli-councilWorkspaceWiring.test.ts — verifies that
after dispatchCouncil runs, getAllTools() contains the 5 critical
workspace tool names (createPhase, createTask, addIdea,
createDocument, searchDocuments).
EOF
)"
```

---

## Task 2: Fix filterExecutable to union role tools with workspace tools (Bug B)

**Objective:** When the executor registry is workspace-only, models still see the workspace tools in AVAILABLE TOOLS so they can call them by name.

**Files:**
- Modify: `packages/core/src/agents/councilApi.ts` (specialist loop + chairman loop)
- Test: existing `tests/unit/cli-councilTools.test.ts` should cover this — verify.

**Step 1: Read current code**

`packages/core/src/agents/councilApi.ts:309-313` defines `executableNames`. Lines 333 and 587 use it.

**Step 2: Read existing test that asserts the available-tools block**

```bash
cd ~/zelari-code && grep -n "AVAILABLE TOOLS\|advertise\|filterExecutable\|workspace tool" tests/unit/cli-councilTools.test.ts | head -10
```

Existing test `council prompts advertise ONLY executable tools (v0.7.5)` covers the inverse: that filtered-out tools are NOT advertised. We need the new behavior: workspace tools MUST be advertised even when not in role.tools.

**Step 3: Write failing test**

Add to `tests/unit/cli-councilTools.test.ts` (or a new file):

```ts
describe('council prompts advertise workspace tools (v0.7.5 Bug B fix)', () => {
  it('workspace tools are advertised even when not in role.tools', async () => {
    // Build a workspace-only registry.
    const { createWorkspaceContext } = await import('../../src/cli/workspace/stubs.js');
    const { createWorkspaceToolRegistry } = await import('../../src/cli/workspace/toolRegistry.js');
    const ctx = createWorkspaceContext(tmpDir);
    const reg = createWorkspaceToolRegistry(ctx);

    // Run a council with a role whose declared tools are NOT in the workspace registry.
    // Use Nettuno (declared: list_files, read_file, grep_content).
    const captured = { systemPrompt: '' };
    const fakeStream = async function* () { yield { type: 'message_end', finishReason: 'stop' }; };
    // ... inject a fake provider that captures the system prompt

    // Assert captured.systemPrompt contains "createPhase", "createTask", etc.
    expect(captured.systemPrompt).toContain('createPhase');
    expect(captured.systemPrompt).toContain('createTask');
  });
});
```

NOTE: Writing this test requires either (a) mocking the provider stream to capture prompts, or (b) using a real provider with a controlled input. Both are heavy. Pragmatic alternative: add a unit test that calls `buildSystemPrompt` directly with a workspace-only registry + Nettuno's role, and asserts the output contains the workspace tool names.

```ts
it('buildSystemPrompt advertises workspace tools for a non-workspace role', async () => {
  const { buildSystemPrompt } = await import('../../packages/core/src/agents/systemPromptBuilder.js');
  const { createWorkspaceContext } = await import('../../src/cli/workspace/stubs.js');
  const { createWorkspaceStubs } = await import('../../src/cli/workspace/stubs.js');
  const ctx = createWorkspaceContext(tmpDir);
  const wsTools = createWorkspaceStubs(ctx);
  const wsNames = wsTools.map((t) => t.name);
  const role = { id: 'nettun', name: 'Nettuno', codename: 'Planner', role: 'Planner', color: '#10b981', avatar: 'N', systemPrompt: 'test', tools: ['list_files'] };

  const prompt = buildSystemPrompt(role as never, {
    tools: wsTools,
    toolNames: wsNames,
    workspaceContext: '',
    ragContext: '',
  });

  expect(prompt).toContain('createPhase');
  expect(prompt).toContain('createTask');
  expect(prompt).toContain('addIdea');
});
```

**Step 4: Run test to verify failure**

```bash
cd ~/zelari-code && npx vitest run tests/unit/cli-councilTools.test.ts -t "advertises workspace tools" 2>&1 | tail -10
```

Expected: FAIL — prompt does not contain `createPhase` because `toolNames` arg is empty (workspace tools not in role.tools).

**Step 5: Apply the fix**

Modify `packages/core/src/agents/councilApi.ts:308-313`:

```ts
// Before:
const executableNames = config.tools ? new Set(config.tools.list()) : null;
const filterExecutable = (names: string[]): string[] =>
  executableNames ? names.filter((n) => executableNames.has(n)) : names;

// After: union workspace tool names so the prompt advertises them.
const workspaceToolNames = config.tools ? config.tools.list() : [];
const executableNames = new Set(workspaceToolNames);
const filterExecutable = (names: string[]): string[] => {
  const merged = Array.from(new Set([...names, ...workspaceToolNames]));
  return executableNames.size > 0 ? merged.filter((n) => executableNames.has(n)) : names;
};
```

Apply same fix at line 587 (chairman loop — same `filterExecutable` is referenced).

**Step 6: Run test to verify pass + full suite**

```bash
cd ~/zelari-code && npx vitest run tests/unit/cli-councilTools.test.ts -t "advertises workspace tools" 2>&1 | tail -10
cd ~/zelari-code && npm test 2>&1 | tail -10
```

Expected: new test PASS, full suite green (875 baseline + 1 new test).

**Step 7: Commit**

```bash
cd ~/zelari-code && git add packages/core/src/agents/councilApi.ts tests/unit/cli-councilTools.test.ts
git commit -m "$(cat <<'EOF'
fix(council): advertise workspace tools even when role.tools differ (Bug B)

filterExecutable was strictly intersecting role.tools with the executor
registry's tool list. When dispatchCouncil auto-wires a workspace-only
registry, the intersection is empty for every role (Nettuno declares
list_files/read_file/grep_content, none of which are workspace stubs).

Effect: the LLM-visible tool list (buildAgentMessages → buildSystemPrompt
→ getToolDescriptions) was empty, so models never saw the workspace tool
names in their AVAILABLE TOOLS block and either guessed or skipped them.
Plutone and Lucifero made only searchDocuments calls (which they
inferred from context) instead of addIdea and createDocument.

Fix: union role.tools with the executor's tool names BEFORE filtering.
Net effect: the prompt advertises whatever the executor can actually run,
even if the role doesn't declare them. The ToolRegistry.invoke gate in
AgentHarness (line 539) is still the source of truth for whether a
tool_call actually executes.

Affects both the specialist loop (line 333) and the chairman loop
(line 587) — they share the same filterExecutable closure.

Test: tests/unit/cli-councilTools.test.ts — new "advertises workspace
tools" case that builds the prompt for Nettuno with a workspace-only
registry and asserts the output contains createPhase/createTask/addIdea.
EOF
)"
```

---

## Task 3: Always run Minosse (Bug C)

**Objective:** Minosse must execute at least once before Lucifero, even when `debateMode: false`.

**Files:**
- Modify: `packages/core/src/agents/councilApi.ts:434-547` (restructure Minosse block)
- Test: existing `tests/unit/cli-council.test.ts` covers size variants

**Step 1: Read current code**

`councilApi.ts:434-547` is the entire Minosse block, gated by `if (config.debateMode && oracle && !completedIds.has(oracle.id))`.

**Step 2: Verify existing test coverage**

```bash
cd ~/zelari-code && grep -n "debateMode\|minos\|oracle" tests/unit/cli-council.test.ts | head -10
```

If no test asserts Minosse runs with `debateMode: false`, add one.

**Step 3: Write failing test**

Add to `tests/unit/cli-council.test.ts`:

```ts
it('runs Minosse even when debateMode is false (Bug C fix)', async () => {
  // ... setup fake provider stream that counts how many agents ran
  // Assert: Caronte, Nettuno, Minosse, Lucifero all execute (4 agent_start events)
  //        but no debate round (single Minosse pass, not iterative)
});
```

**Step 4: Apply the fix**

Restructure lines 434-547 to:

```ts
// Minosse review (always, but debate loop only when debateMode: true)
if (oracle && !completedIds.has(oracle.id)) {
  callbacks.onAgentStart?.(oracle);
  // ... (extract the harness setup + execution into a helper runOracleRound function)
  // If debateMode, loop: runOracleRound(); run specialists; runOracleRound(); ...
  // If not, run once before Lucifero.
}
```

Extract the oracle execution block (lines 461-545) into a helper:

```ts
async function* runOracleRound(opts: {
  sessionId: string;
  userMessage: string;
  config: PureCouncilConfig;
  oracle: AgentRole;
  anonymizedOutputs: { name: string; role: string; content: string }[];
  executableNames: ReadonlySet<string> | null;
  callbacks: PureCouncilCallbacks;
}): AsyncIterable<BrainEvent> { ... }
```

Then in the main function:

```ts
if (oracle && !completedIds.has(oracle.id)) {
  const rounds = config.debateMode ? 2 : 1;
  for (let r = 0; r < rounds; r++) {
    const anonymized = agentOutputs.map((o, i) => ({ ...o, name: `Agent ${i + 1}`, role: 'Specialist' }));
    yield* runOracleRound({ ..., anonymizedOutputs: anonymized });
    if (r < rounds - 1) {
      // Optionally re-run specialists here for true debate. Out of scope for this fix.
    }
  }
}
```

**Step 5: Run tests + full suite**

```bash
cd ~/zelari-code && npx vitest run tests/unit/cli-council.test.ts 2>&1 | tail -10
cd ~/zelari-code && npm test 2>&1 | tail -10
```

**Step 6: Commit**

```bash
cd ~/zelari-code && git add packages/core/src/agents/councilApi.ts tests/unit/cli-council.test.ts
git commit -m "$(cat <<'EOF'
fix(council): run Minosse even when debateMode is false (Bug C)

The Minosse (oracle) review block was gated on config.debateMode.
Default debateMode is false, so a 6-member council (councilSize=6)
silently ran only 5 members: the model emitted agent_start for
Minosse but the orchestrator skipped the execution. Users saw a
member_cost event for a member that never actually ran.

Fix: always run Minosse at least once before Lucifero, but only
loop the debate round (specialist → oracle → specialist → oracle
→ ...) when debateMode is true. The single non-debate Minosse
review is always useful before final synthesis.

Extracts the oracle harness execution into a runOracleRound helper
function to keep the loop body clean. No behavior change for
existing debateMode=true callers.

Test: tests/unit/cli-council.test.ts — new "runs Minosse even when
debateMode is false" case that asserts Minosse emits agent_start +
message_end + member_cost in non-debate mode.
EOF
)"
```

---

## Verification checklist (run after all 3 tasks)

- [ ] `npx tsc --noEmit -p tsconfig.json` clean
- [ ] `npm test` — baseline 875 + 3 new tests (1 per task) = 878 green
- [ ] `npm run smoke` — `zelari-code v0.7.5` printed
- [ ] `npm run build` — bundle builds, no errors
- [ ] Final smoke: re-run the borsa-lusso-react design council, verify all 6 members execute and create their expected artifacts (4 phases + tasks + milestone + 3 docs + 4-6 ADRs + risks.md + synthesis.md)

## Risks

- **Risk**: dynamic import of `@zelari/core/skills` causes load-order cycle in tests. **Mitigation**: same pattern used in `runHeadless.ts:143` which already passes tests. If tests break, check for cyclic deps and fall back to static import (the package exports `setWorkspaceStubs`).
- **Risk**: Task 2 union changes behavior for callers passing both workspace AND non-workspace tools (none today, but future). **Mitigation**: behavior is additive (more tools advertised, never fewer); no tool_call gets rejected that would've been accepted before.
- **Risk**: Task 3 increases token cost by ~10-20% (Minosse always runs now). **Mitigation**: documented in commit message; users can opt out by setting `councilSize: 5` or by submitting the workflow change as a separate proposal.

## Estimated effort

~45 min total: 15 min per task (5 min implementation + 5 min test + 5 min verify).