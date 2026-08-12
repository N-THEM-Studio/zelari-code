#!/usr/bin/env node
/**
 * Extract the Keep-a-Changelog section for a version tag.
 *
 * Used by `.github/workflows/publish.yml` for GitHub Release notes.
 * Slice by heading text — never a RegExp — because version strings like
 * `1.32.0` contain `.` and live inside `[…]`. YAML → bash → `node -e`
 * quoting previously ate the `\[` / `\]` / `\z` escapes and produced
 * `/## [1.32.0] - …(?=^## [|z)/` (unterminated character class).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FALLBACK = 'See CHANGELOG.md';

/**
 * @param {string} markdown
 * @param {string} tag  `v1.32.0` or `1.32.0`
 * @returns {string}
 */
export function extractChangelogNotes(markdown, tag) {
  const version = String(tag ?? '').replace(/^v/i, '').trim();
  if (!version) return FALLBACK;
  const heading = `## [${version}] - `;
  const start = markdown.indexOf(heading);
  if (start < 0) return FALLBACK;
  const next = markdown.indexOf('\n## [', start + heading.length);
  return markdown.slice(start, next < 0 ? undefined : next).trim();
}

/**
 * @param {string} changelogPath
 * @param {string} tag
 * @returns {string}
 */
export function extractChangelogNotesFromFile(changelogPath, tag) {
  return extractChangelogNotes(fs.readFileSync(changelogPath, 'utf8'), tag);
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const tag = process.argv[2] ?? '';
  const file = process.argv[3] ?? 'CHANGELOG.md';
  process.stdout.write(`${extractChangelogNotesFromFile(file, tag)}\n`);
}
