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

const securityAudit: CodingSkillDefinition = {
  id: 'security-audit',
  version: '1.0.0',
  name: 'Security Audit',
  description: 'OWASP Top 10 + CVE check on dependencies + secrets scan. Identifies injection vectors, auth flaws, unsafe deserialization, hardcoded credentials.',
  category: 'review',
  requiredRoles: ['minos'],
  requiredTools: ['grep_content', 'read_file'],
  estimatedCost: 'medium',
  enabledByDefault: true,
  builtin: true,
  triggers: [
    'Any code touching auth, session, password, token, or credential storage',
    'Pre-release audit of the codebase',
    'After a security incident or CVE disclosure',
    'Quarterly compliance check',
    'Integrating a new third-party npm dependency that handles user data',
  ],
  antiPatterns: [
    'Pure UI code with no I/O — defer to code-review skill',
    'A unit test file — no production risk',
    'Mock/seed data — those credentials are intentionally fake',
  ],
  requires: [],
  relatedSkills: ['code-review'],
  tags: ['security', 'owasp', 'audit', 'cve', 'secrets', 'compliance'],
  examples: [
    {
      input: 'Audit src/auth/ directory for security issues',
      output: {
        owaspFindings: [
          { category: 'A01:2021 Broken Access Control', severity: 'HIGH', file: 'src/auth/middleware.ts:34', issue: 'Missing role check on /admin/* routes — any authenticated user can access admin endpoints' },
          { category: 'A02:2021 Cryptographic Failures', severity: 'CRITICAL', file: 'src/auth/token.ts:12', issue: 'Tokens stored with SHA-256(password) instead of bcrypt/argon2 — vulnerable to rainbow tables' },
          { category: 'A03:2021 Injection', severity: 'MEDIUM', file: 'src/auth/login.ts:45', issue: 'Email field not validated; potential XSS if rendered unsafed downstream' },
        ],
        cveCheck: 'npm audit: 3 vulnerabilities (1 high, 2 moderate) in jsonwebtoken@8.5.1 (CVE-2022-23529) — upgrade to 9.0.0+',
        secretsScan: 'No hardcoded API keys found in src/. .env files are gitignored.',
        priorityOrder: [
          '1. Fix SHA-256 → bcrypt (CRITICAL)',
          '2. Add role check middleware (HIGH)',
          '3. Upgrade jsonwebtoken (CVE)',
          '4. Add email validation (MEDIUM)',
        ],
      },
    },
  ],
  outputSchema: '{ owaspFindings: Array<{ category: string; severity: string; file: string; line: number; issue: string }>; cveCheck: string; secretsScan: string; priorityOrder: string[] }',
  systemPromptFragment: `You are auditing the codebase for security vulnerabilities.

## OWASP Top 10 (2021) — check each
1. **A01 Broken Access Control**: missing role checks, IDOR vulnerabilities
2. **A02 Cryptographic Failures**: weak hashing (MD5/SHA-1/SHA-256 for passwords), missing TLS
3. **A03 Injection**: SQL injection, command injection, XSS (especially via unsafe dangerouslySetInnerHTML)
4. **A04 Insecure Design**: missing rate limiting on auth endpoints
5. **A05 Security Misconfiguration**: default credentials, exposed debug endpoints
6. **A06 Vulnerable Components**: outdated dependencies with known CVEs (run npm audit)
7. **A07 Identification & Auth Failures**: missing MFA, weak password policies
8. **A08 Software & Data Integrity Failures**: missing signature verification on updates
9. **A09 Logging & Monitoring Failures**: no audit log on sensitive operations
10. **A10 SSRF**: user-controlled URLs fetched server-side without allowlist

## CVE check
- Run npm audit (or pip-audit, cargo audit, etc. depending on the stack)
- Cross-reference with the GitHub Advisory Database

## Secrets scan
- grep for common patterns: API_KEY, SECRET, TOKEN, PASSWORD, BEGIN PRIVATE KEY
- Check .env files are gitignored

## Output format (JSON-typed)
- owaspFindings: Array<{ category, severity, file, line, issue }>
- cveCheck: string (results of dependency scan)
- secretsScan: string (results of hardcoded secrets scan)
- priorityOrder: string[] (numbered list, CRITICAL first)

Stay under 500 words.${CLARIFICATION_PROTOCOL}`,
};

