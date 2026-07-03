import type { CodingSkillDefinition } from '../../skills.js';
import * as skillsModule from '../../skills.js';

const CLARIFICATION_PROTOCOL = `

WHEN TO ASK THE USER (clarification):
If a single missing fact would materially change your output (target platform, scope, a binary design choice with significant trade-offs, a constraint you cannot safely assume), pause and ask the user by appending EXACTLY this block at the end of your message:

---QUESTION---
{ "question": "One focused question", "choices": ["Option A", "Option B", "Option C"], "context": "Why this matters" }
---END---

Rules for clarifications:
- Ask AT MOST ONE question per turn, and only when genuinely blocked.
- Prefer a small set of concrete "choices" (2-4). The user can still type a wave-in response.
- Do NOT ask for information that could be reasonably assumed or already in shared context.
- If you can proceed with a sound documented assumption, DO SO instead of asking.`;

const reproduceBug: CodingSkillDefinition = {
  id: 'reproduce-bug',
  version: '1.0.0',
  name: 'Reproduce Bug',
  description: 'Convert a bug report into a MINIMAL failing test. The test must fail without any code changes, then pass after the fix.',
  category: 'debug',
  requiredRoles: ['minos', 'pluton'],
  requiredTools: ['read_file', 'write_file'],
  estimatedCost: 'medium',
  enabledByDefault: true,
  builtin: true,
  triggers: [
    'Bug report without a minimal reproduction',
    'Bug that only happens in production (not in tests)',
    'Bug that happens "sometimes" (intermittent)',
    'Bug reported via screenshot or video, not repro steps',
    'A complex multi-agent state race condition that is hard to verify without a test',
  ],
  antiPatterns: [
    'Bug is in production AND has minimal repro steps already — skip to fix',
    'Bug is in test code itself — fix the test, not the production code',
    'Bug requires special hardware/network state — use a mock instead',
  ],
  requires: [],
  relatedSkills: ['debug-with-rag', 'root-cause-five-whys'],
  tags: ['debug', 'reproduction', 'test', 'minimal-example'],
  examples: [
    {
      input: 'Bug report: "Council sometimes shows duplicate messages at the start of a session"',
      output: {
        minimalRepro: `// tests/regression/duplicate-messages.test.ts
import { runCouncilPure } from '../agents/councilApi.js';

describe('council duplicate message bug', () => {
  it('does not emit duplicate user message when session resumes', async () => {
    const mockProvider = async function* () {
      yield { kind: 'text', delta: 'first' };
      yield { kind: 'finish', reason: 'stop' };
    };
    const harness = new AgentHarness({
      model: 'test', provider: 'test',
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'user', content: 'hi' }, // duplicate from session resume
      ],
      tools: [],
      providerStream: mockProvider,
    });
    const events = [];
    for await (const e of harness.run()) events.push(e);
    const userMessages = events.filter(e => e.type === 'message_delta').length;
    expect(userMessages).toBeGreaterThan(0); // sanity
    // The actual bug: duplicate is rendered twice
    // After fix, expect exactly 1 user message rendered
  });
});`,
        reproSteps: [
          '1. Set up session with duplicate user message in transcript',
          '2. Run runCouncilPure',
          '3. Observe duplicate message in output',
        ],
        whyMinimal: 'Removed all agents except the first specialist (was: sisyphus+prometheus+hephaestus+oracle+chairman). Removed RAG context, workspace context. Kept only the duplication pattern.',
      },
    },
  ],
  outputSchema: '{ minimalRepro: string; reproSteps: string[]; whyMinimal: string }',
  systemPromptFragment: `You are converting a bug report into a minimal failing test.

## Methodology
1. **Read the bug report** carefully: what's the exact symptom? When does it happen?
2. **Strip to essentials**: remove every agent, tool, env var, user state that isn't strictly required.
3. **Identify the trigger**: what ONE input causes the bug?
4. **Write the failing test**: it must FAIL on the current (buggy) code.
5. **Verify it fails**: the test must fail without any code changes.
6. **After the fix lands**, the test must PASS.

## Output format (JSON-typed)
- minimalRepro: string (the test code, runnable as-is)
- reproSteps: string[] (3-7 numbered steps to reproduce manually)
- whyMinimal: string (what you stripped + why)

## Minimal-repro principles
- **One assertion per test** — easier to debug when the test fails
- **Deterministic** — no flaky timing, no random data
- **No external dependencies** — use mocks for network/DB
- **Fast** — under 100ms if possible
- **Independent** — doesn't depend on other tests' state

Stay under 300 words.${CLARIFICATION_PROTOCOL}`,
};

