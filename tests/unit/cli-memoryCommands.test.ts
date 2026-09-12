import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { handleSlashCommand } from '../../src/cli/slashCommands.js';
import type { ChatMessage } from '../../src/cli/components/ChatStream.js';
import { handleMemoryCommand } from '../../src/cli/slashHandlers/memory.js';
import { getMemoryService } from '../../src/cli/memory/serviceFactory.js';
import { promoteMemoryToAgentsMd } from '../../src/cli/memory/promotion.js';

describe('/memory command parser', () => {
  it('defaults to stats', () => {
    const result = handleSlashCommand('/memory', []);
    expect(result.kind).toBe('memory');
    expect(result.memorySubcommand).toBe('stats');
    expect(result.memoryArgs).toEqual([]);
  });

  it('preserves search and mutation arguments', () => {
    const search = handleSlashCommand('/memory search sqlite shared context', []);
    expect(search.memorySubcommand).toBe('search');
    expect(search.memoryArgs).toEqual(['sqlite', 'shared', 'context']);
    const forget = handleSlashCommand('/memory forget mem_123 --yes', []);
    expect(forget.memorySubcommand).toBe('forget');
    expect(forget.memoryArgs).toEqual(['mem_123', '--yes']);
  });

  it('is discoverable from /help', () => {
    expect(handleSlashCommand('/help', []).message).toContain('/memory');
  });

  it('parses the slice A/C additions', () => {
    const howWeTest = handleSlashCommand('/memory how-we-test', []);
    expect(howWeTest.kind).toBe('memory');
    expect(howWeTest.memorySubcommand).toBe('how-we-test');
    expect(howWeTest.memoryArgs).toEqual([]);

    const asCheck = handleSlashCommand('/memory promote con-abc --as-check --command npm test', []);
    expect(asCheck.memorySubcommand).toBe('promote');
    expect(asCheck.memoryArgs).toEqual(['con-abc', '--as-check', '--command', 'npm', 'test']);
  });
});

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

