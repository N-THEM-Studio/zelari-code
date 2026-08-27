/**
 * sandboxPath.test.ts — P0.D (t18) symlink-safe sandbox coverage.
 *
 * Legacy lexical tests live in tests/unit/cli-sandboxPath.test.ts; this
 * suite covers realpath guarantees: link escapes (incl. chains), internal
 * links staying allowed, case folding (win32/darwin only), nested targets,
 * TOCTOU verifyContainment. Link tests probe creatability first (junction on
 * win32 needs no privileges; EPERM ⇒ clean skip).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

import {
  resolveSandboxedPath,
  resolveSandboxedPathReal,
  verifyContainment,
  isPathInsideSandbox,
  SandboxViolationError,
} from './sandboxPath.js';

const IS_WIN = process.platform === 'win32';
const CASE_FOLDING_PLATFORM = ['win32', 'darwin'].includes(process.platform);

/**
 * Can THIS environment create links? Win32 junctions need no privileges;
 * POSIX symlinks usually work. False on EPERM ⇒ tests skip cleanly.
 */
function canCreateLinks(): boolean {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'zelari-linkprobe-'));
  try {
    const target = path.join(base, 'target');
    fs.mkdirSync(target);
    const link = path.join(base, 'link');
    if (IS_WIN) fs.symlinkSync(target, link, 'junction');
    else fs.symlinkSync(target, link);
    return fs.statSync(link).isDirectory();
  } catch {
    return false;
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}
const LINKS_OK = canCreateLinks();