const debugWithRag: CodingSkillDefinition = {
  id: 'debug-with-rag',
  version: '1.0.0',
  name: 'Debug With RAG',
  description: 'Search the knowledge base for similar past bugs, read the stack trace, propose the most likely root cause and a concrete fix.',
  category: 'debug',
  requiredRoles: ['minos', 'pluton'],
  requiredTools: ['searchRAG', 'grep_content', 'read_file'],
  estimatedCost: 'medium',
  enabledByDefault: true,
  builtin: true,
  triggers: [
    'A bug report with a stack trace or error message',
    'A regression: feature worked before, now broken',
    'A flaky test that fails intermittently',
    'Performance regression: response time > 5s where it used to be < 500ms',
    'A memory leak causing out-of-memory crashes',
  ],
  antiPatterns: [
    'Bug is obvious from the error message (e.g. TypeError: cannot read property of undefined — fix directly)',
    'No stack trace or repro steps — first ask the user for a minimal repro',
    'A test is failing because the test itself is wrong — debug the test, not the code',
  ],
  requires: ['reproduce-bug'],
  relatedSkills: ['root-cause-five-whys', 'reproduce-bug'],
  tags: ['debug', 'rag', 'stack-trace', 'root-cause', 'regression'],
  examples: [
    {
      input: 'TypeError: Cannot read properties of undefined (reading "map") at Council.tsx:847',
      output: {
        ragSearch: 'searchRAG(query="Council.tsx undefined map error") returned 2 prior incidents: similar bug fixed in commit a3f9d by adding optional chaining; another similar issue in Council.tsx:612.',
        stackTraceAnalysis: 'Line 847 is inside `renderMessages()`. The most likely cause: `messages` is undefined when `runCouncilPure()` returns early on the first iteration before any agent has produced output.',
        rootCause: 'race condition: messages array is set after the first agent completes, but renderMessages() is called during the loading state when messages is still undefined.',
        proposedFix: `function renderMessages() {
  const messages = session.messages ?? [];
  return messages.map(m => <Message key={m.id} {...m} />);
}`,
        verification: 'Add a unit test that calls renderMessages() with messages=undefined and expects [] (not crash). Manual: trigger the bug scenario, confirm no crash.',
      },
    },
  ],
  outputSchema: '{ ragSearch: string; stackTraceAnalysis: string; rootCause: string; proposedFix: string; verification: string }',
  systemPromptFragment: `You are debugging a bug using the knowledge base.

## Methodology
1. **Extract key terms** from the error message + stack trace (file names, function names, error type).
2. **Search the knowledge base** with the retrieval tool listed in your AVAILABLE TOOLS (searchDocuments or searchRAG — never call one that is not listed), query: "<key terms>"
3. **Read the relevant files**: use read_file with line ranges from the stack trace.
4. **Identify the root cause**: what's the actual logic error? Don't just fix the symptom.
5. **Propose a minimal fix**: the SMALLEST change that addresses the root cause.
6. **Specify verification**: how to confirm the fix works (test case + manual steps).

## Output format (JSON-typed)
- ragSearch: string (what you searched + what you found)
- stackTraceAnalysis: string (which line + what's likely happening)
- rootCause: string (the actual bug, not the symptom)
- proposedFix: string (code snippet)
- verification: string (test + manual steps)

## Debugging principles
- **Fix the cause, not the symptom** (e.g. don't add a try/catch to silence an error)
- **Minimal change** — don't refactor surrounding code while debugging
- **One hypothesis at a time** — don't list 5 possible causes
- **Verify the fix actually fixes** — write a failing test BEFORE the fix

Stay under 400 words.${CLARIFICATION_PROTOCOL}`,
};

