import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AcpClient } from './acpClient.js';
import { AcpClientClosedError, type AcpCloseInfo, type AcpExitInfo } from './acpTransport.js';
import { spawnAcpTransport } from './childTransport.js';
import type { AcpSessionUpdateParams } from './protocol.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const fixtureAgent = path.join(here, '__fixtures__', 'fakeAcpServer.mjs');

/**
 * The real front door: `bin/` is always present in a checkout, but it only
 * works once `dist/` exists (`npm run build`). Gate on the BUILT artifact —
 * otherwise a bare CI test job (no `dist/`) would spawn a CLI that exits 1.
 */
const cliEntry = path.join(repoRoot, 'bin', 'zelari-code.js');
const cliBundle = path.join(repoRoot, 'dist', 'cli', 'main.bundled.js');

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Fail loudly instead of hanging the suite on a dead child. */
function deadline<T>(promise: Promise<T>, label: string, ms = 15_000): Promise<T> {
  return Promise.race([
    promise,
    delay(ms).then(() => {
      throw new Error(`${label} did not happen within ${ms}ms`);
    }),
  ]);
}

async function waitUntil(predicate: () => boolean, label: string, ms = 5_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > ms) throw new Error(`${label} did not happen within ${ms}ms`);
    await delay(20);
  }
}

interface Started {
  client: AcpClient;
  updates: AcpSessionUpdateParams[];
  stderr: string[];
  closed: AcpCloseInfo[];
  exited: Promise<AcpExitInfo>;
  log: string[];
}

function start(agentPath: string, env: NodeJS.ProcessEnv = {}): Started {
  const spawned = spawnAcpTransport({
    config: { cliPath: agentPath, nodePath: process.execPath },
    cwd: repoRoot,
    env: { ...process.env, ...env },
  });
  if (!spawned.ok) throw new Error(`spawn failed: ${spawned.reason}`);

  const log: string[] = [];
  const client = new AcpClient(spawned.transport, (line) => log.push(line));
  const updates: AcpSessionUpdateParams[] = [];
  const stderr: string[] = [];
  const closed: AcpCloseInfo[] = [];
  let resolveExit: (info: AcpExitInfo) => void = () => {};
  const exited = new Promise<AcpExitInfo>((resolve) => {
    resolveExit = resolve;
  });

  client.on('update', (params) => updates.push(params));
  client.on('stderr', (line) => stderr.push(line));
  client.on('closed', (info) => closed.push(info));
  client.on('exit', (info) => resolveExit(info));

  return { client, updates, stderr, closed, exited, log };
}

describe('childTransport + AcpClient against a REAL child process', () => {
  it(
    'drives a full session: initialize -> session/new -> streamed tool calls -> clean exit 0',
    { timeout: 30_000 },
    async () => {
      const agent = start(fixtureAgent, { FAKE_ACP_STDERR: '1' });

      const init = await deadline(agent.client.initialize(), 'initialize');
      expect(init.protocolVersion).toBe(1);
      expect(init.agentCapabilities?.loadSession).toBe(false);

      const sessionId = await deadline(agent.client.newSession('/work'), 'session/new');
      expect(sessionId).toMatch(/^fake-session-/);

      const stopReason = await deadline(agent.client.prompt(sessionId, 'hello'), 'session/prompt');
      expect(stopReason).toBe('end_turn');

      // The visible stream: one tool call, its completion, then the message.
      expect(agent.updates.map((u) => u.update.sessionUpdate)).toEqual([
        'tool_call',
        'tool_call_update',
        'agent_message_chunk',
      ]);
      expect(agent.updates[0]?.update).toMatchObject({
        callId: 'fake-call-1',
        title: 'echo_tool',
        status: 'pending',
      });
      expect(agent.updates[1]?.update).toMatchObject({ callId: 'fake-call-1', status: 'completed' });
      expect(agent.updates.every((u) => u.sessionId === sessionId)).toBe(true);
      expect(JSON.stringify(agent.updates)).toContain('echo: hello');

      await waitUntil(() => agent.stderr.some((line) => line.includes('ready')), 'agent stderr');
      expect(agent.stderr.join('\n')).toContain('[fake-acp] boot');

      // Clean shutdown: stdin EOF -> the agent exits 0 by itself (no kill).
      agent.client.shutdown();
      const exit = await deadline(agent.exited, 'agent exit');
      expect(exit.code).toBe(0);
      expect(agent.closed.map((info) => info.reason)).toEqual(['shutdown']);
      expect(agent.log).toEqual([]);
    },
  );

  it(
    'a shutdown mid-turn is clean: the pending prompt rejects, the child still exits 0',
    { timeout: 30_000 },
    async () => {
      const agent = start(fixtureAgent, { FAKE_ACP_STALL: '1' });

      await deadline(agent.client.initialize(), 'initialize');
      const sessionId = await deadline(agent.client.newSession(), 'session/new');

      const turn = agent.client.prompt(sessionId, 'this turn never settles');
      const settled = turn.then(
        () => new Error('the turn resolved but should have been cancelled'),
        (err: unknown) => err,
      );

      // The agent is streaming while the turn is open: the loop is NOT blocked.
      await waitUntil(() => agent.updates.length >= 1, 'the first tool_call update');

      agent.client.shutdown();
      await expect(deadline(settled, 'prompt rejection')).resolves.toBeInstanceOf(
        AcpClientClosedError,
      );

      const exit = await deadline(agent.exited, 'agent exit');
      expect(exit.code).toBe(0);
      expect(agent.closed).toHaveLength(1);
    },
  );
});

describe.runIf(existsSync(cliEntry) && existsSync(cliBundle))(
  'the REAL `zelari-code acp` front door',
  () => {
    it(
      'handshakes and opens a session on the bundled CLI, then exits 0 on EOF',
      { timeout: 30_000 },
      async () => {
        const agent = start(cliEntry);

        const init = await deadline(agent.client.initialize(), 'initialize');
        expect(init.protocolVersion).toBe(1);

        const sessionId = await deadline(agent.client.newSession(repoRoot), 'session/new');
        expect(sessionId.length).toBeGreaterThan(0);

        agent.client.shutdown();
        const exit = await deadline(agent.exited, 'agent exit');
        expect(exit.code).toBe(0);
        expect(agent.closed.map((info) => info.reason)).toEqual(['shutdown']);
      },
    );
  },
);
