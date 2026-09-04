/**
 * tools/eval/competitive/report.ts — human-readable output for the
 * competitive bench: the dry-run plan (primary verification path, fully
 * offline) and the markdown comparison report (agent × anchor medians).
 * Text only — the machine-readable record lives in runs.jsonl/manifest.json.
 */

import type { AnchorManifest } from '../types.ts';
import type { AgentResolution, CompetitiveRunRecord } from './schema.ts';

/** Median of numeric samples (mean of the middle two for even n). */
export function median(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function fmtSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Dry-run plan text: anchors × agents × runs, with availability per agent. */
export function formatPlan(input: {
  anchors: readonly AnchorManifest[];
  resolutions: readonly AgentResolution[];
  runs: number;
  outDir: string;
}): string {
  const ready = input.resolutions.filter((r) => r.available).length;
  const planned = input.anchors.length * input.resolutions.length * input.runs;
  const executed = input.anchors.length * ready * input.runs;
  const lines: string[] = [
    'competitive bench — DRY RUN (offline: no agent process is spawned)',
    `out dir:   ${input.outDir}`,
    `anchors:   ${input.anchors.length} pinned`,
    ...input.anchors.map((a) => `  - ${a.id} (v${a.version}, tier ${a.tier}, profile ${a.profile})`),
    `agents:    ${input.resolutions.length} (${ready} ready, ${input.resolutions.length - ready} skip)`,
    ...input.resolutions.map((r) => {
      const note = r.available ? '' : ` — ${r.note}`;
      return `  ${r.agent.padEnd(9)} ${r.available ? 'ready' : 'skip'}${note}`;
    }),
    `runs/anchor: ${input.runs}`,
    `matrix:    ${input.anchors.length} anchors x ${input.resolutions.length} agents x ${input.runs} run(s) = ${planned} planned (${executed} executed + ${planned - executed} skipped)`,
    'advisory-only: results feed reports, never the CI gate.',
  ];
  return lines.join('\n');
}

function cellFor(records: readonly CompetitiveRunRecord[], available: boolean): string {
  if (records.length === 0) return available ? '-' : 'skip';
  const passes = records.filter((r) => r.status === 'pass').length;
  const walls = records.filter((r) => r.status !== 'skip' && Number.isFinite(r.wallMs)).map((r) => r.wallMs);
  const med = walls.length > 0 ? fmtSeconds(median(walls)) : 'n/a';
  return `${passes}/${records.length} · ${med}`;
}

/** Markdown comparison report (agent × anchor table + skips + raw paths). */
export function formatMarkdownReport(input: {
  outDir: string;
  manifestAnchors: readonly { id: string; version: number; tier: number }[];
  agents: readonly AgentResolution[];
  zelariVersion: string | null;
  records: readonly CompetitiveRunRecord[];
}): string {
  const { outDir, manifestAnchors, agents, records } = input;
  const runsFile = `${outDir}/runs.jsonl`;
  const manifestFile = `${outDir}/manifest.json`;

  const lines: string[] = [
    '# Competitive bench report',
    '',
    `- Recorded: ${new Date().toISOString()}`,
    `- Anchors (${manifestAnchors.length}): ${manifestAnchors.map((a) => `${a.id} v${a.version}`).join(', ')}`,
    `- Agents: ${agents
      .map((a) => {
        if (!a.available) return `${a.agent} (skip)`;
        const v = a.version ?? 'version n/a';
        return a.agent === 'zelari' ? `${a.agent} ${input.zelariVersion ?? v}` : `${a.agent} ${v}`;
      })
      .join(' · ')}`,
    `- Raw runs: \`${runsFile}\` · Manifest: \`${manifestFile}\``,
    '',
    '## agent × anchor (passed/runs · median wall)',
    '',
    `| agent | ${manifestAnchors.map((a) => a.id).join(' | ')} | total |`,
    `|---${manifestAnchors.map(() => '|---').join('')}|---|`,
  ];

  for (const agent of agents) {
    const perAnchor = manifestAnchors.map((a) =>
      cellFor(records.filter((r) => r.agent === agent.agent && r.anchorId === a.id), agent.available),
    );
    const own = records.filter((r) => r.agent === agent.agent);
    const total = agent.available ? `${own.filter((r) => r.status === 'pass').length}/${own.length}` : 'skip';
    lines.push(`| ${agent.agent} | ${perAnchor.join(' | ')} | ${total} |`);
  }

  lines.push('', '## Skips & warnings', '');
  const skips = agents.filter((a) => !a.available);
  if (skips.length === 0) {
    lines.push('- none — every selected agent was available.');
  } else {
    for (const a of skips) lines.push(`- ${a.agent}: ${a.note} — all anchors skipped.`);
  }

  const withTokens = records.filter((r) => r.tokens !== null || r.costUsd !== null);
  lines.push('', '## Tokens / cost', '');
  if (withTokens.length === 0) {
    lines.push('- n/a — no agent reported token usage or cost (zelari stream has no usage event yet; competitors publish no stable format).');
  } else {
    lines.push(`| agent | median tok in/out | cost USD |`, '|---|---|---|');
    for (const agent of agents) {
      const own = records.filter((r) => r.agent === agent.agent);
      const ins = own.map((r) => r.tokens?.input).filter((v): v is number => typeof v === 'number');
      const outs = own.map((r) => r.tokens?.output).filter((v): v is number => typeof v === 'number');
      const costs = own.map((r) => r.costUsd).filter((v): v is number => typeof v === 'number');
      const tok = ins.length > 0 && outs.length > 0 ? `${Math.round(median(ins))}/${Math.round(median(outs))}` : 'n/a';
      const cost = costs.length > 0 ? `$${median(costs).toFixed(4)}` : 'n/a';
      lines.push(`| ${agent.agent} | ${tok} | ${cost} |`);
    }
  }
  lines.push('', '_Advisory-only benchmark: same pinned anchors per agent, deterministic success checks as golden signal. Missing competitors are skipped, never failed._');
  return lines.join('\n');
}
