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

const architectFeature: CodingSkillDefinition = {
  id: 'architect-feature',
  version: '1.0.0',
  name: 'Architect Feature',
  description: 'Multi-perspective feature design: explore 3-5 alternatives, pick the strongest, generate an ADR, list concrete risks and mitigations.',
  category: 'planning',
  requiredRoles: ['charont', 'nettun', 'minos'],
  requiredTools: ['createTask', 'searchRAG'],
  estimatedCost: 'high',
  enabledByDefault: true,
  builtin: true,
  triggers: [
    'New feature spanning multiple modules',
    'Architectural decision with long-term impact',
    'Public API design (libraries, services, CLI commands)',
    'Schema or data model changes affecting persistence',
    'Cross-cutting concern (auth, logging, caching) added to existing system',
  ],
  antiPatterns: [
    'Simple bug fix — use debug-with-rag instead',
    'Single-file refactor under 500 LOC — use refactor-monolith only if > 1000 LOC',
    'Documentation update — use write-tsdoc or write-readme',
    'Adding a one-line config or env var — direct edit is faster',
    'Pure refactor with no design choice — use refactor-monolith or extract-reusable',
  ],
  requires: ['architect-decision-record'],
  relatedSkills: ['scope-check', 'migrate-stack', 'code-review'],
  tags: ['planning', 'architecture', 'design', 'multi-role', 'adr'],
  examples: [
    {
      input: 'Add OAuth login via Google to the Electron desktop app',
      output: {
        goal: 'Enable users to sign in to AnathemaBrain with their Google account, replacing the current email+password flow.',
        alternatives: [
          { approach: 'OAuth library (Passport.js)', score: 'F:4 R:3 M:5', rationale: 'Battle-tested, large ecosystem, easy revocation, ~50KB bundle.' },
          { approach: 'Custom PKCE flow with raw HTTP', score: 'F:3 R:4 M:2', rationale: 'No deps, but high surface area (token refresh, CSRF, error states).' },
          { approach: 'Use Electron built-in OAuth via deep link', score: 'F:4 R:2 M:4', rationale: 'Native to Electron, no redirect_uri issues, but desktop-specific.' },
        ],
        chosen: { approach: 'Passport.js with Google strategy', rationale: 'Lowest maintenance burden given the OAuth library ecosystem; revocation handled by the library.' },
        adrPath: 'docs/adr/0014-google-oauth.md',
        risks: [
          { risk: 'Token refresh edge cases when offline', mitigation: 'Persist refresh token in keychain (already implemented for Grok OAuth).' },
          { risk: 'CSRF on deep-link redirect', mitigation: 'Use OAuth state parameter with cryptographic random nonce.' },
        ],
      },
    },
    {
      input: 'Add a /skill command to the CLI that expands a skill template',
      output: {
        goal: 'Allow the CLI to invoke a skill by name, expanding the template and dispatching to the council.',
        alternatives: [
          { approach: 'Slash command handler in cli/main.ts', score: 'F:5 R:1 M:5', rationale: 'Direct, simple.' },
          { approach: 'Plugin system with skill loader', score: 'F:2 R:4 M:2', rationale: 'Over-engineered for v1.' },
        ],
        chosen: { approach: 'Slash command handler', rationale: 'YAGNI — defer plugin system to v2 when users request it.' },
        adrPath: 'docs/adr/0015-cli-skill-commands.md',
        risks: [
          { risk: 'Skill name collisions across categories', mitigation: 'Namespace as `<category>:<name>` (e.g. `planning:architect-feature`).' },
        ],
      },
    },
  ],
  outputSchema: '{ goal: string; alternatives: Array<{ approach: string; score: string; rationale: string }>; chosen: { approach: string; rationale: string }; adrPath: string; risks: Array<{ risk: string; mitigation: string }> }',
  systemPromptFragment: `You are designing a feature with multi-perspective analysis.

## Methodology
1. Restate the goal in ONE sentence: what user need does this serve?
2. Search prior decisions with the retrieval tool listed in your AVAILABLE TOOLS (searchDocuments or searchRAG — never call one that is not listed), query: "<feature-keyword>"
3. Generate 3-5 DISTINCT approaches (vary the axis: library vs custom, sync vs async, desktop vs server, etc.).
4. Score each approach on three dimensions (1-5 each):
   - Feasibility (F): how easy to implement given the current stack
   - Risk (R, INVERTED — lower is better): likelihood of bugs, security holes, scope creep
   - Maintenance (M): long-term cost (bus factor, doc quality, ecosystem health)
5. Pick the top approach and justify in 1-2 sentences.
6. Generate an ADR (link to architect-decision-record skill).
7. List 2-5 concrete risks + mitigations.

## Output format (JSON-typed)
- goal: string
- alternatives: Array<{ approach: string; score: string; rationale: string }>
- chosen: { approach: string; rationale: string }
- adrPath: string
- risks: Array<{ risk: string; mitigation: string }>

Stay under 400 words. Be decisive: pick ONE approach, do not list 3 equally good options.${CLARIFICATION_PROTOCOL}`,
};