describe('/memory command handler', () => {
  it('searches the native store and blocks exports outside the project', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'zelari-memory-command-'));
    directories.push(cwd);
    const memory = await getMemoryService(cwd, {} as NodeJS.ProcessEnv, { force: true });
    const stored = await memory.remember({
      kind: 'decision',
      content: 'Use bounded native recall for every AgentHarness turn.',
      source: { agent: 'test' },
      writeClass: 'auto',
    });
    await memory.close();

    let messages: ChatMessage[] = [];
    const setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>> = (update) => {
      messages = typeof update === 'function' ? update(messages) : update;
    };
    await handleMemoryCommand({ cwd, setMessages }, 'search', ['bounded', 'recall']);
    expect(messages.at(-1)?.content).toContain(stored.id);

    const outsideName = `${path.basename(cwd)}-outside.json`;
    await handleMemoryCommand({ cwd, setMessages }, 'export', [`../${outsideName}`]);
    expect(messages.at(-1)?.content).toMatch(/must stay inside/i);
    await expect(fs.stat(path.join(path.dirname(cwd), outsideName))).rejects.toThrow();

    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'zelari-memory-export-outside-'));
    directories.push(outside);
    const link = path.join(cwd, 'linked-export');
    try {
      await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
      await handleMemoryCommand({ cwd, setMessages }, 'export', ['linked-export/export.json']);
      expect(messages.at(-1)?.content).toMatch(/symbolic link/i);
      await expect(fs.stat(path.join(outside, 'export.json'))).rejects.toThrow();
    } catch (error) {
      if (!['EPERM', 'EACCES', 'ENOSYS'].includes((error as NodeJS.ErrnoException).code ?? '')) {
        throw error;
      }
    }
  });

  it('promotes durable memory into an idempotent managed AGENTS.md block', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'zelari-memory-promote-'));
    directories.push(cwd);
    await fs.writeFile(path.join(cwd, 'AGENTS.md'), '# Existing instructions\n\nKeep this text.\n', 'utf8');
    const memory = await getMemoryService(cwd, {} as NodeJS.ProcessEnv, { force: true });
    const node = await memory.remember({
      kind: 'constraint',
      content: 'Do not hold an LLM request inside a database transaction.',
      // Promotion bar (memory/promotion.ts): importance ≥ 0.7 AND confidence ≥ 0.8.
      importance: 0.8,
      confidence: 0.9,
      source: { agent: 'council' },
    });
    const first = await promoteMemoryToAgentsMd(cwd, node);
    const second = await promoteMemoryToAgentsMd(cwd, node);
    expect(first.added).toBe(true);
    expect(second).toMatchObject({ added: false, reason: 'already promoted' });
    const agents = await fs.readFile(path.join(cwd, 'AGENTS.md'), 'utf8');
    expect(agents).toContain('Keep this text.');
    expect(agents.match(new RegExp(`memory:${node.id}`, 'g'))).toHaveLength(1);
    expect(agents).toContain('zelari:memory-promotions:start');

    const episode = await memory.remember({
      kind: 'episode', content: 'A transient run detail.', source: { agent: 'test' },
    });
    expect(await promoteMemoryToAgentsMd(cwd, episode)).toMatchObject({ added: false });
    await memory.close();
  });

  it('regenerates .zelari/how-we-test.md from verified procedures', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'zelari-memory-howwetest-'));
    directories.push(cwd);
    const memory = await getMemoryService(cwd, {} as NodeJS.ProcessEnv, { force: true });
    await memory.remember({
      kind: 'procedure',
      content: 'npm run typecheck → pass (typecheck)',
      importance: 0.75,
      confidence: 0.9,
      source: { agent: 'ops-knowledge' },
      metadata: {
        command: 'npm run typecheck',
        digest: 'abc123456789',
        criterionId: 'typecheck',
        opsKnowledgeKey: 'key-typecheck',
        seq: 7,
        verified: true,
      },
    });
    await memory.close();

    let messages: ChatMessage[] = [];
    const setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>> = (update) => {
      messages = typeof update === 'function' ? update(messages) : update;
    };
    await handleMemoryCommand({ cwd, setMessages }, 'how-we-test', []);
    expect(messages.at(-1)?.content).toContain('how-we-test.md');

    const target = path.join(cwd, '.zelari', 'how-we-test.md');
    const body = await fs.readFile(target, 'utf8');
    expect(body).toContain('generato — non editare');
    expect(body).toContain('## typecheck');
    expect(body).toContain('`npm run typecheck`');

    // Explicit regeneration is idempotent.
    await handleMemoryCommand({ cwd, setMessages }, 'how-we-test', []);
    expect(await fs.readFile(target, 'utf8')).toBe(body);
  });

  it('appends a confirmed WorldCheck from a repeat-failure constraint (--as-check)', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'zelari-memory-ascheck-'));
    directories.push(cwd);
    const checksFile = path.join(cwd, '.zelari', 'world', 'checks.json');
    await fs.mkdir(path.dirname(checksFile), { recursive: true });
    const preExisting = { id: 'keep-me', command: 'npm run typecheck', expectExit: 0 };
    await fs.writeFile(
      checksFile,
      JSON.stringify({ checks: [preExisting] }, null, 2) + '\n',
      'utf8',
    );

    const memory = await getMemoryService(cwd, {} as NodeJS.ProcessEnv, { force: true });
    const node = await memory.remember({
      id: 'con-fp123',
      kind: 'constraint',
      content: 'Stesso fallimento ripetuto: npm test exit 1.',
      importance: 0.72,
      confidence: 0.85,
      source: { agent: 'ops-knowledge' },
      metadata: {
        fingerprint: 'fp123',
        command: 'npm test → exit 1',
        digest: 'deadbeef',
        exitCode: 1,
        criterionId: 'tests',
      },
    });
    await memory.close();

    let messages: ChatMessage[] = [];
    const setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>> = (update) => {
      messages = typeof update === 'function' ? update(messages) : update;
    };
    const readChecks = async (): Promise<Array<{ id: string; command: string }>> =>
      JSON.parse(await fs.readFile(checksFile, 'utf8')).checks as Array<{ id: string; command: string }>;

    // No human-typed command → the proposal is shown, checks.json is untouched.
    await handleMemoryCommand({ cwd, setMessages }, 'promote', [node.id, '--as-check']);
    expect(messages.at(-1)?.content).toContain('--as-check --command');
    expect(await readChecks()).toEqual([preExisting]);

    // Confirmed → appended, and the check already there survives.
    await handleMemoryCommand({ cwd, setMessages }, 'promote', [
      node.id,
      '--as-check',
      '--command',
      'npx',
      'vitest',
      'run',
      'src/cli/memory/opsKnowledge.test.ts',
    ]);
    expect(messages.at(-1)?.content).toContain('appended');
    const checks = await readChecks();
    expect(checks.map((check) => check.id)).toEqual([preExisting.id, node.id]);
    expect(checks[1]).toEqual({
      id: node.id,
      command: 'npx vitest run src/cli/memory/opsKnowledge.test.ts',
      expectExit: 0,
    });

    // Re-confirming the same id never duplicates nor rewrites the file.
    const before = await fs.readFile(checksFile, 'utf8');
    await handleMemoryCommand({ cwd, setMessages }, 'promote', [
      node.id,
      '--as-check',
      '--command',
      'npm test',
    ]);
    expect(messages.at(-1)?.content).toContain('already present');
    expect(await fs.readFile(checksFile, 'utf8')).toBe(before);
  });
});
