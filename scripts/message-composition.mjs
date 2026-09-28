#!/usr/bin/env node
/**
 * scripts/message-composition.mjs — offline report over kind:"message" rows.
 *
 * Reads the metrics file written by recordMessageUsage (default
 * ~/.zelari-code/metrics.jsonl, override ANATHEMA_METRICS_FILE or --file)
 * and answers the only question this file can answer:
 *
 *   cache hit = cachedPromptTokens / promptTokens
 *     (same formula as src/cli/budget/cacheHitReport.ts)
 *   which request source weighs more, on rows that carry `composition`
 *     (characters, src/cli/budget/requestComposition.ts)
 *
 * It does not call a provider, change a default, or attribute tentacles.
 * kind:"message" has no agentId. Guessing lead vs tentacle from the model
 * name would be a lie; the report says unknown instead.
 *
 * mcpToolsChars is a subset of toolsChars and is not added again.
 * Token attribution (promptTokens * sourceChars / totalChars) runs only on
 * rows that have both a billed prompt and a positive totalChars.
 *
 * Exit: 0 read · 1 bad args or missing file · 2 no kind:message rows.
 */
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const USAGE = `usage: node scripts/message-composition.mjs [--file <metrics.jsonl>] [--window <n>] [--json] [--out <file>] [--self-test]

  --file       metrics JSONL (default: ANATHEMA_METRICS_FILE or ~/.zelari-code/metrics.jsonl)
  --window     last N kind:message rows (default: all rows in the file)
  --json       machine-readable object on stdout
  --out        also write the human report to this path
  --self-test  check share math on a fixture and exit

Does not promote ZELARI_PROMPT_PROFILE=lean. Composition coverage below 50 rows
is reported as insufficient.`;

const SOURCES = ['system', 'tools', 'trailing', 'user', 'assistant', 'toolResults'];
const MIN_COMPOSITION_ROWS = 50;

function parseArgs(argv) {
  const out = { file: undefined, window: 0, json: false, outPath: undefined, selfTest: false, error: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') out.json = true;
    else if (arg === '--self-test') out.selfTest = true;
    else if (arg === '--file') {
      out.file = argv[++i];
      if (!out.file) return { ...out, error: '--file requires a value' };
    } else if (arg === '--window') {
      const raw = argv[++i];
      const n = raw === undefined ? NaN : Number.parseInt(raw, 10);
      if (!Number.isFinite(n) || n < 0) return { ...out, error: '--window requires a non-negative integer' };
      out.window = n;
    } else if (arg === '--out') {
      out.outPath = argv[++i];
      if (!out.outPath) return { ...out, error: '--out requires a value' };
    } else if (arg === '--help' || arg === '-h') return { ...out, error: USAGE };
    else return { ...out, error: `unknown argument: ${arg}` };
  }
  return out;
}

function defaultMetricsPath() {
  const override = process.env.ANATHEMA_METRICS_FILE;
  if (override && override.trim()) return override.trim();
  const home = process.env.ZELARI_HOME && process.env.ZELARI_HOME.trim()
    ? process.env.ZELARI_HOME.trim()
    : path.join(os.homedir(), '.zelari-code');
  return path.join(home, 'metrics.jsonl');
}

