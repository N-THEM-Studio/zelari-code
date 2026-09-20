/**
 * WS1 (t133) — permission policy engine: precedence, specificity, matchers,
 * and the fail-closed contract of the project config parser.
 *
 * Style follows the sibling safety suites (policyEngine.test.ts /
 * toolPermissions.presets.test.ts): pure fixtures, no fs, no clock.
 */
import { describe, expect, it } from 'vitest';
import {
  describePermissionRule,
  evaluatePermissionPolicy,
  formatPermissionDenial,
  matchPermissionRule,
  matchPermissionRules,
  parsePermissionRuleFile,
  PermissionRuleFileSchema,
  PermissionRuleSchema,
  type ActivePermissionRule,
  type PermissionRule,
} from './permissionPolicy.js';

function rule(partial: Partial<PermissionRule> & { id: string }): PermissionRule {
  return { effect: 'deny', ...partial } as PermissionRule;
}
function active(...rules: PermissionRule[]): ActivePermissionRule[] {
  return rules.map((r) => ({ rule: r, source: 'project' as const }));
}

describe('WS1 engine — precedence deny > ask > allow', () => {
  it('the most restrictive effect wins regardless of declaration order', () => {
    const allow = rule({ id: 'a', effect: 'allow', tool: 'bash', category: 'execute' });
    const ask = rule({ id: 'b', effect: 'ask', tool: 'bash', category: 'execute' });
    const deny = rule({ id: 'c', effect: 'deny', tool: 'bash' });
    for (const rules of [
      active(allow, ask, deny),
      active(deny, ask, allow),
      active(ask, deny, allow),
    ]) {
      const hit = matchPermissionRules(rules, {
        toolName: 'bash',
        categories: ['execute'],
      });
      expect(hit?.rule.id).toBe('c');
      expect(hit?.rule.effect).toBe('deny');
    }
  });

  it('among the same effect the MOST SPECIFIC rule wins (more matchers)', () => {
    const broad = rule({ id: 'broad', effect: 'deny', tool: 'write_file' });
    const narrow = rule({
      id: 'narrow',
      effect: 'deny',
      tool: 'write_file',
      pathPrefix: 'secrets',
      category: 'write',
    });
    const hit = matchPermissionRules(active(broad, narrow), {
      toolName: 'write_file',
      categories: ['write'],
      paths: ['secrets/key.pem', '/repo/secrets/key.pem'],
    });
    expect(hit?.rule.id).toBe('narrow');
    expect(hit?.specificity).toBe(3);
  });

  it('a catch-all rule (no matcher) loses same-effect ties to any matcher rule', () => {
    const catchAll = rule({ id: 'everything', effect: 'deny' });
    const scoped = rule({ id: 'scoped', effect: 'deny', host: 'evil.test' });
    expect(matchPermissionRules(active(catchAll, scoped), { toolName: 'fetch_url' })?.rule.id).toBe(
      'everything',
    );
    expect(
      matchPermissionRules(active(catchAll, scoped), { toolName: 'fetch_url', host: 'evil.test' })?.rule
        .id,
    ).toBe('scoped');
  });

  it('equal effect + equal specificity keeps declaration order (session listed first)', () => {
    const first = rule({ id: 'first', effect: 'ask', tool: 'bash' });
    const second = rule({ id: 'second', effect: 'ask', tool: 'bash' });
    expect(matchPermissionRules(active(first, second), { toolName: 'bash' })?.rule.id).toBe('first');
  });

  it('declared matchers are conjunctive: a non-matching one disqualifies the rule', () => {
    const both = rule({ id: 'both', effect: 'deny', tool: 'write_file', category: 'execute' });
    expect(
      matchPermissionRule(
        { rule: both, source: 'project' },
        { toolName: 'write_file', categories: ['write'] },
      ),
    ).toBeNull();
  });
});

