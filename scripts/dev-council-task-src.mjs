#!/usr/bin/env node
/**
 * dev-council-task-src — Like dev-council-task.mjs but imports directly from
 * TypeScript sources via tsx. Used for dogfooding v3-W: ensures the new
 * workspace tools are wired into the council runtime.
 */

import { dispatchCouncil } from '../src/cli/councilDispatcher.ts';
import { openaiCompatibleProvider, providerConfigFor } from '../src/cli/provider/openai-compatible.ts';
import { createBuiltinToolRegistry } from '../src/cli/toolRegistry.ts';
import { readFileSync } from 'node:fs';

const task = process.argv.slice(2).join(' ') ||
  `Review the v3-W "Council Workspace" implementation. Use addIdea for ADRs, addRisk for risks, createDocument for docs. End with Lucifero synthesis.`;

const providerCfg = await providerConfigFor('grok');
if (!providerCfg) {
  console.error('\x1b[31m✗ No config for provider "grok".\x1b[0m');
  process.exit(1);
}
console.log(`\x1b[36m[setup]\x1b[0m Provider: ${providerCfg.providerId}  Model: ${providerCfg.model}`);

const providerStream = openaiCompatibleProvider(providerCfg);
const councilSize = parseInt(process.env.COUNCIL_SIZE ?? '3', 10);
console.log(`\x1b[36m[setup]\x1b[0m Council size: ${councilSize}`);

const { registry: toolRegistry, tools } = createBuiltinToolRegistry({ root: process.cwd() });
console.log(`\x1b[36m[setup]\x1b[0m Built-in tools: ${tools.map(t => t.name).join(', ')}`);
console.log(`\x1b[36m[setup]\x1b[0m Workspace tools auto-wired by dispatchCouncil`);

const dispatchOpts = {
  apiKey: providerCfg.apiKey,
  provider: 'grok',
  model: providerCfg.model,
  councilSize,
  debateMode: false,
  ragContext: '',
  workspaceContext: `Working dir: ${process.cwd()}`,
  providerStream,
  tools: toolRegistry,
  maxToolCallsPerTurn: 3,
};

const ts = () => new Date().toISOString().slice(11, 23);
const startMs = Date.now();
let totalTokens = 0;

for await (const event of dispatchCouncil(task, dispatchOpts)) {
  switch (event.type) {
    case 'agent_start':
      console.log(`\n\x1b[1m\x1b[36m[${ts()}] agent_start\x1b[0m  session=${event.sessionId?.slice(0,8)}  model=${event.model}`);
      break;
    case 'message_delta':
      process.stdout.write(event.delta);
      break;
    case 'thinking_delta':
      process.stdout.write(`\x1b[2m${event.delta}\x1b[0m`);
      break;
    case 'message_end':
      if (event.usage) totalTokens += event.usage.totalTokens || 0;
      break;
    case 'tool_execution_start':
      console.log(`\n\x1b[33m[${ts()}] → tool  ${event.toolName}(${JSON.stringify(event.args).slice(0,100)})`);
      break;
    case 'tool_execution_end':
      console.log(`\x1b[33m[${ts()}] ← ${event.isError ? '\x1b[31m✗\x1b[0m' : '\x1b[32m✓\x1b[0m'} ${event.durationMs}ms`);
      break;
    case 'member_cost':
      console.log(`\n\x1b[1m\x1b[35m[${ts()}] member_cost\x1b[0m  ${event.name}  prompt=${event.promptTokens||0}  completion=${event.completionTokens||0}  tools=${event.toolCalls||0}  ${event.durationMs}ms`);
      break;
    case 'error':
      console.error(`\n\x1b[31m[${ts()}] ERROR:\x1b[0m ${event.message}`);
      break;
  }
}

const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
console.log(`\n\n\x1b[1m\x1b[36m═══════════════════════════════════════════════════════════════\x1b[0m`);
console.log(`\x1b[1m\x1b[36m  COUNCIL COMPLETE  ${elapsed}s  ${totalTokens} tok\x1b[0m`);
console.log(`\x1b[1m\x1b[36m═══════════════════════════════════════════════════════════════\x1b[0m`);