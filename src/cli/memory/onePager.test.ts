/** S4 — volatile one-pager working set: cap, fail-open, index-only, recap gate. */
import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  ONE_PAGER_CHAR_CAP,
  ONE_PAGER_PREFIX,
  buildOnePager,
  isOnePagerEnabled,
} from './onePager.js';
import { _resetSessionTodosForTests, writeSessionTodos } from '../sessionTodos.js';

const dirs: string[] = [];

afterEach(async () => {
  _resetSessionTodosForTests();
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function tmpCwd(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zelari-one-pager-'));
  dirs.push(dir);
  return dir;
}

function body(messages: readonly { content: string }[]): string {
  return messages.map((m) => m.content).join('\n');
}

describe('buildOnePager — volatile working set (S4)', () => {
  it('is on by default and off with ZELARI_ONE_PAGER=0', () => {
    expect(isOnePagerEnabled({})).toBe(true);
    expect(isOnePagerEnabled({ ZELARI_ONE_PAGER: '0' })).toBe(false);
  });

  it('ZELARI_ONE_PAGER=0 → no message at all', async () => {
    writeSessionTodos([{ content: 'do the thing' }]);
    const out = await buildOnePager({ env: { ZELARI_ONE_PAGER: '0' } });
    expect(out).toEqual([]);
  });

  it('caps the message at ONE_PAGER_CHAR_CAP and starts with the marker', async () => {
    writeSessionTodos(
      Array.from({ length: 40 }, (_, i) => ({
        id: `t${i}`,
        content: 'x'.repeat(500),
      })),
    );
    const out = await buildOnePager({ cwd: await tmpCwd() });
    expect(out).toHaveLength(1);
    expect(out[0]!.content.length).toBeLessThanOrEqual(ONE_PAGER_CHAR_CAP);
    expect(out[0]!.content.startsWith(ONE_PAGER_PREFIX)).toBe(true);
  });

  it('is fail-open: a throwing memory.export() never rejects', async () => {
    writeSessionTodos([{ content: 'keep going' }]);
    const memory = {
      export: async (): Promise<unknown> => {
        throw new Error('boom');
      },
    };
    const out = await buildOnePager({ cwd: await tmpCwd(), memory });
    expect(Array.isArray(out)).toBe(true);
    expect(body(out)).not.toContain('boom');
  });

  it('how-we-test section carries path + mtime ONLY, never the body', async () => {
    const cwd = await tmpCwd();
    const target = path.join(cwd, '.zelari', 'how-we-test.md');
    await fs.mkdir(path.dirname(target), { recursive: true });
    const secret = 'SECRET-INTERNAL-BODY-MARKER';
    await fs.writeFile(target, `# How we test\n${secret}\n`, 'utf8');
    const out = await buildOnePager({ cwd });
    const text = body(out);
    expect(text).toContain('how-we-test.md');
    expect(text).toContain('How we test');
    expect(text).not.toContain(secret);
  });

  it('omits the how-we-test section when the file is missing (fail-open)', async () => {
    writeSessionTodos([{ content: 'keep going' }]);
    const out = await buildOnePager({ cwd: await tmpCwd() });
    expect(body(out)).not.toContain('how-we-test.md');
  });

  it('skipCompactRecap:true omits the summary; false includes it', async () => {
    writeSessionTodos([{ content: 'keep going' }]);
    const cwd = await tmpCwd();
    const compactSummary = 'SUMMARY-MARKER-ABC';
    const skipped = await buildOnePager({ cwd, skipCompactRecap: true, compactSummary });
    expect(body(skipped)).not.toContain(compactSummary);
    const included = await buildOnePager({ cwd, skipCompactRecap: false, compactSummary });
    expect(body(included)).toContain(compactSummary);
  });

  it('includes verified procedure aliases when memory enumerates them', async () => {
    const memory = {
      export: async (): Promise<unknown> => [
        {
          kind: 'procedure',
          status: 'active',
          tags: ['probe-health'],
          content: 'first line\nmore',
          metadata: { verified: true },
        },
      ],
    };
    const out = await buildOnePager({ cwd: await tmpCwd(), memory });
    expect(body(out)).toContain('probe-health');
  });
});
