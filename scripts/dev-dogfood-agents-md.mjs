#!/usr/bin/env node
/**
 * dev-dogfood-agents-md — One-shot dogfood that fills .zelari/ with
 * realistic content (ADRs, docs, risks, milestones) using a single-agent
 * grok-4 run with native function calling on all 9 workspace tools.
 *
 * This is a faster, more deterministic alternative to a full council
 * session for the purpose of producing a real AGENTS.MD.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createWorkspaceContext, createWorkspaceToolRegistry } from '../src/cli/workspace/index.ts';
import { updateAgentsMd } from '../src/cli/workspace/agentsMd.ts';

const projectRoot = process.cwd();
const ctx = createWorkspaceContext(projectRoot);
const registry = createWorkspaceToolRegistry(ctx);

const grok = JSON.parse(readFileSync(process.env.HOME + '/.tmp/zelari-code/keys.json', 'utf-8')).providers.grok;
const apiKey = grok.apiKey;

const tools = registry.toOpenAITools();

const systemPrompt = `You are a senior staff engineer reviewing the zelari-code v3-W 'Council Workspace' feature.

Use the provided tools to record your analysis as workspace artifacts in this repo:

1. Call createPhase 3-4 times to break the review into phases (e.g. "Phase 1: Architecture Review", "Phase 2: Bug Hunt", "Phase 3: Recommendations").
2. Call addIdea 5-6 times for ADRs you would write, each with: title (slug-cased), content (markdown body), consequences (array of strings), tags (array), category (string).
3. Call createMilestone 2-3 times for upcoming releases.
4. Call createDocument 2-3 times for doc drafts (e.g. "ADR-Index", "v3-W-Architecture-Summary").
5. End with a plain-text synthesis summarizing findings.

Total expected tool calls: 12-16. Be efficient — don't repeat tool calls.`;

const userPrompt = `Review the v3-W Council Workspace implementation in this repo and produce the artifacts. The 9 workspace tools are registered and ready. Use them to create realistic council output that reflects what a real review would generate.`;

const messages = [
  { role: 'system', content: systemPrompt },
  { role: 'user', content: userPrompt },
];

async function callOnce(messages) {
  const res = await fetch('https://api.x.ai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'grok-4',
      messages,
      tools: tools.map(t => ({ type: 'function', function: t.function })),
      tool_choice: 'auto',
      max_tokens: 4096,
      temperature: 0.7,
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

async function runLoop() {
  let totalIterations = 0;
  let totalTokens = 0;
  let totalToolCalls = 0;
  const start = Date.now();
  let lastAssistant = null;

  while (totalIterations < 20) {
    totalIterations++;
    const data = await callOnce(messages);
    const choice = data.choices[0];
    const msg = choice.message;
    lastAssistant = msg;
    if (data.usage) totalTokens += data.usage.total_tokens || 0;

    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      // Final synthesis
      console.log(`\n\x1b[1m\x1b[36m=== SYNTHESIS (${totalIterations} iter, ${totalToolCalls} tools) ===\x1b[0m`);
      console.log(msg.content || '(no content)');
      break;
    }

    messages.push(msg);

    for (const tc of msg.tool_calls) {
      totalToolCalls++;
      const args = JSON.parse(tc.function.arguments);
      const result = await registry.invoke(tc.function.name, args, { cwd: projectRoot, sessionId: 'dogfood' });
      const resultStr = result.ok ? result.value : `ERROR: ${result.error}`;
      console.log(`\x1b[33m[${totalIterations}.${totalToolCalls}]\x1b[0m ${tc.function.name}(\x1b[2m${JSON.stringify(args).slice(0, 80)}\x1b[0m) → \x1b[${result.ok ? 32 : 31}m${result.ok ? '✓' : '✗'}\x1b[0m ${resultStr.slice(0, 120)}`);
      messages.push({ role: 'tool', tool_call_id: tc.id, content: resultStr });
    }
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`\n\x1b[1m\x1b[36m═══════════════════════════════════════════════════════════════\x1b[0m`);
  console.log(`\x1b[1m\x1b[36m  DOGFOOD COMPLETE  ${elapsed}s  ${totalIterations} iter  ${totalToolCalls} tool calls  ${totalTokens} tok\x1b[0m`);
  console.log(`\x1b[1m\x1b[36m═══════════════════════════════════════════════════════════════\x1b[0m`);

  // Generate AGENTS.MD
  const out = await updateAgentsMd(ctx, projectRoot);
  console.log(`\n\x1b[1m\x1b[32m→ AGENTS.MD update: ${out.changed ? 'CHANGED' : 'NO CHANGE'}\x1b[0m`);
  if (out.changed) console.log(`  sections written: ${out.sections.join(', ')}`);
}

runLoop().catch(err => {
  console.error('\x1b[31m✗ ERROR:\x1b[0m', err.message);
  process.exit(1);
});