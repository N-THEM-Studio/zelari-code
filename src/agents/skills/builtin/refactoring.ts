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

const extractReusable: CodingSkillDefinition = {
  id: 'extract-reusable',
  version: '1.0.0',
  name: 'Extract Reusable Module',
  description: 'Find duplication across files via semantic search. Identify shared logic, propose a new reusable module with a clean API, plan the migration of all call sites.',
  category: 'refactor',
  requiredRoles: ['atlas', 'oracle'],
  requiredTools: ['searchRAG'],
  estimatedCost: 'medium',
  enabledByDefault: true,
  builtin: true,
  triggers: [
    'Same logic copy-pasted across 3+ files',
    'Two near-identical utility functions (e.g. formatDate in 2 different files)',
    'A bug fix needs to be applied in 5 places',
    'New project copies code from old project (opportunity to extract)',
  ],
  antiPatterns: [
    'Duplication is INTENTIONAL (different domains, different evolution paths)',
    'Shared logic is so trivial (< 5 lines) that a function call adds more noise than it removes',
    'API is unstable — extracting now would force awkward premature abstractions',
  ],
  requires: [],
  relatedSkills: ['refactor-monolith', 'simplify-conditionals'],
  tags: ['refactor', 'deduplication', 'reuse', 'shared-module'],
  examples: [
    {
      input: 'There are 3 different "formatDuration" implementations in src/ — slightly different in each',
      output: {
        duplication: {
          callSites: [
            { file: 'src/components/Timer.tsx', function: 'formatDuration(ms: number): string', line: 23 },
            { file: 'src/lib/utils.ts', function: 'formatDuration(ms: number): string', line: 47 },
            { file: 'src/pages/Settings.tsx', function: 'formatDurationText(ms: number): string', line: 156 },
          ],
          differences: [
            'Timer.tsx: shows "1h 23m" for >1h, "23m 45s" for >1m, else "45s"',
            'utils.ts: shows "1:23:45" always (HH:MM:SS)',
            'Settings.tsx: shows "23m" for >1m, "45s" else',
          ],
        },
        proposedModule: {
          path: 'src/lib/format/duration.ts',
          api: `export function formatDuration(ms: number, opts?: { style?: 'compact' | 'full' | 'minimal' }): string`,
          variants: [
            { style: 'compact', example: '1h 23m' },
            { style: 'full', example: '1:23:45' },
            { style: 'minimal', example: '23m' },
          ],
        },
        migration: [
          { step: 'Create src/lib/format/duration.ts with the 3-style API', linesToAdd: 30 },
          { step: 'Update Timer.tsx to call formatDuration(ms, {style:"compact"})', linesToChange: 2 },
          { step: 'Update utils.ts to call formatDuration(ms, {style:"full"})', linesToChange: 2 },
          { step: 'Update Settings.tsx to call formatDuration(ms, {style:"minimal"})', linesToChange: 2 },
        ],
        benefits: ['Single source of truth for duration formatting', 'Easy to add new styles (e.g. ISO 8601)', 'Tests in one place'],
      },
    },
  ],
  outputSchema: '{ duplication: { callSites: Array<{ file: string; function: string; line: number }>; differences: string[] }; proposedModule: { path: string; api: string; variants: Array<{ style: string; example: string }> }; migration: Array<{ step: string; linesToChange: number }>; benefits: string[] }',
  systemPromptFragment: `You are finding duplicated logic and extracting a reusable module.

## Methodology
1. Use grep/semantic search to find candidate duplication (3+ similar implementations).
2. Read each call site to understand the VARIATIONS (not just the common pattern).
3. Design an API that accommodates ALL variations (use options pattern, not multiple functions).
4. Specify the new module path + function signature + behavior table.
5. List migration steps: which file + which lines change to use the new module.

## Extraction principles
- **Variations via options, not forks**: prefer formatDuration(ms, opts) over formatDurationCompact()/Full()
- **Pure functions**: extracted modules should have no hidden state, no I/O
- **Tests first**: write the test suite for the new module BEFORE migrating call sites
- **Single responsibility**: extracted module does ONE thing well

## Output format (JSON-typed)
- duplication: { callSites: [{file, function, line}], differences[] }
- proposedModule: { path, api (TS signature), variants: [{style, example}] }
- migration: [{step, linesToChange}]
- benefits: string[] (3-5 bullet points)

Stay under 500 words.${CLARIFICATION_PROTOCOL}`,
};

