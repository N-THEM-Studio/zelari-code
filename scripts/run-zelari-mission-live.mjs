#!/usr/bin/env node
/**
 * Headless Zelari-mode smoke — runs runZelariMission + real council dispatch.
 * Usage: node scripts/run-zelari-mission-live.mjs "<prompt>" [projectRoot]
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildMissionBrief } from '@zelari/core/council';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

const { runZelariMission } = await import(join(repoRoot, 'dist/cli/zelariMission.js'));
const { getMemoryBackend, formatMemoryHits } = await import(join(repoRoot, 'dist/cli/memory/fileBackend.js'));
const { dispatchCouncil } = await import(join(repoRoot, 'dist/cli/councilDispatcher.js'));
const { createBuiltinToolRegistry } = await import(join(repoRoot, 'dist/cli/toolRegistry.js'));
const { createWorkspaceContext, createWorkspaceStubs } = await import(join(repoRoot, 'dist/cli/workspace/stubs.js'));
const { createWorkspaceToolRegistry } = await import(join(repoRoot, 'dist/cli/workspace/toolRegistry.js'));
const { runPostCouncilHook } = await import(join(repoRoot, 'dist/cli/workspace/postCouncilHook.js'));
const { providerFromEnv, openaiCompatibleProvider } = await import(join(repoRoot, 'dist/cli/provider/openai-compatible.js'));
const { FeedbackStore } = await import(join(repoRoot, 'dist/cli/councilFeedback.js'));
const { setWorkspaceStubs } = await import('@zelari/core/skills');
const { detectDegradedRun } = await import('@zelari/core/council');

const userPrompt =
  process.argv[2] ??
  'crea un singolo file html che rappresenti una landing page per zelari-code, stile moderno terminal code. Un solo file index.html nella root del progetto.';
const projectRoot = resolve(process.argv[3] ?? process.cwd());

const log = (m) => {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${m}`;
  console.log(line);
};

async function runCouncilSlice({ userMessage, runMode, ragContext }) {
  const envConfig = await providerFromEnv();
  if (!envConfig) throw new Error('No API key — check grok OAuth / provider.json');

  const sessionId = randomUUID();
  const { registry: toolRegistry } = createBuiltinToolRegistry();
  const realCtx = createWorkspaceContext(projectRoot);
  const realReg = createWorkspaceToolRegistry(realCtx);
  for (const name of realReg.list()) {
    const td = realReg.get(name);
    if (td) toolRegistry.register(td);
  }
  setWorkspaceStubs(createWorkspaceStubs(realCtx));
  const feedbackStore = new FeedbackStore();

  const chairmanBudget = (() => {
    const raw = process.env.ZELARI_MODE_MAX_TOOLS_LUCIFER;
    const n = raw ? Number.parseInt(raw, 10) : 30;
    return Number.isFinite(n) && n > 0 ? n : 30;
  })();

  let chairmanSynthesis = '';
  let chairmanErrored = false;
  let luciferWrites = 0;
  let councilAborted = false;
  let councilRunMode = runMode;
  let consecutiveErrors = 0;

  for await (const event of dispatchCouncil(userMessage, {
    apiKey: envConfig.apiKey,
    model: envConfig.model,
    provider: 'openai-compatible',
    providerStream: openaiCompatibleProvider(envConfig),
    sessionId,
    tools: toolRegistry,
    feedbackStore,
    workspaceRoot: projectRoot,
    ragContext,
    runMode,
    maxToolCallsPerTurn: 15,
    maxToolCallsChairman: chairmanBudget,
    onCouncilStatus: (m) => log(`[status] ${m}`),
  })) {
    if (event.type === 'council_mode') councilRunMode = event.runMode;
    if (event.type === 'message_delta' && event.memberId === 'lucifer') {
      chairmanSynthesis += event.delta;
    }
    if (event.type === 'tool_execution_end' && event.toolName === 'write_file') {
      luciferWrites++;
    }
    if (event.type === 'agent_end' && event.reason === 'error') {
      if (event.memberId === 'lucifer') chairmanErrored = true;
      consecutiveErrors++;
      if (consecutiveErrors >= 2) councilAborted = true;
    }
    if (event.type === 'error' && event.severity === 'fatal') {
      councilAborted = true;
      log(`[error] ${event.message?.slice(0, 200)}`);
    }
  }

  const degraded = detectDegradedRun({
    chairmanErrored,
    councilAborted,
    luciferWriteCount: luciferWrites,
    synthesisText: chairmanSynthesis,
    runMode: councilRunMode,
  });

  const workspaceCtx = createWorkspaceContext(projectRoot);
  const hook = await runPostCouncilHook(workspaceCtx, {
    runMode: councilRunMode,
    userMessage,
    synthesisText: chairmanSynthesis || undefined,
    degradedRun: degraded.degraded,
    degradedReasons: degraded.reasons,
  });

  const ok = hook.completion?.completion?.ok ?? false;
  log(`[slice] mode=${councilRunMode} writes=${luciferWrites} completion.ok=${ok}`);
  return {
    completionOk: ok,
    ran: !councilAborted,
    synthesisText: chairmanSynthesis,
  };
}

async function main() {
  log(`projectRoot=${projectRoot}`);
  log(`prompt=${userPrompt.slice(0, 100)}...`);
  const envConfig = await providerFromEnv();
  if (!envConfig) {
    console.error('FAIL: no provider/API key');
    process.exit(1);
  }
  log(`provider=${envConfig.providerId} model=${envConfig.model}`);

  await mkdir(projectRoot, { recursive: true });
  const memory = await getMemoryBackend(projectRoot);
  const brief = buildMissionBrief({
    userMessage: userPrompt,
    hasPlan: existsSync(join(projectRoot, '.zelari', 'plan.json')),
  });

  const state = await runZelariMission(userPrompt, brief, {
    projectRoot,
    memory,
    emit: log,
    runSlice: async (args) => {
      const hits = await memory.search(`${brief.deliverableThisMission} ${userPrompt}`, {
        limit: 6,
        useGraph: false,
      });
      const ragContext = formatMemoryHits(hits);
      return runCouncilSlice({
        userMessage: args.userMessage,
        runMode: args.runMode,
        ragContext,
      });
    },
  });

  await memory.close();
  log(`MISSION status=${state.status} iterations=${state.iteration}`);

  const indexPath = join(projectRoot, 'index.html');
  if (existsSync(indexPath)) {
    log(`SUCCESS: ${indexPath}`);
    process.exit(0);
  }
  // search any html in project root
  const { readdir } = await import('node:fs/promises');
  const files = await readdir(projectRoot);
  const html = files.filter((f) => f.endsWith('.html'));
  if (html.length) {
    log(`PARTIAL: html files: ${html.join(', ')}`);
    process.exit(0);
  }
  log('FAIL: no index.html created');
  process.exit(2);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(2);
});