const architectDecisionRecord: CodingSkillDefinition = {
  id: 'architect-decision-record',
  version: '1.0.0',
  name: 'Architect Decision Record',
  description: 'Generate an ADR (Architecture Decision Record) from a decision rationale. Format: Context, Decision, Consequences, Alternatives Considered.',
  category: 'planning',
  requiredRoles: ['nettun', 'pluton'],
  requiredTools: ['createDocument'],
  estimatedCost: 'low',
  enabledByDefault: true,
  builtin: true,
  triggers: [
    'A non-trivial architectural decision has been made',
    'Reviewing a past decision and want to capture WHY it was made',
    'Onboarding a new team member to the rationale behind existing choices',
    'After running architect-feature, to formalize the chosen approach',
  ],
  antiPatterns: [
    'No real decision has been made yet — first run architect-feature or scope-check',
    'Trivial choice (file naming, color scheme) — use a code comment',
    'Decision is reversible in under 1 hour — defer the ADR',
  ],
  requires: [],
  relatedSkills: ['architect-feature', 'scope-check'],
  tags: ['planning', 'documentation', 'adr', 'decision-log'],
  examples: [
    {
      input: 'Document why we use SQLite over Postgres for local storage',
      output: {
        path: 'docs/adr/0007-sqlite-over-postgres.md',
        content: `# 7. SQLite over Postgres for local storage

## Context
AnathemaBrain is an Electron desktop app that runs entirely on the user's machine. We need persistent storage for vault documents, RAG vectors, settings, and council sessions.

## Decision
Use SQLite (via better-sqlite3) for all local storage.

## Consequences
- Zero-config: works out of the box, no separate DB server to manage
- Single-file backups: copy ~/.anathemabrain/db.sqlite
- FTS5 + JSON1 support built-in (used by RAG and vault search)
- Cross-platform: tested on macOS, Linux, Windows

### Positive
- No network round-trip — sub-millisecond reads
- Embedded = no auth/connection-string management
- Mature ecosystem (better-sqlite3, sqlite-vss)

### Negative
- Single-writer: concurrent writes are serialized (acceptable for desktop)
- No horizontal scaling (irrelevant for desktop)
- Migration tooling requires custom scripts (we have db/migrations.ts)

## Alternatives Considered
- **Postgres**: rejected — requires a server process, overkill for desktop
- **LevelDB / RocksDB**: rejected — no SQL, harder to query vector data
- **JSON files**: rejected — no concurrent access, no FTS
`,
      },
    },
  ],
  outputSchema: '{ path: string; content: string }',
  systemPromptFragment: `You are writing an Architecture Decision Record (ADR).

## Required sections
1. **# N. <Title>** — short title in present tense ("Use X for Y")
2. **## Context** — what is the situation? What forces are at play? (2-3 paragraphs)
3. **## Decision** — what did we decide? State it clearly in 1-2 sentences.
4. **## Consequences** — what becomes easier (+) and harder (-) as a result?
5. **## Alternatives Considered** — 2-4 alternatives with one-line rejection reasons.

## Numbering
- Check docs/adr/ for the next available number (NNN-title.md format)
- ADR numbers are permanent — never reuse, even if an ADR is superseded (mark superseded in the body instead)

## Tone
- Factual, not promotional
- Acknowledge trade-offs honestly
- Link to relevant code/PRs/files using relative paths

Stay under 800 words.${CLARIFICATION_PROTOCOL}`,
};