function num(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function emptySources() {
  return { system: 0, tools: 0, trailing: 0, user: 0, assistant: 0, toolResults: 0 };
}

function sourceChars(composition) {
  return {
    system: num(composition.systemChars),
    tools: num(composition.toolsChars),
    trailing: num(composition.trailingChars),
    user: num(composition.userChars),
    assistant: num(composition.assistantChars),
    toolResults: num(composition.toolResultChars),
  };
}

/** @param {Record<string, unknown>[]} rows kind:message objects, already windowed */
export function aggregate(rows) {
  let promptTokens = 0;
  let cachedPromptTokens = 0;
  let billable = 0;
  const byModel = new Map();
  const chars = emptySources();
  const attributed = emptySources();
  let compositionRows = 0;
  let compositionPrompt = 0;
  let mcpChars = 0;
  let storedTotal = 0;
  let summedTotal = 0;
  const toolResults = new Map();
  let minTs = Infinity;
  let maxTs = 0;

  for (const row of rows) {
    const prompt = num(row.promptTokens);
    const cached = Math.min(num(row.cachedPromptTokens), prompt);
    if (typeof row.ts === 'number' && Number.isFinite(row.ts)) {
      if (row.ts < minTs) minTs = row.ts;
      if (row.ts > maxTs) maxTs = row.ts;
    }
    if (prompt > 0) {
      billable += 1;
      promptTokens += prompt;
      cachedPromptTokens += cached;
      const key = `${row.provider || 'unknown'}::${row.model || 'unknown'}`;
      const model = byModel.get(key) ?? {
        provider: row.provider || 'unknown',
        model: row.model || 'unknown',
        messages: 0,
        promptTokens: 0,
        cachedPromptTokens: 0,
      };
      model.messages += 1;
      model.promptTokens += prompt;
      model.cachedPromptTokens += cached;
      byModel.set(key, model);
    }

    const composition = row.composition;
    if (!composition || typeof composition !== 'object') continue;
    const parts = sourceChars(composition);
    const total = SOURCES.reduce((sum, key) => sum + parts[key], 0);
    if (total <= 0) continue;
    compositionRows += 1;
    storedTotal += num(composition.totalChars);
    summedTotal += total;
    mcpChars += num(composition.mcpToolsChars);
    if (prompt > 0) compositionPrompt += prompt;
    for (const key of SOURCES) {
      chars[key] += parts[key];
      if (prompt > 0) attributed[key] += prompt * (parts[key] / total);
    }
    const byTool = composition.toolResultsByTool;
    if (byTool && typeof byTool === 'object') {
      for (const [name, value] of Object.entries(byTool)) {
        toolResults.set(name, (toolResults.get(name) ?? 0) + num(value));
      }
    }
  }

  const share = Object.fromEntries(
    SOURCES.map((key) => [key, summedTotal > 0 ? chars[key] / summedTotal : 0]),
  );
  return {
    messages: rows.length,
    span: {
      from: Number.isFinite(minTs) ? new Date(minTs).toISOString() : null,
      to: maxTs > 0 ? new Date(maxTs).toISOString() : null,
    },
    cache: {
      messages: billable,
      promptTokens,
      cachedPromptTokens,
      hitRate: promptTokens > 0 ? cachedPromptTokens / promptTokens : 0,
      byModel: [...byModel.values()]
        .map((row) => ({
          ...row,
          hitRate: row.promptTokens > 0 ? row.cachedPromptTokens / row.promptTokens : 0,
        }))
        .sort((a, b) => b.promptTokens - a.promptTokens),
    },
    composition: {
      rows: compositionRows,
      coverage: rows.length > 0 ? compositionRows / rows.length : 0,
      chars,
      share,
      attributedPromptTokens: attributed,
      attributedPromptTotal: compositionPrompt,
      mcpChars,
      storedTotalChars: storedTotal,
      summedTotalChars: summedTotal,
      topToolResults: [...toolResults.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([name, chars]) => ({ name, chars })),
    },
    tentacles: {
      attributable: false,
      reason: 'kind:message has no agentId. Lead vs tentacle is not in this file.',
    },
  };
}

function decide(summary) {
  const n = summary.composition.rows;
  if (n < MIN_COMPOSITION_ROWS) {
    return {
      promoteLean: false,
      reason: `composition on ${n} rows, below ${MIN_COMPOSITION_ROWS}. Do not promote lean or cut a source from this file.`,
    };
  }
  const share = summary.composition.share;
  const heaviest = SOURCES.reduce((best, key) => (share[key] > share[best] ? key : best), SOURCES[0]);
  if (summary.cache.hitRate < 0.4 && summary.cache.messages >= MIN_COMPOSITION_ROWS) {
    return {
      promoteLean: false,
      reason: `cache hit ${(summary.cache.hitRate * 100).toFixed(1)}% on ${summary.cache.messages} calls. Prefix churn dominates a shorter prompt.`,
    };
  }
  if (heaviest === 'toolResults' && share.toolResults >= 0.4) {
    return {
      promoteLean: false,
      reason: 'tool results are the heaviest source. lean removes the tool catalog, not results.',
    };
  }
  if (heaviest === 'system' || heaviest === 'tools') {
    return {
      promoteLean: false,
      reason: `${heaviest} is the heaviest composed source (${(share[heaviest] * 100).toFixed(1)}%). That makes lean an eval candidate (tokenEfficiencyArms), not a default change.`,
    };
  }
  return {
    promoteLean: false,
    reason: `${heaviest} leads at ${(share[heaviest] * 100).toFixed(1)}%, not enough to change a default.`,
  };
}

function fmtInt(n) {
  return Math.round(n).toLocaleString('en-US');
}

function fmtRate(rate) {
  return `${(rate * 100).toFixed(1)}%`;
}

function formatReport(file, summary, decision) {
  const cache = summary.cache;
  const composition = summary.composition;
  const lines = [
    'message composition',
    `file: ${file}`,
    `span: ${summary.span.from ?? 'n/a'} .. ${summary.span.to ?? 'n/a'}`,
    `rows: ${summary.messages} kind:message`,
    '',
    'cache',
    `  messages ${cache.messages} · prompt ${fmtInt(cache.promptTokens)} tokens · cached ${fmtInt(cache.cachedPromptTokens)} · hit ${fmtRate(cache.hitRate)}`,
  ];
  for (const row of cache.byModel.slice(0, 5)) {
    lines.push(
      `  ${row.provider}/${row.model}  ${fmtRate(row.hitRate)}  (${row.messages} msg · ${fmtInt(row.promptTokens)} prompt)`,
    );
  }
  lines.push(
    '',
    'composition',
    `  instrumented ${composition.rows}/${summary.messages} (${fmtRate(composition.coverage)}) — characters of the request as sent, not tokens`,
  );
  if (composition.rows === 0) {
    lines.push('  no row carries composition. Source shares are unknown, not zero.');
  } else {
    for (const key of SOURCES) {
      lines.push(`  ${key}  ${fmtInt(composition.chars[key])} chars  ${fmtRate(composition.share[key])}`);
    }
    lines.push(`  mcp schemas (subset of tools)  ${fmtInt(composition.mcpChars)} chars`);
    if (composition.storedTotalChars > 0) {
      const drift = Math.abs(composition.storedTotalChars - composition.summedTotalChars) / composition.storedTotalChars;
      if (drift > 0.01) {
        lines.push(`  note: stored totalChars differs from the sum of sources by ${fmtRate(drift)}`);
      }
    }
    lines.push(`  attributed prompt tokens on those rows: ${fmtInt(composition.attributedPromptTotal)}`);
    for (const key of SOURCES) {
      lines.push(`    ${key}  ~${fmtInt(composition.attributedPromptTokens[key])}`);
    }
    if (composition.topToolResults.length > 0) {
      lines.push(
        '  top tool-result producers: ' +
          composition.topToolResults.map((row) => `${row.name} ${fmtInt(row.chars)}`).join(' · '),
      );
    }
  }
  lines.push(
    '',
    'tentacles',
    `  ${summary.tentacles.reason}`,
    '',
    'decision',
    '  do not promote ZELARI_PROMPT_PROFILE=lean from this file.',
    `  ${decision.reason}`,
    '',
  );
  return lines.join('\n');
}

function selfTest() {
  const summary = aggregate([
    {
      kind: 'message',
      ts: 1,
      provider: 'fixture',
      model: 'fixture',
      promptTokens: 100,
      cachedPromptTokens: 40,
      composition: {
        totalChars: 100,
        systemChars: 50,
        toolsChars: 10,
        mcpToolsChars: 4,
        trailingChars: 5,
        userChars: 5,
        assistantChars: 10,
        toolResultChars: 20,
        toolResultsByTool: { read_file: 20 },
      },
    },
    { kind: 'message', promptTokens: 0, cachedPromptTokens: 10 },
  ]);
  const problems = [];
  if (Math.abs(summary.composition.share.system - 0.5) > 1e-9) problems.push('system share');
  if (Math.abs(summary.cache.hitRate - 0.4) > 1e-9) problems.push('hit rate');
  if (Math.abs(summary.composition.attributedPromptTokens.toolResults - 20) > 1e-6) problems.push('attribution');
  if (summary.tentacles.attributable !== false) problems.push('tentacles');
  if (decide(summary).promoteLean !== false) problems.push('decision');
  if (problems.length > 0) {
    console.error(`self-test failed: ${problems.join(', ')}`);
    process.exit(1);
  }
  console.log('self-test ok');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.selfTest) {
    selfTest();
    return;
  }
  if (args.error) {
    console.error(args.error);
    process.exit(1);
  }
  const file = args.file ?? defaultMetricsPath();
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (err) {
    console.error(`cannot read ${file}: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  const messages = [];
  let bad = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      bad += 1;
      continue;
    }
    if (row && row.kind === 'message') messages.push(row);
  }
  if (messages.length === 0) {
    console.error(`no kind:message rows in ${file} (${bad} bad lines). Unknown, not a 0% cache.`);
    process.exit(2);
  }
  const windowed = args.window > 0 ? messages.slice(-args.window) : messages;
  const summary = aggregate(windowed);
  const decision = decide(summary);
  const report = formatReport(file, summary, decision);
  if (args.json) {
    console.log(JSON.stringify({ file, badLines: bad, window: args.window || null, ...summary, decision }, null, 2));
  } else {
    if (bad > 0) console.log(`bad lines: ${bad}`);
    console.log(report);
  }
  if (args.outPath) {
    await fs.mkdir(path.dirname(path.resolve(args.outPath)), { recursive: true });
    await fs.writeFile(args.outPath, report, 'utf8');
  }
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
if (isDirect || process.argv[1]?.endsWith('message-composition.mjs')) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
