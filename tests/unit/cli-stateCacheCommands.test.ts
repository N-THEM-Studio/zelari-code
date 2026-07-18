import { describe, it, expect } from 'vitest';
import { handleSlashCommand } from '../../src/cli/slashCommands.js';

const skills: never[] = [];

describe('/state slash commands', () => {
  it('parses /state and /state status', () => {
    expect(handleSlashCommand('/state', skills).kind).toBe('state_status');
    expect(handleSlashCommand('/state status', skills).kind).toBe('state_status');
  });

  it('parses /state commit [label]', () => {
    const r = handleSlashCommand('/state commit after green', skills);
    expect(r.kind).toBe('state_commit');
    expect(r.stateArg).toBe('after green');
  });

  it('parses /state show [id]', () => {
    const r = handleSlashCommand('/state show abc123', skills);
    expect(r.kind).toBe('state_show');
    expect(r.stateArg).toBe('abc123');
  });

  it('returns usage for unknown subcommand', () => {
    const r = handleSlashCommand('/state foo', skills);
    expect(r.kind).toBe('state_usage');
    expect(r.message).toMatch(/Usage/);
  });

  it('parses /state restore [id] [--no-tree]', () => {
    const r = handleSlashCommand('/state restore abc123', skills);
    expect(r.kind).toBe('state_restore');
    expect(r.stateArg).toBe('abc123');
    expect(r.stateNoTree).toBeUndefined();

    const r2 = handleSlashCommand('/state restore abc123 --no-tree', skills);
    expect(r2.kind).toBe('state_restore');
    expect(r2.stateArg).toBe('abc123');
    expect(r2.stateNoTree).toBe(true);

    const r3 = handleSlashCommand('/state restore', skills);
    expect(r3.kind).toBe('state_restore');
    expect(r3.stateArg).toBeUndefined();
  });
});

describe('/cache slash commands', () => {
  it('parses /cache and /cache stats', () => {
    expect(handleSlashCommand('/cache', skills).kind).toBe('cache_stats');
    expect(handleSlashCommand('/cache stats', skills).kind).toBe('cache_stats');
  });
});
