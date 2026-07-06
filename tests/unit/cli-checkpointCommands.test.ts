/**
 * /checkpoint + /rollback slash-command parsing (v1.2 workspace checkpoints).
 */
import { describe, it, expect } from 'vitest';
import { handleSlashCommand } from '../../src/cli/slashCommands';
import type { CodingSkillDefinition } from '@zelari/core/skills';

const skills: CodingSkillDefinition[] = [];

describe('/checkpoint', () => {
  it('parses "/checkpoint" as checkpoint_create with no label', () => {
    const r = handleSlashCommand('/checkpoint', skills);
    expect(r.handled).toBe(true);
    expect(r.kind).toBe('checkpoint_create');
    expect(r.checkpointLabel).toBeUndefined();
  });

  it('captures a multi-word label', () => {
    const r = handleSlashCommand('/checkpoint before refactor', skills);
    expect(r.kind).toBe('checkpoint_create');
    expect(r.checkpointLabel).toBe('before refactor');
  });
});

describe('/rollback', () => {
  it('parses "/rollback" as a list request', () => {
    const r = handleSlashCommand('/rollback', skills);
    expect(r.kind).toBe('rollback_list');
  });

  it('parses "/rollback <id>" with the id', () => {
    const r = handleSlashCommand('/rollback a1b2c3d4', skills);
    expect(r.kind).toBe('rollback');
    expect(r.rollbackId).toBe('a1b2c3d4');
  });

  it('parses "/rollback latest" with no explicit id (newest)', () => {
    const r = handleSlashCommand('/rollback latest', skills);
    expect(r.kind).toBe('rollback');
    expect(r.rollbackId).toBeUndefined();
  });
});
