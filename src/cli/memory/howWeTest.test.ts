import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { MemoryNode } from '@zelari/core/memory';
import {
  HOW_WE_TEST_HEADER,
  HOW_WE_TEST_RELATIVE,
  collectHowWeTestRows,
  listVerifiedProcedureNodes,
  projectHowWeTest,
  regenerateHowWeTest,
  rowFromNode,
  shortDigest,
  writeHowWeTest,
} from './howWeTest.js';

function node(overrides: Partial<MemoryNode> = {}): MemoryNode {
  return {
    id: 'ops-1',
    schemaVersion: 1,
    projectId: 'p',
    kind: 'procedure',
    content: 'npm run typecheck → pass (typecheck)',
    importance: 0.75,
    confidence: 0.9,
    status: 'active',
    tags: [],
    source: {},
    createdAt: 't',
    updatedAt: 't',
    recordedAt: 't',
    metadata: {
      command: 'npm run typecheck',
      digest: 'abc123456789',
      criterionId: 'typecheck',
      opsKnowledgeKey: 'key-typecheck',
      seq: 42,
      verified: true,
    },
    ...overrides,
  };
}

function procedure(overrides: {
  key: string;
  criterionId: string;
  command: string;
  digest?: string;
  seq?: number;
  verified?: boolean;
}): MemoryNode {
  return node({
    id: `ops-${overrides.key}`,
    metadata: {
      command: overrides.command,
      digest: overrides.digest ?? 'digest',
      criterionId: overrides.criterionId,
      opsKnowledgeKey: overrides.key,
      seq: overrides.seq ?? 1,
      verified: overrides.verified ?? true,
    },
  });
}

describe('rowFromNode', () => {
  it('projects a verified, active procedure', () => {
    expect(rowFromNode(node())).toEqual({
      key: 'key-typecheck',
      criterionId: 'typecheck',
      command: 'npm run typecheck',
      digest: 'abc123456789',
      seq: 42,
    });
  });

  it('skips anything that is not a verified procedure', () => {
    expect(rowFromNode(node({ kind: 'constraint' }))).toBeNull();
    expect(rowFromNode(node({ status: 'retracted' }))).toBeNull();
    expect(rowFromNode(node({ metadata: { opsKnowledgeKey: 'k', command: 'c', digest: 'd' } })))
      .toBeNull();
  });
});