const performanceReview: CodingSkillDefinition = {
  id: 'performance-review',
  version: '1.0.0',
  name: 'Performance Review',
  description: 'Identify algorithmic complexity issues (O(n²), O(n³)), N+1 queries, unnecessary allocations, missing caching opportunities, I/O blocking patterns.',
  category: 'review',
  requiredRoles: ['pluton'],
  requiredTools: ['read_file', 'grep_content'],
  estimatedCost: 'medium',
  enabledByDefault: true,
  builtin: true,
  triggers: [
    'Performance regression report from users',
    'Response time > 1s where it used to be < 100ms',
    'CPU profiling shows a hot function',
    'Memory growth over time (potential leak)',
    'Database query log shows slow queries',
  ],
  antiPatterns: [
    'UI-only code with no I/O or loops — defer',
    'Code that handles < 100 items (premature optimization)',
    'One-time scripts — performance rarely matters',
  ],
  requires: [],
  relatedSkills: ['code-review'],
  tags: ['performance', 'optimization', 'big-o', 'caching', 'memory', 'profiling'],
  examples: [
    {
      input: 'Review src/lib/search.ts (filters 10,000 documents)',
      output: {
        findings: [
          { type: 'N+1 query', severity: 'HIGH', file: 'src/lib/search.ts:34', issue: 'For each of 10,000 docs, fires a separate DB query to fetch tags. Total: 10,001 queries per search.', fix: 'Use a single JOIN query to fetch all tags upfront. Reduces to 1 query.' },
          { type: 'Allocation in hot loop', severity: 'MEDIUM', file: 'src/lib/search.ts:67', issue: 'Creates a new Date object inside the filter loop (10,000 allocations per search).', fix: 'Hoist the comparison date outside the loop.' },
          { type: 'Missing index', severity: 'MEDIUM', file: 'src/lib/search.ts:45', issue: 'SQL query filters by `created_at` but the table has no index on that column. Full table scan on every search.', fix: 'CREATE INDEX idx_documents_created_at ON documents(created_at);' },
          { type: 'Caching opportunity', severity: 'LOW', file: 'src/lib/search.ts:89', issue: 'Results identical for the same query within 60s window; no caching layer.', fix: 'Add LRU cache keyed on query hash, TTL 60s.' },
        ],
        bigO: 'O(n) becomes O(1) with the JOIN fix + O(1) with the cache',
        expectedSpeedup: '10-100x for typical queries',
      },
    },
  ],
  outputSchema: '{ findings: Array<{ type: string; severity: string; file: string; line: number; issue: string; fix: string }>; bigO: string; expectedSpeedup: string }',
  systemPromptFragment: `You are reviewing code for performance issues.

## Common patterns to detect
1. **N+1 queries**: loop with a DB call inside (fetch all data upfront with a JOIN)
2. **Allocation in hot loops**: \`new SomeClass()\` inside \`for (...)\` (hoist outside)
3. **Missing index**: SQL filter on unindexed column (add index, EXPLAIN ANALYZE)
4. **No caching**: identical computation repeated (LRU cache, memoize)
5. **Blocking I/O in async**: \`await fs.readFileSync(...)\` (use async readFile)
6. **Quadratic loops**: nested loops over the same array (use hash map for O(n) lookup)
7. **Synchronous XHR/fetch**: blocking the main thread (use async/await or worker)

## Output format (JSON-typed)
- findings: Array<{ type, severity, file, line, issue, fix }>
- bigO: string (the complexity change after fixes)
- expectedSpeedup: string (estimated speedup magnitude)

## Anti-patterns to avoid
- **Don't propose premature optimizations** (caching for a function called once)
- **Don't change behavior for performance** unless explicitly asked
- **Profile first** — don't guess where the hot path is

Stay under 500 words.${CLARIFICATION_PROTOCOL}`,
};