function makeTempRoot(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

/** Create a link appropriate to the platform. */
function makeLink(target: string, linkPath: string): void {
  if (IS_WIN) fs.symlinkSync(target, linkPath, 'junction');
  else fs.symlinkSync(target, linkPath);
}

// Layer 1 (lexical): legacy Task A2 semantics must survive untouched.
describe('sandboxPath lexical layer (fake root — no FS touches)', () => {
  const fakeRoot = path.join('/tmp', 'sandbox-root-p0d-does-not-exist');

  it('resolves a relative path against the root', () => {
    const resolved = resolveSandboxedPath('foo/bar.txt', { root: fakeRoot });
    expect(resolved).toBe(path.resolve(fakeRoot, 'foo/bar.txt'));
  });

  it('../../etc/passwd-style escape DENIED', () => {
    expect(() =>
      resolveSandboxedPath('../../etc/passwd', { root: fakeRoot }),
    ).toThrow(SandboxViolationError);
  });

  it('absolute path outside root DENIED', () => {
    expect(() =>
      resolveSandboxedPath('/etc/passwd', { root: fakeRoot }),
    ).toThrow(SandboxViolationError);
  });

  it('prefix confusion (/root-baz vs /root) DENIED', () => {
    expect(() =>
      resolveSandboxedPath(`${fakeRoot}-baz/x`, { root: fakeRoot }),
    ).toThrow(SandboxViolationError);
  });

  it('empty path rejected', () => {
    expect(() => resolveSandboxedPath('', { root: fakeRoot })).toThrow();
  });
});

// Real roots: both layers active.
describe('sandboxPath real-root containment (both layers)', () => {
  let root: string;

  beforeEach(() => {
    root = makeTempRoot('zelari-sbx-real-');
  });

  it('nonexistent NESTED target under a safe dir ALLOWED (suffix handling)', () => {
    try {
      fs.mkdirSync(path.join(root, 'a'));
      const resolved = resolveSandboxedPath(
        path.join('a', 'deeper', 'new-file.txt'),
        { root },
      );
      expect(resolved).toBe(path.resolve(root, 'a', 'deeper', 'new-file.txt'));
      expect(isPathInsideSandbox(resolved, { root })).toBe(true);
    } finally {
      cleanup(root);
    }
  });

  it('existing nested file ALLOWED, returns lexical resolution', () => {
    try {
      fs.mkdirSync(path.join(root, 'src'), { recursive: true });
      fs.writeFileSync(path.join(root, 'src', 'main.ts'), 'export {};\n');
      const abs = path.join(root, 'src', 'main.ts');
      expect(resolveSandboxedPath(abs, { root })).toBe(path.resolve(abs));
    } finally {
      cleanup(root);
    }
  });
});

// Layer 2 link escapes: whole block skipped when links cannot be created.
describe.skipIf(!LINKS_OK)(
  'sandboxPath junction/symlink escapes (P0.D)' +
    (LINKS_OK ? '' : ' [skipped: links not creatable here]'),
  () => {
    it('junction/symlink inside workspace → OUTSIDE target DENIED', () => {
      const root = makeTempRoot('zelari-sbx-ws-');
      const outside = makeTempRoot('zelari-sbx-outside-');
      try {
        makeLink(outside, path.join(root, 'out'));
        expect(() =>
          resolveSandboxedPath(path.join('out', 'secret.txt'), { root }),
        ).toThrow(SandboxViolationError);
        expect(isPathInsideSandbox(path.join('out', 'f.txt'), { root })).toBe(
          false,
        );
      } finally {
        cleanup(root);
        cleanup(outside);
      }
    });

    it('absolute path THROUGH an inside link escaping the workspace DENIED', () => {
      const root = makeTempRoot('zelari-sbx-ws2-');
      const outside = makeTempRoot('zelari-sbx-outside2-');
      try {
        makeLink(outside, path.join(root, 'l'));
        expect(() =>
          resolveSandboxedPath(path.join(root, 'l', 'victim.txt'), { root }),
        ).toThrow(SandboxViolationError);
      } finally {
        cleanup(root);
        cleanup(outside);
      }
    });

    it('symlink CHAIN a → b → outside DENIED (realpath resolves whole chain)', () => {
      const root = makeTempRoot('zelari-sbx-chain-');
      const outside = makeTempRoot('zelari-sbx-outside3-');
      try {
        makeLink(outside, path.join(root, 'b'));
        makeLink(path.join(root, 'b'), path.join(root, 'a')); // a → b → outside
        expect(() =>
          resolveSandboxedPath(path.join('a', 'x.txt'), { root }),
        ).toThrow(SandboxViolationError);
      } finally {
        cleanup(root);
        cleanup(outside);
      }
    });

    it('INTERNAL link (inside workspace) stays ALLOWED — no over-blocking', () => {
      const root = makeTempRoot('zelari-sbx-int-');
      try {
        fs.mkdirSync(path.join(root, 'real-data'), { recursive: true });
        makeLink(path.join(root, 'real-data'), path.join(root, 'alias-data'));
        const resolved = resolveSandboxedPath(
          path.join('alias-data', 'note.md'),
          { root },
        );
        expect(resolved).toBe(path.resolve(root, 'alias-data', 'note.md'));
        expect(isPathInsideSandbox(resolved, { root })).toBe(true);
      } finally {
        cleanup(root);
      }
    });
  },
);

// Case folding: only on case-insensitive platforms, applied post-realpath.
describe('sandboxPath case handling', () => {
  it.skipIf(!CASE_FOLDING_PLATFORM)(
    'case variant of an EXISTING path ALLOWED on win32/darwin (folded after realpath)',
    () => {
      const root = makeTempRoot('zelari-sbx-case-');
      try {
        fs.mkdirSync(path.join(root, 'DIRUP'), { recursive: true });
        fs.writeFileSync(path.join(root, 'DIRUP', 'F.txt'), 'x\n');
        // Request a DIFFERENT casing than what exists on disk.
        const variant = path.join(root, 'dirup', 'f.txt');
        const resolved = resolveSandboxedPath(variant, { root });
        // Resolver keeps returning the lexical spelling…
        expect(resolved).toBe(path.resolve(variant));
        // …and must not reject the internal case-variant path.
        expect(isPathInsideSandbox(variant, { root })).toBe(true);
      } finally {
        cleanup(root);
      }
    },
  );

  it.skipIf(CASE_FOLDING_PLATFORM)(
    'linux does NOT fold case: wrong-case spelling is just a NEW path',
    () => {
      const root = makeTempRoot('zelari-sbx-exact-');
      try {
        fs.mkdirSync(path.join(root, 'Exact'));
        fs.writeFileSync(path.join(root, 'Exact', 'file'), 'x\n');
        const wrongCase = path.join(root, 'exact', 'other-file');
        // No denial: on linux this is just a nonexistent (harmless) path —
        // no silent mapping onto the cased directory.
        expect(resolveSandboxedPath(wrongCase, { root })).toBe(
          path.resolve(wrongCase),
        );
      } finally {
        cleanup(root);
      }
    },
  );
});

// TOCTOU [PW §5]: fresh-syscall re-check catches mutations after early check.
describe('sandboxPath TOCTOU re-check (verifyContainment)', () => {
  it('accepts when nothing changed since the early resolve', () => {
    const root = makeTempRoot('zelari-sbx-tt0-');
    try {
      fs.mkdirSync(path.join(root, 'stable'), { recursive: true });
      fs.writeFileSync(path.join(root, 'stable', 'keep.txt'), 'x\n');
      const abs = path.join(root, 'stable', 'keep.txt');
      const early = resolveSandboxedPath(abs, { root });
      expect(() => verifyContainment(early, { root })).not.toThrow();
    } finally {
      cleanup(root);
    }
  });

  it.skipIf(!LINKS_OK)(
    'directory swapped for an outside junction AFTER the early check is CAUGHT before write',
    () => {
      const root = makeTempRoot('zelari-sbx-tt1-');
      const outside = makeTempRoot('zelari-sbx-outside4-');
      try {
        // Permission time: resolver verifies containment — passes.
        const safeDir = path.join(root, 'data');
        fs.mkdirSync(safeDir, { recursive: true });
        const secretAbs = path.join(safeDir, 'secret.txt');
        const earlyResolved = resolveSandboxedPath(secretAbs, { root });
        expect(earlyResolved).toBe(path.resolve(secretAbs));

        // Adversarial window: data/ replaced by a junction pointing OUTSIDE.
        fs.rmSync(safeDir, { recursive: true, force: true });
        makeLink(outside, safeDir);

        // Final gate immediately before the "write": fresh syscalls expose
        // the swapped link.
        expect(() => verifyContainment(earlyResolved, { root })).toThrow(
          SandboxViolationError,
        );
        expect(() =>
          resolveSandboxedPath(earlyResolved, { root }),
        ).toThrow(SandboxViolationError);
      } finally {
        cleanup(root);
        cleanup(outside);
      }
    },
  );
});

// API contract.
describe('sandboxPath exports (compat contract)', () => {
  it('resolveSandboxedPathReal mirrors resolveSandboxedPath exactly', () => {
    const root = makeTempRoot('zelari-sbx-api-');
    try {
      fs.mkdirSync(path.join(root, 'd'));
      const p = 'd/f';
      expect(resolveSandboxedPathReal(p, { root })).toBe(
        resolveSandboxedPath(p, { root }),
      );
    } finally {
      cleanup(root);
    }
  });
});