describe('WS1 engine — matchers', () => {
  it('tool: exact name or * glob', () => {
    expect(matchPermissionRule({ rule: rule({ id: 't', tool: 'bash' }), source: 'session' }, { toolName: 'bash' })).not.toBeNull();
    expect(matchPermissionRule({ rule: rule({ id: 't', tool: 'bash' }), source: 'session' }, { toolName: 'bash2' })).toBeNull();
    expect(matchPermissionRule({ rule: rule({ id: 'g', tool: 'mcp__*' }), source: 'session' }, { toolName: 'mcp__github__x' })).not.toBeNull();
    expect(matchPermissionRule({ rule: rule({ id: 'c', tool: '*' }), source: 'session' }, { toolName: 'anything' })).not.toBeNull();
  });

  it('category: matches any of the tool categories; absent category never matches', () => {
    const r = { rule: rule({ id: 'w', category: 'write' as const }), source: 'project' as const };
    expect(matchPermissionRule(r, { toolName: 'apply_diff', categories: ['write'] })).not.toBeNull();
    expect(matchPermissionRule(r, { toolName: 'apply_diff', categories: ['read', 'write'] })).not.toBeNull();
    expect(matchPermissionRule(r, { toolName: 'read_file', categories: ['read'] })).toBeNull();
    expect(matchPermissionRule(r, { toolName: 'mystery' })).toBeNull();
  });

  it('pathPrefix: segment-boundary, separator- and case-insensitive, any candidate value', () => {
    const r = { rule: rule({ id: 'p', pathPrefix: 'secrets' }), source: 'project' as const };
    expect(matchPermissionRule(r, { toolName: 'write_file', paths: ['secrets/a.pem'] })).not.toBeNull();
    expect(matchPermissionRule(r, { toolName: 'write_file', paths: ['SeCrEtS\\a.pem'] })).not.toBeNull();
    expect(matchPermissionRule(r, { toolName: 'write_file', paths: ['/repo/secrets/a.pem'] })).not.toBeNull();
    // boundary: `secrets-private` is NOT inside `secrets`
    expect(matchPermissionRule(r, { toolName: 'write_file', paths: ['secrets-private/a.pem'] })).toBeNull();
    expect(
      matchPermissionRule(
        { rule: rule({ id: 'abs', pathPrefix: '/repo/secrets' }), source: 'project' },
        { toolName: 'write_file', paths: ['a.txt', '/repo/secrets/a.txt'] },
      ),
    ).not.toBeNull();
  });

  it('host: exact or domain suffix, with an optional *. prefix', () => {
    const exact = { rule: rule({ id: 'h', host: 'example.com' }), source: 'project' as const };
    expect(matchPermissionRule(exact, { toolName: 'fetch_url', host: 'example.com' })).not.toBeNull();
    expect(matchPermissionRule(exact, { toolName: 'fetch_url', host: 'api.example.com' })).not.toBeNull();
    expect(matchPermissionRule(exact, { toolName: 'fetch_url', host: 'notexample.com' })).toBeNull();
    const wild = { rule: rule({ id: 'w', host: '*.example.com' }), source: 'project' as const };
    expect(matchPermissionRule(wild, { toolName: 'fetch_url', host: 'api.example.com' })).not.toBeNull();
    expect(matchPermissionRule(wild, { toolName: 'fetch_url' })).toBeNull();
  });
});

describe('WS1 engine — decisions & fail-closed', () => {
  it('no rules ⇒ no opinion (null), and the fallback keeps the category decision', () => {
    expect(matchPermissionRules([], { toolName: 'bash', categories: ['execute'] })).toBeNull();
    const withDefault = evaluatePermissionPolicy([], { toolName: 'bash' }, { fallback: 'allow' });
    expect(withDefault).toMatchObject({ decision: 'allow', source: 'default', reason: '' });
  });

  it('no rule + NO fallback fails closed on ask — never a silent allow', () => {
    const v = evaluatePermissionPolicy([], { toolName: 'bash' });
    expect(v.decision).toBe('ask');
    expect(v.source).toBe('fail-closed');
    expect(v.reason).toContain('failing closed');
  });

  it('verdict carries the matched rule id, source and note', () => {
    const v = evaluatePermissionPolicy(
      [{ rule: rule({ id: 'no-push', effect: 'deny', tool: 'bash', note: 'never push' }), source: 'session' }],
      { toolName: 'bash', categories: ['execute'] },
    );
    expect(v).toMatchObject({ decision: 'deny', matchedRuleId: 'no-push', source: 'session' });
    expect(v.reason).toBe("[permissions:session] rule 'no-push' — never push");
    expect(formatPermissionDenial('bash', v)).toContain("rule 'no-push'");
    expect(formatPermissionDenial('bash', v)).toContain('denied "bash"');
  });

  it('an unconstrained rule never widens anything on its own: specificity is reported', () => {
    const v = evaluatePermissionPolicy(active(rule({ id: 'all', effect: 'ask' })), { toolName: 'x' });
    expect(v.specificity).toBe(0);
    expect(v.decision).toBe('ask');
    expect(describePermissionRule('project', { id: 'all' })).toBe("[permissions:project] rule 'all'");
  });
});

