/**
 * Mission brief — a structured, deterministic reading of a free-form prompt.
 *
 * Level A (this module): rules + heuristics, pure and dependency-free, always
 * runs. Level B (optional LLM polish of `deliverableThisMission`/`assumptions`)
 * is layered on by the CLI driver, not here — so the brief stays testable and
 * free of provider coupling.
 */

import { classifyMission, type MissionIntent } from './mission.js';
import { resolveCouncilRunMode, type CouncilRunMode } from './runMode.js';

export interface MissionSlice {
  id: string;
  title: string;
  /** Task ids from `.zelari/plan.json` bound to this slice (filled by the driver). */
  taskIds?: string[];
  /** Upper bound on tasks for the MVP slice. */
  maxTasks?: number;
}

export interface MissionBrief {
  intent: MissionIntent;
  /** How the FIRST run should behave. Greenfield with no plan → design-phase. */
  runModeHint: CouncilRunMode;
  stackInferred: string[];
  deliverableThisMission: string;
  assumptions: string[];
  outOfScope: string[];
  phases: Array<{ name: string; mode: CouncilRunMode }>;
  /** The slice whose `completion.ok` ends the mission (stop = MVP slice). */
  sliceMvp: MissionSlice;
  slices: MissionSlice[];
  userPromptOriginal: string;
}

export interface BuildMissionBriefInput {
  userMessage: string;
  hasPlan?: boolean;
  /** Max tasks in the MVP slice. Default 8. */
  maxSliceTasks?: number;
  env?: { ZELARI_COUNCIL_MODE?: string };
}

/** Rough stack detection — surfaced to members, not authoritative. */
const STACK_SIGNALS: Array<[RegExp, string]> = [
  [/\breact\b/i, 'react'],
  [/\bnext\.?js\b/i, 'nextjs'],
  [/\bvue\b/i, 'vue'],
  [/\bsvelte\b/i, 'svelte'],
  [/\bangular\b/i, 'angular'],
  [/\bnode(\.js)?\b/i, 'node'],
  [/\bexpress\b/i, 'express'],
  [/\blaravel\b/i, 'laravel'],
  [/\bphp\b/i, 'php'],
  [/\bpython\b/i, 'python'],
  [/\bdjango\b/i, 'django'],
  [/\bflask\b/i, 'flask'],
  [/\btypescript\b|\bts\b/i, 'typescript'],
  [/\btailwind\b/i, 'tailwind'],
  [/\bpostgres(ql)?\b/i, 'postgres'],
  [/\bmysql\b/i, 'mysql'],
  [/\bsqlite\b/i, 'sqlite'],
  [/\bmongo(db)?\b/i, 'mongodb'],
  [/\bstripe\b/i, 'stripe'],
];

function inferStack(msg: string): string[] {
  const found = new Set<string>();
  for (const [re, name] of STACK_SIGNALS) {
    if (re.test(msg)) found.add(name);
  }
  return [...found];
}

function firstSentence(msg: string, max = 160): string {
  const oneLine = msg.replace(/\s+/g, ' ').trim();
  return oneLine.length <= max ? oneLine : oneLine.slice(0, max - 1).trimEnd() + '…';
}

function deliverableFor(intent: MissionIntent, msg: string): string {
  const s = firstSentence(msg);
  switch (intent) {
    case 'greenfield':
      return `Design and scaffold a working MVP for: ${s}`;
    case 'redesign':
      return `Redesign the UI/UX while preserving behaviour for: ${s}`;
    case 'extend':
      return `Extend the existing project with: ${s}`;
    case 'fix':
      return `Diagnose and resolve: ${s}`;
  }
}

function assumptionsFor(intent: MissionIntent, stack: string[], msg: string): string[] {
  const out: string[] = [];
  if (intent === 'greenfield' && stack.length === 0) {
    out.push('Stack not specified — a sensible default will be chosen and stated in the plan.');
  }
  if (/\b(pagament|payment|checkout|stripe)\b/i.test(msg)) {
    out.push('Payments are stubbed (no live gateway credentials).');
  }
  if (/\b(auth|login|accesso|autenticazione)\b/i.test(msg)) {
    out.push('Authentication uses a minimal local scheme unless specified otherwise.');
  }
  if (out.length === 0) {
    out.push('Scope is limited to the MVP slice defined below.');
  }
  return out;
}

/**
 * Build the deterministic (Level A) mission brief.
 */
export function buildMissionBrief(input: BuildMissionBriefInput): MissionBrief {
  const { userMessage, hasPlan = false } = input;
  const maxTasks = input.maxSliceTasks ?? 8;

  const intent = classifyMission({ userMessage, hasPlan });
  const runModeHint = resolveCouncilRunMode({
    userMessage,
    hasExistingPlan: hasPlan,
    env: input.env,
  });
  const stackInferred = inferStack(userMessage);

  const isGreenfield = intent === 'greenfield' && !hasPlan;
  const phases: MissionBrief['phases'] = isGreenfield
    ? [
        { name: 'design', mode: 'design-phase' },
        { name: 'implementation', mode: 'implementation' },
      ]
    : [{ name: runModeHint === 'design-phase' ? 'design' : 'implementation', mode: runModeHint }];

  const sliceMvp: MissionSlice = {
    id: 'slice-mvp',
    title: `MVP — ${firstSentence(userMessage, 60)}`,
    maxTasks,
  };

  return {
    intent,
    runModeHint,
    stackInferred,
    deliverableThisMission: deliverableFor(intent, userMessage),
    assumptions: assumptionsFor(intent, stackInferred, userMessage),
    outOfScope: [
      'Production deployment and CI/CD pipelines',
      'Real credentials, secrets, and third-party account setup',
    ],
    phases,
    sliceMvp,
    slices: [sliceMvp],
    userPromptOriginal: userMessage,
  };
}
