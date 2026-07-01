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

const writeReadme: CodingSkillDefinition = {
  id: 'write-readme',
  version: '1.0.0',
  name: 'Write README',
  description: 'Generate a project README from the codebase. Sections: Title, Badges, Description, Quick Start, Architecture, Development, Testing, Deployment, Contributing, License.',
  category: 'docs',
  requiredRoles: ['nettun', 'pluton'],
  requiredTools: ['read_file', 'grep_content'],
  estimatedCost: 'medium',
  enabledByDefault: true,
  builtin: true,
  triggers: [
    'A new project is being created',
    'Existing README is missing or stale',
    'A project is being open-sourced',
    'Onboarding new team members (they read the README first)',
  ],
  antiPatterns: [
    'README exists and is recent — update instead of regenerate',
    'Personal/internal project (README rarely matters)',
    'Library with auto-generated docs from source code comments',
  ],
  requires: [],
  relatedSkills: ['write-tsdoc', 'write-changelog'],
  tags: ['docs', 'readme', 'onboarding', 'open-source'],
  examples: [
    {
      input: 'Generate README for AnathemaBrain (Electron + React + TypeScript AI agent platform)',
      output: {
        readme: `# AnathemaBrain

> An educational Python project for learning how coding agents are built.

AnathemaBrain is an Electron desktop app... (truncated)

## Quick Start

\`\`\`bash
npm install
npm run dev
\`\`\`

## Architecture

- **Main process** (electron/main/): Node.js, IPC handlers, LLM streaming
- **Renderer** (src/): React 19 UI, Zustand stores
- **Agent system** (src/agents/): Council multi-agent orchestration

## Development

\`\`\`bash
npm run typecheck
npm run test
npm run lint
\`\`\`

## Testing

96+ tests via Vitest + jsdom.

## Deployment

\`\`\`bash
npm run build
npm run electron:build
\`\`\`

## Contributing

See docs/plans/ for active roadmaps. Pull requests welcome.

## License

Apache 2.0
`,
        sections: ['Title + tagline', 'Badges', 'Description', 'Quick Start', 'Architecture diagram', 'Development commands', 'Testing', 'Deployment', 'Contributing link', 'License'],
      },
    },
  ],
  outputSchema: '{ readme: string; sections: string[] }',
  systemPromptFragment: `You are writing a project README.md.

## Required sections (in order)
1. **Title + tagline** (1 sentence): what is this project?
2. **Badges** (optional): CI status, npm version, license
3. **Description** (2-3 paragraphs): what does it do, who is it for
4. **Quick Start** (5-10 lines): install + run + see something working
5. **Architecture** (1-2 paragraphs + diagram): high-level structure
6. **Development** (commands): how to run tests, typecheck, lint
7. **Testing**: what kind of tests exist, how to run them
8. **Deployment** (if applicable): how to build + ship
9. **Contributing**: link to CONTRIBUTING.md or describe PR process
10. **License**: license type

## Output format (JSON-typed)
- readme: string (the full README content in markdown)
- sections: string[] (the sections you included)

## README principles
- **Show, don't tell**: code examples for non-trivial concepts
- **Up-to-date**: don't include commands that don't work
- **Scannable**: use headers, bullets, code blocks
- **One page max**: link to deeper docs rather than nesting everything

Stay under 600 words.${CLARIFICATION_PROTOCOL}`,
};

const writeTsdoc: CodingSkillDefinition = {
  id: 'write-tsdoc',
  version: '1.0.0',
  name: 'Write TSDoc',
  description: 'Generate TSDoc/JSDoc comments for undocumented exports. Output: docstrings with @param, @returns, @throws, @example tags following the TSDoc standard.',
  category: 'docs',
  requiredRoles: ['pluton'],
  requiredTools: ['read_file'],
  estimatedCost: 'low',
  enabledByDefault: true,
  builtin: true,
  triggers: [
    'A function or class lacks documentation',
    'A public API is exported without TSDoc',
    'IDE intellisense shows "any" or missing info for a function',
    'A new utility is added to a shared library',
  ],
  antiPatterns: [
    'The function is private/internal — no need for TSDoc',
    'Auto-generated docs already exist (typedoc, etc.)',
    'The function is self-explanatory (getName → returns name)',
  ],
  requires: [],
  relatedSkills: ['write-readme'],
  tags: ['docs', 'tsdoc', 'jsdoc', 'intellisense', 'api-docs'],
  examples: [
    {
      input: 'Add TSDoc to src/lib/formatDuration.ts',
      output: {
        documented: `/**
 * Formats a duration in milliseconds as a human-readable string.
 *
 * @param ms - Duration in milliseconds. Must be a non-negative finite number.
 * @param opts - Formatting options.
 * @param opts.style - 'compact' (1h 23m), 'full' (1:23:45), or 'minimal' (23m).
 *   Defaults to 'compact'.
 * @returns The formatted duration string.
 * @throws {RangeError} If ms is negative.
 * @throws {TypeError} If ms is NaN or Infinity.
 *
 * @example
 *   formatDuration(4980000);                       // '1h 23m'
 *   formatDuration(4980000, { style: 'full' });    // '1:23:45'
 *   formatDuration(60000, { style: 'minimal' });   // '1m'
 */
export function formatDuration(ms: number, opts?: { style?: 'compact' | 'full' | 'minimal' }): string {
  // ... existing implementation
}`,
        tagsAdded: ['@param', '@param (nested)', '@returns', '@throws x2', '@example'],
      },
    },
  ],
  outputSchema: '{ documented: string; tagsAdded: string[] }',
  systemPromptFragment: `You are writing TSDoc comments for a TypeScript function or class.

## TSDoc tags (use these)
- \`@param {type} name - description\` — for each parameter
- \`@returns description\` (or \`@return\` legacy alias)
- \`@throws {ErrorType} condition\` — for each throw path
- \`@example\` followed by code block (for non-trivial usage)
- \`@deprecated reason\` — if the function is being phased out
- \`@see FunctionName\` — for cross-references
- \`@remarks\` — additional context
- \`@internal\` — for internal helpers (suppresses from public docs)

## Output format (JSON-typed)
- documented: string (the full code block with TSDoc added)
- tagsAdded: string[] (which tags you included)

## TSDoc principles
- **First sentence is the summary**: ends with a period, capital letter
- **One @param per parameter**: don't omit even if obvious
- **@throws for EVERY throw path**: callers need to know
- **@example for non-trivial usage**: best way to communicate intent
- **No marketing language**: just describe what the function does
- **No implementation details**: TSDoc is for the API contract, not internals

Stay under 400 words.${CLARIFICATION_PROTOCOL}`,
};

