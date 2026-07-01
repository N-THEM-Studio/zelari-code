#!/usr/bin/env node
/**
 * dev-council-task — End-to-end multi-agent council task via runCouncilPure.
 *
 * Runs a single council dispatch with multiple specialists in sequence:
 *   1. Caronte  (Orchestrator) — analyzes + delegates
 *   2. Nettuno (Planner)      — turns intent into buildable plan
 *   3. Gerione (Ideator)     — diverges + converges ideas
 *   4. Plutone (Knowledge Mapper) — maps relevant concepts/dependencies
 *   5. Minosse (Reviewer)        — quality + risk assessment
 *   6. Lucifero (Synthesizer)   — final integrated answer
 *
 * Streams BrainEvents for each member so you can see who does what.
 */

import { runCouncilPure } from '../dist/agents/councilApi.js';
import { AGENT_ROLES, getCouncilAgents } from '../dist/agents/roles.js';
import { openaiCompatibleProvider, providerConfigFor } from '../dist/cli/provider/openai-compatible.js';
import { createBuiltinToolRegistry } from '../dist/cli/toolRegistry.js';

const task = process.argv.slice(2).join(' ') ||
  `Design the MVP architecture for a small CLI tool that helps developers
track and summarize their daily standup notes. The tool should:
- Accept free-form input ("yesterday I did X, today I do Y, blockers: Z")
- Auto-tag entries with project names inferred from git context
- Generate a weekly summary suitable for posting to Slack
- Run offline with no API calls (local-first)

Target: solo developer, plain Node, no Electron. Suggest a clean module
structure and the smallest viable feature set.`;

// ── Resolve Grok config + build provider stream ────────────────────────
const providerCfg = await providerConfigFor('grok');
if (!providerCfg) {
  console.error(`\x1b[31m✗ No config for provider "grok". Run /login grok first.\x1b[0m`);
  process.exit(1);
}
console.log(`\x1b[36m[setup]\x1b[0m Provider: ${providerCfg.providerId}  Model: ${providerCfg.model}`);

const providerStream = openaiCompatibleProvider(providerCfg);

// ── Council configuration ─────────────────────────────────────────────
const councilSize = parseInt(process.env.COUNCIL_SIZE ?? '4', 10); // 4 specialists + oracle + chairman
const agents = getCouncilAgents(councilSize);
console.log(`\x1b[36m[setup]\x1b[0m Council size: ${councilSize} → ${agents.map(a => a.name).join(', ')}`);
console.log(`\x1b[36m[setup]\x1b[0m Task: ${task.replace(/\n/g, ' ').slice(0, 140)}…\n`);

const { registry: toolRegistry, tools } = createBuiltinToolRegistry({ root: process.cwd() });
console.log(`\x1b[36m[setup]\x1b[0m Tools available to members: ${tools.map(t => t.name).join(', ')}`);

const config = {
  apiKey: providerCfg.apiKey,
  provider: 'grok',
  model: providerCfg.model,
  councilSize,
  debateMode: false,
  ragContext: '',
  workspaceContext: `Working dir: ${process.cwd()}`,
  providerStream,
  tools: toolRegistry,
  maxToolCallsPerTurn: 2,
};

// ── Stream events ──────────────────────────────────────────────────────
const ts = () => new Date().toISOString().slice(11, 23);
const memberOutputs = new Map();
let activeMember = null;
let activeBuf = '';
let usageByMember = new Map();
let totalUsage = { prompt: 0, completion: 0 };
const startMs = Date.now();

for await (const event of runCouncilPure(task, config)) {
  switch (event.type) {
    case 'agent_start':
      console.log(`\n\x1b[1m\x1b[36m[${ts()}] agent_start\x1b[0m  session=${event.sessionId.slice(0, 8)}  model=${event.model}`);
      break;
    case 'message_start':
      console.log(`\x1b[34m[${ts()}]\x1b[0m message_start  messageId=${event.messageId}`);
      activeBuf = '';
      break;
    case 'message_delta':
      activeBuf += event.delta;
      process.stdout.write(event.delta);
      break;
    case 'thinking_delta':
      process.stdout.write(`\x1b[2m${event.delta}\x1b[0m`);
      break;
    case 'message_end': {
      if (event.usage) {
        totalUsage.prompt += event.usage.promptTokens;
        totalUsage.completion += event.usage.completionTokens;
      }
      // Try to attribute usage to the active member if we have it
      if (activeMember && event.usage) {
        const prev = usageByMember.get(activeMember) || { prompt: 0, completion: 0 };
        usageByMember.set(activeMember, {
          prompt: prev.prompt + event.usage.promptTokens,
          completion: prev.completion + event.usage.completionTokens,
        });
      }
      console.log(`\n\x1b[34m[${ts()}]\x1b[0m message_end  reason=${event.finishReason}  len=${event.totalLength}` + (event.usage ? `  +${event.usage.totalTokens}tok` : ''));
      if (activeMember && activeBuf) {
        memberOutputs.set(activeMember, (memberOutputs.get(activeMember) || '') + activeBuf);
      }
      break;
    }
    case 'tool_execution_start':
      console.log(`\n\x1b[33m[${ts()}]\x1b[0m → tool  ${event.toolName}(${JSON.stringify(event.args).slice(0, 80)})`);
      break;
    case 'tool_execution_end':
      console.log(`\x1b[33m[${ts()}]\x1b[0m ← tool_result ${event.isError ? '\x1b[31m✗\x1b[0m' : '\x1b[32m✓\x1b[0m'}  ${event.durationMs}ms`);
      break;
    case 'agent_end': {
      const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
      console.log(`\n\x1b[1m\x1b[36m[${ts()}] agent_end\x1b[0m  duration=${elapsed}s`);
      break;
    }
    case 'member_cost':
      activeMember = event.name;
      console.log(`\n\x1b[1m\x1b[35m[${ts()}] member_cost\x1b[0m  ${event.name} (${event.memberId})  prompt=${event.promptTokens || 0}  completion=${event.completionTokens || 0}  tool_calls=${event.toolCalls ?? 0}  duration=${event.durationMs}ms  err=${event.errored}`);
      break;
    case 'error':
      console.error(`\n\x1b[31m[${ts()}]\x1b[0m ERROR: ${event.message}`);
      break;
    default:
      console.log(`\x1b[34m[${ts()}]\x1b[0m ${event.type}`);
  }
}

// ── Summary ────────────────────────────────────────────────────────────
console.log(`\n\x1b[1m\x1b[36m═══════════════════════════════════════════════════════════════════\x1b[0m`);
console.log(`\x1b[1m\x1b[36m  COUNCIL SUMMARY\x1b[0m`);
console.log(`\x1b[1m\x1b[36m═══════════════════════════════════════════════════════════════════\x1b[0m`);

console.log(`\n\x1b[1mMembers who produced output:\x1b[0m`);
for (const [name, content] of memberOutputs) {
  const usage = usageByMember.get(name);
  console.log(`  \x1b[35m•\x1b[0m ${name.padEnd(15)} ${content.length.toString().padStart(5)} chars` + (usage ? `  (${usage.prompt + usage.completion} tok)` : ''));
}

console.log(`\n\x1b[1mTotal tokens (cumulative across members):\x1b[0m prompt=${totalUsage.prompt}  completion=${totalUsage.completion}  total=${totalUsage.prompt + totalUsage.completion}`);

const totalElapsed = ((Date.now() - startMs) / 1000).toFixed(1);
console.log(`\x1b[1mWall clock:\x1b[0m ${totalElapsed}s`);