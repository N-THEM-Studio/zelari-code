import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { editFileTool, replaceFileString, writeFileTool } from './filesystem.js';
import { WriteRejectSchema } from './edit.js';
import type { ToolContext } from '../toolTypes.js';

let tmpRoot: string;
let ctx: ToolContext;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'zelari-edit-'));
  ctx = {
    cwd: tmpRoot,
    signal: new AbortController().signal,
    audit: () => {},
    sessionId: 'test-edit',
  };
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('replaceFileString', () => {
  it('matches LF oldString against CRLF file text and restores CRLF', () => {
    const text = 'import {\r\n  agentRulesFor,\r\n  loadPolicySet,\r\n} from "./p.js";\r\n';
    const r = replaceFileString(
      text,
      'import {\n  agentRulesFor,\n  loadPolicySet,\n} from "./p.js";\n',
      'import {\n  agentLayersFor,\n  loadPolicySet,\n} from "./p.js";\n',
      false,
    );
    expect(r.occurrences).toBe(1);
    expect(r.newContent).toBe(
      'import {\r\n  agentLayersFor,\r\n  loadPolicySet,\r\n} from "./p.js";\r\n',
    );
  });

  it('keeps LF files byte-identical on LF oldString', () => {
    const text = 'a\nb\nc\n';
    const r = replaceFileString(text, 'b', 'B', false);
    expect(r.occurrences).toBe(1);
    expect(r.newContent).toBe('a\nB\nc\n');
  });

  it('replaceAll is newline-agnostic', () => {
    const text = 'foo\r\nfoo\r\n';
    const r = replaceFileString(text, 'foo\n', 'bar\n', true);
    expect(r.occurrences).toBe(2);
    expect(r.newContent).toBe('bar\r\nbar\r\n');
  });
});

describe('edit_file CRLF', () => {
  it('edits a CRLF file when oldString is LF and preserves CRLF on disk', async () => {
    const file = path.join(tmpRoot, 'toolRegistry.ts');
    await fs.writeFile(file, 'const x = 1;\r\nconst y = 2;\r\n', 'utf-8');
    const r = await editFileTool.execute(
      { path: 'toolRegistry.ts', oldString: 'const x = 1;\n', newString: 'const x = 9;\n', replaceAll: false },
      ctx,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.occurrencesReplaced).toBe(1);
    const written = await fs.readFile(file);
    expect(written.toString('utf-8')).toBe('const x = 9;\r\nconst y = 2;\r\n');
  });

  it('still errors when the snippet is genuinely missing', async () => {
    await fs.writeFile(path.join(tmpRoot, 'f.ts'), 'hello\r\nworld\r\n', 'utf-8');
    const r = await editFileTool.execute(
      { path: 'f.ts', oldString: 'nope\n', newString: 'x', replaceAll: false },
      ctx,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('no match for oldString');
  });
});

describe('write_file file_exists guard (t77)', () => {
  it('creates a new file', async () => {
    const r = await writeFileTool.execute({ path: 'fresh.ts', content: 'hello\n' }, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.bytesWritten).toBe('hello\n'.length);
    await expect(fs.readFile(path.join(tmpRoot, 'fresh.ts'), 'utf-8')).resolves.toBe('hello\n');
  });

  it('rejects an existing target with file_exists and leaves the disk untouched', async () => {
    const file = path.join(tmpRoot, 'keep.ts');
    await fs.writeFile(file, 'original\n', 'utf-8');
    const r = await writeFileTool.execute({ path: 'keep.ts', content: 'clobber\n' }, ctx);
    expect(r.ok).toBe(false);
    expect(await fs.readFile(file, 'utf-8')).toBe('original\n');
    if (!r.ok) {
      expect(r.error).toContain('FILE_EXISTS');
      const reject = WriteRejectSchema.parse(r.meta?.reject);
      expect(reject.status).toBe('file_exists');
      expect(reject.path).toBe(file);
      expect(reject.next).toEqual({ action: 're-read', path: file });
    }
  });

  it('overwrite: true replaces an existing file', async () => {
    const file = path.join(tmpRoot, 'swap.ts');
    await fs.writeFile(file, 'old\n', 'utf-8');
    const r = await writeFileTool.execute(
      { path: 'swap.ts', content: 'new\n', overwrite: true },
      ctx,
    );
    expect(r.ok).toBe(true);
    await expect(fs.readFile(file, 'utf-8')).resolves.toBe('new\n');
  });

  it('the file_exists minimalDiff contrasts existing (-) vs incoming (+), bounded', async () => {
    await fs.writeFile(path.join(tmpRoot, 'd.ts'), 'line1\nline2\n', 'utf-8');
    const r = await writeFileTool.execute({ path: 'd.ts', content: 'gone1\ngone2\n' }, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const reject = WriteRejectSchema.parse(r.meta?.reject);
      const lines = reject.minimalDiff.split('\n');
      expect(lines.some((l) => l.startsWith('-'))).toBe(true);
      expect(lines.some((l) => l.startsWith('+'))).toBe(true);
      // Header (3) + bounded body: ~10 existing head lines, ~40 body lines cap.
      expect(lines.length).toBeLessThanOrEqual(43);
    }
  });
});