const migrateStack: CodingSkillDefinition = {
  id: 'migrate-stack',
  version: '1.0.0',
  name: 'Migrate Stack',
  description: 'Plan a migration (framework, language, database, build tool) with phased rollout and a concrete rollback strategy. Identifies big-bang risks and proposes incremental steps.',
  category: 'planning',
  requiredRoles: ['charont', 'nettun', 'geryon'],
  requiredTools: ['createTask', 'searchRAG'],
  estimatedCost: 'high',
  enabledByDefault: true,
  builtin: true,
  triggers: [
    'Replacing a framework (e.g. CRA → Vite, Express → Fastify)',
    'Upgrading a major version with breaking changes (React 17 → 18)',
    'Switching databases (Postgres → SQLite, JSON files → Postgres)',
    'Migrating build tooling (webpack → esbuild, npm → pnpm)',
    'Replacing a key library with a competitor (moment → date-fns)',
  ],
  antiPatterns: [
    'Greenfield project — use architect-feature instead',
    'A/B test of two stacks — use a spike/benchmark first',
    'Migration can be done by automated codemods — skip the planning skill',
  ],
  requires: ['architect-decision-record', 'scope-check'],
  relatedSkills: ['architect-feature', 'refactor-monolith'],
  tags: ['planning', 'migration', 'rollout', 'rollback', 'risk-management'],
  examples: [
    {
      input: 'Migrate AnathemaBrain from Create React App (CRA) to Vite',
      output: {
        goal: 'Reduce dev server startup from 30s to <2s, reduce prod build from 60s to <10s.',
        phases: [
          { name: 'Phase 1: Setup parallel build', exitCriterion: 'npm run dev:vite works for a hello-world', durationDays: 2 },
          { name: 'Phase 2: Migrate entry points', exitCriterion: 'Both Webpack and Vite builds succeed; renderer loads in both', durationDays: 5 },
          { name: 'Phase 3: Migrate loaders (CSS, assets)', exitCriterion: 'All static assets load correctly under Vite', durationDays: 3 },
          { name: 'Phase 4: Cut over', exitCriterion: 'Webpack config deleted; CI runs only Vite', durationDays: 2 },
        ],
        rollbackStrategy: 'Keep Webpack config in git history (tag: pre-vite-migration). Revert the single commit that switches the default dev script.',
        risks: [
          { risk: 'Asset paths differ between Webpack and Vite (~/ aliases, ?url imports)', mitigation: 'Phase 3 includes a path-mapping smoke test.' },
          { risk: 'electron-vite specific electron features not yet stable', mitigation: 'Phase 1 spike verifies electron-vite can compile the existing Electron main process.' },
        ],
      },
    },
  ],
  outputSchema: '{ goal: string; phases: Array<{ name: string; exitCriterion: string; durationDays: number }>; rollbackStrategy: string; risks: Array<{ risk: string; mitigation: string }> }',
  systemPromptFragment: `You are planning a stack migration.

## Methodology
1. State the GOAL in measurable terms (e.g. "reduce build time from 60s to 10s").
2. Decompose into 3-6 phases. Each phase has a CLEAR exit criterion (testable condition).
3. Each phase should be DEPLOYABLE on its own (no big-bang steps).
4. Plan a ROLLBACK strategy: which single commit reverts to the previous state?
5. List 3-7 concrete risks + mitigations per phase.

## Migration principles
- **Strangler Fig**: new system grows alongside old, traffic migrates incrementally
- **No big-bang rewrites**: every phase must be independently shippable
- **Reversibility first**: every phase has a tested rollback path
- **Data migration last**: schema changes follow code changes (dual-write during transition)

## Output format (JSON-typed)
- goal: string (measurable)
- phases: Array<{ name: string; exitCriterion: string; durationDays: number }>
- rollbackStrategy: string (the single command or commit that reverts)
- risks: Array<{ risk: string; mitigation: string }>

Stay under 500 words.${CLARIFICATION_PROTOCOL}`,
};

