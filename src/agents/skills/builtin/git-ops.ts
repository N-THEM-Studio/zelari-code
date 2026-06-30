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

const commitMessage: CodingSkillDefinition = {
  id: 'commit-message',
  version: '1.0.0',
  name: 'Commit Message',
  description: 'Generate a Conventional Commits message from a staged git diff. Format: <type>(<scope>): <subject>. Body explains WHY. Footer references issues.',
  category: 'ops',
  requiredRoles: ['atlas'],
  requiredTools: [],
  estimatedCost: 'low',
  enabledByDefault: true,
  builtin: true,
  triggers: [
    'A developer has staged changes and needs a commit message',
    'A PR description requires a list of conventional commits',
    'A CHANGELOG is generated from commit history',
  ],
  antiPatterns: [
    'Empty diff (nothing staged) — fail fast',
    'Merge commits or reverts — different format',
    'Multi-purpose commits (refactor + feat + fix in one) — split first',
  ],
  requires: [],
  relatedSkills: ['pr-description', 'write-changelog'],
  tags: ['git', 'commit', 'conventional-commits', 'changelog'],
  examples: [
    {
      input: 'Staged diff: 3 files changed, +45/-12. Adds brain event types and EventBus class.',
      output: {
        subject: 'feat(events): add BrainEvent types + EventBus (Phase 11)',
        body: `Adds the provider-neutral event layer:
- 12 BrainEvent discriminated union types
- EventBus class with typed subscribers + error isolation
- emit/subscribe/subscribeAll API

Foundation for Phase 12 (AgentHarness extraction).`,
        footer: 'Refs: docs/plans/2026-06-28-anathema-coder.md',
        type: 'feat',
        scope: 'events',
      },
    },
  ],
  outputSchema: '{ subject: string; body: string; footer: string; type: "feat" | "fix" | "refactor" | "docs" | "test" | "chore" | "perf" | "style"; scope: string }',
  systemPromptFragment: `You are writing a Conventional Commits message.

## Format
<type>(<scope>): <subject>

<body — explain WHY, not WHAT>

<footer — issue refs, breaking changes>

## Types
- feat: new feature
- fix: bug fix
- refactor: code change that neither fixes a bug nor adds a feature
- docs: documentation only
- test: adding/correcting tests
- chore: build/tooling changes (deps, CI, config)
- perf: performance improvement
- style: formatting, missing semicolons, etc. (no logic change)

## Subject rules
- Imperative mood ("add" not "added")
- Lowercase (except proper nouns)
- Max 72 characters
- No trailing period

## Body rules
- Wrap at 72 characters
- Explain WHY the change was made
- Bullet points for multiple distinct changes

## Footer rules
- \`Refs: #123\` for related issues
- \`BREAKING CHANGE: <description>\` for breaking changes
- \`Co-authored-by: Name <email>\` for pair work

## Output format (JSON-typed)
- subject: string
- body: string
- footer: string
- type: ConventionalCommitType
- scope: string (optional, lowercase module name)

Stay under 300 words.${CLARIFICATION_PROTOCOL}`,
};

const prDescription: CodingSkillDefinition = {
  id: 'pr-description',
  version: '1.0.0',
  name: 'PR Description',
  description: 'Generate a pull request description with sections: Summary, Motivation, Changes, Testing, Screenshots, Risks. Synthesizes from commits + diff + related issues.',
  category: 'ops',
  requiredRoles: ['prometheus', 'atlas'],
  requiredTools: [],
  estimatedCost: 'medium',
  enabledByDefault: true,
  builtin: true,
  triggers: [
    'A PR is ready for review and needs a description',
    'A PR template requires filling in structured sections',
    'A large change (>200 LOC) needs careful framing for reviewers',
  ],
  antiPatterns: [
    'A 1-line typo fix — title only, no body needed',
    'A WIP / draft PR — defer until ready',
    'Generated code (codegen output) — link to the generator instead',
  ],
  requires: ['commit-message'],
  relatedSkills: ['commit-message', 'write-changelog'],
  tags: ['git', 'pr', 'pull-request', 'review', 'documentation'],
  examples: [
    {
      input: 'PR for Phase 11 of AnathemaCoder: BrainEvent types + EventBus + LLM streaming wiring',
      output: {
        title: 'Phase 11: Provider-neutral events foundation',
        summary: 'Introduces the BrainEvent discriminated union and EventBus — the provider-neutral contract between LLM providers and any frontend (Electron renderer today, Ink CLI in Phase 14).',
        motivation: 'The current IPC bridge (\`emitChunk\`/\`emitDone\`) couples every frontend to provider-specific chunks. Any new frontend (CLI, mobile, web) would need to duplicate SSE parsing per provider. This is the foundation that lets Phase 12 extract an AgentHarness usable from any context.',
        changes: [
          'Added \`electron/shared/events.ts\` — 12 discriminated union types (agent_start, message_delta, tool_execution_start, etc.)',
          'Added \`electron/shared/eventBus.ts\` — typed pub/sub with error isolation',
          'Wired 5 local emit helpers in \`electron/main/ipc/llm.ts\` (emitAgentStart, emitMessageStart, emitMessageDelta, emitMessageEnd, emitBrainError)',
          'Tool execution emits \`BrainToolExecutionStartEvent\` when provider yields tool_call',
          'Council emits \`agent_start\` / \`agent_end\` at run boundaries',
          '6 new vitest tests for EventBus (typed delivery, wildcard, error isolation)',
        ],
        testing: '96/96 tests passing. New: 6 EventBus tests in tests/unit/eventBus.test.ts. Manual: existing Electron renderer unchanged (verified Council chat still streams correctly).',
        risks: [
          'Adding event emission alongside IPC is purely additive — no migration needed for existing renderer code.',
          'Council event timing verified manually: agent_start fires before any message events, agent_end fires after.',
        ],
      },
    },
  ],
  outputSchema: '{ title: string; summary: string; motivation: string; changes: string[]; testing: string; risks: string[] }',
  systemPromptFragment: `You are writing a Pull Request description.

## Sections (use all)
1. **Title** (max 72 chars, imperative mood)
2. **Summary** (1 paragraph): what does this PR do?
3. **Motivation** (1-2 paragraphs): WHY? What problem does it solve?
4. **Changes** (bullet list, 5-15 items): specific files/concepts changed
5. **Testing** (1 paragraph): how was it verified? Test counts, manual steps
6. **Risks** (bullet list, 2-5 items): what could go wrong? Migration needed?

## Output format (JSON-typed)
- title: string
- summary: string
- motivation: string
- changes: string[]
- testing: string
- risks: string[]

## PR description principles
- **Reviewer-first**: optimize for someone who has NEVER seen this code
- **Concrete not abstract**: cite file paths, line numbers, function names
- **Risk-honest**: don't hide breaking changes or migration steps
- **Self-contained**: PR description should make sense without clicking through to issues

Stay under 500 words.${CLARIFICATION_PROTOCOL}`,
};