describe('collectHowWeTestRows', () => {
  it('dedups by opsKnowledgeKey keeping the newest observation', () => {
    const rows = collectHowWeTestRows([
      procedure({ key: 'a', criterionId: 'tests', command: 'npm test', seq: 3 }),
      procedure({ key: 'a', criterionId: 'tests', command: 'npm test', seq: 9 }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.seq).toBe(9);
  });

  it('is order-independent (same rows for any permutation)', () => {
    const input = [
      procedure({ key: 'b', criterionId: 'lint', command: 'npm run lint' }),
      procedure({ key: 'a', criterionId: 'tests', command: 'npm test' }),
      procedure({ key: 'c', criterionId: 'lint', command: 'npm run lint:fix' }),
    ];
    const forward = collectHowWeTestRows(input);
    const reverse = collectHowWeTestRows([...input].reverse());
    expect(forward).toEqual(reverse);
    expect(forward.map((row) => row.criterionId)).toEqual(['lint', 'lint', 'tests']);
    expect(forward.map((row) => row.command)).toEqual([
      'npm run lint',
      'npm run lint:fix',
      'npm test',
    ]);
  });
});

describe('projectHowWeTest', () => {
  it('renders the non-editable header and an empty state', () => {
    const md = projectHowWeTest([]);
    expect(md).toContain(HOW_WE_TEST_HEADER);
    expect(md).toContain('generato — non editare');
    expect(md).toContain('Nessuna procedura verificata');
  });

  it('groups by criterion with command, short digest and last observation', () => {
    const md = projectHowWeTest(
      collectHowWeTestRows([
        procedure({ key: 'a', criterionId: 'tests', command: 'npm test', digest: '0123456789ab', seq: 7 }),
        procedure({ key: 'b', criterionId: 'typecheck', command: 'npm run typecheck', digest: 'ffffffffff', seq: 3 }),
      ]),
    );
    expect(md.indexOf('## tests')).toBeLessThan(md.indexOf('## typecheck'));
    expect(md).toContain('`npm test` — exit 0 — digest `01234567` — ultima osservazione seq 7');
    expect(md).toContain('`npm run typecheck` — exit 0 — digest `ffffffff` — ultima osservazione seq 3');
    expect(md).not.toContain('0123456789ab');
  });

  it('is byte-idempotent', () => {
    const rows = collectHowWeTestRows([
      procedure({ key: 'a', criterionId: 'tests', command: 'npm test' }),
    ]);
    expect(projectHowWeTest(rows)).toBe(projectHowWeTest(rows));
  });

  it('keeps digests readable', () => {
    expect(shortDigest('deadbeefcafe')).toBe('deadbeef');
    expect(shortDigest('abc')).toBe('abc');
  });
});

describe('writeHowWeTest', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('writes .zelari/how-we-test.md atomically and idempotently', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'zelari-howwetest-'));
    dirs.push(root);
    const rows = collectHowWeTestRows([
      procedure({ key: 'a', criterionId: 'tests', command: 'npm test' }),
    ]);

    const first = await writeHowWeTest(root, rows);
    expect(first.written).toBe(true);
    const target = path.join(root, HOW_WE_TEST_RELATIVE);
    const body = await readFile(target, 'utf8');
    expect(body).toContain('## tests');

    const second = await writeHowWeTest(root, rows);
    expect(second.written).toBe(true);
    expect(await readFile(target, 'utf8')).toBe(body);

    // No temporary file is left behind by the tmp→rename write.
    const leftovers = (await readdir(path.join(root, '.zelari'))).filter((name) =>
      name.includes('.tmp-'),
    );
    expect(leftovers).toEqual([]);
  });

  it('overwrites a previous projection when a procedure disappears', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'zelari-howwetest-'));
    dirs.push(root);
    await writeHowWeTest(root, collectHowWeTestRows([procedure({ key: 'a', criterionId: 'tests', command: 'npm test' })]));
    await writeHowWeTest(root, []);
    const body = await readFile(path.join(root, HOW_WE_TEST_RELATIVE), 'utf8');
    expect(body).toContain('Nessuna procedura verificata');
  });
});

describe('regenerateHowWeTest', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('projects the backend dump', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'zelari-howwetest-'));
    dirs.push(root);
    const source = {
      export: async () => ({
        schemaVersion: 1 as const,
        exportedAt: 't',
        projectId: 'p',
        nodes: [
          procedure({ key: 'a', criterionId: 'tests', command: 'npm test' }),
          procedure({ key: 'b', criterionId: 'tests', command: 'npm run lint', verified: false }),
        ],
        edges: [],
        versions: [],
      }),
    };
    const result = await regenerateHowWeTest(source, root);
    expect(result.written).toBe(true);
    expect(result.rows).toBe(1);
    const body = await readFile(path.join(root, HOW_WE_TEST_RELATIVE), 'utf8');
    expect(body).toContain('npm test');
    expect(body).not.toContain('npm run lint');
  });

  it('reports why nothing was written when the backend cannot enumerate', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'zelari-howwetest-'));
    dirs.push(root);
    const result = await regenerateHowWeTest({}, root);
    expect(result.written).toBe(false);
    expect(result.reason).toMatch(/cannot enumerate/);
    expect(await readdir(root)).toEqual([]);
  });

  it('accepts a plain array dump and returns null without an export seam', async () => {
    expect(await listVerifiedProcedureNodes({ export: async () => [node()] })).toHaveLength(1);
    expect(await listVerifiedProcedureNodes({ export: async () => [{ id: 'x' }] })).toEqual([]);
    expect(await listVerifiedProcedureNodes({})).toBeNull();
    expect(await listVerifiedProcedureNodes({ export: async () => { throw new Error('nope'); } }))
      .toBeNull();
  });
});