const scopeCheck: CodingSkillDefinition = {
  id: 'scope-check',
  version: '1.0.0',
  name: 'Scope Check',
  description: 'Validate feasibility of a proposed feature or change. Identify hidden costs, dependencies, risks. Propose a reduced scope that fits the available budget.',
  category: 'planning',
  requiredRoles: ['charont', 'minos', 'lucifer'],
  requiredTools: ['searchRAG'],
  estimatedCost: 'medium',
  enabledByDefault: true,
  builtin: true,
  triggers: [
    'User proposes an ambitious feature without a clear MVP boundary',
    'Estimates are unclear or contested',
    'Hidden dependencies suspected (auth, billing, third-party APIs)',
    'Before committing to a multi-week project',
    'When a stakeholder says "this should be easy" and you suspect it is not',
  ],
  antiPatterns: [
    'The task is already small and well-scoped — just do it',
    'Pure research / exploration — no commitment to implement',
    'Bug fix — use debug-with-rag instead',
  ],
  requires: [],
  relatedSkills: ['architect-feature', 'migrate-stack'],
  tags: ['planning', 'feasibility', 'risk-assessment', 'mvp', 'scoping'],
  examples: [
    {
      input: 'Build a "smart inbox" that categorizes emails using the local LLM council',
      output: {
        feasibility: 'partial',
        estimatedEffortDays: 14,
        hiddenCosts: [
          { cost: 'IMAP polling + auth setup (3-5 days)', mitigation: 'Use existing Gmail API OAuth2 flow' },
          { cost: 'Email parsing (HTML, attachments) - 2 days', mitigation: 'Use mailparser library' },
          { cost: 'Local LLM inference at scale - 1 day setup + per-email ~3s', mitigation: 'Batch categorization, use smaller model (gemini-2.5-flash)' },
          { cost: 'Council orchestration - already have it', mitigation: 'Reuse runCouncilPure' },
        ],
        reducedScope: {
          phase1: 'Single Gmail account, read-only, top-20 inbox categorization (3 days)',
          phase2: 'Multi-account + auto-archive (5 days)',
          phase3: 'Reply drafting suggestions (6 days)',
        },
        risks: [
          'Council API costs: 5 emails × 3 council members × 4 providers = 60 LLM calls per batch',
          'User privacy: emails sent to cloud providers unless restricted to local-only model',
        ],
      },
    },
  ],
  outputSchema: '{ feasibility: "yes" | "partial" | "no"; estimatedEffortDays: number; hiddenCosts: Array<{ cost: string; mitigation: string }>; reducedScope: { phase1: string; phase2: string; phase3: string }; risks: string[] }',
  systemPromptFragment: `You are validating the scope of a proposed feature or change.

## Methodology
1. Restate the proposal in ONE sentence.
2. Search the knowledge base with the retrieval tool listed in your AVAILABLE TOOLS (searchDocuments or searchRAG — never call one that is not listed), query: "<proposed-keyword>"
3. Estimate effort realistically (in person-days, with calibration from prior projects).
4. List HIDDEN costs: auth flows, data migration, third-party APIs, deployment, monitoring.
5. Propose a REDUCED SCOPE that delivers 80% of the value in 20% of the time.
6. Flag risks that could block the project.

## Output format (JSON-typed)
- feasibility: 'yes' | 'partial' | 'no'
- estimatedEffortDays: number
- hiddenCosts: Array<{ cost: string; mitigation: string }>
- reducedScope: { phase1: string; phase2: string; phase3: string } (3 phases, each independently shippable)
- risks: string[] (3-5 risks)

## When to be skeptical
- "Just add X" usually hides auth + persistence + UI work (3x multiplier)
- "Use the existing system" usually means new integration code
- Estimates from optimistic people — multiply by 2-3x for calendar time

Stay under 400 words. Be honest about feasibility — say NO when the answer is NO.${CLARIFICATION_PROTOCOL}`,
};

// Register all 4 skills at module load time in topological dependency order.
// Throws at startup if any `requires` cross-reference is invalid.
registerCodingSkill(architectDecisionRecord);
registerCodingSkill(scopeCheck);
registerCodingSkill(architectFeature);
registerCodingSkill(migrateStack);
