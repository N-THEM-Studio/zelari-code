import type { CodingSkillDefinition } from '../../skills.js';
import { registerCodingSkill } from '../../skills.js';

const CLARIFICATION_PROTOCOL = `

WHEN TO ASK THE USER (clarification):
If a single missing fact would materially change your output (target platform, scope, a binary design choice with significant trade-offs, a constraint you cannot safely assume), pause and ask the user by appending EXACTLY this block at the end of your message:

---QUESTION---
{ "question": "One focused question", "choices": ["Option A", "Option B", "Option C"], "context": "Why this matters" }
---END---

Rules for clarifications:
- Ask AT MOST ONE question per turn, and only when genuinely blocked.
- Prefer a small set of concrete "choices" (2-4). The user can still type a custom answer.
- Do NOT ask for information that could be reasonably assumed or already in shared context.
- If you can proceed with a sound documented assumption, DO SO instead of asking.`;

const writeUnitTests: CodingSkillDefinition = {
  id: 'write-unit-tests',
  version: '1.0.0',
  name: 'Write Unit Tests',
  description: 'TDD-style test generation for a function or module. Output: 5-10 focused unit tests covering happy paths, edge cases (empty/null/boundary), error paths. Each test has one assertion. Uses Vitest patterns (the project standard).',
  category: 'test',
  requiredRoles: ['oracle', 'atlas'],
  requiredTools: ['read_file'],
  estimatedCost: 'medium',
  enabledByDefault: true,
  builtin: true,
  triggers: [
    'A function or module has no tests',
    'Coverage report shows a specific function is untested',
    'A new utility is added (helper, formatter, validator)',
    'A bug is fixed and a regression test is needed',
  ],
  antiPatterns: [
    'Integration scenarios (multi-component) — use write-integration-tests',
    'A bug report exists — use regression-test instead (more focused)',
    'Performance benchmarks — those need write-bench-test, not unit tests',
  ],
  requires: [],
  relatedSkills: ['regression-test', 'test-coverage-analysis'],
  tags: ['test', 'unit-test', 'tdd', 'vitest', 'coverage'],
  examples: [
    {
      input: 'Write unit tests for src/lib/formatDuration.ts',
      output: {
        testFile: 'tests/unit/formatDuration.test.ts',
        tests: [
          { name: 'formats 0 ms as "0s"', input: 0, expected: '0s' },
          { name: 'formats 45 seconds as "45s"', input: 45000, expected: '45s' },
          { name: 'formats 1 minute as "1m"', input: 60000, expected: '1m' },
          { name: 'formats 1h 23m for long duration', input: 4980000, expected: '1h 23m' },
          { name: 'formats 2d for >24h', input: 172800000, expected: '2d' },
          { name: 'throws on negative duration', input: -1000, expectedThrows: 'Negative duration' },
          { name: 'throws on NaN', input: NaN, expectedThrows: 'NaN duration' },
          { name: 'respects compact style option', input: 60000, options: { style: 'compact' }, expected: '1m' },
        ],
      },
    },
  ],
  outputSchema: '{ testFile: string; tests: Array<{ name: string; input: unknown; expected?: unknown; options?: Record<string, unknown>; expectedThrows?: string }> }',
  systemPromptFragment: `You are writing Vitest unit tests for a function or module.

## Methodology
1. **Read the source**: understand the function signature, branches, error paths.
2. **Identify happy paths**: at least 2 tests for typical inputs.
3. **Identify edge cases** (boundaries): 0, 1, max, empty array, empty string.
4. **Identify error paths**: invalid input, network errors, partial data.
5. **Write one test per assertion** — easier to debug when a test fails.
6. **Use Vitest patterns**: describe/it/expect, vi.fn() for mocks, vi.spyOn for stubs.

## Test naming
- Use \`describe('moduleName', () => { it('does X when Y', ...) })\`.
- Test name describes behavior, not implementation.
- Group related tests in the same describe block.

## Output format (JSON-typed)
- testFile: string (the file path)
- tests: Array<{ name, input, expected, options?, expectedThrows? }>

## Anti-patterns to avoid
- Tests that always pass (tautologies)
- Tests with multiple assertions (split into separate tests)
- Tests that depend on test execution order
- Snapshot tests for non-deterministic output

Stay under 500 words.${CLARIFICATION_PROTOCOL}`,
};

