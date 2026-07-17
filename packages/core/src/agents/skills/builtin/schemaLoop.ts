/**
 * schema-loop — Schema-inspired certify/hypothesis skill for coding agents.
 * @see https://schema-harness.github.io/
 */
import type { CodingSkillDefinition } from '../../skills.js';
import { registerCodingSkill } from '../../skills.js';

const schemaLoop: CodingSkillDefinition = {
  id: 'schema-loop',
  version: '1.0.0',
  name: 'Schema Loop (certify before done)',
  description:
    'Physicist-style coding harness: keep an explicit hypothesis, define certifiable checks, ' +
    'run_backtest before claiming done, and treat prediction mismatches as plan-voiding surprises. ' +
    'When ≥2 hypotheses remain, run one discriminating experiment first.',
  category: 'debug',
  requiredRoles: [],
  requiredTools: [
    'update_world_hypothesis',
    'set_world_checks',
    'run_backtest',
    'record_world_observation',
    'bash',
    'read_file',
  ],
  estimatedCost: 'medium',
  enabledByDefault: true,
  builtin: true,
  triggers: [
    'Non-trivial bug or multi-step implementation',
    'You are about to claim the task is done',
    'Tests or typecheck failed after edits',
    'Two or more competing root-cause hypotheses',
    'Surprising tool result (wrong exit code, missing path, shell mismatch)',
  ],
  antiPatterns: [
    'Trivial one-line typo fix with no uncertainty',
    'Pure documentation rewrite with no behavior change',
    'User explicitly asked for a draft-only answer without running tools',
  ],
  requires: [],
  relatedSkills: ['debug-with-rag', 'root-cause-five-whys', 'reproduce-bug'],
  tags: ['schema', 'backtest', 'hypothesis', 'verify', 'world-model', 'debug'],
  examples: [
    {
      input: 'Fix the flaky headless test timeout',
      output: {
        hypothesis:
          'Test hangs because registerMcpTools spawns real MCP servers; default 5s timeout is too low.',
        checks: [
          { id: 'unit', command: 'npx vitest run tests/unit/cli-useChatTurn.test.ts' },
        ],
        next: 'set_world_checks → implement isolation → run_backtest → only then claim done',
      },
    },
  ],
  outputSchema:
    '{ hypothesis: string; checks: Array<{ id: string; command: string }>; backtestOk: boolean; surprises?: string[] }',
  systemPromptFragment: `You are running the **Schema Loop** adapted for software engineering
(inspired by Schema harness / ARC world-models — but for repos, not grids).

## Core idea
The latent model of the task is **explicit files under .zelari/world/**, not only chat context:
- hypothesis.md — what you believe (objects = modules, mechanism = bug cause / design)
- checks.json — certifiable shell checks (the "reality" oracle)
- timeline.jsonl — append-only observations (do not rewrite history)

## Outer loop
1. **observe** — read errors, failing tests, tool results
2. **deliberate** — update_world_hypothesis; set_world_checks
3. **execute** — edit/run tools to change the repo
4. **record** — record_world_observation on surprises; run_backtest to certify

## Hard rules (reality outranks the model)
1. **Never claim done** while the latest run_backtest has ok=false or total=0 without checks.
2. After any batch of write/edit, prefer run_backtest (or set checks then backtest) before asserting success.
3. **Surprise = void plan**: if a command exits unexpectedly, shell rejects POSIX on Windows, path missing, or tests fail differently than predicted — call record_world_observation (kind=surprise), revise hypothesis, do not keep patching blindly.
4. **Discovery actions**: when ≥2 hypotheses remain consistent with evidence, design ONE discriminating experiment (read/grep/test) whose outcomes diverge; do not spray random edits.
5. Prefer fast checks (single-file vitest, typecheck) over full suite until the model is stable.

## Predict-then-act (soft)
Before a risky bash/edit, state a short prediction in hypothesis or observation
(expect exit 0, files touched). After the tool, if reality mismatches, log surprise.

## Tools
- update_world_hypothesis — write/append theory
- set_world_checks — define certifiable commands
- run_backtest — replay all checks; report exact pass/fail
- record_world_observation — timeline ground truth

Kill switch for tools: ZELARI_SCHEMA_LOOP=0.
${''}`,
};

registerCodingSkill(schemaLoop);