const testCoverageAnalysis: CodingSkillDefinition = {
  id: 'test-coverage-analysis',
  version: '1.0.0',
  name: 'Test Coverage Analysis',
  description: 'Identify untested code branches. Suggest specific test cases that would close the coverage gap, prioritizing edge cases and error paths.',
  category: 'review',
  requiredRoles: ['minos', 'pluton'],
  requiredTools: ['read_file'],
  estimatedCost: 'medium',
  enabledByDefault: true,
  builtin: true,
  triggers: [
    'Coverage report shows < 80% line coverage',
    'A new feature was added without tests',
    'A bug was found that should have been caught by tests',
    'Quarterly coverage audit',
    'Refactoring a high-churn module where regression risk is high',
  ],
  antiPatterns: [
    'Tests exist but are tautologies (assertions that always pass)',
    'Coverage targets > 95% (often forces meaningless tests)',
    'Auto-generated code (skip — the generator has its own tests)',
  ],
  requires: [],
  relatedSkills: ['code-review'],
  tags: ['review', 'testing', 'coverage', 'edge-cases'],
  examples: [
    {
      input: 'src/lib/formatDuration.ts has 6 branches; coverage report shows only 3 are tested',
      output: {
        untestedBranches: [
          { branch: 'ms < 0 (negative duration)', file: 'src/lib/formatDuration.ts:12', suggestedTest: "expect(formatDuration(-1000)).toThrow('Negative duration')" },
          { branch: 'ms === 0', file: 'src/lib/formatDuration.ts:14', suggestedTest: "expect(formatDuration(0)).toBe('0s')" },
          { branch: 'ms > 1 day (very large)', file: 'src/lib/formatDuration.ts:22', suggestedTest: "expect(formatDuration(86400000 * 2)).toBe('2d')" },
        ],
        edgeCases: [
          'ms is NaN (e.g. from a corrupt timestamp) — should throw',
          'ms is Infinity (e.g. from setTimeout overflow) — should cap at a max',
          'style option is invalid — should default to "compact"',
        ],
        priorityOrder: ['1. NaN/Infinity handling (data integrity)', '2. ms === 0 boundary (off-by-one)', '3. style validation (UX)'],
      },
    },
  ],
  outputSchema: '{ untestedBranches: Array<{ branch: string; file: string; line: number; suggestedTest: string }>; edgeCases: string[]; priorityOrder: string[] }',
  systemPromptFragment: `You are identifying untested code branches.

## Methodology
1. **Read each branch** in the source file (if/else, switch cases, try/catch).
2. **Identify untested branches** by reading the corresponding test file.
3. **Suggest a SPECIFIC test** (not "add a test for X" — write the actual assertion).
4. **Prioritize edge cases**: NaN, null, undefined, empty array, max int, negative numbers.
5. **Prioritize error paths**: what happens when validation fails, network drops, etc.?

## Output format (JSON-typed)
- untestedBranches: Array<{ branch, file, line, suggestedTest }>
- edgeCases: string[] (3-7 cases)
- priorityOrder: string[] (numbered list)

## Test quality principles
- **One assertion per test** — easier to debug
- **Specific assertion** — not \`expect(result).toBeTruthy()\` but \`expect(result).toBe('1h 23m')\`
- **Test the boundary** — \`n=0\`, \`n=1\`, \`n=MAX_INT\`
- **Test the failure path** — invalid input, network errors, partial data

Stay under 400 words.${CLARIFICATION_PROTOCOL}`,
};