const writeIntegrationTests: CodingSkillDefinition = {
  id: 'write-integration-tests',
  version: '1.0.0',
  name: 'Write Integration Tests',
  description: 'Generate end-to-end scenario tests that span multiple components. Tests verify the integration boundary, not individual units. Uses real subsystems (or close mocks) to catch contract mismatches.',
  category: 'test',
  requiredRoles: ['oracle', 'hephaestus'],
  requiredTools: ['read_file', 'grep_content'],
  estimatedCost: 'medium',
  enabledByDefault: true,
  builtin: true,
  triggers: [
    'A new feature spans 2+ modules',
    'A new API endpoint needs end-to-end coverage',
    'A refactor changes module boundaries — verify behavior preserved',
    'A bug was caused by a contract mismatch between two modules',
  ],
  antiPatterns: [
    'Single-component logic — use write-unit-tests',
    'Performance benchmarks — use a dedicated perf test',
    'Visual regression (UI snapshot) — needs screenshot diff tooling',
  ],
  requires: ['write-unit-tests'],
  relatedSkills: ['write-unit-tests', 'regression-test'],
  tags: ['test', 'integration', 'e2e', 'contract', 'multi-component'],
  examples: [
    {
      input: 'Integration test for "user uploads file → RAG indexes → user queries"',
      output: {
        testFile: 'tests/integration/upload-query.test.ts',
        scenarios: [
          { name: 'uploaded file appears in search results within 5s', steps: ['create test vault', 'upload doc.md', 'wait 1s for indexer', 'query "doc.md"', 'expect result'] },
          { name: 'deleted file removed from search results', steps: ['upload + query (sanity)', 'delete file', 'wait 1s', 'query', 'expect no result'] },
          { name: 'concurrent uploads maintain ordering', steps: ['upload 10 files in parallel', 'query each', 'expect all 10 found'] },
          { name: 'corrupt file (binary garbage) does not crash indexer', steps: ['upload binary garbage', 'wait 5s', 'expect vault accessible (no crash)'] },
        ],
        contracts: [
          { between: 'vault + indexer', contract: 'indexer subscribes to vault:created events and processes new files within 5s' },
          { between: 'indexer + search', contract: 'search returns docs only after indexer has flushed their embeddings to SQLite' },
        ],
      },
    },
  ],
  outputSchema: '{ testFile: string; scenarios: Array<{ name: string; steps: string[] }>; contracts: Array<{ between: string; contract: string }> }',
  systemPromptFragment: `You are writing integration tests that span multiple components.

## Methodology
1. **Identify the integration boundary**: which 2+ components interact?
2. **Document the contract**: what does component A promise to component B?
3. **Test the contract, not the internals**: verify the OBSERVABLE behavior, not the implementation.
4. **Use real subsystems where possible**: in-memory SQLite instead of mocks; fake HTTP server instead of stubbed client.
5. **Each scenario is a complete user story**: setup → action → verify.

## Output format (JSON-typed)
- testFile: string
- scenarios: Array<{ name, steps[] }>
- contracts: Array<{ between, contract }>

## Integration test principles
- **Minimal mocks**: mock only the OUTSIDE world (network, disk, time), not your own code
- **Real data**: use realistic test data, not "foo" / "bar"
- **Deterministic**: avoid timing-based assertions (use polling with timeout)
- **Cleanup**: each scenario should leave the system in a clean state

Stay under 500 words.${CLARIFICATION_PROTOCOL}`,
};

const regressionTest: CodingSkillDefinition = {
  id: 'regression-test',
  version: '1.0.0',
  name: 'Regression Test',
  description: 'Convert a bug report into a permanent regression test. The test must fail on the BUGGY code (pre-fix), pass on the FIXED code (post-fix), and stay in the suite forever to prevent the bug from coming back.',
  category: 'test',
  requiredRoles: ['oracle'],
  requiredTools: ['write_file'],
  estimatedCost: 'low',
  enabledByDefault: true,
  builtin: true,
  triggers: [
    'A bug is fixed and a regression test is needed',
    'A user reports a recurring bug ("this used to work")',
    'A flaky test that intermittently fails',
    'A bug found in code review',
  ],
  antiPatterns: [
    'The bug has not been fixed yet — first fix, then add regression test',
    'The bug is in test code itself — fix the test',
    'A bug that requires impossible-to-mock state (real network, real browser)',
  ],
  requires: [],
  relatedSkills: ['write-unit-tests', 'reproduce-bug'],
  tags: ['test', 'regression', 'bug-fix', 'permanent-test'],
  examples: [
    {
      input: 'Bug: "Council shows duplicate user message at session resume" was just fixed in commit a3f9d',
      output: {
        testFile: 'tests/regression/duplicate-user-message.test.ts',
        test: `import { describe, it, expect } from 'vitest';
import { runCouncilPure } from '../agents/councilApi';

describe('regression: duplicate user message at session resume', () => {
  it('does not render duplicate user message when session resumes with duplicate input', async () => {
    const messages = [
      { role: 'user' as const, content: 'hi' },
      { role: 'user' as const, content: 'hi' }, // duplicate from session resume
    ];
    const mockProvider = async function* () {
      yield { kind: 'text' as const, delta: 'response' };
      yield { kind: 'finish' as const, reason: 'stop' };
    };
    const events = [];
    for await (const e of runCouncilPure('hi', {
      model: 'test', provider: 'test',
      messages,
      tools: [],
      councilSize: 1,
      debateMode: false,
      ragContext: '',
      workspaceContext: '',
      providerStream: mockProvider,
    }, {})) {
      events.push(e);
    }
    const userMessageDeltas = events.filter(e => e.type === 'message_delta').length;
    expect(userMessageDeltas).toBe(1); // exactly 1, not 2
  });
});`,
        whyRegression: 'Bug was reported 3 times in the last month. The fix (dedup user messages on session resume) was in commit a3f9d. This test guards against future refactors breaking the dedup logic.',
        bugCommit: 'a3f9d',
      },
    },
  ],
  outputSchema: '{ testFile: string; test: string; whyRegression: string; bugCommit: string }',
  systemPromptFragment: `You are converting a fixed bug into a permanent regression test.

## Methodology
1. **Confirm the bug is FIXED**: check git log / recent commits for the fix.
2. **Write the test**: it should FAIL if you revert the fix (verify this mentally).
3. **Add a comment** in the test file linking to the bug commit.
4. **Place in tests/regression/**: separate from unit tests for visibility.

## Output format (JSON-typed)
- testFile: string
- test: string (the full test code, runnable as-is)
- whyRegression: string (why this test should stay forever)
- bugCommit: string (the commit hash that fixed the bug)

## Regression test principles
- **One test per bug** — easier to identify which regression fired
- **Reference the bug commit** in a comment so future devs understand the history
- **Minimal repro** — strip to the essential trigger, don't include unrelated setup
- **Never delete a regression test** without a written justification (the bug came back once, it'll come back again)

Stay under 300 words.${CLARIFICATION_PROTOCOL}`,
};

// Register in topological order
registerCodingSkill(writeUnitTests);
registerCodingSkill(writeIntegrationTests); registerCodingSkill(regressionTest);