const simplifyConditionals: CodingSkillDefinition = {
  id: 'simplify-conditionals',
  version: '1.0.0',
  name: 'Simplify Conditionals',
  description: 'Reduce cyclomatic complexity of boolean/conditional code. Extract guard clauses, replace nested if-else with lookup tables, simplify boolean expressions using De Morgan\'s laws.',
  category: 'refactor',
  requiredRoles: ['atlas'],
  requiredTools: [],
  estimatedCost: 'low',
  enabledByDefault: true,
  builtin: true,
  triggers: [
    'Cyclomatic complexity > 10 in a single function',
    'Nested if-else > 3 levels deep',
    'Boolean expressions with > 4 terms',
    'Multiple early returns that could be guard clauses',
    'Switch statements with > 8 cases that share structure',
  ],
  antiPatterns: [
    'Performance-critical branches (compiler will optimize nested ifs better than lookups)',
    'Complex domain logic that IS the conditional structure (e.g. tax brackets)',
    'Code under active development where the structure is still in flux',
  ],
  requires: [],
  relatedSkills: ['extract-reusable', 'refactor-monolith'],
  tags: ['refactor', 'simplification', 'cyclomatic-complexity', 'clean-code'],
  examples: [
    {
      input: 'function canUserEdit(user, doc) { if (user.isAdmin) { return true; } else { if (doc.ownerId === user.id) { return true; } else { if (doc.collaborators.includes(user.id) && !doc.locked) { return true; } else { return false; } } } }',
      output: {
        before: { lines: 9, cyclomaticComplexity: 5 },
        after: { lines: 6, cyclomaticComplexity: 1 },
        refactored: `function canUserEdit(user, doc) {
  if (user.isAdmin) return true;
  if (doc.ownerId === user.id) return true;
  if (doc.collaborators.includes(user.id) && !doc.locked) return true;
  return false;
}`,
        explanation: 'Extracted guard clauses (early returns). Eliminated 3 levels of nesting. Cyclomatic complexity dropped from 5 to 1. Logic preserved exactly.',
      },
    },
    {
      input: 'function getDiscount(tier) { if (tier === "bronze") return 0.05; else if (tier === "silver") return 0.10; else if (tier === "gold") return 0.15; else if (tier === "platinum") return 0.20; else return 0; }',
      output: {
        before: { lines: 7, cyclomaticComplexity: 5 },
        after: { lines: 7, cyclomaticComplexity: 1 },
        refactored: `const DISCOUNT_BY_TIER = { bronze: 0.05, silver: 0.10, gold: 0.15, platinum: 0.20 } as const;
function getDiscount(tier: DiscountTier): number {
  return DISCOUNT_BY_TIER[tier] ?? 0;
}`,
        explanation: 'Replaced if-else chain with const lookup table. Adding a new tier = one line in the table, no function edit. Type-safe via `as const`. Default 0 via nullish coalescing.',
      },
    },
  ],
  outputSchema: '{ before: { lines: number; cyclomaticComplexity: number }; after: { lines: number; cyclomaticComplexity: number }; refactored: string; explanation: string }',
  systemPromptFragment: `You are reducing the complexity of conditional code.

## Common patterns to apply
1. **Guard clauses**: replace \`if (cond) { ...big block... } else { return false; }\` with \`if (!cond) return false; ...big block...\`
2. **Lookup tables**: replace \`if/else if/else if/...\` chains with \`const TABLE = { ... } as const; return TABLE[key] ?? default\`
3. **Boolean simplification**: apply De Morgan's laws (\`!(A && B)\` → \`!A || !B\`), extract complex predicates into named booleans
4. **Polymorphism**: replace type-checking conditionals (\`if (type === 'A') ... else if (type === 'B') ...\`) with method dispatch

## Output format (JSON-typed)
- before: { lines, cyclomaticComplexity }
- after: { lines, cyclomaticComplexity }
- refactored: string (the new code)
- explanation: string (1-2 sentences on what changed and why)

## What NOT to do
- Don't change behavior — only structure
- Don't introduce new abstractions for one-off conditionals
- Don't sacrifice readability for fewer lines (e.g. overly clever ternary chains)

Stay under 400 words.${CLARIFICATION_PROTOCOL}`,
};