const ciPipeline: CodingSkillDefinition = {
  id: 'ci-pipeline',
  version: '1.0.0',
  name: 'CI Pipeline',
  description: 'Generate a GitHub Actions workflow YAML that runs typecheck + lint + test + build on every push and PR. Configures Node version, caching, and failure annotations.',
  category: 'ops',
  requiredRoles: ['atlas'],
  requiredTools: [],
  estimatedCost: 'medium',
  enabledByDefault: true,
  builtin: true,
  triggers: [
    'A project is being open-sourced and needs CI',
    'Existing CI is missing a step (e.g. no typecheck)',
    'A new test framework is added',
    'A release pipeline is being automated',
  ],
  antiPatterns: [
    'The project has no tests yet — write tests first, then CI',
    'A different CI system is in use (CircleCI, GitLab CI) — use that one',
    'The project is a personal/internal tool (CI rarely matters)',
  ],
  requires: [],
  relatedSkills: ['write-changelog'],
  tags: ['ci', 'github-actions', 'automation', 'pipeline'],
  examples: [
    {
      input: 'Generate GitHub Actions for AnathemaBrain (Electron + React + TS + Vitest)',
      output: {
        workflowFile: '.github/workflows/ci.yml',
        content: `name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    strategy:
      matrix:
        node-version: [20.x]

    steps:
      - uses: actions/checkout@v4

      - name: Setup Node.js \${{ matrix.node-version }}
        uses: actions/setup-node@v4
        with:
          node-version: \${{ matrix.node-version }}
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Typecheck (node config)
        run: npm run typecheck:node

      - name: Typecheck (web config)
        run: npm run typecheck:web

      - name: Lint
        run: npm run lint

      - name: Test
        run: npm run test

      - name: Build (Electron renderer + main)
        run: npm run build

      - name: Upload coverage
        if: success()
        uses: actions/upload-artifact@v4
        with:
          name: coverage-\${{ matrix.node-version }}
          path: coverage/
`,
        jobs: ['test'],
        triggers: ['push to main', 'pull_request to main'],
        nodeVersion: '20.x',
      },
    },
  ],
  outputSchema: '{ workflowFile: string; content: string; jobs: string[]; triggers: string[]; nodeVersion: string }',
  systemPromptFragment: `You are writing a GitHub Actions workflow YAML.

## Required structure
1. **name**: workflow display name
2. **on**: triggers (push to main, pull_request, manual workflow_dispatch)
3. **jobs**: at least one job with steps
4. **runs-on**: ubuntu-latest (default)
5. **timeout-minutes**: 15 (default, increase for slower builds)
6. **matrix.node-version**: pin to a specific major version (e.g. 20.x)

## Standard steps (in order)
1. actions/checkout@v4
2. actions/setup-node@v4 with cache: 'npm'
3. npm ci (NOT npm install — faster in CI)
4. typecheck (run the project's typecheck script)
5. lint (run the project's lint script)
6. test (run the project's test script)
7. build (run the project's build script, if applicable)

## Output format (JSON-typed)
- workflowFile: string (path like .github/workflows/ci.yml)
- content: string (the full YAML)
- jobs: string[] (job names)
- triggers: string[] (trigger events)
- nodeVersion: string (pinned Node version)

## CI principles
- **Fail fast**: order steps from fastest → slowest (typecheck before build)
- **Cache dependencies**: cache: 'npm' saves 30s+ on cold builds
- **Pin versions**: use @v4 not @latest for reproducibility
- **Don't cache build artifacts**: cache only deps
- **Separate jobs for parallel**: typecheck, lint, test can be parallel jobs

Stay under 500 words.${CLARIFICATION_PROTOCOL}`,
};

registerCodingSkill(commitMessage);
registerCodingSkill(prDescription);
registerCodingSkill(ciPipeline);
