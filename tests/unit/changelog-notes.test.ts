/**
 * changelog-notes.test.ts — extract Keep-a-Changelog sections without regex.
 *
 * Guards the publish.yml GitHub Release notes path: a previous node -e
 * RegExp treated `## [1.32.0]` as a character class and threw
 * "Unterminated character class".
 */
import { describe, it, expect } from 'vitest';
import {
  extractChangelogNotes,
  extractChangelogNotesFromFile,
} from '../../scripts/changelog-notes.mjs';

const SAMPLE = `# Changelog

## [Unreleased]

## [1.32.0] - 2026-08-12

### Added
- Folder trust

## [1.31.1] - 2026-08-12

### Fixed
- qwen-mm-plugins

## [1.0.0] - 2026-01-01

First stable.
`;

describe('extractChangelogNotes', () => {
  it('extracts a dotted semver section without treating [1.32.0] as a regex class', () => {
    const notes = extractChangelogNotes(SAMPLE, 'v1.32.0');
    expect(notes.startsWith('## [1.32.0] - 2026-08-12')).toBe(true);
    expect(notes).toContain('Folder trust');
    expect(notes).not.toContain('## [1.31.1]');
    expect(notes).not.toContain('## [Unreleased]');
  });

  it('accepts a tag without the v prefix', () => {
    const notes = extractChangelogNotes(SAMPLE, '1.31.1');
    expect(notes.startsWith('## [1.31.1] - 2026-08-12')).toBe(true);
    expect(notes).toContain('qwen-mm-plugins');
    expect(notes).not.toContain('## [1.32.0]');
    expect(notes).not.toContain('## [1.0.0]');
  });

  it('takes the last section through EOF when no next heading exists', () => {
    const notes = extractChangelogNotes(SAMPLE, '1.0.0');
    expect(notes).toBe('## [1.0.0] - 2026-01-01\n\nFirst stable.');
  });

  it('falls back when the version is missing or empty', () => {
    expect(extractChangelogNotes(SAMPLE, '9.9.9')).toBe('See CHANGELOG.md');
    expect(extractChangelogNotes(SAMPLE, '')).toBe('See CHANGELOG.md');
    expect(extractChangelogNotes(SAMPLE, 'v')).toBe('See CHANGELOG.md');
  });

  it('reads the real CHANGELOG for the current 1.32.0 heading', () => {
    const notes = extractChangelogNotesFromFile('CHANGELOG.md', 'v1.32.0');
    expect(notes.startsWith('## [1.32.0] - ')).toBe(true);
    expect(notes).toContain('Folder trust');
    expect(notes).not.toMatch(/^## \[1\.31/m);
  });
});
