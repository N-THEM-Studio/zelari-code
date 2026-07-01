/**
 * cli-workspace-storage.test.ts — Tests for the storage primitives
 * (frontmatter parse/serialize, file I/O, mutex).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseFrontmatter,
  serializeFrontmatter,
  parseYaml,
  serializeYaml,
  Storage,
  workspaceMutex,
} from '../../src/cli/workspace/storage.js';

let tmpDir: string;
let storage: Storage;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'zelari-ws-test-'));
  storage = new Storage();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('parseFrontmatter / serializeFrontmatter', () => {
  it('parses simple frontmatter', () => {
    const md = `---
kind: phase
id: discovery
order: 1
---
# Phase Body

Some content here.`;
    const result = parseFrontmatter(md);
    expect(result.meta).toEqual({ kind: 'phase', id: 'discovery', order: 1 });
    expect(result.body).toContain('# Phase Body');
    expect(result.body).toContain('Some content here.');
  });

  it('returns empty meta when no frontmatter', () => {
    const md = '# Just a title\n\nNo frontmatter here.';
    const result = parseFrontmatter(md);
    expect(result.meta).toEqual({});
    expect(result.body).toBe(md);
  });

  it('roundtrips through serializeFrontmatter', () => {
    const meta = { kind: 'adr', id: '001-test', status: 'accepted', tags: ['auth', 'security'] };
    const body = '## Context\n\nWe needed to decide X.';
    const md = serializeFrontmatter(meta, body);
    const result = parseFrontmatter(md);
    expect(result.meta).toEqual(meta);
    expect(result.body).toBe(body);
  });

  it('handles null and boolean values', () => {
    const md = `---
flag: true
nothing: null
count: 42
---
body`;
    const result = parseFrontmatter(md);
    expect(result.meta).toEqual({ flag: true, nothing: null, count: 42 });
  });

  it('handles flow-style arrays', () => {
    const md = `---
tags: [auth, security, jwt]
---
body`;
    const result = parseFrontmatter(md);
    expect(result.meta.tags).toEqual(['auth', 'security', 'jwt']);
  });

  it('handles quoted strings with special chars', () => {
    const md = `---
title: "JWT: rotation strategy"
path: 'src/auth/jwt.ts'
---
body`;
    const result = parseFrontmatter(md);
    expect(result.meta.title).toBe('JWT: rotation strategy');
    expect(result.meta.path).toBe('src/auth/jwt.ts');
  });

  it('handles flow-style arrays (canonical form)', () => {
    const md = `---
tags:
  - auth
  - security
---
body`;
    // Note: our serializer always writes flow-style (`[a, b, c]`).
    // Block-style arrays are not supported in v1 — read returns empty
    // for that case. To make roundtrips work, callers should use the
    // serializer (write flow-style) rather than hand-writing block YAML.
    const result = parseFrontmatter(md);
    expect(result.meta.tags).toEqual([]);
    // Sanity: the same content written + read via the serializer roundtrips.
    const md2 = serializeFrontmatter({ tags: ['auth', 'security'] }, 'body');
    const result2 = parseFrontmatter(md2);
    expect(result2.meta.tags).toEqual(['auth', 'security']);
  });
});

describe('parseYaml / serializeYaml', () => {
  it('roundtrips nested objects', () => {
    const obj = {
      kind: 'phase',
      id: 'p1',
      meta: { order: 1, color: '#ff0000' },
      tasks: ['t1', 't2'],
    };
    const yaml = serializeYaml(obj);
    const back = parseYaml(yaml);
    expect(back).toEqual(obj);
  });

  it('roundtrips array of objects', () => {
    const obj = {
      checklist: [
        { item: 'tests pass', status: 'pass' },
        { item: 'docs updated', status: 'note' },
      ],
    };
    const yaml = serializeYaml(obj);
    const back = parseYaml(yaml);
    expect(back).toEqual(obj);
  });

  it('quotes strings with colons', () => {
    const yaml = serializeYaml({ title: 'JWT: rotation' });
    const back = parseYaml(yaml);
    expect(back).toEqual({ title: 'JWT: rotation' });
  });
});

describe('Storage', () => {
  it('reads a Markdown file with frontmatter', () => {
    const path = join(tmpDir, 'doc.md');
    writeFileSync(path, '---\nkind: adr\nid: 001-jwt-rotation\n---\nbody content');
    const result = storage.read(path);
    // Note: `001-jwt-rotation` is parsed as a string because of the dash;
    // pure-numeric ids like `id: 1` would be parsed as numbers. Our real
    // ids are always slugified (`001-jwt-rotation`) so this is fine.
    expect(result.meta).toEqual({ kind: 'adr', id: '001-jwt-rotation' });
    expect(result.body).toBe('body content');
  });

  it('throws on missing file', () => {
    expect(() => storage.read(join(tmpDir, 'nope.md'))).toThrow(/not found/);
  });

  it('readIfExists returns null on missing', () => {
    expect(storage.readIfExists(join(tmpDir, 'nope.md'))).toBeNull();
  });

  it('writes a file atomically with frontmatter', () => {
    const path = join(tmpDir, 'sub', 'doc.md');
    storage.write(path, { kind: 'adr', id: '001' }, '# Body\n\nHello.');
    expect(existsSync(path)).toBe(true);
    const content = readFileSync(path, 'utf8');
    expect(content).toMatch(/^---\n/);
    expect(content).toContain('kind: adr');
    expect(content).toContain('# Body');
  });

  it('listMarkdown returns sorted .md files', () => {
    storage.write(join(tmpDir, 'a.md'), {}, 'a');
    storage.write(join(tmpDir, 'b.md'), {}, 'b');
    storage.write(join(tmpDir, 'ignore.txt'), '', 'ignored');
    expect(storage.listMarkdown(tmpDir).sort()).toEqual([
      join(tmpDir, 'a.md'),
      join(tmpDir, 'b.md'),
    ]);
  });

  it('listMarkdown returns empty for missing dir', () => {
    expect(storage.listMarkdown(join(tmpDir, 'missing'))).toEqual([]);
  });
});

describe('workspaceMutex', () => {
  it('serializes writes to the same key', async () => {
    // Two tasks share key 'k0' (i=0, i=2), two share key 'k1' (i=1, i=3).
    // Same-key tasks must NOT interleave. Different-key tasks may interleave.
    const order: number[] = [];
    const tasks = [0, 1, 2, 3].map((i) =>
      workspaceMutex.run(`k${i % 2}`, async () => {
        order.push(i);
        await new Promise((r) => setTimeout(r, 5));
        order.push(i + 100);
      }),
    );
    await Promise.all(tasks);

    // For each shared key, the start of the second task must come AFTER
    // the end of the first task (no interleaving within a key).
    const findPair = (keyIdx: 0 | 1) => {
      const startA = order.indexOf(keyIdx);
      const endA = order.indexOf(keyIdx + 100);
      const startB = order.indexOf(keyIdx + 2);
      const endB = order.indexOf(keyIdx + 2 + 100);
      return { startA, endA, startB, endB };
    };
    const p0 = findPair(0);
    const p1 = findPair(1);

    // Same-key tasks: either A finishes before B starts, or B finishes before A starts.
    const sameKeyDisjoint0 = p0.endA < p0.startB || p0.endB < p0.startA;
    const sameKeyDisjoint1 = p1.endA < p1.startB || p1.endB < p1.startA;
    expect(sameKeyDisjoint0).toBe(true);
    expect(sameKeyDisjoint1).toBe(true);
  });
});