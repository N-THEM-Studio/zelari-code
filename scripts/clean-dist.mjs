#!/usr/bin/env node
/** Remove only the generated TypeScript output trees used by this monorepo. */
import { rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const allowed = new Map(
  ['dist', 'packages/core/dist', 'packages/core/tsconfig.tsbuildinfo'].map((rel) => [
    rel,
    path.resolve(repoRoot, rel),
  ]),
);
const requested = process.argv.slice(2);
const targets = requested.length > 0 ? requested : [...allowed.keys()];

for (const rel of targets) {
  const target = path.resolve(repoRoot, rel);
  if (allowed.get(rel) !== target) {
    throw new Error(`Refusing to remove unsupported build path: ${rel}`);
  }
  rmSync(target, { recursive: true, force: true });
  console.log(`[clean-dist] removed ${rel}`);
}