const writeChangelog: CodingSkillDefinition = {
  id: 'write-changelog',
  version: '1.0.0',
  name: 'Write Changelog',
  description: 'Generate a CHANGELOG.md entry from git history. Follows Keep a Changelog format with sections: Added, Changed, Deprecated, Removed, Fixed, Security. Groups commits by category, deduplicates, writes user-facing descriptions.',
  category: 'docs',
  requiredRoles: ['pluton'],
  requiredTools: [],
  estimatedCost: 'low',
  enabledByDefault: true,
  builtin: true,
  triggers: [
    'A release is being prepared',
    'A sprint/iteration ends',
    'Significant changes have accumulated since the last entry',
    'A user-visible breaking change happened',
  ],
  antiPatterns: [
    'No commits since the last changelog entry — skip',
    'Internal refactors with no user impact — exclude',
    'Doc-only changes — mention briefly in "Changed" or skip',
  ],
  requires: [],
  relatedSkills: ['write-readme', 'write-tsdoc'],
  tags: ['docs', 'changelog', 'release-notes', 'keep-a-changelog'],
  examples: [
    {
      input: 'Generate changelog for v0.2.0 from commits since v0.1.0 (last 30 commits)',
      output: {
        changelog: `# Changelog

All notable changes to AnathemaBrain are documented in this file.

## [0.2.0] - 2026-06-28

### Added
- **BrainEvent provider-neutral types** (Phase 11): 12 discriminated union events for agent lifecycle, message streaming, tool execution, errors
- **EventBus**: typed in-memory pub/sub with error isolation
- **AgentHarness**: pure agent loop yielding AsyncIterable<BrainEvent>
- **runCouncilPure()**: council orchestration without window.electronAPI dependency
- **5 built-in coding tools**: read_file, write_file, edit_file, bash, grep_content
- **14 senior-grade coding skills** across 4 categories (Planning, Refactoring, Debugging, Review)

### Changed
- LLM streaming now emits BrainEvents alongside the IPC bridge (renderer unchanged)
- Agent system refactored to use AgentHarness as the loop driver

### Fixed
- Council event timing: agent_start/agent_end now emit at correct boundaries
- Tool execution start events fire when provider yields tool_call deltas

### Security
- Grok OAuth token refresh now respects rate limits (fixed race condition)

[0.1.0] - 2026-06-01
... (previous entries)
`,
        sectionsUsed: ['Added', 'Changed', 'Fixed', 'Security'],
        commitsProcessed: 30,
      },
    },
  ],
  outputSchema: '{ changelog: string; sectionsUsed: string[]; commitsProcessed: number }',
  systemPromptFragment: `You are writing a CHANGELOG.md entry from git history.

## Keep a Changelog format
Sections (use only those with content):
- **Added** — new features
- **Changed** — changes in existing functionality
- **Deprecated** — soon-to-be removed features
- **Removed** — now removed features
- **Fixed** — bug fixes
- **Security** — vulnerability fixes

## Methodology
1. **List commits since the last release** (use git log).
2. **Categorize each commit** into the right section.
3. **Translate to user-facing language**: "feat: add event bus" → "EventBus: typed in-memory pub/sub".
4. **Group related commits**: if 5 commits all touch the event system, write ONE entry.
5. **Skip internal-only changes**: refactors that don't change behavior.
6. **Add version + date**: top of the entry.

## Output format (JSON-typed)
- changelog: string (the full CHANGELOG.md content)
- sectionsUsed: string[] (which sections you wrote)
- commitsProcessed: number

## Changelog principles
- **User-facing language**: write for end-users, not developers
- **Group, don't list**: 1 entry per feature, not 1 per commit
- **Highlight breaking changes**: bold or callout
- **Link to issues/PRs**: reference #123, fixes #456
- **Date format**: ISO 8601 (YYYY-MM-DD)

Stay under 500 words.${CLARIFICATION_PROTOCOL}`,
};

// Register all skills
registerCodingSkill(writeReadme);
registerCodingSkill(writeTsdoc); registerCodingSkill(writeChangelog);