describe('WS1 — .zelari/permissions.json parsing is fail-closed', () => {
  const FILE = '/repo/.zelari/permissions.json';
  const valid = JSON.stringify({
    version: 1,
    rules: [
      { id: 'no-secrets', effect: 'deny', pathPrefix: 'secrets' },
      { id: 'ask-network', effect: 'ask', category: 'network', note: 'review network' },
    ],
  });

  it('accepts a well-formed file and tags every rule as source project', () => {
    const res = parsePermissionRuleFile(valid, FILE);
    expect(res.error).toBeUndefined();
    expect(res.rules.map((r) => [r.source, r.rule.id, r.rule.effect])).toEqual([
      ['project', 'no-secrets', 'deny'],
      ['project', 'ask-network', 'ask'],
    ]);
  });

  it('a catch-all project rule is accepted (deny-everything is expressible)', () => {
    const res = parsePermissionRuleFile(JSON.stringify({ rules: [{ id: 'all', effect: 'deny' }] }), FILE);
    expect(res.error).toBeUndefined();
    expect(res.rules).toHaveLength(1);
  });

  it.each([
    ['invalid JSON', '{not json', 'invalid JSON'],
    ['unknown key', JSON.stringify({ rules: [{ id: 'x', effect: 'deny', tool: 'bash', extra: 1 }] }), 'invalid permissions config'],
    ['bad effect', JSON.stringify({ rules: [{ id: 'x', effect: 'maybe' }] }), 'invalid permissions config'],
    ['missing id', JSON.stringify({ rules: [{ effect: 'deny' }] }), 'invalid permissions config'],
    ['unknown category', JSON.stringify({ rules: [{ id: 'x', effect: 'deny', category: 'shell' }] }), 'invalid permissions config'],
    ['duplicate id', JSON.stringify({ rules: [{ id: 'x', effect: 'deny' }, { id: 'x', effect: 'allow' }] }), 'duplicate rule id'],
    ['wrong version', JSON.stringify({ version: 2, rules: [] }), 'invalid permissions config'],
    ['rules not an array', JSON.stringify({ rules: {} }), 'invalid permissions config'],
  ])('%s → error naming the file, and NO rules', (_label, raw, needle) => {
    const res = parsePermissionRuleFile(raw, FILE);
    expect(res.rules).toEqual([]);
    expect(res.error).toContain(FILE);
    expect(res.error).toContain(needle);
    expect(res.error).toContain('failing closed');
  });

  it('a malformed config can never yield an allow verdict', () => {
    const res = parsePermissionRuleFile('{oops', FILE);
    const rules: ActivePermissionRule[] = res.rules;
    const v = evaluatePermissionPolicy(rules, { toolName: 'bash' }, { fallback: 'allow' });
    // no rules survive → the caller falls back to the category decision
    expect(v.source).toBe('default');
    // …and the error text is what the gate surfaces as a fail-closed ask
    expect(res.error).toBeTruthy();
  });
});

/**
 * The `$comment` documentation slot — the WS1 self-footgun this suite pins.
 *
 * The template WS1 ships as `.zelari/permissions.json` IS
 * `{ "$comment": …, "version": 1, "rules": [] }`. The `.strict()` schemas used
 * to reject it as malformed, and a malformed config fails closed (every call
 * 'ask') — so the shipped 0-rule file had the exact OPPOSITE effect of a
 * rule-less file: nothing at all was allowed without an interactive approver.
 * `$comment` is therefore accepted AND stripped (content never validated,
 * never reaching the engine); every other unknown key stays fatal.
 */
