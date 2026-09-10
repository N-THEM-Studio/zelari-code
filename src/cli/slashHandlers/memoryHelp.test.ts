/**
 * t54 follow-up — `/memory audit` was implemented and reachable (read-only
 * decay + contradiction report) but absent from BOTH help surfaces: the
 * `/help` memory row and the `/memory` usage footer. Users could not discover
 * it. These assertions pin each surface so the gap cannot silently reopen.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Dispatch, SetStateAction } from 'react';
import type { ChatMessage } from '../components/ChatStream.js';
import { handleSlashCommand } from '../slashCommands.js';
import { handleMemoryCommand } from './memory.js';

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

describe('/memory audit discoverability (t54 follow-up)', () => {
  it('is listed in the /help memory row', () => {
    const help = handleSlashCommand('/help', []);
    expect(help.kind).toBe('help');
    const row = (help.message ?? '')
      .split('\n')
      .find((line) => line.includes('/memory [')) ?? '';
    expect(row, 'the /help message must document the /memory subcommands').toBeTruthy();
    expect(row).toMatch(/\/memory \[[^\]]*\baudit\b/);
  });

  it('parses to the audit subcommand instead of the unknown-subcommand path', () => {
    const parsed = handleSlashCommand('/memory audit', []);
    expect(parsed.kind).toBe('memory');
    expect(parsed.memorySubcommand).toBe('audit');
    expect(parsed.memoryArgs).toEqual([]);
  });

  it('is printed in the usage footer emitted by /memory stats', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'zelari-memory-help-'));
    directories.push(cwd);
    let messages: ChatMessage[] = [];
    const setMessages: Dispatch<SetStateAction<ChatMessage[]>> = (update) => {
      messages = typeof update === 'function'
        ? (update as (current: ChatMessage[]) => ChatMessage[])(messages)
        : update;
    };

    await handleMemoryCommand({ cwd, setMessages }, 'stats', []);

    expect(messages.at(-1)?.content).toContain('/memory audit');
  });
});