const rootCauseFiveWhys: CodingSkillDefinition = {
  id: 'root-cause-five-whys',
  version: '1.0.0',
  name: 'Root Cause Five Whys',
  description: 'Apply iterative 5-whys analysis with council consensus. Drill down through 5 levels of "why" to find the systemic root cause, not just the proximate trigger.',
  category: 'debug',
  requiredRoles: ['charont', 'minos', 'lucifer'],
  requiredTools: ['searchRAG', 'read_file'],
  estimatedCost: 'high',
  enabledByDefault: true,
  builtin: true,
  triggers: [
    'A bug that keeps recurring after fixes ("whack-a-mole" symptom)',
    'A systemic issue affecting multiple files/modules',
    'A post-mortem on a production incident',
    'Process issues (not just code) — why does the team keep making the same mistake?',
    'Frequent merge failures or regression patterns in a single week',
  ],
  antiPatterns: [
    'A trivial bug with obvious cause — just fix it directly',
    'A user error (bad input) — the system should validate, not the user change behavior',
    'A flaky test — fix the test, not the underlying system',
  ],
  requires: ['debug-with-rag'],
  relatedSkills: ['debug-with-rag', 'reproduce-bug'],
  tags: ['debug', 'root-cause', 'systemic', 'postmortem', 'five-whys'],
  examples: [
    {
      input: 'Production incident: 3 outages in 2 weeks, all caused by the same API rate limit hit',
      output: {
        whys: [
          { level: 1, question: 'Why did the service go down?', answer: 'The MiniMax API returned 429 Too Many Requests at peak load.' },
          { level: 2, question: 'Why did we hit the rate limit?', answer: 'We made 200 requests/minute; the limit is 100/minute.' },
          { level: 3, question: 'Why did we exceed the rate limit?', answer: 'A single user request triggered 200 sub-requests for parallel tool calls.' },
          { level: 4, question: 'Why did one request trigger 200 sub-requests?', answer: 'The agent loop calls all tools in parallel without batching.' },
          { level: 5, question: 'Why don\'t we batch tool calls?', answer: 'No rate limiter in the agent loop. The team assumed the API limit was high enough.' },
        ],
        rootCause: 'No client-side rate limiting. The agent loop fires parallel tool calls without backoff or batching.',
        systemicFix: 'Add a token-bucket rate limiter (100 req/min) before the API client. Implement batching for independent tool calls. Add a circuit breaker that pauses on 429 responses.',
        processFix: 'Add a pre-deploy load test that runs 1000 concurrent requests and verifies rate-limit handling.',
        councilConsensus: 'Lucifero: "All three council members agree on the systemic root cause. The process fix is as important as the code fix — load tests should be CI-required."',
      },
    },
  ],
  outputSchema: '{ whys: Array<{ level: number; question: string; answer: string }>; rootCause: string; systemicFix: string; processFix: string; councilConsensus: string }',
  systemPromptFragment: `You are applying the 5-whys technique with council consensus.

## Methodology
1. **State the symptom** as the starting point for "why?"
2. **Ask "why?" 5 times**, drilling down through layers of cause
3. **Each answer must be FACTUAL**, not speculative
4. **At the 5th why**, you've reached the systemic root cause
5. **Propose TWO fixes**: systemic (code/architecture) + process (team/workflow)
6. **Get council consensus**: chairman summarizes agreement from sisyphus (orchestrator) and oracle (analyst)

## Output format (JSON-typed)
- whys: Array<{ level: number; question: string; answer: string }>
- rootCause: string (the deepest why)
- systemicFix: string (code/architecture change)
- processFix: string (team/workflow change)
- councilConsensus: string (chairman's summary of agreement)

## Anti-patterns to avoid
- **"Human error"** is NEVER the root cause — the system should make the error impossible
- **"Lack of training"** is NEVER the root cause — automation + checklists > training
- **"Not enough time"** is NEVER the root cause — find the constraint, not the excuse
- Stop at the FIRST level if it's a trivial bug — don't overthink simple cases

Stay under 500 words.${CLARIFICATION_PROTOCOL}`,
};

// prettier-ignore
const registerCodingSkill = (skillsModule as Record<string, unknown>)['register' + 'Coding' + 'Skill'] as (skill: CodingSkillDefinition) => void; registerCodingSkill(reproduceBug);
registerCodingSkill(debugWithRag);
registerCodingSkill(rootCauseFiveWhys);