describe('WS1 — `$comment` is documentation: accepted, stripped, never policy', () => {
  const FILE = '/repo/.zelari/permissions.json';

  it('top-level `$comment` + a rule with its own `$comment` load, comments stripped, rule active', () => {
    const res = parsePermissionRuleFile(
      JSON.stringify({
        $comment: 'WS1 (t133) local permission policy — ships with NO rules.',
        version: 1,
        rules: [
          {
            $comment: 'credentials never leave the repo',
            id: 'no-secrets',
            effect: 'deny',
            pathPrefix: 'secrets',
          },
        ],
      }),
      FILE,
    );
    expect(res.error).toBeUndefined();
    expect(res.rules).toHaveLength(1);
    const entry = res.rules[0];
    expect(entry?.source).toBe('project');
    expect(entry?.rule).toEqual({ id: 'no-secrets', effect: 'deny', pathPrefix: 'secrets' });
    expect(Object.keys(entry?.rule ?? {})).not.toContain('$comment');
    // …and the rule still DECIDES (a comment must never change the verdict)
    expect(evaluatePermissionPolicy(res.rules, { toolName: 'write_file', paths: ['secrets/key.pem'] })).toMatchObject(
      { decision: 'deny', matchedRuleId: 'no-secrets' },
    );
  });

  it('the shipped 0-rule template is a VALID config and stays a no-op', () => {
    const res = parsePermissionRuleFile(
      JSON.stringify({ $comment: 'documentation only', version: 1, rules: [] }),
      FILE,
    );
    expect(res.error).toBeUndefined();
    expect(res.rules).toEqual([]);
    // zero rules ⇒ no opinion ⇒ the category decision stands (pre-WS1 behavior)
    expect(
      evaluatePermissionPolicy(res.rules, { toolName: 'bash' }, { fallback: 'allow' }),
    ).toMatchObject({ decision: 'allow', source: 'default' });
  });

  it('both schemas strip the key themselves (no `$comment` survives parsing)', () => {
    expect(PermissionRuleSchema.parse({ $comment: 'doc', id: 'x', effect: 'deny' })).toEqual({
      id: 'x',
      effect: 'deny',
    });
    const file = PermissionRuleFileSchema.parse({
      $comment: 'doc',
      version: 1,
      rules: [{ $comment: 'doc', id: 'x', effect: 'deny' }],
    });
    expect(file).toEqual({ version: 1, rules: [{ id: 'x', effect: 'deny' }] });
    expect(Object.keys(file)).not.toContain('$comment');
  });

  it('`$comment` is the ONLY tolerated extra key: a typo (or a case slip) still fails closed', () => {
    const malformed = [
      // rule-level typo
      JSON.stringify({ rules: [{ $comment: 'doc', id: 'x', effect: 'deny', coment: 'typo' }] }),
      // top level, wrong case
      JSON.stringify({ $Comment: 'wrong case', rules: [] }),
    ];
    for (const raw of malformed) {
      const res = parsePermissionRuleFile(raw, FILE);
      expect(res.rules).toEqual([]);
      expect(res.error).toContain(FILE);
      expect(res.error).toContain('invalid permissions config');
      expect(res.error).toContain('failing closed');
    }
  });

  it('a comment does NOT swallow the real error: bad effect fails closed naming the path', () => {
    const res = parsePermissionRuleFile(
      JSON.stringify({
        $comment: 'doc',
        version: 1,
        rules: [{ $comment: 'doc', id: 'x', effect: 'maybe' }],
      }),
      FILE,
    );
    expect(res.rules).toEqual([]);
    expect(res.error).toContain(FILE);
    expect(res.error).toContain("at 'rules.0.effect'");
    expect(res.error).toContain('failing closed');
  });

  it('a non-string `$comment` is still a wrong type (the slot is a string, not a free-for-all)', () => {
    const res = parsePermissionRuleFile(JSON.stringify({ $comment: 42, rules: [] }), FILE);
    expect(res.rules).toEqual([]);
    expect(res.error).toContain(FILE);
    expect(res.error).toContain('failing closed');
  });
});
