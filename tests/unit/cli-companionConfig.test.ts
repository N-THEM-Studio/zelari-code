import { describe, expect, it } from 'vitest';
import {
  mergeProjects,
  resolveProjectPath,
  tokenMatches,
  slugFromPath,
  type CompanionConfigFile,
} from '../../src/cli/companion/config.js';

describe('companion config', () => {
  it('tokenMatches is timing-safe equality via hash', () => {
    expect(tokenMatches('secret-abc', 'secret-abc')).toBe(true);
    expect(tokenMatches('secret-abc', 'secret-xyz')).toBe(false);
    expect(tokenMatches('secret-abc', null)).toBe(false);
  });

  it('slugFromPath derives id from folder name', () => {
    expect(slugFromPath('Z:\\EasyPeasy\\zelari-code')).toBe('zelari-code');
    expect(slugFromPath('/home/me/My App!')).toMatch(/^my-app/);
  });

  it('mergeProjects adds CLI paths without losing existing', () => {
    const cfg: CompanionConfigFile = {
      projects: [{ id: 'a', name: 'a', path: '/tmp/a' }],
    };
    const merged = mergeProjects(cfg, ['/tmp/b', '/tmp/a']);
    expect(merged.some((p) => p.path === '/tmp/a')).toBe(true);
    expect(merged.some((p) => p.path === '/tmp/b')).toBe(true);
  });

  it('resolveProjectPath enforces allowlist', () => {
    const projects = [
      { id: 'zelari', name: 'zelari-code', path: 'Z:\\EasyPeasy\\zelari-code' },
      { id: 'other', name: 'other', path: 'Z:\\other' },
    ];
    expect(resolveProjectPath(projects, 'zelari').ok).toBe(true);
    expect(resolveProjectPath(projects, 'Z:\\EasyPeasy\\zelari-code').ok).toBe(
      true,
    );
    const bad = resolveProjectPath(projects, 'Z:\\not-allowed');
    expect(bad.ok).toBe(false);
  });

  it('resolveProjectPath defaults to first project', () => {
    const projects = [
      { id: 'a', name: 'a', path: '/tmp/a' },
      { id: 'b', name: 'b', path: '/tmp/b' },
    ];
    const r = resolveProjectPath(projects, null);
    expect(r.ok && r.project.id).toBe('a');
  });
});