const refactorMonolith: CodingSkillDefinition = {
  id: 'refactor-monolith',
  version: '1.0.0',
  name: 'Refactor Monolith',
  description: 'Multi-perspective decomposition of large files (>1000 LOC) into focused modules. Identifies natural responsibility boundaries, proposes a module map with line numbers, validates no circular deps, generates a per-phase migration plan.',
  category: 'refactor',
  requiredRoles: ['hephaestus', 'atlas', 'oracle'],
  requiredTools: ['searchRAG', 'createTask'],
  estimatedCost: 'high',
  enabledByDefault: true,
  builtin: true,
  triggers: [
    'Single file > 1000 LOC with mixed responsibilities',
    'Cyclomatic complexity > 50 in a single function',
    'Multiple unrelated imports (>15 distinct packages) in one file',
    'Onboarding new devs is hard because no one file fits in their head',
    'Build/test times are slow because one big file recompiles on every change',
  ],
  antiPatterns: [
    'File under 500 LOC — defer; not worth the migration cost',
    'Truly cohesive file even if large (e.g. a state machine FSM)',
    'Quick fix needed urgently — refactor first, fix second',
    'No tests exist — write characterization tests first, refactor second',
  ],
  requires: ['extract-reusable'],
  relatedSkills: ['simplify-conditionals', 'architect-feature'],
  tags: ['refactor', 'modularization', 'god-module', 'split', 'architecture'],
  examples: [
    {
      input: 'src/Council.tsx is 1822 LOC with mixed concerns: chat rendering, tool dispatch, voice input, slash commands, file attachments',
      output: {
        currentState: {
          file: 'src/Council.tsx',
          totalLines: 1822,
          responsibilities: ['chat render', 'tool dispatch', 'voice input', 'slash commands', 'file attachments', 'settings panel', 'token counter'],
        },
        proposedModules: [
          { name: 'ChatStream.tsx', responsibility: 'render assistant/user messages', estimatedLines: 350, dependsOn: ['useChatStream hook'] },
          { name: 'ToolDispatch.tsx', responsibility: 'show tool execution + results', estimatedLines: 280, dependsOn: ['brain/tool types'] },
          { name: 'VoiceInput.tsx', responsibility: 'microphone + transcription UI', estimatedLines: 150, dependsOn: ['useVoiceRecorder hook'] },
          { name: 'SlashCommands.tsx', responsibility: 'command palette + autocomplete', estimatedLines: 200, dependsOn: ['useSlashCommands hook'] },
          { name: 'useCouncil.ts (hook)', responsibility: 'state + council orchestration logic', estimatedLines: 400, dependsOn: [] },
        ],
        migrationPhases: [
          { phase: 1, name: 'Extract useCouncil hook', exitCriterion: 'Council.tsx < 1500 LOC, all behavior unchanged, all tests pass', durationDays: 2 },
          { phase: 2, name: 'Extract ChatStream + ToolDispatch', exitCriterion: 'Council.tsx < 1000 LOC', durationDays: 3 },
          { phase: 3, name: 'Extract VoiceInput + SlashCommands', exitCriterion: 'Council.tsx < 500 LOC OR deleted entirely', durationDays: 2 },
        ],
        risks: [
          { risk: 'Hidden circular imports between new modules', mitigation: 'Run `madge --circular src/` after each phase; CI fails on circular deps.' },
          { risk: 'Lost re-render optimization (inline JSX vs memoized components)', mitigation: 'Phase 1 establishes React.memo + useMemo conventions before extracting.' },
        ],
      },
    },
  ],
  outputSchema: '{ currentState: { file: string; totalLines: number; responsibilities: string[] }; proposedModules: Array<{ name: string; responsibility: string; estimatedLines: number; dependsOn: string[] }>; migrationPhases: Array<{ phase: number; name: string; exitCriterion: string; durationDays: number }>; risks: Array<{ risk: string; mitigation: string }> }',
  systemPromptFragment: `You are planning a multi-perspective decomposition of a large file.

## Methodology
1. Identify the file's CURRENT responsibilities (read the source if needed).
2. Search the KB for prior split decisions: searchRAG(query="<file-name-keyword>")
3. Propose 4-8 NEW modules, each with ONE clear responsibility.
4. Map existing functions/sections to new modules (with line numbers).
5. Validate NO circular dependencies between proposed modules.
6. Plan 3-5 migration phases, each independently shippable with all tests passing.

## Module split principles
- **One job per module**: if you can't describe a module's purpose in ONE sentence, split further
- **No circular deps**: A imports B, B imports C is fine; A imports B, B imports A is not
- **Stable abstractions**: the new module boundaries should match NATURAL responsibility seams (state vs UI vs I/O), not arbitrary line counts
- **Testability first**: each module should be unit-testable in isolation

## Output format (JSON-typed)
- currentState: { file, totalLines, responsibilities[] }
- proposedModules: Array<{ name, responsibility, estimatedLines, dependsOn[] }>
- migrationPhases: Array<{ phase, name, exitCriterion, durationDays }>
- risks: Array<{ risk, mitigation }>

Stay under 600 words. Be decisive about module boundaries — pick ONE natural split, don't present 3 equally valid options.${CLARIFICATION_PROTOCOL}`,
};

// Register all 3 skills at module load time in topological dependency order.
// Throws at startup if any \`requires\` cross-reference is invalid.
registerCodingSkill(extractReusable);
registerCodingSkill(simplifyConditionals);
registerCodingSkill(refactorMonolith);