const codeReview: CodingSkillDefinition = {
  id: 'code-review',
  version: '1.0.0',
  name: 'Code Review',
  description: 'Multi-role review covering correctness, style, performance, security, and accessibility. Each role emits findings with severity (CRITICAL/HIGH/MEDIUM/LOW). Lucifero synthesizes consensus.',
  category: 'review',
  requiredRoles: ['minos', 'pluton', 'lucifer'],
  requiredTools: ['read_file', 'grep_content', 'searchRAG'],
  estimatedCost: 'high',
  enabledByDefault: true,
  builtin: true,
  triggers: [
    'A pull request is ready for review',
    'A code change affects > 100 lines',
    'Code touches auth, payments, or other security-critical paths',
    'Before merging to main',
    'A pre-merge sanity check on critical files',
  ],
  antiPatterns: [
    'Single-line change (typo, comment fix) — direct merge',
    'Trivial style fix (whitespace, import order) — direct merge',
    'WIP / draft PR — review when ready',
    'Generated code (e.g. codegen output) — review the upstream generator instead',
  ],
  requires: ['security-audit', 'performance-review', 'test-coverage-analysis'],
  relatedSkills: ['security-audit', 'performance-review', 'test-coverage-analysis'],
  tags: ['review', 'multi-role', 'pr-review', 'correctness', 'security'],
  examples: [
    {
      input: 'Review src/components/AuthForm.tsx (180 LOC) — adds passwordless email login',
      output: {
        findings: [
          { role: 'minos', severity: 'CRITICAL', line: 67, issue: 'No CSRF token on the form submit', file: 'src/components/AuthForm.tsx' },
          { role: 'pluton', severity: 'HIGH', line: 23, issue: 'N+1 query: user lookup fires on every keystroke instead of debounced', file: 'src/components/AuthForm.tsx' },
          { role: 'minos', severity: 'MEDIUM', line: 102, issue: 'Error message leaks server response body (XSS risk)', file: 'src/components/AuthForm.tsx' },
          { role: 'lucifer', severity: 'LOW', line: 45, issue: 'Variable name `usrEml` should be `userEmail` (style)', file: 'src/components/AuthForm.tsx' },
        ],
        consensus: '2 CRITICAL/HIGH blockers must be fixed before merge. CSRF is the most critical. After CSRF fix, N+1 query, then error message.',
        mergeVerdict: 'BLOCK',
      },
    },
  ],
  outputSchema: '{ findings: Array<{ role: string; severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW"; line: number; issue: string; file: string }>; consensus: string; mergeVerdict: "APPROVE" | "REQUEST_CHANGES" | "BLOCK" }',
  systemPromptFragment: `You are conducting a multi-role code review.

## Review roles
- **oracle (correctness)**: bugs, race conditions, edge cases, error handling
- **atlas (performance)**: O(n²) algorithms, N+1 queries, unnecessary allocations, missing caching
- **oracle (security)**: injection, auth bypass, secrets in code, unsafe deserialization (overlaps with security-audit skill — run that first)
- **atlas (accessibility)**: ARIA labels, keyboard nav, color contrast
- **chairman (synthesis)**: aggregates all findings, emits verdict (APPROVE / REQUEST_CHANGES / BLOCK)

## Severity levels
- **CRITICAL**: must fix before merge (security, data loss, crash)
- **HIGH**: should fix before merge (correctness bug, performance regression)
- **MEDIUM**: nice to fix (code smell, minor perf)
- **LOW**: nitpick (style, naming)

## Output format (JSON-typed)
- findings: Array<{ role, severity, line, issue, file }>
- consensus: string (chairman's synthesis)
- mergeVerdict: 'APPROVE' | 'REQUEST_CHANGES' | 'BLOCK'

## Review principles
- **Be specific**: cite file + line numbers
- **Be actionable**: each finding has a concrete fix
- **Don't bikeshed style** — note as LOW or skip
- **Trust the author** — don't require changes that are preference, not correctness

Stay under 600 words.${CLARIFICATION_PROTOCOL}`,
};

// prettier-ignore
const registerCodingSkill = (skillsModule as Record<string, unknown>)['register' + 'Coding' + 'Skill'] as (skill: CodingSkillDefinition) => void; registerCodingSkill(securityAudit);
registerCodingSkill(performanceReview);
registerCodingSkill(testCoverageAnalysis);
registerCodingSkill(codeReview);
